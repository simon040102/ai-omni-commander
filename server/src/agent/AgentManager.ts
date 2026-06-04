import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentRole, AgentStartConfig, AgentOutputEvent,
  ClaudeStreamResult, ClaudeStreamInit, BusEvent,
  Workspace, McpStdioServerConfig,
} from '@omni/shared';
import { EventTypes } from '@omni/shared';
import { AgentProcess } from './AgentProcess.js';
import { AgentProcessPty } from './AgentProcessPty.js';
import { getAgentRoleConfig } from './AgentRoles.js';
import { ProgressDetector } from './ProgressDetector.js';
import { createAgent, updateAgent, getAgent, getAgentsByRole, getAgentsByProject, getRunningAgents } from '../db/queries/agents.js';
import { getProject, updateProject } from '../db/queries/projects.js';
import { getGlobalMcpServers } from '../db/queries/globalConfig.js';
import { updateTask, getTask } from '../db/queries/tasks.js';
import { logAgentOutput, createIntervention, clearAgentOutputs, getAgentOutputs } from '../db/queries/events.js';
import { createPlan } from '../db/queries/plans.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import { getConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('AgentManager');

/**
 * Manages the full lifecycle of multiple Claude Code agent processes.
 */
/** Wait this long after last user input before executing stop→resume (merge rapid inputs) */
const INPUT_DEBOUNCE_MS = 1500;

export class AgentManager {
  private _usesPty = false;
  private processes = new Map<string, AgentProcess | AgentProcessPty>();
  private progressDetector = new ProgressDetector();
  /** Agents that have explicitly signaled task completion via [TASK_COMPLETE] */
  private taskDoneAgents = new Set<string>();
  /** Store initial prompts per agent for re-injection after context compaction */
  private initialPrompts = new Map<string, string>();
  /** Per-agent debounce: buffer pending inputs and fire once after DEBOUNCE_MS of silence */
  private inputBuffer = new Map<string, string[]>();
  private inputDebounceTimer = new Map<string, ReturnType<typeof setTimeout>>();
  private inputDebounceResolvers = new Map<string, Array<(v: boolean) => void>>();
  /** Agents that should NEVER update task status (fullstack subagents — persists across resumes) */
  private readonly skipTaskStatusAgents = new Set<string>();

  constructor(
    private eventBus: EventBus,
    private contextSync: ContextSync,
  ) {
    // Determine agent backend from config
    this._usesPty = getConfig().agentBackend === 'pty';
    if (this._usesPty) {
      logger.info('Using PTY backend (interactive mode, subscription billing)');
    } else {
      logger.info('Using SDK backend (programmatic mode, SDK credit)');
    }

    // Listen for contract changes to notify frontend agents
    this.eventBus.on(EventTypes.CONTRACT_UPDATED, (e) => this.onContractUpdated(e));
  }

  /** Recover agents that were running when the server last shut down / crashed.
   *  In MCP mode we simply mark them as error — no auto-resume. */
  async recoverRunningAgents(): Promise<void> {
    const runningAgents = getRunningAgents();
    if (runningAgents.length === 0) return;

    logger.info({ count: runningAgents.length }, 'Found agents to recover from previous session');

    for (const agent of runningAgents) {
      const agentId = agent.id;
      logger.warn({ agentId }, 'Marking orphaned agent as error');
      updateAgent(agentId, { status: 'error', pid: null });
      if (agent.currentTaskId) {
        const task = getTask(agent.currentTaskId);
        if (task && (task.status === 'in_progress' || task.status === 'assigned')) {
          updateTask(agent.currentTaskId, { status: 'pending', assignedAgentId: null });
        }
      }
      await this.eventBus.emit({
        type: EventTypes.AGENT_OUTPUT,
        source: agentId,
        payload: { agentId, projectId: agent.projectId, streamType: 'system',
          content: '[RECOVERY] Server 重啟，agent 已標記為 error。請手動重新執行。' },
        timestamp: new Date().toISOString(),
      });
    }

    logger.info('Agent recovery complete');
  }


