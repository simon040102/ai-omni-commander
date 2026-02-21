import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import type { AgentRole, AgentSpawnConfig, ClaudeStreamMessage } from '@omni/shared';
import { StreamParser } from './StreamParser.js';
import { createChildLogger } from '../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';

export type AgentProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

const logger = createChildLogger('AgentProcess');

export class AgentProcess extends EventEmitter {
  private process: ChildProcess | null = null;
  private parser: StreamParser;
  private _status: AgentProcessStatus = 'idle';
  private _sessionId: string | null = null;
  private _pid: number | null = null;

  constructor(
    public readonly agentId: string,
    public readonly role: AgentRole,
    private config: AgentSpawnConfig,
  ) {
    super();
    this.parser = new StreamParser();
    this.parser.on('message', (msg: ClaudeStreamMessage) => this.handleMessage(msg));
  }

  get status(): AgentProcessStatus { return this._status; }
  get sessionId(): string | null { return this._sessionId; }
  get pid(): number | null { return this._pid; }

  /** Spawn a new Claude CLI process */
  async spawn(prompt: string): Promise<void> {
    if (this.process && !this.process.killed) {
      throw new Error(`Agent ${this.agentId} already has a running process`);
    }

    this.setStatus('starting');
    // Strip null bytes from prompt to avoid spawn errors
    const safePrompt = prompt.replace(/\0/g, '');
    const args = this.buildArgs(); // prompt no longer in args
    const claudeCmd = this.resolveClaudeCommand();

    logger.info({ agentId: this.agentId, role: this.role, cmd: claudeCmd, promptLen: safePrompt.length }, 'Spawning agent');

    // Clean env to avoid nested Claude Code detection
    // Claude Code checks multiple env vars to prevent nesting
    const env = { ...process.env };
    delete env['CLAUDECODE'];
    delete env['CLAUDE_CODE_ENTRYPOINT'];
    delete env['CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING'];
    // Also remove any other CLAUDE_ prefixed vars that might trigger nesting detection
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_')) delete env[key];
    }

