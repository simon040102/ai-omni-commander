import type {
  AgentRole, AgentStartConfig, AgentOutputEvent,
  ClaudeStreamResult, ClaudeStreamInit, BusEvent,
  Workspace,
} from '@omni/shared';
import { EventTypes } from '@omni/shared';
import { AgentProcess } from './AgentProcess.js';
import { getAgentRoleConfig } from './AgentRoles.js';
import { createAgent, updateAgent, getAgent, getAgentsByRole, getAgentsByProject } from '../db/queries/agents.js';
import { getProject, updateProject } from '../db/queries/projects.js';
import { updateTask, getTask } from '../db/queries/tasks.js';
import { logAgentOutput, createIntervention, clearAgentOutputs } from '../db/queries/events.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import { getConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('AgentManager');

/**
 * Manages the full lifecycle of multiple Claude Code agent processes.
 */
export class AgentManager {
  private processes = new Map<string, AgentProcess>();

  constructor(
    private eventBus: EventBus,
    private contextSync: ContextSync,
  ) {
    // Listen for contract changes to notify frontend agents
    this.eventBus.on(EventTypes.CONTRACT_UPDATED, (e) => this.onContractUpdated(e));
  }

  /** Start an agent for a specific task */
  async startAgent(config: AgentStartConfig): Promise<string> {
    const appConfig = getConfig();
    const roleConfig = getAgentRoleConfig(config.role);

    // Build enhanced system prompt with context
    let systemPrompt = roleConfig.systemPrompt;
    const contracts = await this.contextSync.readAllContracts();
    if (contracts.length > 0) {
      systemPrompt += `\n\nCurrent API Contracts:\n${JSON.stringify(contracts, null, 2)}`;
    }

    // Create DB record
    const agent = createAgent({
      projectId: config.projectId,
      role: config.role,
      systemPrompt,
      model: config.model || roleConfig.model,
      allowedTools: roleConfig.allowedTools,
    });

    updateAgent(agent.id, { status: 'starting' });
    if (config.taskId) {
      updateAgent(agent.id, { currentTaskId: config.taskId });
      updateTask(config.taskId, { assignedAgentId: agent.id, status: 'in_progress' });
    }

    // Create AgentProcess
    const proc = new AgentProcess(agent.id, config.role, {
      workingDir: this.getWorkingDir(config.projectId, config.role),
      systemPrompt,
      model: config.model || roleConfig.model,
      allowedTools: roleConfig.allowedTools,
      maxBudgetUsd: appConfig.maxAgentBudgetUsd || undefined,
    });

    // Wire up event handlers
    this.wireProcessEvents(proc, agent.id, config.projectId, config.taskId || null);

    this.processes.set(agent.id, proc);

    // Spawn the process
    await proc.spawn(config.prompt);

    logger.info({ agentId: agent.id, role: config.role }, 'Agent started');
    return agent.id;
  }