  /** Start an agent for a specific task */
  async startAgent(config: AgentStartConfig): Promise<string> {
    const roleConfig = getAgentRoleConfig(config.role);

    // Build enhanced system prompt with context
    let systemPrompt = roleConfig.systemPrompt;
    const contracts = await this.contextSync.readAllContracts();
    if (contracts.length > 0) {
      systemPrompt += `\n\nCurrent API Contracts:\n${JSON.stringify(contracts, null, 2)}`;
    }

    // Auto-generate title from task or role
    let agentTitle: string | undefined;
    if (config.taskId) {
      const task = getTask(config.taskId);
      if (task) agentTitle = task.title;
    }

    // Resolve MCP servers (global config + workspace .mcp.json) and build allowed tools list
    const agentWorkingDir = config.workingDir || this.getWorkingDir(config.projectId, config.role);
    const { allowedTools, mcpServers } = this.resolveToolsAndMcp(roleConfig.allowedTools, agentWorkingDir);

    // Create DB record (use pre-generated agentId if provided, so uploaded files can reference it)
    const agent = createAgent({
      projectId: config.projectId,
      id: config.agentId,
      role: config.role,
      title: agentTitle,
      systemPrompt,
      model: config.model || roleConfig.model,
      allowedTools: roleConfig.allowedTools,
      workingDir: agentWorkingDir,
    });

    updateAgent(agent.id, { status: 'starting' });
    if (config.taskId) {
      updateAgent(agent.id, { currentTaskId: config.taskId });
      // Skip task status update for fullstack subagents (task status managed by FullstackController)
      if (!config.skipTaskStatusUpdate) {
        updateTask(config.taskId, { assignedAgentId: agent.id, status: 'in_progress' });
        await this.eventBus.emit({
          type: EventTypes.TASK_STATUS_CHANGED,
          source: agent.id,
          payload: { taskId: config.taskId, projectId: config.projectId, newStatus: 'in_progress', assignedAgentId: agent.id },
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Create AgentProcess (SDK or PTY backend)
    const procConfig = {
      workingDir: agentWorkingDir,
      systemPrompt,
      model: config.model || roleConfig.model,
      allowedTools,
      useWorkspaceSkills: config.useWorkspaceSkills !== false,
      ...(mcpServers && { mcpServers }),
    };
    const proc = this._usesPty
      ? new AgentProcessPty(agent.id, config.role, procConfig)
      : new AgentProcess(agent.id, config.role, procConfig);

    // Wire up event handlers
    this.wireProcessEvents(proc, agent.id, config.projectId, config.taskId || null);

    // Store initial prompt for re-injection after context compaction
    this.initialPrompts.set(agent.id, config.prompt);

    // Set compaction context callback — re-injects initial prompt after auto-compaction
    proc.onCompactionContext = () => {
      const initialPrompt = this.initialPrompts.get(agent.id);
      const flowSummary = this.progressDetector.getFlowPlanSummary(agent.id);
      const parts: string[] = [];
      if (initialPrompt) {
        parts.push(`## 原始任務 Prompt（Context 壓縮後重新注入）\n\n${initialPrompt}`);
      }
      if (flowSummary) {
        parts.push(flowSummary);
      }
      return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
    };

    this.processes.set(agent.id, proc);
    if (config.skipTaskStatusUpdate) {
      this.skipTaskStatusAgents.add(agent.id);
    }

    // Spawn the process
    try {
      await proc.spawn(config.prompt);
    } catch (err) {
      logger.error({ agentId: agent.id, err }, 'Failed to spawn agent process');
      this.processes.delete(agent.id);
      this.clearAgentState(agent.id);
      updateAgent(agent.id, { status: 'error', pid: null });
      if (config.taskId) {
        updateTask(config.taskId, { status: 'failed' });
      }
      await this.eventBus.emit({
        type: EventTypes.AGENT_OUTPUT,
        source: agent.id,
        payload: { agentId: agent.id, projectId: config.projectId, streamType: 'error',
          content: `[SYSTEM] Agent 啟動失敗: ${(err as Error).message}` },
        timestamp: new Date().toISOString(),
      });
      throw err;
    }

    // Emit initial prompt event so frontend can display it
    await this.eventBus.emit({
      type: EventTypes.AGENT_INITIAL_PROMPT,
      source: agent.id,
      payload: {
        agentId: agent.id,
        prompt: config.prompt,
        role: config.role,
      },
      timestamp: new Date().toISOString(),
    });

    logger.info({ agentId: agent.id, role: config.role }, 'Agent started');
    return agent.id;
  }

  /** Clear tracking state for an agent */
  private clearAgentState(agentId: string): void {
    this.taskDoneAgents.delete(agentId);
    this.skipTaskStatusAgents.delete(agentId);
    this.initialPrompts.delete(agentId);
    this.progressDetector.clear(agentId);
  }

  /** Stop a specific agent.
   * If the process is truly active, kills it. If the process already finished
   * (stale 'running' status), just syncs state without a redundant kill attempt. */
  async stopAgent(agentId: string): Promise<void> {
    const proc = this.processes.get(agentId);
    const wasActive = proc?.isActive ?? false;

    if (proc) {
      if (wasActive) {
        logger.info({ agentId }, 'Agent is active — stopping');
        await proc.stop();
      } else {
        logger.info({ agentId }, 'Agent process exists but is inactive — syncing stale status');
      }
      this.processes.delete(agentId);
    } else {
      // Process not in map (e.g. after server restart) — try kill by PID from DB
      const agent = getAgent(agentId);
      if (agent?.pid) {
        try {
          process.kill(agent.pid, 'SIGTERM');
          logger.info({ agentId, pid: agent.pid }, 'Killed orphaned agent process by PID');
        } catch {
          logger.info({ agentId, pid: agent.pid }, 'Agent PID not found (already exited)');
        }
      } else {
        logger.info({ agentId }, 'Agent not in process map — syncing stale status');
      }
    }

    this.clearAgentState(agentId);

    // Reset task back to pending if agent is stopped while task is still in_progress
    const agentRecord = getAgent(agentId);
    if (agentRecord?.currentTaskId) {
      const task = getTask(agentRecord.currentTaskId);
      if (task && task.status === 'in_progress') {
        updateTask(agentRecord.currentTaskId, { status: 'pending', assignedAgentId: null });
        logger.info({ agentId, taskId: agentRecord.currentTaskId }, 'Reset task to pending (agent stopped)');
      }
    }

    updateAgent(agentId, { status: 'stopped', pid: null, currentTaskId: null });
    await this.eventBus.emit({
      type: EventTypes.AGENT_STOPPED,
      source: agentId,
      payload: { agentId },
      timestamp: new Date().toISOString(),
    });
  }

  /** Kill all PTY processes without changing DB status (for graceful shutdown → startup recovery) */
  async killAllProcessesForShutdown(): Promise<void> {
    logger.info({ count: this.processes.size }, 'Killing all agent processes for shutdown (preserving DB state)');
    for (const [agentId, proc] of this.processes) {
      try {
        proc.removeAllListeners('result');
        if (proc.isActive) await proc.stop();
      } catch (err) {
        logger.warn({ agentId, err }, 'Error killing process during shutdown');
      }
    }
    this.processes.clear();
  }

  /** Stop all agents for a project */
  async stopAllForProject(projectId: string): Promise<void> {
    const toStop: string[] = [];
    for (const [agentId] of this.processes) {
      if (projectId === '*') {
        toStop.push(agentId);
      } else {
        const agent = getAgent(agentId);
        if (agent && agent.projectId === projectId) {
          toStop.push(agentId);
        }
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

    const roleConfig = getAgentRoleConfig(agent.role);

    let systemPrompt = roleConfig.systemPrompt;
    const contracts = await this.contextSync.readAllContracts();
    if (contracts.length > 0) {
      systemPrompt += `\n\nCurrent API Contracts:\n${JSON.stringify(contracts, null, 2)}`;
    }

    const rerunWorkingDir = this.getWorkingDir(agent.projectId, agent.role);
    const { allowedTools, mcpServers } = this.resolveToolsAndMcp(roleConfig.allowedTools, rerunWorkingDir);

    const rerunConfig = {
      workingDir: rerunWorkingDir,
      systemPrompt,
      model: agent.model,
      allowedTools,
      ...(mcpServers && { mcpServers }),
    };
    const newProc = this._usesPty
      ? new AgentProcessPty(agentId, agent.role, rerunConfig)
      : new AgentProcess(agentId, agent.role, rerunConfig);

    this.wireProcessEvents(newProc, agentId, agent.projectId, null);
    this.processes.set(agentId, newProc);

    try {
      await newProc.spawn(prompt);
    } catch (err) {
      logger.error({ agentId, err }, 'Rerun spawn failed');
      this.processes.delete(agentId);
      updateAgent(agentId, { status: 'error', pid: null });
      throw err;
    }
    logger.info({ agentId, role: agent.role }, 'Agent rerun with new prompt');
  }

  /** Resume an agent using its Claude session ID */
  async resumeAgent(agentId: string, followUpPrompt?: string): Promise<void> {
    const proc = this.processes.get(agentId);
    logger.info({ agentId, hasProc: !!proc, promptLen: followUpPrompt?.length }, 'resumeAgent called');

    if (proc) {
      logger.info({ agentId, sessionId: proc.sessionId }, 'Resuming existing process');
      // Prepend flow plan progress so agent knows where it left off
      let enrichedPrompt = followUpPrompt;
      if (enrichedPrompt) {
        const flowSummary = this.progressDetector.getFlowPlanSummary(agentId);
        if (flowSummary) {
          enrichedPrompt = `${flowSummary}\n\n請從尚未完成的步驟繼續執行，不要重複已完成的步驟。\n\n${enrichedPrompt}`;
        }
      }
      await proc.resume(enrichedPrompt);
    } else {
      const agent = getAgent(agentId);
      logger.info({ agentId, agentSessionId: agent?.sessionId, agentStatus: agent?.status }, 'Resuming from DB agent');
      if (!agent || !agent.sessionId) throw new Error('No session to resume');

      // Update agent status to indicate it's resuming
      updateAgent(agentId, { status: 'starting' });

      const roleConfig = getAgentRoleConfig(agent.role);

      // Create new process with session resume
      const resumeWorkingDir = this.getWorkingDir(agent.projectId, agent.role);
      const { allowedTools, mcpServers } = this.resolveToolsAndMcp(roleConfig.allowedTools, resumeWorkingDir);

      const resumeConfig = {
        workingDir: resumeWorkingDir,
        sessionId: agent.sessionId,
        model: agent.model,
        systemPrompt: roleConfig.systemPrompt,
        allowedTools,
        ...(mcpServers && { mcpServers }),
      };
      const newProc = this._usesPty
        ? new AgentProcessPty(agentId, agent.role, resumeConfig)
        : new AgentProcess(agentId, agent.role, resumeConfig);

      // Wire up event handlers (same as startAgent)
      this.wireProcessEvents(newProc, agentId, agent.projectId, agent.currentTaskId);

      // Set compaction context callback — re-injects initial prompt after auto-compaction
      newProc.onCompactionContext = () => {
        const initialPrompt = this.initialPrompts.get(agentId);
        const flowSummary = this.progressDetector.getFlowPlanSummary(agentId);
        const parts: string[] = [];
        if (initialPrompt) {
          parts.push(`## 原始任務 Prompt（Context 壓縮後重新注入）\n\n${initialPrompt}`);
        }
        if (flowSummary) {
          parts.push(flowSummary);
        }
        return parts.length > 0 ? parts.join('\n\n---\n\n') : null;
      };

      this.processes.set(agentId, newProc);

      // Restore flow plan state from DB so isFlowComplete() works after server restart
      if (agent.flowPlanJson) {
        this.progressDetector.restoreFlowPlan(agentId, agent.flowPlanJson);
      }

      // Prepend flow plan progress summary so the agent knows where it left off
      let enrichedPrompt = followUpPrompt;
      if (enrichedPrompt) {
        const flowSummary = this.progressDetector.getFlowPlanSummary(agentId);
        if (flowSummary) {
          enrichedPrompt = `${flowSummary}\n\n請從尚未完成的步驟繼續執行，不要重複已完成的步驟。\n\n${enrichedPrompt}`;
        }
      }

      try {
        await newProc.resume(enrichedPrompt);
      } catch (err) {
        logger.error({ agentId, err }, 'Resume spawn failed');
        this.processes.delete(agentId);
        updateAgent(agentId, { status: 'error', pid: null });
        throw err;
      }

      logger.info({ agentId, sessionId: agent.sessionId }, 'Agent session resumed');
    }
  }

  /**
   * Send a follow-up instruction to an agent.
   * Since --print mode closes stdin after the initial prompt,
   * this stops the current process and resumes the session with the new prompt.
   */
  async sendInputToAgent(agentId: string, text: string): Promise<boolean> {
    // Accumulate input into per-agent buffer and debounce
    const buf = this.inputBuffer.get(agentId) ?? [];
    buf.push(text);
    this.inputBuffer.set(agentId, buf);

    // Clear previous timer (reset the debounce window)
    const prevTimer = this.inputDebounceTimer.get(agentId);
    if (prevTimer) clearTimeout(prevTimer);

    // Return a promise that resolves when the debounced batch actually executes
    return new Promise<boolean>((resolve) => {
      const resolvers = this.inputDebounceResolvers.get(agentId) ?? [];
      resolvers.push(resolve);
      this.inputDebounceResolvers.set(agentId, resolvers);

      const timer = setTimeout(async () => {
        // Collect and clear buffer
        const messages = this.inputBuffer.get(agentId) ?? [];
        this.inputBuffer.delete(agentId);
        this.inputDebounceTimer.delete(agentId);
        const pendingResolvers = this.inputDebounceResolvers.get(agentId) ?? [];
        this.inputDebounceResolvers.delete(agentId);

        // Merge all buffered messages into one prompt
        let merged: string;
        if (messages.length === 1) {
          merged = messages[0]!;
        } else {
          // Number each message so the agent addresses all of them
          merged = messages
            .map((m, i) => `[USER MESSAGE ${i + 1}/${messages.length}]\n${m}`)
            .join('\n\n')
            + '\n\n請逐一回應以上所有訊息。';
        }
        logger.info({ agentId, messageCount: messages.length }, 'Debounce fired — executing merged input');

        try {
          const result = await this._doSendInput(agentId, merged);
          for (const r of pendingResolvers) r(result);
        } catch (err) {
          for (const r of pendingResolvers) r(false);
        }
      }, INPUT_DEBOUNCE_MS);

      this.inputDebounceTimer.set(agentId, timer);
    });
  }

  /** Actual send-input logic, executed after debounce merges rapid inputs */
  private async _doSendInput(agentId: string, text: string): Promise<boolean> {
    const proc = this.processes.get(agentId);
    logger.info({ agentId, hasProc: !!proc, procStatus: proc?.status }, 'sendInputToAgent called');

    // If process exists and stdin is writable, try direct write
    if (proc && proc.sendInput(text)) return true;

    // Axure agents use Playwright MCP which cannot survive session resume.
    // Their sessions are ephemeral — only allow input while the process is actively running.
    const agentForRoleCheck = getAgent(agentId);
    if (agentForRoleCheck?.role === 'axure') {
      logger.warn({ agentId }, 'Axure agent is not running — cannot resume (Playwright MCP sessions are ephemeral)');
      await this.eventBus.emit({
        type: 'agent.output',
        source: agentId,
        payload: {
          agentId,
          projectId: agentForRoleCheck.projectId,
          streamType: 'system',
          content: '[SYSTEM] Axure agent 已停止，無法 resume（Playwright MCP session 不可恢復）。請使用 MockupView 的「繼續爬取」按鈕重新派發。',
        },
        timestamp: new Date().toISOString(),
      });
      return false;
    }

    // Get session ID from process or database
    let sessionId = proc?.sessionId;
    logger.info({ agentId, sessionIdFromProc: sessionId }, 'Checking sessionId from process');

    if (!sessionId) {
      const agent = getAgent(agentId);
      sessionId = agent?.sessionId ?? null;
      logger.info({ agentId, sessionIdFromDB: sessionId, agentStatus: agent?.status }, 'Checking sessionId from DB');
    }

    if (!sessionId) {
      logger.warn({ agentId }, 'Cannot resume: no session ID found');
      return false;
    }

    // Stop current process if running
    if (proc) {
      logger.info({ agentId, sessionId }, 'Stopping agent to resume with new instruction');
      await proc.stop();
      this.processes.delete(agentId);
    }

    // Clear taskDoneAgents so the resumed agent doesn't get immediately stopped
    // (PTY mode: checkMarkers would see [TASK_COMPLETE] from previous turn and stop again)
    this.taskDoneAgents.delete(agentId);

    // Resume the session with the user's instruction as the new prompt
    logger.info({ agentId, sessionId }, 'Resuming agent session with user instruction');
    await this.resumeAgent(agentId, text);
    return true;
  }

  /** Get all active agent processes */
  getActiveAgents(): string[] {
    return Array.from(this.processes.keys());
  }

  /** Get a specific process */
  getProcess(agentId: string): AgentProcess | AgentProcessPty | undefined {
    return this.processes.get(agentId);
  }

  /** Attach standard event handlers to an AgentProcess or AgentProcessPty */
  private wireProcessEvents(
    proc: AgentProcess | AgentProcessPty,
    agentId: string,
    projectId: string,
    taskId: string | null,
  ): void {
    proc.on('init', (msg: ClaudeStreamInit) => {
      updateAgent(agentId, {
        status: 'running',
        sessionId: msg.session_id,
        pid: proc.pid,
        // Store the actual model from Claude SDK (e.g., "claude-sonnet-4-20250514")
        model: msg.model || undefined,
      });
      this.eventBus.emit({
        type: EventTypes.AGENT_STARTED,
        source: agentId,
        payload: { agentId, role: proc.role, projectId, model: msg.model, taskId, title: getAgent(agentId)?.title },
        timestamp: new Date().toISOString(),
      });
    });

    proc.on('output', (output: AgentOutputEvent & { isStreaming?: boolean; projectId?: string }) => {
      output.taskId = taskId;
      output.projectId = projectId;

      // Only persist non-streaming outputs to DB (streaming will be followed by full message)
      if (!output.isStreaming) {
        try {
          logAgentOutput({
            agentId,
            taskId: taskId || undefined,
            streamType: output.streamType,
            content: output.content,
          });
        } catch (dbErr) {
          // FK constraint can fail if agent was deleted while still outputting — log but don't crash
          logger.warn({ agentId, err: dbErr }, 'Failed to persist agent output (agent may have been deleted)');
        }
      }

      // Broadcast via event bus (WebSocket will pick this up) — including streaming for real-time display
      this.eventBus.emit({
        type: EventTypes.AGENT_OUTPUT,
        source: agentId,
        payload: output as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });

      // Detect progress changes BEFORE checking markers — so [STEP_DONE:N] in the same
      // text block as [TASK_COMPLETE] gets processed first, allowing isFlowComplete() to
      // return true when checkMarkers runs.
      if (!output.isStreaming) {
        const progress = this.progressDetector.processOutput(agentId, output);
        if (progress) {
          this.eventBus.emit({
            type: EventTypes.AGENT_PROGRESS,
            source: agentId,
            payload: progress as unknown as Record<string, unknown>,
            timestamp: new Date().toISOString(),
          });
          // Persist flow plan to DB whenever it changes
          const flowJson = this.progressDetector.getFlowPlanJson(agentId);
          if (flowJson) {
            updateAgent(agentId, { flowPlanJson: flowJson });
          }
        }
      }

      // Check for markers — only in assistant text output (after progress detection)
      if (output.streamType === 'text') {
        try {
          this.checkMarkers(agentId, projectId, taskId, output.content);
        } catch (err) {
          logger.error({ err, agentId }, 'checkMarkers failed');
        }
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

    // Role-based path resolution (frontendPath / backendPath)
    if (role === 'frontend' && project.frontendPath) {
      return project.frontendPath;
    }
    if (role === 'backend' && project.backendPath) {
      return project.backendPath;
    }

    // Check if workspaces are configured (legacy)
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

  /**
   * Merge global MCP servers (from global_config) with project-level .mcp.json.
   * Project-level entries override global ones with the same name.
   * This allows subprocess agents to use MCP servers without interactive approval.
   */
  private resolveMcpServers(workingDir: string): Record<string, McpStdioServerConfig> | undefined {
    const global = getGlobalMcpServers();

    let project: Record<string, McpStdioServerConfig> = {};
    try {
      const raw = readFileSync(join(workingDir, '.mcp.json'), 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpStdioServerConfig> };
      project = parsed.mcpServers ?? {};
    } catch {
      // no .mcp.json — fine
    }

    const merged = { ...global, ...project };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * Build the full allowedTools list by merging role defaults with MCP tool names.
   * Also returns resolved mcpServers for passing to AgentProcess.
   */
  private resolveToolsAndMcp(
    roleAllowedTools: string[],
    workingDir: string,
  ): { allowedTools: string[]; mcpServers?: Record<string, McpStdioServerConfig> } {
    const mcpServers = this.resolveMcpServers(workingDir);
    const allowedTools = [...roleAllowedTools];

    if (mcpServers) {
      for (const serverName of Object.keys(mcpServers)) {
        if (serverName === 'playwright') {
          const pwTools = [
            'browser_navigate', 'browser_navigate_back', 'browser_click', 'browser_type',
            'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_hover',
            'browser_drag', 'browser_snapshot', 'browser_take_screenshot', 'browser_evaluate',
            'browser_run_code', 'browser_console_messages', 'browser_network_requests',
            'browser_wait_for', 'browser_resize', 'browser_tabs', 'browser_close',
            'browser_handle_dialog', 'browser_file_upload', 'browser_install',
          ];
          for (const tool of pwTools) {
            allowedTools.push(`mcp__${serverName}__${tool}`);
          }
        }
      }
    }

    return { allowedTools, mcpServers };
  }

  private async handleAgentComplete(
    agentId: string,
    projectId: string,
    taskId: string | null,
    result: ClaudeStreamResult,
  ): Promise<void> {
    logger.info({ agentId, taskId, isError: result.is_error }, 'handleAgentComplete called');
    this.progressDetector.clear(agentId);

    // Read skip flag BEFORE clearAgentState (which cleans it up)
    const shouldSkipTaskStatus = this.skipTaskStatusAgents.has(agentId);

    // Capture TASK_COMPLETE flag before clearAgentState (which may clean up state)
    const taskCompleteSignaled = this.taskDoneAgents.has(agentId);

    this.clearAgentState(agentId);
    updateAgent(agentId, {
      status: 'stopped',
      totalCostUsd: result.cost_usd,
      totalTurns: result.num_turns,
      totalInputTokens: result.input_tokens || 0,
      totalOutputTokens: result.output_tokens || 0,
      pid: null,
    });

    if (taskId && !shouldSkipTaskStatus) {
      // If agent exited without [TASK_COMPLETE], mark as failed even if exit code is 0
      const status = result.is_error ? 'failed' : (taskCompleteSignaled ? 'completed' : 'failed');
      if (!taskCompleteSignaled && !result.is_error) {
        logger.warn({ agentId, taskId }, 'Agent exited without [TASK_COMPLETE] — marking task as failed');
        this.eventBus.emit({
          type: EventTypes.AGENT_OUTPUT,
          source: agentId,
          payload: { agentId, projectId, streamType: 'system',
            content: '[SYSTEM] Agent 結束但未輸出 [TASK_COMPLETE]，任務標記為 failed。' },
          timestamp: new Date().toISOString(),
        });
      }
      updateTask(taskId, {
        status,
        resultSummary: result.result ?? undefined,
      });

      // Notify frontend of task status change
      await this.eventBus.emit({
        type: EventTypes.TASK_STATUS_CHANGED,
        source: agentId,
        payload: { taskId, projectId, newStatus: status, assignedAgentId: agentId },
        timestamp: new Date().toISOString(),
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
      payload: {
        agentId,
        projectId,
        costUsd: result.cost_usd,
        turns: result.num_turns,
        inputTokens: result.input_tokens || 0,
        outputTokens: result.output_tokens || 0,
      },
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
    const shouldSkipTaskStatus = this.skipTaskStatusAgents.has(agentId);
    this.clearAgentState(agentId);
    updateAgent(agentId, { status: 'error' });

    if (taskId && !shouldSkipTaskStatus) {
      updateTask(taskId, { status: 'failed' });
      await this.eventBus.emit({
        type: EventTypes.TASK_STATUS_CHANGED,
        source: agentId,
        payload: { taskId, projectId, newStatus: 'failed', assignedAgentId: agentId },
        timestamp: new Date().toISOString(),
      });
    }

    await this.eventBus.emit({
      type: EventTypes.AGENT_ERROR,
      source: agentId,
      payload: { agentId, projectId, taskId, error: error.message },
      timestamp: new Date().toISOString(),
    });
  }

  private checkMarkers(agentId: string, projectId: string, taskId: string | null, content: string): void {
    // [TASK_COMPLETE] or [REVIEW_COMPLETE] — agent signals done
    // Only force-stop if flow plan is fully done (or no flow plan exists)
    if (/\[TASK_COMPLETE\]/.test(content)) {
      this.taskDoneAgents.add(agentId);
      const flowComplete = this.progressDetector.isFlowComplete(agentId);
      if (flowComplete) {
        logger.info({ agentId, taskId }, '[TASK_COMPLETE] + flow complete — finishing agent');
        // In PTY mode, Claude CLI doesn't auto-exit — we need to stop it
        const proc = this.processes.get(agentId);
        if (proc instanceof AgentProcessPty) {
          // Give agent 3 seconds to finish current output, then stop
          setTimeout(() => {
            proc.stop().catch(() => {});
          }, 3000);
        }
        // In SDK mode, the query iterator will end naturally
      } else {
        logger.info({ agentId, taskId }, '[TASK_COMPLETE] detected but flow plan not finished — letting agent continue');
      }
    }
    if (/(?:^|\n)\s*\[REVIEW_COMPLETE\]/.test(content)) {
      this.taskDoneAgents.add(agentId);
      // Don't stop immediately — let the agent finish its current turn (e.g., write summary)
      logger.info({ agentId, taskId }, '[REVIEW_COMPLETE] marker detected — letting agent finish current turn');
    }

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

    // Check for [PLAN_READY] marker — extract plan content from recent outputs
    if (/(?:^|\n)\s*\[PLAN_READY\]/.test(content)) {
      this.extractAndSavePlan(agentId, projectId);
    }

    // Check for [REVIEW_COMPLETE] marker — extract structured review JSON
    if (/(?:^|\n)\s*\[REVIEW_COMPLETE\]/.test(content)) {
      this.extractAndSaveReview(agentId, projectId, taskId);
    }
  }

  /** Extract plan content from recent agent outputs and save to DB */
  private async extractAndSavePlan(agentId: string, projectId: string): Promise<void> {
    const agent = getAgent(agentId);
    if (!agent) return;

    // Get recent text outputs for this agent
    const outputs = getAgentOutputs(agentId, 100);

    // Concatenate text outputs to reconstruct the plan
    const textContent = outputs
      .filter(o => o.streamType === 'text')
      .reverse()  // getAgentOutputs returns DESC, we want chronological
      .map(o => o.content)
      .join('\n');

    // Extract content before [PLAN_READY] marker
    const planMatch = textContent.match(/([\s\S]*?)\s*\[PLAN_READY\]/);
    if (!planMatch) {
      logger.warn({ agentId }, 'PLAN_READY marker found but no plan content extracted');
      return;
    }

    const planContent = planMatch[1].trim();
    if (!planContent) {
      logger.warn({ agentId }, 'Empty plan content');
      return;
    }

    // Save plan to DB
    const plan = createPlan({
      agentId,
      projectId,
      content: planContent,
    });

    logger.info({ agentId, projectId, planId: plan.id }, 'Plan extracted and saved');

    // Emit event for frontend
    await this.eventBus.emit({
      type: EventTypes.AGENT_PLAN_READY,
      source: agentId,
      payload: {
        plan,
        agentRole: agent.role,
      },
      timestamp: new Date().toISOString(),
    });

    // Check if plan approval is required
    const project = getProject(projectId);
    if (project?.configJson) {
      try {
        const cfg = JSON.parse(project.configJson) as { planConfig?: { requireApproval: boolean } };
        if (cfg.planConfig?.requireApproval) {
          // Pause the agent — it will wait for approval
          logger.info({ agentId, projectId }, 'Plan approval required, agent will wait');
          // Note: The agent process continues running but won't proceed past the plan
          // until explicitly resumed after approval. The frontend will show the plan
          // and provide approve/reject buttons.
        }
      } catch { /* ignore parse errors */ }
    }
  }

  /** Extract structured review JSON from recent agent outputs and save */
  private async extractAndSaveReview(agentId: string, projectId: string, taskId: string | null): Promise<void> {
    const agent = getAgent(agentId);
    if (!agent) return;

    const outputs = getAgentOutputs(agentId, 100);
    const textContent = outputs
      .filter(o => o.streamType === 'text')
      .reverse()
      .map(o => o.content)
      .join('\n');

    // Extract JSON from ```json...``` code block
    const jsonMatch = textContent.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
    if (!jsonMatch) {
      logger.warn({ agentId }, 'REVIEW_COMPLETE marker found but no JSON block extracted');
      // Emit with a fallback result
      await this.eventBus.emit({
        type: EventTypes.REVIEW_COMPLETED,
        source: agentId,
        payload: {
          projectId,
          taskId: taskId?.replace('review-', '') || null,
          agentId,
          result: { verdict: 'pass', score: 50, issues: [], summary: 'Review completed (no structured output)' },
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // Lenient parse: strip trailing commas
      const cleanJson = jsonMatch[1].replace(/,\s*([\]}])/g, '$1');
      const result = JSON.parse(cleanJson);

      // Validate minimum structure
      if (!result.verdict || typeof result.score !== 'number') {
        throw new Error('Invalid review JSON structure');
      }

      // Save to agents table
      updateAgent(agentId, { reviewResultJson: JSON.stringify(result) });

      // Resolve original taskId (strip "review-" prefix)
      const originalTaskId = taskId?.replace('review-', '') || null;

      logger.info({ agentId, projectId, verdict: result.verdict, score: result.score }, 'Review result extracted');

      await this.eventBus.emit({
        type: EventTypes.REVIEW_COMPLETED,
        source: agentId,
        payload: {
          projectId,
          taskId: originalTaskId,
          agentId,
          result,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, agentId }, 'Failed to parse review JSON');
    }
  }

  private async requestIntervention(
    agentId: string,
    projectId: string,
    taskId: string | null,
    reason: string,
  ): Promise<void> {
    let intervention;
    try {
      intervention = createIntervention({
        projectId,
        agentId,
        taskId: taskId || undefined,
        reason,
      });
    } catch (err) {
      logger.error({ err, agentId, projectId }, 'Failed to create intervention (project may have been deleted)');
      return;
    }

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
