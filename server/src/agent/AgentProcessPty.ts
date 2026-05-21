import { EventEmitter } from 'node:events';
import type { AgentRole, AgentSpawnConfig, ClaudeStreamResult } from '@omni/shared';
import type { JsonlMessage, JsonlAssistantMessage, JsonlUserMessage } from '@omni/shared';
import { PtyController } from './PtyController.js';
import { JsonlWatcher } from './JsonlWatcher.js';
import { SessionResolver } from './SessionResolver.js';
import { SystemPromptInjector } from './SystemPromptInjector.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('AgentProcessPty');

export type AgentProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

/**
 * AgentProcessPty — Replacement for SDK-based AgentProcess.
 * Uses node-pty to spawn Claude CLI in interactive mode (walks subscription billing).
 * Reads structured output from ~/.claude/ JSONL session files.
 *
 * Implements the same EventEmitter interface as AgentProcess:
 *   Events: 'init', 'output', 'result', 'statusChange', 'error'
 */
export class AgentProcessPty extends EventEmitter {
  readonly agentId: string;
  readonly role: AgentRole;
  private config: AgentSpawnConfig;

  private _status: AgentProcessStatus = 'idle';
  private _sessionId: string | null = null;
  private _outputSuppressed = false;

  private ptyController: PtyController | null = null;
  private jsonlWatcher: JsonlWatcher | null = null;
  private processedUuids = new Set<string>();

  // Usage tracking (accumulated from JSONL assistant messages)
  private accumulatedInputTokens = 0;
  private accumulatedOutputTokens = 0;
  private turnCount = 0;
  private startTime = 0;

  /** Callback for re-injecting context after compaction */
  onCompactionContext: (() => string | null) | null = null;

  constructor(agentId: string, role: AgentRole, config: AgentSpawnConfig) {
    super();
    this.agentId = agentId;
    this.role = role;
    this.config = config;
  }

  get status(): AgentProcessStatus { return this._status; }
  get sessionId(): string | null { return this._sessionId; }
  get pid(): number | null { return this.ptyController?.pid ?? null; }
  get isActive(): boolean { return this._status === 'running' || this._status === 'starting'; }

  /** Estimate context usage from accumulated token counts */
  async getContextUsage(): Promise<{ totalTokens: number; maxTokens: number; percentage: number } | null> {
    const totalTokens = this.accumulatedInputTokens + this.accumulatedOutputTokens;
    const maxTokens = this.config.model?.includes('[1m]') ? 1_000_000 : 200_000;
    return {
      totalTokens,
      maxTokens,
      percentage: totalTokens > 0 ? (totalTokens / maxTokens) * 100 : 0,
    };
  }

