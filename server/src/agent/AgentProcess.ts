import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKMessage, SDKAssistantMessage, SDKUserMessage as SDKUserMsg, SDKResultMessage, SDKSystemMessage, HookInput, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRole, AgentSpawnConfig } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

export type AgentProcessStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

const logger = createChildLogger('AgentProcess');

export class AgentProcess extends EventEmitter {
  private _query: Query | null = null;
  private _status: AgentProcessStatus = 'idle';
  private _sessionId: string | null = null;
  private _pid: number | null = null;
  /** AbortController for forcefully terminating the underlying CLI process.
   *  Must be recreated on each spawn() since abort() is one-shot. */
  private _abortController: AbortController | null = null;

  // Buffers for accumulating streamed content
  private _streamingTextBuffer = '';
  private _streamingThinkingBuffer = '';
  /** When true, all output emission is suppressed (set immediately on stop) */
  private _outputSuppressed = false;

  // Queue-based input: allows injecting user messages without stop/resume
  private _inputQueue: string[] = [];
  private _inputWaiter: (() => void) | null = null;

  /** External callback to provide context after compaction (set by AgentManager) */
  public onCompactionContext: (() => string | null) | null = null;

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

  /** Get current context usage from the running query */
  async getContextUsage(): Promise<{ totalTokens: number; maxTokens: number; percentage: number } | null> {
    if (!this._query) return null;
    try {
      const usage = await this._query.getContextUsage();
      return { totalTokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage };
    } catch {
      return null;
    }
  }

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

    // Use bypassPermissions on all platforms — agents run autonomously and need
    // full tool access (including MCP tools like playwright for smoke tests).
    // Requires prior `claude --dangerously-skip-permissions` acceptance on the machine.
    const permissionMode = 'bypassPermissions';
    const allowDangerouslySkipPermissions = true;

    logger.info({ platform: process.platform, permissionMode }, 'Using platform-specific permission mode');

    // Create a fresh AbortController for each spawn (abort() is one-shot, cannot be reused)
    this._abortController = new AbortController();

    // Queue-based AsyncGenerator: yields initial prompt, then waits for queued input.
    // This allows sendInput() to inject follow-up messages without stop/resume.
    this._inputQueue = [];
    this._inputWaiter = null;
    const self = this;
    async function* messageGenerator() {
      // Yield initial prompt
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: safePrompt },
        parent_tool_use_id: null,
        session_id: self._sessionId || '',
      };
      // Wait for queued follow-up messages
      while (true) {
        if (self._inputQueue.length > 0) {
          const text = self._inputQueue.shift()!;
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: text },
            parent_tool_use_id: null,
            session_id: self._sessionId || '',
          };
        } else {
          // Wait until sendInput() pushes a message or agent is stopped
          await new Promise<void>((resolve) => {
            self._inputWaiter = resolve;
          });
          // If agent is stopping, exit the generator
          if (self._status === 'stopping' || self._status === 'stopped') return;
        }
      }
    }

    // Build SessionStart hook to inject flow plan context after compaction
    const compactionHook: HookCallbackMatcher = {
      hooks: [async (input: HookInput) => {
        if (input.hook_event_name === 'SessionStart' && 'source' in input && input.source === 'compact') {
          const context = self.onCompactionContext?.();
          if (context) {
            logger.info({ agentId: self.agentId }, 'Injecting flow plan context after compaction');
            return {
              hookSpecificOutput: {
                hookEventName: 'SessionStart' as const,
                additionalContext: context,
              },
            };
          }
        }
        return {};
      }],
    };

    // Resolve model: opus → claude-opus-4-6[1m] for 1M context
    const resolvedModel = this.config.model === 'opus' ? 'claude-opus-4-6[1m]' : this.config.model;

    this._query = query({
      prompt: messageGenerator(),
      options: {
        cwd: this.config.workingDir,
        model: resolvedModel,
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
        // AbortController for forceful termination
        abortController: this._abortController,
        // Hooks: inject flow plan context after compaction
        hooks: {
          SessionStart: [compactionHook],
        },
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
   * Send a follow-up message to the running agent via the input queue.
   * The message will be delivered after the current turn completes.
   * Returns true if the agent is running and input was queued.
   */
  sendInput(text: string): boolean {
    if (!this._query || this._status !== 'running') return false;
    this._inputQueue.push(text);
    // Wake up the generator if it's waiting
    if (this._inputWaiter) {
      const waiter = this._inputWaiter;
      this._inputWaiter = null;
      waiter();
    }
    logger.info({ agentId: this.agentId, queueLen: this._inputQueue.length }, 'Input queued for agent');
    return true;
  }

  /** Suppress all future output emission (called externally for immediate silencing) */
  suppressOutput(): void {
    this._outputSuppressed = true;
  }

  /** Gracefully stop the agent — abort + close double guarantee */
  async stop(): Promise<void> {
    if (!this._query) return;

    // 1. Flush any accumulated streaming buffers so they get persisted to DB
    if (this._streamingTextBuffer.trim()) {
      this.emit('output', {
        agentId: this.agentId,
        streamType: 'text',
        content: this._streamingTextBuffer.trim(),
        timestamp: new Date().toISOString(),
      });
      this._streamingTextBuffer = '';
    }
    if (this._streamingThinkingBuffer.trim()) {
      this.emit('output', {
        agentId: this.agentId,
        streamType: 'system',
        content: `[thinking] ${this._streamingThinkingBuffer.trim()}`,
        timestamp: new Date().toISOString(),
      });
      this._streamingThinkingBuffer = '';
    }

    // 2. Now suppress output so no new events leak after this point
    this._outputSuppressed = true;
    this.setStatus('stopping');

    // Wake up the input generator so it can exit
    if (this._inputWaiter) {
      const waiter = this._inputWaiter;
      this._inputWaiter = null;
      waiter();
    }

    // 3. AbortController — forcefully terminates the underlying HTTP connection and CLI process
    if (this._abortController) {
      this._abortController.abort();
    }

    // 3. close() as guarantee to clean up resources (subprocess, MCP transports, etc.)
    try {
      this._query.close();
    } catch {
      // close() may fail if already terminated — ignore
    }

    // Wait for consumeStream to finish (abort triggers AbortError in the for-await loop)
    await new Promise<void>((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        settled = true;
        resolve();
      }, 3000);
      const check = () => {
        if (settled) return;
        if (!this._query) {
          settled = true;
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

    // Reset state — aborted AbortController cannot be reused, spawn() creates a new one
    this._outputSuppressed = false;
    this._abortController = null;
    this._inputQueue = [];
    this._inputWaiter = null;

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
