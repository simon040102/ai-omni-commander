import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentRole, AgentStartConfig, AgentOutputEvent,
  ClaudeStreamResult, ClaudeStreamInit, BusEvent,
  Workspace, McpStdioServerConfig,
} from '@omni/shared';
import { EventTypes } from '@omni/shared';
import { AgentProcess } from './AgentProcess.js';
import { getAgentRoleConfig } from './AgentRoles.js';
import { ProgressDetector } from './ProgressDetector.js';
import { createAgent, updateAgent, getAgent, getAgentsByRole, getAgentsByProject, getRunningAgents } from '../db/queries/agents.js';
import { getProject, updateProject } from '../db/queries/projects.js';
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
const INACTIVITY_NUDGE_MS = 3 * 60 * 1000; // 3 minutes of no output → nudge
const INACTIVITY_CHECK_INTERVAL_MS = 30 * 1000; // check every 30s
const MAX_NUDGES = 5; // nudge up to 5 times, then force-fail
const NUDGE_MESSAGE = '請繼續執行任務。如果你在等待什麼或遇到問題，請說明後繼續。';

/** When agent exits mid-task, auto-resume this many times before accepting completion */
const MAX_AUTO_RESUMES = 3;
const AUTO_RESUME_MESSAGE = '請繼續執行任務。注意：任務完成標準包含 build 零錯誤、smoke test（若有勾選）通過、E2E spec 撰寫並執行（若有勾選），全部完成後才能加上 [TASK_COMPLETE]。';

export class AgentManager {
  private processes = new Map<string, AgentProcess>();
  private progressDetector = new ProgressDetector();
  /** Agents currently in self-review phase (will complete after review finishes) */
  private reviewingAgents = new Set<string>();
  /** Last output timestamp per agent (ms) */
  private lastOutputAt = new Map<string, number>();
  /** How many times each agent has been nudged */
  private nudgeCount = new Map<string, number>();
  /** How many times each agent has been auto-resumed after exiting mid-task */
  private autoResumeCount = new Map<string, number>();
  /** Agents that have explicitly signaled task completion via [TASK_COMPLETE] */
  private taskDoneAgents = new Set<string>();
  private watchdogInterval: ReturnType<typeof setInterval>;

  constructor(
    private eventBus: EventBus,
    private contextSync: ContextSync,
  ) {
    // Listen for contract changes to notify frontend agents
    this.eventBus.on(EventTypes.CONTRACT_UPDATED, (e) => this.onContractUpdated(e));
    // Start inactivity watchdog
    this.watchdogInterval = setInterval(() => this.runWatchdog(), INACTIVITY_CHECK_INTERVAL_MS);
  }