  /** Stop a specific agent */
  async stopAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc) {
      await proc.stop();
      this.processes.delete(agentId);
    }
    updateAgent(agentId, { status: 'stopped', pid: null });
    await this.eventBus.emit({
      type: EventTypes.AGENT_STOPPED,
      source: agentId,
      payload: { agentId },
      timestamp: new Date().toISOString(),
    });
  }

  /** Stop all agents for a project */
  async stopAllForProject(projectId: string): Promise<void> {
    const toStop: string[] = [];
    for (const [agentId, proc] of this.processes) {
      const agent = getAgent(agentId);
      if (agent && agent.projectId === projectId) {
        toStop.push(agentId);
      }
    }
    await Promise.all(toStop.map(id => this.stopAgent(id)));
  }

  /** Restart a failed agent */
  async restartAgent(agentId: string, newPrompt?: string): Promise<void> {
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Stop if running
    await this.stopAgent(agentId);

    // Check retry limit
    if (agent.currentTaskId) {
      const task = getTask(agent.currentTaskId);
      if (task && task.retryCount >= task.maxRetries) {
        logger.warn({ agentId, taskId: task.id }, 'Max retries exceeded, requesting intervention');
        await this.requestIntervention(
          agentId, agent.projectId, task.id,
          `Task "${task.title}" failed after ${task.retryCount} retries`,
        );
        return;
      }
      if (task) {
        updateTask(task.id, { retryCount: task.retryCount + 1 });
      }
    }

    // Re-start
    const prompt = newPrompt || 'Continue and complete the task. If you encountered an error, try a different approach.';
    await this.startAgent({
      projectId: agent.projectId,
      role: agent.role,
      taskId: agent.currentTaskId || undefined,
      prompt,
      model: agent.model,
    });
  }

  /** Rerun an existing agent with a new prompt (clears old outputs, starts fresh session) */
  async rerunAgent(agentId: string, prompt: string): Promise<void> {
    const agent = getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Stop if still running
    const proc = this.processes.get(agentId);
    if (proc) {
      await proc.stop();
      this.processes.delete(agentId);
    }

    // Clear old outputs so terminal starts fresh
    clearAgentOutputs(agentId);

    // Notify frontend to clear terminal for this agent
    await this.eventBus.emit({
      type: 'agent.outputsCleared',
      source: agentId,
      payload: { agentId, projectId: agent.projectId },
      timestamp: new Date().toISOString(),
    });

    // Reset agent state
    updateAgent(agentId, {
      status: 'starting',
      sessionId: null,
      pid: null,
      currentTaskId: null,
    });

    const appConfig = getConfig();
    const roleConfig = getAgentRoleConfig(agent.role);

    let systemPrompt = roleConfig.systemPrompt;
    const contracts = await this.contextSync.readAllContracts();
    if (contracts.length > 0) {
      systemPrompt += `\n\nCurrent API Contracts:\n${JSON.stringify(contracts, null, 2)}`;
    }

    const newProc = new AgentProcess(agentId, agent.role, {
      workingDir: this.getWorkingDir(agent.projectId, agent.role),
      systemPrompt,
      model: agent.model,
      allowedTools: roleConfig.allowedTools,
      maxBudgetUsd: appConfig.maxAgentBudgetUsd || undefined,
    });

    this.wireProcessEvents(newProc, agentId, agent.projectId, null);
    this.processes.set(agentId, newProc);

    await newProc.spawn(prompt);
    logger.info({ agentId, role: agent.role }, 'Agent rerun with new prompt');
  }

  /** Resume an agent using its Claude session ID */
  async resumeAgent(agentId: string, followUpPrompt?: string): Promise<void> {
    const proc = this.processes.get(agentId);
    if (proc) {
      await proc.resume(followUpPrompt);
    } else {
      const agent = getAgent(agentId);
      if (!agent || !agent.sessionId) throw new Error('No session to resume');
      const cfg = getConfig();
      // Create new process with session resume
      const newProc = new AgentProcess(agentId, agent.role, {
        workingDir: this.getWorkingDir(agent.projectId, agent.role),
        sessionId: agent.sessionId,
        model: agent.model,
        maxBudgetUsd: cfg.maxAgentBudgetUsd || undefined,
      });

      // Wire up event handlers (same as startAgent)
      this.wireProcessEvents(newProc, agentId, agent.projectId, agent.currentTaskId);

      this.processes.set(agentId, newProc);
      await newProc.resume(followUpPrompt);
    }
  }

  /**
   * Send a follow-up instruction to an agent.
   * Since --print mode closes stdin after the initial prompt,
   * this stops the current process and resumes the session with the new prompt.
   */
  async sendInputToAgent(agentId: string, text: string): Promise<boolean> {
    const proc = this.processes.get(agentId);
    if (!proc) return false;

    // If stdin is still writable (shouldn't normally happen), try direct write
    if (proc.sendInput(text)) return true;

    // Otherwise: stop current process and resume session with the new instruction
    const sessionId = proc.sessionId;
    if (!sessionId) {
      logger.warn({ agentId }, 'Cannot resume: no session ID');
      return false;
    }

    logger.info({ agentId, sessionId }, 'Stopping agent to resume with new instruction');
    await proc.stop();
    this.processes.delete(agentId);

    // Resume the session with the user's instruction as the new prompt
    await this.resumeAgent(agentId, text);
    return true;
  }

  /** Get all active agent processes */
  getActiveAgents(): string[] {
    return Array.from(this.processes.keys());
  }

  /** Get a specific process */
  getProcess(agentId: string): AgentProcess | undefined {
    return this.processes.get(agentId);
  }

  /** Attach standard event handlers to an AgentProcess */
  private wireProcessEvents(
    proc: AgentProcess,
    agentId: string,
    projectId: string,
    taskId: string | null,
  ): void {
    proc.on('init', (msg: ClaudeStreamInit) => {
      updateAgent(agentId, {
        status: 'running',
        sessionId: msg.session_id,
        pid: proc.pid,
      });
      this.eventBus.emit({
        type: EventTypes.AGENT_STARTED,
        source: agentId,
        payload: { agentId, role: proc.role, projectId },
        timestamp: new Date().toISOString(),
      });
    });

    proc.on('output', (output: AgentOutputEvent) => {
      output.taskId = taskId;

      // Persist to DB
      logAgentOutput({
        agentId,
        taskId: taskId || undefined,
        streamType: output.streamType,
        content: output.content,
      });

      // Broadcast via event bus (WebSocket will pick this up)
      this.eventBus.emit({
        type: EventTypes.AGENT_OUTPUT,
        source: agentId,
        payload: output as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });

      // Check for markers — only in assistant text output
      if (output.streamType === 'text') {
        this.checkMarkers(agentId, projectId, taskId, output.content);
      }
    });

    proc.on('result', (result: ClaudeStreamResult) => {
      this.handleAgentComplete(agentId, projectId, taskId, result);
    });

    proc.on('statusChange', ({ previous, current }: { previous: string; current: string }) => {
      updateAgent(agentId, { status: current as import('@omni/shared').AgentStatus });
      this.eventBus.emit({
        type: 'agent.statusChange',
        source: agentId,
        payload: { agentId, previousStatus: previous, newStatus: current },
        timestamp: new Date().toISOString(),
      });
    });

    proc.on('error', (err: Error) => {
      logger.error({ agentId, err }, 'Agent process error');
      this.handleAgentError(agentId, projectId, taskId, err);
    });
  }

  private getWorkingDir(projectId: string, role?: AgentRole): string {
    const project = getProject(projectId);
    if (!project) {
      const config = getConfig();
      return config.projectRoot;
    }

    // Check if workspaces are configured
    if (project.configJson) {
      try {
        const cfg = JSON.parse(project.configJson) as { workspaces?: Workspace[] };
        if (cfg.workspaces && cfg.workspaces.length > 0) {
          // Try to match role to workspace label
          if (role) {
            const match = cfg.workspaces.find(ws => ws.label.toLowerCase() === role.toLowerCase());
            if (match) return match.path;
          }
          // If only one workspace, always use it
          if (cfg.workspaces.length === 1) return cfg.workspaces[0].path;
          // Fallback to first workspace
          return cfg.workspaces[0].path;
        }
      } catch { /* ignore parse errors */ }
    }

    return project.workingDir;
  }

  private async handleAgentComplete(
    agentId: string,
    projectId: string,
    taskId: string | null,
    result: ClaudeStreamResult,
  ): Promise<void> {
    updateAgent(agentId, {
      status: 'stopped',
      totalCostUsd: result.cost_usd,
      totalTurns: result.num_turns,
      pid: null,
    });

    if (taskId) {
      const status = result.is_error ? 'failed' : 'completed';
      updateTask(taskId, {
        status,
        resultSummary: result.result ?? undefined,
      });

      await this.eventBus.emit({
        type: EventTypes.TASK_COMPLETED,
        source: agentId,
        payload: { taskId, projectId, status, costUsd: result.cost_usd },
        timestamp: new Date().toISOString(),
      });
    }

    await this.eventBus.emit({
      type: EventTypes.AGENT_COMPLETED,
      source: agentId,
      payload: { agentId, projectId, costUsd: result.cost_usd, turns: result.num_turns },
      timestamp: new Date().toISOString(),
    });

    this.processes.delete(agentId);

    // Check if all agents for this project are done — if so, mark project as completed
    this.checkProjectCompletion(projectId);
  }

  private checkProjectCompletion(projectId: string): void {
    const project = getProject(projectId);
    if (!project || project.status !== 'executing') return;

    const allAgents = getAgentsByProject(projectId);
    const allDone = allAgents.every(a =>
      a.status === 'stopped' || a.status === 'error' || a.status === 'idle'
    );

    if (allDone && allAgents.length > 0) {
      const hasErrors = allAgents.some(a => a.status === 'error');
      const newStatus = hasErrors ? 'failed' : 'completed';
      updateProject(projectId, { status: newStatus });
      logger.info({ projectId, newStatus, agentCount: allAgents.length }, 'All agents finished, project status updated');

      this.eventBus.emit({
        type: EventTypes.PROJECT_PHASE_CHANGED,
        source: projectId,
        payload: { projectId, status: newStatus },
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async handleAgentError(
    agentId: string,
    projectId: string,
    taskId: string | null,
    error: Error,
  ): Promise<void> {
    updateAgent(agentId, { status: 'error' });

    if (taskId) {
      updateTask(taskId, { status: 'failed' });
    }

    await this.eventBus.emit({
      type: EventTypes.AGENT_ERROR,
      source: agentId,
      payload: { agentId, projectId, taskId, error: error.message },
      timestamp: new Date().toISOString(),
    });
  }

  private checkMarkers(agentId: string, projectId: string, taskId: string | null, content: string): void {
    // Only match [NEEDS_HUMAN] when it appears as a standalone marker,
    // not when it's embedded in instructional text (e.g. "請加上 [NEEDS_HUMAN]")
    // Match: line starts with it, or it's preceded by whitespace/newline only
    if (/(?:^|\n)\s*\[NEEDS_HUMAN\]/.test(content)) {
      this.requestIntervention(agentId, projectId, taskId, 'Agent explicitly requested human assistance');
    }

    if (content.includes('[ENTITY_CHANGED:')) {
      const match = content.match(/\[ENTITY_CHANGED:\s*(\w+)\]/);
      if (match) {
        this.eventBus.emit({
          type: EventTypes.CONTRACT_ENTITY_CHANGED,
          source: agentId,
          payload: { entity: match[1], agentId, projectId },
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private async requestIntervention(
    agentId: string,
    projectId: string,
    taskId: string | null,
    reason: string,
  ): Promise<void> {
    const intervention = createIntervention({
      projectId,
      agentId,
      taskId: taskId || undefined,
      reason,
    });

    await this.eventBus.emit({
      type: EventTypes.INTERVENTION_NEEDED,
      source: agentId,
      payload: {
        interventionId: intervention.id,
        agentId,
        projectId,
        taskId,
        reason,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private async onContractUpdated(event: BusEvent): Promise<void> {
    const { entity } = event.payload as { entity: string };

    // Note: With --print mode, stdin is closed after initial prompt.
    // Contract update notifications are logged but cannot be sent to running agents.
    // Agents should be configured to watch for contract file changes in their CLAUDE.md.
    logger.info({ entity }, 'Contract updated — running agents cannot be notified (stdin closed)');
  }
}
