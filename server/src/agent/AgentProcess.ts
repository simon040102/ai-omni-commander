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

  // Buffers for accumulating streamed content
  private _streamingTextBuffer = '';
  private _streamingThinkingBuffer = '';
  /** When true, all output emission is suppressed (set immediately on stop) */
  private _outputSuppressed = false;

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
  /** True if the underlying SDK query is still running (not yet finished/aborted) */
  get isActive(): boolean { return this._query !== null; }

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

    // Create env without CLAUDECODE to avoid nested session detection (needed for all platforms)
    const cleanEnv = { ...process.env };
    delete cleanEnv['CLAUDECODE'];

    // Platform-specific permission settings
    const isMac = process.platform === 'darwin';

    // Mac: Use bypassPermissions (requires prior `claude --dangerously-skip-permissions` acceptance)
    // Windows/Linux: Use acceptEdits (auto-accepts file edits, no prior setup needed)
    const permissionMode = isMac ? 'bypassPermissions' : 'acceptEdits';
    const allowDangerouslySkipPermissions = isMac ? true : undefined;

    logger.info({ platform: process.platform, permissionMode }, 'Using platform-specific permission mode');

    this._query = query({
      prompt: safePrompt,
      options: {
        cwd: this.config.workingDir,
        model: this.config.model,
        systemPrompt: this.config.systemPrompt,
        allowedTools: this.config.allowedTools,
        permissionMode,
        ...(allowDangerouslySkipPermissions && { allowDangerouslySkipPermissions }),
        resume: this.config.sessionId || undefined,
        sessionId: (!this.config.sessionId && this._sessionId) ? this._sessionId : undefined,
        // Load project-level CLAUDE.md and .claude/settings.json (if enabled)
        ...(this.config.useWorkspaceSkills !== false && { settingSources: ['project'] }),
        // Enable streaming partial messages for real-time output
        includePartialMessages: true,
        // Avoid nested session detection
        env: cleanEnv,
        // Extra MCP servers (bypasses .mcp.json interactive approval requirement)
        ...(this.config.mcpServers && { mcpServers: this.config.mcpServers }),
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

  /** Suppress all future output emission (called externally for immediate silencing) */
  suppressOutput(): void {
    this._outputSuppressed = true;
  }

  /** Gracefully stop the agent */
  async stop(): Promise<void> {
    if (!this._query) return;

    // Immediately suppress output so no new events leak while close() propagates
    this._outputSuppressed = true;
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
    // Check both _sessionId (from previous run) and config.sessionId (from AgentManager when recreating process)
    const sessionId = this._sessionId || this.config.sessionId;
    if (!sessionId) {
      throw new Error('No session ID to resume');
    }
    // Ensure both are set for spawn() to use
    this._sessionId = sessionId;
    this.config.sessionId = sessionId;
    await this.spawn(newPrompt || 'Continue where you left off.');
  }

  /** Map SDK messages to internal events */
  private handleSDKMessage(msg: SDKMessage): void {
    // If output is suppressed (agent is being stopped), skip all emission
    if (this._outputSuppressed) return;

    // Log all system messages to understand what SDK sends
    if (msg.type === 'system') {
      const subtype = 'subtype' in msg ? msg.subtype : 'unknown';
      logger.info({ agentId: this.agentId, subtype, msg }, '[SDK System Message]');

      // Emit non-init system messages to terminal for visibility
      if (subtype !== 'init') {
        this.emit('output', {
          agentId: this.agentId,
          streamType: 'system',
          content: `[${subtype}] ${JSON.stringify(msg, null, 2).slice(0, 500)}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

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
      // Log full result for debugging
      logger.info({ agentId: this.agentId, result }, '[SDK Result Message]');

      // Extract token usage from modelUsage (aggregate all models)
      let inputTokens = 0;
      let outputTokens = 0;
      if ('modelUsage' in result && result.modelUsage) {
        for (const usage of Object.values(result.modelUsage)) {
          inputTokens += usage.inputTokens || 0;
          outputTokens += usage.outputTokens || 0;
        }
      }
      this.emit('result', {
        type: 'result',
        subtype: result.subtype,
        session_id: result.session_id,
        result: 'result' in result ? result.result : undefined,
        cost_usd: result.total_cost_usd,
        num_turns: result.num_turns,
        duration_ms: result.duration_ms,
        is_error: result.is_error,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      });
    }

    // Assistant messages (only handle tool_use, text is handled via streaming flush)
    if (msg.type === 'assistant') {
      const assistantMsg = msg as SDKAssistantMessage;
      for (const block of assistantMsg.message.content) {
        // Skip text blocks - already flushed via content_block_stop
        if (block.type === 'tool_use') {
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

    // Streaming partial messages (real-time text output)
    if (msg.type === 'stream_event') {
      const event = (msg as { event: { type: string; index?: number; delta?: { type: string; text?: string; thinking?: string } } }).event;

      // Accumulate streaming content
      if (event.type === 'content_block_delta' && event.delta) {
        // Handle text streaming
        if (event.delta.type === 'text_delta' && event.delta.text) {
          this._streamingTextBuffer += event.delta.text;
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'text',
            content: event.delta.text,
            timestamp: new Date().toISOString(),
            isStreaming: true,
          });
        }
        // Handle thinking streaming
        if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          this._streamingThinkingBuffer += event.delta.thinking;
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'system',
            content: `[thinking] ${event.delta.thinking}`,
            timestamp: new Date().toISOString(),
            isStreaming: true,
          });
        }
      }

      // When content block ends, emit buffered content for DB persistence
      if (event.type === 'content_block_stop') {
        // Flush thinking buffer
        if (this._streamingThinkingBuffer.trim()) {
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'system',
            content: `[thinking] ${this._streamingThinkingBuffer.trim()}`,
            timestamp: new Date().toISOString(),
          });
          this._streamingThinkingBuffer = '';
        }
        // Flush text buffer
        if (this._streamingTextBuffer.trim()) {
          this.emit('output', {
            agentId: this.agentId,
            streamType: 'text',
            content: this._streamingTextBuffer.trim(),
            timestamp: new Date().toISOString(),
          });
          this._streamingTextBuffer = '';
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