    this.process = spawn(claudeCmd, args, {
      cwd: this.config.workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._pid = this.process.pid ?? null;

    // Write prompt via stdin as plain text to avoid ARG_MAX limits on large prompts
    // Note: --input-format stream-json is NOT compatible with --print mode in Claude CLI 2.1.50
    if (!this.config.sessionId && this.process.stdin) {
      this.process.stdin.write(safePrompt);
      this.process.stdin.end();
    }

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.parser.feed(chunk.toString());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.warn({ agentId: this.agentId }, `stderr: ${text}`);
        this.emit('output', {
          agentId: this.agentId,
          streamType: 'error',
          content: text,
          timestamp: new Date().toISOString(),
        });
      }
    });

    this.process.on('exit', (code, signal) => {
      logger.info({ agentId: this.agentId, code, signal }, 'Process exited');
      this.parser.flush();
      if (this._status !== 'stopping') {
        this.setStatus(code === 0 ? 'stopped' : 'error');
      } else {
        this.setStatus('stopped');
      }
      this.process = null;
      this._pid = null;
    });

    this.process.on('error', (err) => {
      logger.error({ agentId: this.agentId, err }, 'Process error');
      this.setStatus('error');
      this.emit('error', err);
    });
  }

  /**
   * Send a follow-up message to a running agent.
   * Since --print mode uses plain text stdin (closed after initial prompt),
   * this returns false — use resume() to continue a conversation instead.
   */
  sendInput(text: string): boolean {
    if (!this.process?.stdin?.writable) {
      logger.warn({ agentId: this.agentId }, 'Cannot send input: stdin closed (use resume instead)');
      return false;
    }
    this.process.stdin.write(text);
    this.process.stdin.end();
    return true;
  }

  /** Gracefully stop the agent process */
  async stop(): Promise<void> {
    if (!this.process || this.process.killed) return;

    this.setStatus('stopping');
    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /** Resume with the same session ID */
  async resume(newPrompt?: string): Promise<void> {
    if (!this._sessionId) {
      throw new Error('No session ID to resume');
    }
    this.config.sessionId = this._sessionId;
    await this.spawn(newPrompt || 'Continue where you left off.');
  }

  private resolveClaudeCommand(): string {
    const { claudePath } = this.config;
    if (claudePath === 'npx') {
      return 'npx';
    }
    return claudePath;
  }

  private buildArgs(): string[] {
    const { claudePath } = this.config;
    const args: string[] = [];

    // If using npx, prepend the package name
    if (claudePath === 'npx') {
      args.push('@anthropic-ai/claude-code');
    }

    args.push('--print');
    args.push('--output-format', 'stream-json');
    args.push('--verbose');

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Use bypass permissions for autonomous operation
    args.push('--permission-mode', 'bypassPermissions');
    args.push('--dangerously-skip-permissions');

    if (this.config.systemPrompt) {
      args.push('--system-prompt', this.config.systemPrompt);
    }

    // Detect and load project-level CLAUDE.md / settings
    this.injectProjectSettings(args);

    if (this.config.allowedTools && this.config.allowedTools.length > 0) {
      args.push('--allowedTools', ...this.config.allowedTools);
    }

    if (this.config.sessionId) {
      args.push('--resume', this.config.sessionId);
    } else {
      const sid = randomUUID();
      this._sessionId = sid;
      args.push('--session-id', sid);
    }

    if (this.config.maxBudgetUsd && this.config.maxBudgetUsd > 0) {
      args.push('--max-budget-usd', String(this.config.maxBudgetUsd));
    }

    // Prompt is sent via stdin (not as an arg) to avoid ARG_MAX limits

    return args;
  }

  /**
   * If the target project has CLAUDE.md or .claude/ settings,
   * inject them so the agent follows project-level instructions.
   */
  private injectProjectSettings(args: string[]): void {
    const { workingDir } = this.config;

    // Check for .claude/settings.json
    const settingsPath = path.join(workingDir, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      args.push('--settings', settingsPath);
    }
  }

  private handleMessage(msg: ClaudeStreamMessage): void {
    // Detect init message to capture session ID
    if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
      this._sessionId = msg.session_id;
      this.setStatus('running');
      this.emit('init', msg);
    }

    // Detect result message (completion)
    if (msg.type === 'result') {
      this.emit('result', msg);
    }

    // Forward all messages
    if (msg.type === 'assistant') {
      const assistantMsg = msg as import('@omni/shared').ClaudeStreamAssistantMessage;
      for (const block of assistantMsg.message.content) {
        if (block.type === 'text') {
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'text',
            content: block.text,
            timestamp: new Date().toISOString(),
          });
        } else if (block.type === 'tool_use') {
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'tool_use',
            content: `[${block.name}] ${JSON.stringify(block.input).slice(0, 200)}`,
            toolName: block.name,
            toolInput: block.input,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } else if (msg.type === 'user') {
      const userMsg = msg as import('@omni/shared').ClaudeStreamUserMessage;
      for (const block of userMsg.message.content) {
        if (block.type === 'tool_result') {
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'tool_result',
            content: typeof block.content === 'string'
              ? block.content.slice(0, 500)
              : JSON.stringify(block.content).slice(0, 500),
            timestamp: new Date().toISOString(),
          });
        }
      }
    } else if (msg.type === 'raw') {
      this.emit('output', {
        agentId: this.agentId,
        streamType: 'system',
        content: (msg as import('@omni/shared').ClaudeStreamRaw).content,
        timestamp: new Date().toISOString(),
      });
    }

    // Emit the raw message for advanced consumers
    this.emit('stream', msg);
  }

  private setStatus(status: AgentProcessStatus): void {
    const previous = this._status;
    this._status = status;
    this.emit('statusChange', { previous, current: status });
  }
}
