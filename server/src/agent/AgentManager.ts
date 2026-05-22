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
import { JsonlWatcher } from './JsonlWatcher.js';
import { SessionResolver } from './SessionResolver.js';
import type { JsonlAssistantMessage, JsonlUserMessage } from '@omni/shared';
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
const INACTIVITY_NUDGE_MS = 3 * 60 * 1000; // 3 minutes of no output → nudge
const INACTIVITY_CHECK_INTERVAL_MS = 30 * 1000; // check every 30s
const MAX_NUDGES = 5; // nudge up to 5 times, then force-fail
const NUDGE_MESSAGE = '請繼續執行任務。如果你在等待什麼或遇到問題，請說明後繼續。';

/** When agent exits mid-task, auto-resume this many times before accepting completion */
const MAX_AUTO_RESUMES = 3;
/** Wait this long after last user input before executing stop→resume (merge rapid inputs) */
const INPUT_DEBOUNCE_MS = 1500;
const AUTO_RESUME_MESSAGE = '請繼續執行任務。注意：任務完成標準包含 build 零錯誤、smoke test（若有勾選）通過、E2E spec 撰寫並執行（若有勾選），全部完成後才能加上 [TASK_COMPLETE]。';

export class AgentManager {
  private _usesPty = false;
  private processes = new Map<string, AgentProcess | AgentProcessPty>();
  private progressDetector = new ProgressDetector();
  /** Agents currently in self-review phase (will complete after review finishes) */
  private reviewingAgents = new Set<string>();
  /** Last output timestamp per agent (ms) */
  private lastOutputAt = new Map<string, number>();
  /** Last output stream type per agent (to detect tool_use waiting) */
  private lastOutputStreamType = new Map<string, string>();
  /** How many times each agent has been nudged */
  private nudgeCount = new Map<string, number>();
  /** How many times each agent has been auto-resumed after exiting mid-task */
  private autoResumeCount = new Map<string, number>();
  /** Agents that have explicitly signaled task completion via [TASK_COMPLETE] */
  private taskDoneAgents = new Set<string>();
  /** Store initial prompts per agent for re-injection after context compaction */
  private initialPrompts = new Map<string, string>();
  /** Per-agent debounce: buffer pending inputs and fire once after DEBOUNCE_MS of silence */
  private inputBuffer = new Map<string, string[]>();
  private inputDebounceTimer = new Map<string, ReturnType<typeof setTimeout>>();
  private inputDebounceResolvers = new Map<string, Array<(v: boolean) => void>>();
  private watchdogInterval: ReturnType<typeof setInterval>;
  /** Agents that should NEVER update task status (fullstack subagents — persists across resumes) */
  private readonly skipTaskStatusAgents = new Set<string>();
  /** VSCode sync poller: tracks JSONL file offset per stopped agent */
  private vscodeSyncOffsets = new Map<string, { offset: number; lastActivity: number }>();
  private vscodeSyncInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly VSCODE_SYNC_INTERVAL_MS = 5000;
  private static readonly VSCODE_SYNC_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

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
    // Start inactivity watchdog
    this.watchdogInterval = setInterval(() => this.runWatchdog(), INACTIVITY_CHECK_INTERVAL_MS);
  }

  /** Recover agents that were running when the server last shut down / crashed */
  async recoverRunningAgents(): Promise<void> {
    const runningAgents = getRunningAgents();
    if (runningAgents.length === 0) return;

    logger.info({ count: runningAgents.length }, 'Found agents to recover from previous session');
    const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

    for (const agent of runningAgents) {
      const agentId = agent.id;

      // Check if heartbeat is too stale
      const lastHb = agent.lastHeartbeat ? new Date(agent.lastHeartbeat + 'Z').getTime() : 0;
      const isStale = lastHb > 0 && (Date.now() - lastHb > STALE_THRESHOLD_MS);

      // No sessionId or stale → mark error, reset task
      if (!agent.sessionId || isStale) {
        const reason = !agent.sessionId ? 'no sessionId' : 'stale heartbeat (>1h)';
        logger.warn({ agentId, reason }, 'Cannot recover agent — marking error');
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
            content: `[RECOVERY] Agent 無法恢復 (${reason})，已標記為 error。` },
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Has sessionId and not stale → attempt resume
      try {
        logger.info({ agentId, sessionId: agent.sessionId }, 'Recovering agent — resuming session');
        await this.eventBus.emit({
          type: EventTypes.AGENT_OUTPUT,
          source: agentId,
          payload: { agentId, projectId: agent.projectId, streamType: 'system',
            content: '[RECOVERY] Server 重啟，自動恢復 agent session...' },
          timestamp: new Date().toISOString(),
        });
        await this.resumeAgent(agentId, AUTO_RESUME_MESSAGE);
      } catch (err) {
        logger.error({ agentId, err }, 'Recovery resume failed — marking error');
        updateAgent(agentId, { status: 'error', pid: null });
        if (agent.currentTaskId) {
          const task = getTask(agent.currentTaskId);
          if (task && (task.status === 'in_progress' || task.status === 'assigned')) {
            updateTask(agent.currentTaskId, { status: 'pending', assignedAgentId: null });
          }
        }
      }

      // Stagger to avoid ConPTY contention on Windows
      await new Promise(r => setTimeout(r, 3000));
    }

    logger.info('Agent recovery complete');
  }

  /** Start polling stopped agents' JSONL files for VSCode-continued conversations */
  startVsCodeSyncPoller(): void {
    if (this.vscodeSyncInterval) return;
    this.vscodeSyncInterval = setInterval(() => this.runVsCodeSync(), AgentManager.VSCODE_SYNC_INTERVAL_MS);
    logger.info('VSCode sync poller started (5s interval)');
  }

  private async runVsCodeSync(): Promise<void> {
    const db = (await import('../db/connection.js')).getDb();
    const rows = db.prepare(
      `SELECT a.id, a.session_id, a.working_dir, a.project_id, p.working_dir AS project_working_dir
       FROM agents a JOIN projects p ON a.project_id = p.id
       WHERE a.status IN ('stopped', 'error') AND a.session_id IS NOT NULL`
    ).all() as Array<{ id: string; session_id: string; working_dir: string | null; project_id: string; project_working_dir: string }>;

    const now = Date.now();

    for (const row of rows) {
      const agentId = row.id;
      const tracked = this.vscodeSyncOffsets.get(agentId);

      // Stop tracking if idle for too long
      if (tracked && now - tracked.lastActivity > AgentManager.VSCODE_SYNC_IDLE_TIMEOUT_MS) {
        this.vscodeSyncOffsets.delete(agentId);
        continue;
      }

      const cwd = row.working_dir || row.project_working_dir;
      if (!cwd) continue;
      const jsonlPath = SessionResolver.getJsonlPath(cwd, row.session_id);
      const currentSize = JsonlWatcher.getFileSize(jsonlPath);

      // First time seeing this agent: initialize offset to current size (skip existing history)
      if (!tracked) {
        this.vscodeSyncOffsets.set(agentId, { offset: currentSize, lastActivity: now });
        continue;
      }

      const knownOffset = tracked.offset;
      if (currentSize <= knownOffset) continue;

      // New content detected — read only new bytes from offset
      try {
        const { messages: newMessages, newOffset } = JsonlWatcher.readFrom(jsonlPath, knownOffset);
        this.vscodeSyncOffsets.set(agentId, { offset: newOffset, lastActivity: now });

        for (const msg of newMessages) {
          const ts = msg.timestamp || new Date().toISOString();
          if (msg.type === 'assistant') {
            const asst = msg as JsonlAssistantMessage;
            for (const block of (asst.message?.content || [])) {
              if (block.type === 'text') {
                await this.emitVsCodeOutput(agentId, row.project_id, 'text', block.text, ts);
              } else if (block.type === 'tool_use') {
                await this.emitVsCodeOutput(agentId, row.project_id, 'tool_use',
                  JSON.stringify({ tool: block.name, input: block.input }), ts);
              }
            }
          } else if (msg.type === 'user') {
            const user = msg as JsonlUserMessage;
            for (const block of (user.message?.content || [])) {
              if (block.type === 'tool_result') {
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                await this.emitVsCodeOutput(agentId, row.project_id, 'tool_result', content, ts);
              } else if (block.type === 'text' && block.text?.trim()) {
                await this.emitVsCodeOutput(agentId, row.project_id, 'system', `[USER] ${block.text}`, ts);
              }
            }
          }
        }
      } catch {
        // JSONL read error — skip silently
      }
    }
  }

  private async emitVsCodeOutput(
    agentId: string, projectId: string,
    streamType: string, content: string, timestamp: string,
  ): Promise<void> {
    await this.eventBus.emit({
      type: EventTypes.AGENT_OUTPUT,
      source: agentId,
      payload: { agentId, streamType, content, timestamp } as unknown as Record<string, unknown>,
      timestamp,
    });
  }

  /** Track zombie resume attempts to prevent infinite loops */
  private zombieResumeCount = new Map<string, number>();
  private static readonly MAX_ZOMBIE_RESUMES = 2;

  private async runWatchdog(): Promise<void> {
    // --- Zombie check: DB says running but no process exists → auto-resume ---
    const runningInDb = getRunningAgents();
    for (const agent of runningInDb) {
      if (this.processes.has(agent.id)) continue;

      // Limit zombie resume attempts to prevent infinite loops
      const zombieCount = this.zombieResumeCount.get(agent.id) ?? 0;
      if (zombieCount >= AgentManager.MAX_ZOMBIE_RESUMES) {
        logger.warn({ agentId: agent.id, zombieCount }, 'Max zombie resumes reached — marking stopped');
        this.zombieResumeCount.delete(agent.id);
        updateAgent(agent.id, { status: 'stopped', pid: null });
        continue;
      }
      this.zombieResumeCount.set(agent.id, zombieCount + 1);

      logger.warn({ agentId: agent.id, status: agent.status, attempt: zombieCount + 1 }, 'Zombie agent detected — auto-resuming');
      try {
        await this.eventBus.emit({
          type: EventTypes.AGENT_OUTPUT,
          source: agent.id,
          payload: {
            agentId: agent.id,
            projectId: agent.projectId,
            streamType: 'system',
            content: `[WATCHDOG] Agent process 已消失，自動嘗試繼續執行... (${zombieCount + 1}/${AgentManager.MAX_ZOMBIE_RESUMES})`,
          },
          timestamp: new Date().toISOString(),
        });
        await this.resumeAgent(agent.id, AUTO_RESUME_MESSAGE);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, 'Zombie auto-resume failed — marking stopped');
        this.zombieResumeCount.delete(agent.id);
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

    // Broadcast context usage for all running agents
    for (const [agentId, proc] of this.processes) {
      try {
        const usage = await proc.getContextUsage();
        if (usage) {
          const agent = getAgent(agentId);
          await this.eventBus.emit({
            type: 'agent.contextUsage',
            source: agentId,
            payload: { agentId, projectId: agent?.projectId, ...usage },
            timestamp: new Date().toISOString(),
          });
        }
      } catch { /* ignore */ }
    }

    // Write heartbeat for all active agents (used by startup recovery to detect stale agents)
    const heartbeatTime = new Date().toISOString();
    for (const [agentId] of this.processes) {
      try { updateAgent(agentId, { lastHeartbeat: heartbeatTime }); } catch { /* agent may have been deleted */ }
    }

    const now = Date.now();
    for (const [agentId] of this.processes) {
      const lastOut = this.lastOutputAt.get(agentId);
      if (!lastOut) continue;
      const idleMs = now - lastOut;
      if (idleMs < INACTIVITY_NUDGE_MS) continue;

      // Skip nudge if agent is waiting for a tool result (e.g., TaskOutput blocking on subagent)
      const lastStreamType = this.lastOutputStreamType.get(agentId);
      if (lastStreamType === 'tool_use' || lastStreamType === 'tool_result') {
        // Agent is mid-tool-call, not truly idle — reset timer and skip
        this.lastOutputAt.set(agentId, now);
        continue;
      }

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
    this.lastOutputAt.set(agent.id, Date.now());
    this.nudgeCount.set(agent.id, 0);
    this.autoResumeCount.set(agent.id, 0);
    if (config.skipTaskStatusUpdate) {
      this.skipTaskStatusAgents.add(agent.id);
    }

    // Spawn the process
    try {
      await proc.spawn(config.prompt);
    } catch (err) {
      logger.error({ agentId: agent.id, err }, 'Failed to spawn agent process');
      this.processes.delete(agent.id);
      this.clearWatchdog(agent.id);
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

  /** Clear watchdog tracking for an agent */
  private clearWatchdog(agentId: string): void {
    this.lastOutputAt.delete(agentId);
    this.lastOutputStreamType.delete(agentId);
    this.nudgeCount.delete(agentId);
    this.autoResumeCount.delete(agentId);
    this.taskDoneAgents.delete(agentId);
    this.zombieResumeCount.delete(agentId);
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

    // Mark as manually stopped so handleAgentComplete skips auto-resume
    this.taskDoneAgents.add(agentId);

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
    clearInterval(this.watchdogInterval);
    if (this.vscodeSyncInterval) clearInterval(this.vscodeSyncInterval);
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
    this.lastOutputAt.set(agentId, Date.now());
    this.nudgeCount.set(agentId, 0);

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

    // Exhaust auto-resume count so the agent won't auto-resume after answering user's question.
    // User-initiated resume is a one-shot interaction — agent should stop when done, not loop.
    this.autoResumeCount.set(agentId, MAX_AUTO_RESUMES);

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
      // Update last-active timestamp and stream type for watchdog
      this.lastOutputAt.set(agentId, Date.now());
      this.lastOutputStreamType.set(agentId, output.streamType);

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
    logger.info({ agentId, taskId, isError: result.is_error, taskDone: this.taskDoneAgents.has(agentId) }, 'handleAgentComplete called');
    this.progressDetector.clear(agentId);

    // --- Auto-resume: if task-based and not errored, resume a few times before accepting completion ---
    // Skip auto-resume for coordinator agents (they run once and produce structured output)
    const agentForResume = getAgent(agentId);
    const isOneShot = agentForResume?.role === 'coordinator' || agentForResume?.role === 'integration-test';
    if (taskId && !result.is_error && !this.reviewingAgents.has(agentId) && !this.taskDoneAgents.has(agentId) && !isOneShot) {
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
    // Skip self-review if agent explicitly signaled [TASK_COMPLETE] —
    // the flow plan already includes a self-review step before the marker.
    const shouldSelfReview = taskId
      && !result.is_error
      && !this.reviewingAgents.has(agentId)
      && !this.taskDoneAgents.has(agentId)
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

    // Read skip flag BEFORE clearWatchdog (which cleans it up)
    const shouldSkipTaskStatus = this.skipTaskStatusAgents.has(agentId);

    // Capture TASK_COMPLETE flag before clearWatchdog (which may clean up state)
    const taskCompleteSignaled = this.taskDoneAgents.has(agentId);

    this.clearWatchdog(agentId);
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

    const shouldSkipTaskStatus = this.skipTaskStatusAgents.has(agentId);
    this.clearWatchdog(agentId);
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