  /** Spawn Claude CLI in interactive mode via PTY */
  async spawn(prompt: string): Promise<void> {
    this.setStatus('starting');
    this.startTime = Date.now();
    this.accumulatedInputTokens = 0;
    this.accumulatedOutputTokens = 0;
    this.turnCount = 0;
    // On resume (sessionId set), keep processedUuids to avoid re-processing old messages
    const isResume = !!this.config.sessionId;
    if (!isResume) {
      this.processedUuids.clear();
    }
    this._outputSuppressed = false;

    // Resolve model
    const resolvedModel = this.config.model === 'opus' ? 'claude-opus-4-6[1m]' : (this.config.model || 'sonnet');

    // Build CLI args — use --allowedTools instead of --dangerously-skip-permissions
    // to avoid the bypass permissions confirmation prompt
    const toolsList = (this.config.allowedTools || ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent', 'Skill']).join(',');
    const args: string[] = [
      '--model', resolvedModel,
      '--allowedTools', toolsList,
    ];

    // Resume existing session
    if (this.config.sessionId) {
      args.push('--resume', this.config.sessionId);
      this._sessionId = this.config.sessionId;
    }

    // Clean environment:
    // - Remove CLAUDECODE to avoid nested detection
    // - Remove VSCODE_* vars to prevent Claude Code VSCode Extension from
    //   opening a new VSCode window for each spawned agent PTY process
    const cleanEnv = { ...process.env } as Record<string, string>;
    delete cleanEnv['CLAUDECODE'];
    for (const key of Object.keys(cleanEnv)) {
      if (key.startsWith('VSCODE_') || key === 'TERM_PROGRAM') {
        delete cleanEnv[key];
      }
    }

    // Snapshot existing sessions to detect the new one
    const knownSessions = this._sessionId
      ? new Set<string>() // resuming: we already know the session ID
      : SessionResolver.snapshotSessions(this.config.workingDir);

    // On resume: capture JSONL file size BEFORE spawning CLI,
    // because --resume immediately writes file-history-snapshot on start.
    // By capturing size before spawn, the watcher will see all new content
    // including the resume's user message and assistant response.
    let resumeOffset: number | undefined;
    if (isResume && this._sessionId) {
      const jsonlPath = SessionResolver.getJsonlPath(this.config.workingDir, this._sessionId);
      resumeOffset = JsonlWatcher.getFileSize(jsonlPath);
      logger.info({ agentId: this.agentId, resumeOffset, jsonlPath }, 'Captured JSONL offset before resume spawn');
    }

    // Spawn PTY
    this.ptyController = new PtyController();

    this.ptyController.on('exit', (e: { exitCode: number; signal?: number }) => {
      if (this._status === 'stopping' || this._status === 'stopped') return;
      logger.info({ agentId: this.agentId, exitCode: e.exitCode }, 'PTY process exited');
      this.handleProcessExit(e.exitCode, e.signal);
    });

    await this.ptyController.spawn('claude', args, {
      cwd: this.config.workingDir,
      env: cleanEnv,
    });

    // Wait for CLI to be ready (detect prompt character instead of fixed delay)
    await this.waitForPromptReady(15000);

    // On resume: only send user prompt (system prompt already in session history).
    // On first spawn: wrap with system prompt + task title.
    const finalPrompt = isResume
      ? prompt
      : SystemPromptInjector.wrapPrompt({
          taskTitle: undefined, // Will be set by caller via prompt content
          systemPrompt: this.config.systemPrompt,
          userPrompt: prompt,
        });

    // Type prompt character by character + Enter
    // Ink (Claude CLI's terminal UI) requires individual keystrokes, not bulk paste
    logger.info({ agentId: this.agentId, isResume, promptLen: finalPrompt.length }, 'Typing prompt');
    await this.ptyController.typeAndSubmit(finalPrompt);

    // Detect session ID
    if (!this._sessionId) {
      try {
        const session = await SessionResolver.waitForNewSession(
          this.config.workingDir,
          knownSessions,
          15000,
        );
        this._sessionId = session.sessionId;
        logger.info({ agentId: this.agentId, sessionId: this._sessionId }, 'Session detected');
      } catch (err) {
        logger.error({ err, agentId: this.agentId }, 'Failed to detect session');
        this.setStatus('error');
        this.emit('error', err);
        return;
      }
    }

    // Start JSONL watcher
    const jsonlPath = SessionResolver.getJsonlPath(this.config.workingDir, this._sessionId);
    this.jsonlWatcher = new JsonlWatcher(jsonlPath, resumeOffset);

    this.jsonlWatcher.on('message', (msg: JsonlMessage) => {
      this.handleJsonlMessage(msg);
    });

    this.jsonlWatcher.on('error', (err: Error) => {
      logger.warn({ err, agentId: this.agentId }, 'JSONL watcher error');
    });

    this.jsonlWatcher.start();

    // Emit init event
    this.setStatus('running');
    this.emit('init', {
      type: 'system',
      subtype: 'init',
      session_id: this._sessionId,
      tools: [],
      model: resolvedModel,
    });
  }

  /** Send follow-up input to the running agent */
  sendInput(text: string): boolean {
    if (!this.ptyController?.isAlive || this._status !== 'running') {
      return false;
    }
    // Use typeAndSubmit (character by character) for Ink compatibility
    this.ptyController.typeAndSubmit(text).catch(() => {});
    return true;
  }

  /** Suppress output emission (called before stop to prevent leaks) */
  suppressOutput(): void {
    this._outputSuppressed = true;
  }

  /** Stop the agent process */
  async stop(): Promise<void> {
    this._outputSuppressed = true;
    this.setStatus('stopping');

    // Flush any remaining JSONL content before stopping (for accurate token counts)
    this.jsonlWatcher?.flush();
    this.jsonlWatcher?.stop();

    // Remove exit listener to prevent double emit of 'result'
    this.ptyController?.removeAllListeners('exit');

    // Graceful stop the PTY (Ctrl+C → wait → kill)
    if (this.ptyController?.isAlive) {
      // Try sending /exit command first (Claude CLI exit command)
      this.ptyController.write('/exit\n');
      await new Promise(r => setTimeout(r, 1000));

      if (this.ptyController.isAlive) {
        await this.ptyController.gracefulStop(3000);
      }
    }

    this.setStatus('stopped');

    // Emit result event so AgentManager handles completion (DB update, task status)
    this.emit('result', {
      type: 'result',
      subtype: 'success',
      session_id: this._sessionId || '',
      result: undefined,
      cost_usd: this.estimateCost(),
      num_turns: this.turnCount,
      duration_ms: Date.now() - this.startTime,
      is_error: false,
      input_tokens: this.accumulatedInputTokens,
      output_tokens: this.accumulatedOutputTokens,
    } as ClaudeStreamResult);
  }

  /** Resume an existing session with a new prompt */
  async resume(newPrompt?: string): Promise<void> {
    // Create new PTY with --resume flag
    const oldSessionId = this._sessionId;

    // Reset state
    this.ptyController = null;
    this.jsonlWatcher?.stop();
    this.jsonlWatcher = null;
    this._outputSuppressed = false;

    // Spawn with resume
    if (oldSessionId) {
      this.config = { ...this.config, sessionId: oldSessionId };
    }

    await this.spawn(newPrompt || '請繼續執行任務。');
  }

  /** Wait for Claude CLI to show its input prompt (❯ or >) before typing */
  private waitForPromptReady(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.ptyController) { resolve(); return; }

      let buffer = '';
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      const handler = (data: string) => {
        buffer += data;
        // Keep only last 4KB to prevent unbounded growth during CLI init
        if (buffer.length > 4096) buffer = buffer.slice(-4096);
        // Claude CLI shows "❯" (Unicode) or ">" when ready for input
        // Also detect "?" which appears in prompt-selection mode
        const clean = buffer.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
        if (clean.includes('❯') || clean.includes('\n> ') || clean.match(/\n[?] /)) {
          logger.info({ bufLen: buffer.length }, 'CLI prompt detected, ready for input');
          this.ptyController?.removeListener('data', handler);
          // Extra delay to ensure Ink TextInput is fully ready to receive keystrokes
          setTimeout(done, 1000);
        }
      };

      this.ptyController.on('data', handler);

      // Fallback: if no prompt detected within timeout, proceed anyway
      setTimeout(() => {
        this.ptyController?.removeListener('data', handler);
        if (!resolved) {
          logger.warn({ bufLen: buffer.length }, 'CLI prompt not detected within timeout, proceeding');
        }
        done();
      }, timeoutMs);
    });
  }

  // ── Internal handlers ──

  private handleJsonlMessage(msg: JsonlMessage): void {
    if (this._outputSuppressed) return;

    // Skip already processed messages (dedup by uuid)
    if (msg.uuid && this.processedUuids.has(msg.uuid)) return;
    if (msg.uuid) this.processedUuids.add(msg.uuid);

    switch (msg.type) {
      case 'assistant':
        this.handleAssistantMessage(msg as JsonlAssistantMessage);
        break;
      case 'user':
        this.handleUserMessage(msg as JsonlUserMessage);
        break;
      case 'queue-operation':
        // Session lifecycle indicator — ignore
        break;
      case 'ai-title':
        // Session title — could emit as system info
        break;
      default:
        // file-history-snapshot, progress, etc. — ignore
        break;
    }
  }

  private handleAssistantMessage(msg: JsonlAssistantMessage): void {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) return;

    // Track usage
    const usage = msg.message?.usage;
    if (usage) {
      this.accumulatedInputTokens += usage.input_tokens || 0;
      this.accumulatedOutputTokens += usage.output_tokens || 0;
    }
    this.turnCount++;

    // Process each content block
    for (const block of content) {
      switch (block.type) {
        case 'text':
          this.emitOutput('text', block.text);
          break;
        case 'thinking':
          this.emitOutput('system', `[thinking] ${block.thinking}`);
          break;
        case 'tool_use':
          this.emitOutput('tool_use', JSON.stringify({
            tool: block.name,
            input: block.input,
          }), block.name, block.input as Record<string, unknown>);
          break;
      }
    }
  }

  private handleUserMessage(msg: JsonlUserMessage): void {
    const content = msg.message?.content;
    if (!content || !Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_result') {
        const resultContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        this.emitOutput('tool_result', resultContent);
      }
    }
  }

  private handleProcessExit(exitCode: number, signal?: number): void {
    // Build result event
    const result: ClaudeStreamResult = {
      type: 'result',
      subtype: exitCode === 0 ? 'success' : 'error',
      session_id: this._sessionId || '',
      result: undefined,
      cost_usd: this.estimateCost(),
      num_turns: this.turnCount,
      duration_ms: Date.now() - this.startTime,
      is_error: exitCode !== 0,
      input_tokens: this.accumulatedInputTokens,
      output_tokens: this.accumulatedOutputTokens,
    };

    this.jsonlWatcher?.stop();
    this.setStatus('stopped');
    this.emit('result', result);
  }

  private emitOutput(
    streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system',
    content: string,
    toolName?: string,
    toolInput?: Record<string, unknown>,
  ): void {
    if (this._outputSuppressed) return;
    this.emit('output', {
      agentId: this.agentId,
      streamType,
      content,
      timestamp: new Date().toISOString(),
      toolName,
      toolInput,
    });
  }

  private setStatus(status: AgentProcessStatus): void {
    const prev = this._status;
    this._status = status;
    if (prev !== status) {
      this.emit('statusChange', { previous: prev, current: status });
    }
  }

  private estimateCost(): number {
    const model = (this.config.model || 'sonnet').toLowerCase();
    const pricing = { input: 3, output: 15 }; // default: sonnet
    if (model.includes('opus')) { pricing.input = 5; pricing.output = 25; }
    else if (model.includes('haiku')) { pricing.input = 1; pricing.output = 5; }
    return (this.accumulatedInputTokens * pricing.input + this.accumulatedOutputTokens * pricing.output) / 1_000_000;
  }
}
