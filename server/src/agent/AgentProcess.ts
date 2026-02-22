import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKAssistantMessage, SDKUserMessage as SDKUserMsg, SDKResultMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRole, AgentSpawnConfig } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

export type AgentProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

const logger = createChildLogger('AgentProcess');

export class AgentProcess extends EventEmitter {
  private _query: Query | null = null;
  private _status: AgentProcessStatus = 'idle';
  private _sessionId: string | null = null;
  private _pid: number | null = null;

  constructor(
    public readonly agentId: string,
    public readonly role: AgentRole,
    private config: AgentSpawnConfig,
  ) {
    super();
  }

  get status(): AgentProcessStatus { return this._status; }
  get sessionId(): string | null { return this._sessionId; }
  get pid(): number | null { return this._pid; }

  /** Start a new Claude agent using the SDK */
  async spawn(prompt: string): Promise<void> {
    if (this._query) {
      throw new Error(`Agent ${this.agentId} already has a running query`);
    }

    this.setStatus('starting');
    const safePrompt = prompt.replace(/\0/g, '');

    // Generate session ID upfront if not resuming
    if (!this.config.sessionId && !this._sessionId) {
      this._sessionId = randomUUID();
    }

    logger.info({ agentId: this.agentId, role: this.role, promptLen: safePrompt.length }, 'Spawning agent via SDK');

    this._query = query({
      prompt: safePrompt,
      options: {
        cwd: this.config.workingDir,
        model: this.config.model,
        systemPrompt: this.config.systemPrompt,
        allowedTools: this.config.allowedTools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        resume: this.config.sessionId || undefined,
        sessionId: (!this.config.sessionId && this._sessionId) ? this._sessionId : undefined,
        // Load project-level CLAUDE.md and .claude/settings.json
        settingSources: ['project'],
      },
    });

    // Run the async generator in background
    this.consumeStream(this._query);
  }

  /** Consume the SDK async generator stream */
  private async consumeStream(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        this.handleSDKMessage(msg);
      }
      // Stream ended normally
      if (this._status !== 'stopping') {
        this.setStatus('stopped');
      } else {
        this.setStatus('stopped');
      }
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError' || this._status === 'stopping') {
        this.setStatus('stopped');
      } else {
        logger.error({ agentId: this.agentId, err }, 'SDK stream error');
        this.setStatus('error');
        this.emit('error', err);
      }
    } finally {
      this._query = null;
      this._pid = null;
    }
  }

  /**
   * Send a follow-up message is not directly supported in single-query mode.
   * Returns false — use resume() to continue a conversation instead.
   */
  sendInput(_text: string): boolean {
    logger.warn({ agentId: this.agentId }, 'Cannot send input: use resume instead');
    return false;
  }

  /** Gracefully stop the agent */
  async stop(): Promise<void> {
    if (!this._query) return;

    this.setStatus('stopping');
    this._query.close();

    // Wait briefly for the stream to finish
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      const check = () => {
        if (!this._query) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
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

  /** Map SDK messages to internal events */
  private handleSDKMessage(msg: SDKMessage): void {
    // Init message
    if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
      const initMsg = msg as SDKSystemMessage;
      this._sessionId = initMsg.session_id;
      this.setStatus('running');
      // Emit init in a format compatible with existing handlers
      this.emit('init', {
        type: 'system',
        subtype: 'init',
        session_id: initMsg.session_id,
        tools: initMsg.tools,
        model: initMsg.model,
      });
    }

    // Result message (completion)
    if (msg.type === 'result') {
      const result = msg as SDKResultMessage;
      this.emit('result', {
        type: 'result',
        subtype: result.subtype,
        session_id: result.session_id,
        result: 'result' in result ? result.result : undefined,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        duration_ms: result.duration_ms,
        is_error: result.is_error,
      });
    }

    // Assistant messages
    if (msg.type === 'assistant') {
      const assistantMsg = msg as SDKAssistantMessage;
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
            toolInput: block.input as Record<string, unknown>,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // User messages (tool results)
    if (msg.type === 'user' && !('isReplay' in msg && msg.isReplay)) {
      const userMsg = msg as SDKUserMsg;
      const content = userMsg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const resultContent = (block as { content?: string | unknown }).content;
            this.emit('output', {
              agentId: this.agentId,
              streamType: 'tool_result',
              content: typeof resultContent === 'string'
                ? resultContent.slice(0, 500)
                : JSON.stringify(resultContent).slice(0, 500),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
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