  private async runWatchdog(): Promise<void> {
    // --- Zombie check: DB says running but no process exists → auto-resume ---
    const runningInDb = getRunningAgents();
    for (const agent of runningInDb) {
      if (this.processes.has(agent.id)) continue;
      logger.warn({ agentId: agent.id, status: agent.status }, 'Zombie agent detected — auto-resuming');
      try {
        await this.eventBus.emit({
          type: EventTypes.AGENT_OUTPUT,
          source: agent.id,
          payload: {
            agentId: agent.id,
            projectId: agent.projectId,
            streamType: 'system',
            content: '[WATCHDOG] Agent process 已消失，自動嘗試繼續執行...',
          },
          timestamp: new Date().toISOString(),
        });
        await this.resumeAgent(agent.id, AUTO_RESUME_MESSAGE);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, 'Zombie auto-resume failed — marking stopped');
        updateAgent(agent.id, { status: 'stopped', pid: null });
        if (agent.currentTaskId) updateTask(agent.currentTaskId, { status: 'failed' });
        await this.eventBus.emit({
          type: EventTypes.AGENT_OUTPUT,
          source: agent.id,
          payload: {
            agentId: agent.id,
            projectId: agent.projectId,
            streamType: 'system',
            content: '[WATCHDOG] 自動重啟失敗，已標記停止。請手動重新執行任務。',
          },
          timestamp: new Date().toISOString(),
        });
        await this.eventBus.emit({
          type: 'agent.statusChange',
          source: agent.id,
          payload: { agentId: agent.id, previousStatus: agent.status, newStatus: 'stopped' },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (this.processes.size === 0) return;
    const now = Date.now();
    for (const [agentId] of this.processes) {
      const lastOut = this.lastOutputAt.get(agentId);
      if (!lastOut) continue;
      const idleMs = now - lastOut;
      if (idleMs < INACTIVITY_NUDGE_MS) continue;

      const nudges = this.nudgeCount.get(agentId) ?? 0;

      // Exceeded max nudges → force-stop and mark failed
      if (nudges >= MAX_NUDGES) {
        logger.error({ agentId, nudges }, 'Agent exceeded max nudges — force-stopping as failed');
        try {
          const agent = getAgent(agentId);
          await this.eventBus.emit({
            type: EventTypes.AGENT_OUTPUT,
            source: agentId,
            payload: {
              agentId,
              projectId: agent?.projectId,
              streamType: 'system',
              content: `[WATCHDOG] Agent 連續無回應超過 ${MAX_NUDGES} 次，已強制停止並標記為 failed。請手動重新執行。`,
            },
            timestamp: new Date().toISOString(),
          });
          await this.stopAgent(agentId);
          if (agent?.currentTaskId) updateTask(agent.currentTaskId, { status: 'failed' });
          updateAgent(agentId, { status: 'error' });
        } catch (err) {
          logger.error({ err, agentId }, 'Watchdog force-stop failed');
        }
        continue;
      }

      logger.warn({ agentId, idleMs: Math.round(idleMs / 1000), nudge: nudges + 1 }, 'Agent inactive, sending nudge');
      this.nudgeCount.set(agentId, nudges + 1);
      // Reset timer so we don't nudge again immediately
      this.lastOutputAt.set(agentId, now);

      try {
        await this.sendInputToAgent(agentId, NUDGE_MESSAGE);
        // Emit system message so terminal shows the nudge
        const agent = getAgent(agentId);
        await this.eventBus.emit({
          type: EventTypes.AGENT_OUTPUT,
          source: agentId,
          payload: {
            agentId,
            projectId: agent?.projectId,
            streamType: 'system',
            content: `[WATCHDOG] Agent 無回應 ${Math.round(idleMs / 60000)} 分鐘 — 自動戳一下 (${nudges + 1}/${MAX_NUDGES})`,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        logger.error({ err, agentId }, 'Watchdog nudge failed');
      }
    }
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

    // Create DB record (use pre-generated agentId if provided, so uploaded files can reference it)
    const agent = createAgent({
      projectId: config.projectId,
      id: config.agentId,
      role: config.role,
      title: agentTitle,
      systemPrompt,
      model: config.model || roleConfig.model,
      allowedTools: roleConfig.allowedTools,
    });

    updateAgent(agent.id, { status: 'starting' });
    if (config.taskId) {
      updateAgent(agent.id, { currentTaskId: config.taskId });
      updateTask(config.taskId, { assignedAgentId: agent.id, status: 'in_progress' });

      // Notify frontend of task status change
      await this.eventBus.emit({
        type: EventTypes.TASK_STATUS_CHANGED,
        source: agent.id,
        payload: { taskId: config.taskId, projectId: config.projectId, newStatus: 'in_progress', assignedAgentId: agent.id },
        timestamp: new Date().toISOString(),
      });
    }

    // Inject playwright MCP server if workingDir contains a .mcp.json with playwright
    // This bypasses the interactive approval requirement for .mcp.json in subprocess mode
    const agentWorkingDir = config.workingDir || this.getWorkingDir(config.projectId, config.role);
    const mcpServers = this.resolveMcpServers(agentWorkingDir);

    // Create AgentProcess
    const proc = new AgentProcess(agent.id, config.role, {
      workingDir: agentWorkingDir,
      systemPrompt,
      model: config.model || roleConfig.model,
      allowedTools: roleConfig.allowedTools,
      useWorkspaceSkills: config.useWorkspaceSkills !== false, // default to true
      ...(mcpServers && { mcpServers }),
    });

    // Wire up event handlers
    this.wireProcessEvents(proc, agent.id, config.projectId, config.taskId || null);

    this.processes.set(agent.id, proc);
    this.lastOutputAt.set(agent.id, Date.now());
    this.nudgeCount.set(agent.id, 0);
    this.autoResumeCount.set(agent.id, 0);

    // Spawn the process
    await proc.spawn(config.prompt);

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

  /** Clear watchdog tracking for an agent */
  private clearWatchdog(agentId: string): void {
    this.lastOutputAt.delete(agentId);
    this.nudgeCount.delete(agentId);
    this.autoResumeCount.delete(agentId);
    this.taskDoneAgents.delete(agentId);
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

    this.clearWatchdog(agentId);
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
    });

    this.wireProcessEvents(newProc, agentId, agent.projectId, null);
    this.processes.set(agentId, newProc);
    this.lastOutputAt.set(agentId, Date.now());
    this.nudgeCount.set(agentId, 0);

    await newProc.spawn(prompt);
    logger.info({ agentId, role: agent.role }, 'Agent rerun with new prompt');
  }

  /** Resume an agent using its Claude session ID */
  async resumeAgent(agentId: string, followUpPrompt?: string): Promise<void> {
    const proc = this.processes.get(agentId);
    logger.info({ agentId, hasProc: !!proc, promptLen: followUpPrompt?.length }, 'resumeAgent called');

    if (proc) {
      logger.info({ agentId, sessionId: proc.sessionId }, 'Resuming existing process');
      await proc.resume(followUpPrompt);
    } else {
      const agent = getAgent(agentId);
      logger.info({ agentId, agentSessionId: agent?.sessionId, agentStatus: agent?.status }, 'Resuming from DB agent');
      if (!agent || !agent.sessionId) throw new Error('No session to resume');

      // Update agent status to indicate it's resuming
      updateAgent(agentId, { status: 'starting' });

      const roleConfig = getAgentRoleConfig(agent.role);

      // Create new process with session resume
      const newProc = new AgentProcess(agentId, agent.role, {
        workingDir: this.getWorkingDir(agent.projectId, agent.role),
        sessionId: agent.sessionId,
        model: agent.model,
        systemPrompt: roleConfig.systemPrompt,
        allowedTools: roleConfig.allowedTools,
      });

      // Wire up event handlers (same as startAgent)
      this.wireProcessEvents(newProc, agentId, agent.projectId, agent.currentTaskId);

      this.processes.set(agentId, newProc);
      await newProc.resume(followUpPrompt);

      logger.info({ agentId, sessionId: agent.sessionId }, 'Agent session resumed');
    }
  }

  /**
   * Send a follow-up instruction to an agent.
   * Since --print mode closes stdin after the initial prompt,
   * this stops the current process and resumes the session with the new prompt.
   */
  async sendInputToAgent(agentId: string, text: string): Promise<boolean> {
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
      // Update last-active timestamp for watchdog
      this.lastOutputAt.set(agentId, Date.now());

      // Only persist non-streaming outputs to DB (streaming will be followed by full message)
      if (!output.isStreaming) {
        logAgentOutput({
          agentId,
          taskId: taskId || undefined,
          streamType: output.streamType,
          content: output.content,
        });
      }

      // Broadcast via event bus (WebSocket will pick this up) — including streaming for real-time display
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

      // Detect progress changes (non-streaming only to avoid noise)
      if (!output.isStreaming) {
        const progress = this.progressDetector.processOutput(agentId, output);
        if (progress) {
          this.eventBus.emit({
            type: EventTypes.AGENT_PROGRESS,
            source: agentId,
            payload: progress as unknown as Record<string, unknown>,
            timestamp: new Date().toISOString(),
          });
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
   * Read .mcp.json from workingDir and return its mcpServers map.
   * This allows subprocess agents to use MCP servers without interactive approval.
   */
  private resolveMcpServers(workingDir: string): Record<string, McpStdioServerConfig> | undefined {
    try {
      const raw = readFileSync(join(workingDir, '.mcp.json'), 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpStdioServerConfig> };
      return parsed.mcpServers && Object.keys(parsed.mcpServers).length > 0
        ? parsed.mcpServers
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async handleAgentComplete(
    agentId: string,
    projectId: string,
    taskId: string | null,
    result: ClaudeStreamResult,
  ): Promise<void> {
    this.progressDetector.clear(agentId);

    // --- Auto-resume: if task-based and not errored, resume a few times before accepting completion ---
    if (taskId && !result.is_error && !this.reviewingAgents.has(agentId) && !this.taskDoneAgents.has(agentId)) {
      const resumes = this.autoResumeCount.get(agentId) ?? 0;
      if (resumes < MAX_AUTO_RESUMES) {
        this.autoResumeCount.set(agentId, resumes + 1);
        logger.info({ agentId, taskId, resume: resumes + 1, maxResumes: MAX_AUTO_RESUMES },
          'Agent exited mid-task — auto-resuming');
        try {
          await this.eventBus.emit({
            type: EventTypes.AGENT_OUTPUT,
            source: agentId,
            payload: {
              agentId,
              projectId,
              streamType: 'system',
              content: `[AUTO-RESUME ${resumes + 1}/${MAX_AUTO_RESUMES}] Agent 自行停止，自動繼續執行...`,
            },
            timestamp: new Date().toISOString(),
          });
          await new Promise(resolve => setTimeout(resolve, 1000));
          this.processes.delete(agentId);
          await this.resumeAgent(agentId, AUTO_RESUME_MESSAGE);
        } catch (err) {
          logger.error({ err, agentId }, 'Auto-resume failed, proceeding to completion');
          this.autoResumeCount.delete(agentId);
          // fall through to normal completion
        }
        return;
      }
      // All auto-resumes exhausted — proceed to self-review / completion
      this.autoResumeCount.delete(agentId);
    }

    // --- Self-review: intercept first completion to trigger review ---
    const agent = getAgent(agentId);
    const shouldSelfReview = taskId
      && !result.is_error
      && !this.reviewingAgents.has(agentId)
      && agent
      && (agent.role === 'frontend' || agent.role === 'backend')
      && this.isReviewEnabled(projectId);

    if (shouldSelfReview) {
      logger.info({ agentId, taskId }, 'Task completed — starting self-review phase');
      this.reviewingAgents.add(agentId);

      try {
        // Update agent status to 'reviewing' so frontend can show it
        updateAgent(agentId, {
          status: 'reviewing' as import('@omni/shared').AgentStatus,
          totalCostUsd: result.cost_usd,
          totalTurns: result.num_turns,
          totalInputTokens: result.input_tokens || 0,
          totalOutputTokens: result.output_tokens || 0,
          pid: null,
        });

        // Notify frontend of reviewing status
        await this.eventBus.emit({
          type: 'agent.statusChange',
          source: agentId,
          payload: { agentId, previousStatus: 'running', newStatus: 'reviewing' },
          timestamp: new Date().toISOString(),
        });

        // Resume the same session with a self-review prompt
        const task = getTask(taskId!);
        const reviewPrompt = `你剛才完成了任務「${task?.title || ''}」的開發工作。

現在請 Review 你剛才所做的所有程式碼修改：
1. 程式碼正確性 — 有沒有 bug、typo、邏輯錯誤
2. 安全性 — SQL injection、XSS 等常見漏洞
3. Edge cases — 例外處理、空值檢查
4. 程式碼風格 — 命名、一致性

請使用 git diff 或 Read 工具回顧你的修改，然後輸出以下 JSON：

\`\`\`json
{
  "verdict": "pass" 或 "fail",
  "score": 0-100,
  "issues": [
    { "severity": "critical" | "warning" | "info", "file": "路徑", "line": 行號, "message": "問題描述" }
  ],
  "summary": "總體評估"
}
\`\`\`

完成後請輸出 [REVIEW_COMPLETE]。`;

        // Delay to let the process and session file fully flush to disk
        await new Promise(resolve => setTimeout(resolve, 1500));
        this.processes.delete(agentId);
        await this.resumeAgent(agentId, reviewPrompt);
        return; // Don't complete yet — wait for review to finish
      } catch (err) {
        logger.error({ err, agentId }, 'Failed to start self-review, completing normally');
        this.reviewingAgents.delete(agentId);
        // Fall through to normal completion
      }
    }

    // --- Normal completion (or post-review completion) ---
    const wasReviewing = this.reviewingAgents.delete(agentId);
    if (wasReviewing) {
      logger.info({ agentId, taskId }, 'Self-review completed');
    }

    this.clearWatchdog(agentId);
    updateAgent(agentId, {
      status: 'stopped',
      totalCostUsd: result.cost_usd,
      totalTurns: result.num_turns,
      totalInputTokens: result.input_tokens || 0,
      totalOutputTokens: result.output_tokens || 0,
      pid: null,
    });

    if (taskId) {
      const status = result.is_error ? 'failed' : 'completed';
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

  /** Check if self-review is enabled for a project (default: true) */
  private isReviewEnabled(projectId: string): boolean {
    const project = getProject(projectId);
    if (!project?.configJson) return true; // enabled by default
    try {
      const cfg = JSON.parse(project.configJson);
      if (cfg.reviewConfig && cfg.reviewConfig.enabled === false) return false;
    } catch { /* ignore */ }
    return true;
  }

  private checkProjectCompletion(projectId: string): void {
    const project = getProject(projectId);
    if (!project || project.status !== 'executing') return;

    const allAgents = getAgentsByProject(projectId);
    const allDone = allAgents.every(a =>
      a.status === 'stopped' || a.status === 'error' || a.status === 'idle'
    ) && allAgents.every(a => !this.reviewingAgents.has(a.id));

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
    // If this error happened during self-review, don't fail the task —
    // the original work was already completed successfully before the review started.
    const wasReviewing = this.reviewingAgents.delete(agentId);
    if (wasReviewing) {
      logger.warn({ agentId, taskId }, 'Self-review failed — task preserved as completed');
      updateAgent(agentId, { status: 'stopped' });
      this.processes.delete(agentId);
      this.checkProjectCompletion(projectId);
      return;
    }

    this.clearWatchdog(agentId);
    updateAgent(agentId, { status: 'error' });

    if (taskId) {
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
    // [TASK_COMPLETE] or [REVIEW_COMPLETE] — agent signals done; skip auto-resume
    if (/(?:^|\n)\s*\[TASK_COMPLETE\]/.test(content)) {
      this.taskDoneAgents.add(agentId);
      logger.info({ agentId, taskId }, '[TASK_COMPLETE] marker detected — auto-resume disabled');
    }
    if (/(?:^|\n)\s*\[REVIEW_COMPLETE\]/.test(content)) {
      this.taskDoneAgents.add(agentId);
      logger.info({ agentId, taskId }, '[REVIEW_COMPLETE] marker detected — auto-resume disabled');
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
