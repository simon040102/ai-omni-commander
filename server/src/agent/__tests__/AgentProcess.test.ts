import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProcess } from '../AgentProcess.js';
import type { AgentSpawnConfig } from '@omni/shared';

// Mock the SDK query function
const mockClose = vi.fn();
const mockReturn = vi.fn().mockResolvedValue({ value: undefined, done: true });
const mockNext = vi.fn();
const mockThrow = vi.fn();

function createMockQuery(messages: Array<{ type: string; [k: string]: unknown }> = []) {
  let index = 0;
  const q = {
    close: mockClose,
    return: mockReturn,
    throw: mockThrow,
    interrupt: vi.fn().mockResolvedValue(undefined),
    next: mockNext.mockImplementation(async () => {
      if (index < messages.length) {
        return { value: messages[index++], done: false };
      }
      return { value: undefined, done: true };
    }),
    [Symbol.asyncIterator]() { return q; },
  };
  return q;
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Get the mocked query function
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
const mockSdkQuery = vi.mocked(sdkQuery);

function createConfig(overrides?: Partial<AgentSpawnConfig>): AgentSpawnConfig {
  return {
    workingDir: '/tmp/test',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'test prompt',
    allowedTools: [],
    ...overrides,
  };
}

describe('AgentProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and getters', () => {
    it('initializes with idle status', () => {
      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      expect(proc.status).toBe('idle');
      expect(proc.sessionId).toBeNull();
      expect(proc.pid).toBeNull();
      expect(proc.isActive).toBe(false);
    });
  });

  describe('spawn()', () => {
    it('sets status to starting and creates a query', async () => {
      const mockQuery = createMockQuery([]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const statusChanges: string[] = [];
      proc.on('statusChange', (e) => statusChanges.push(e.current));

      await proc.spawn('hello');

      // Should have called SDK query
      expect(mockSdkQuery).toHaveBeenCalledTimes(1);
      const callArgs = mockSdkQuery.mock.calls[0]![0];
      // prompt should be an AsyncGenerator (streaming input mode), not a string
      expect(typeof callArgs.prompt).not.toBe('string');
      // abortController should be passed
      expect(callArgs.options?.abortController).toBeInstanceOf(AbortController);

      // Wait for stream to finish
      await vi.waitFor(() => expect(proc.isActive).toBe(false));
      expect(statusChanges).toContain('starting');
    });

    it('throws if already has a running query', async () => {
      // Create a query that never resolves
      const neverEndQuery = {
        close: vi.fn(),
        return: vi.fn(),
        throw: vi.fn(),
        interrupt: vi.fn(),
        next: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
        [Symbol.asyncIterator]() { return neverEndQuery; },
      };
      mockSdkQuery.mockReturnValue(neverEndQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      await proc.spawn('first');

      await expect(proc.spawn('second')).rejects.toThrow('already has a running query');
    });

    it('generates a session ID if none provided', async () => {
      const mockQuery = createMockQuery([]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      await proc.spawn('hello');

      await vi.waitFor(() => expect(proc.isActive).toBe(false));
      // sessionId should be set (UUID format)
      expect(proc.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('stop()', () => {
    it('does nothing if no query is running', async () => {
      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      await proc.stop(); // should not throw
      expect(proc.status).toBe('idle');
    });

    it('sets status to stopping, calls abort and close', async () => {
      // Create a query that hangs until aborted
      let rejectNext: ((err: Error) => void) | null = null;
      const hangingQuery = {
        close: vi.fn().mockImplementation(() => {
          // When close is called, reject the pending next()
          if (rejectNext) rejectNext(new Error('closed'));
        }),
        return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        throw: vi.fn(),
        interrupt: vi.fn(),
        next: vi.fn().mockImplementation(() => {
          return new Promise((_, reject) => {
            rejectNext = reject;
          });
        }),
        [Symbol.asyncIterator]() { return hangingQuery; },
      };
      mockSdkQuery.mockReturnValue(hangingQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const statusChanges: string[] = [];
      proc.on('statusChange', (e) => statusChanges.push(e.current));
      // Suppress unhandled error from the mock
      proc.on('error', () => {});

      await proc.spawn('hello');
      expect(proc.isActive).toBe(true);

      await proc.stop();

      expect(statusChanges).toContain('stopping');
      expect(statusChanges).toContain('stopped');
      expect(hangingQuery.close).toHaveBeenCalled();
      expect(proc.isActive).toBe(false);
    });

    it('does not call interrupt() — avoids ERR_STREAM_WRITE_AFTER_END', async () => {
      const mockQuery = createMockQuery([]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      await proc.spawn('hello');
      await vi.waitFor(() => expect(proc.isActive).toBe(false));

      // Re-mock to track a hanging query
      let rejectFn: ((e: Error) => void) | null = null;
      const hangQuery = {
        close: vi.fn().mockImplementation(() => { if (rejectFn) rejectFn(new Error('closed')); }),
        return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        throw: vi.fn(),
        interrupt: vi.fn(),
        next: vi.fn().mockImplementation(() => new Promise((_, rej) => { rejectFn = rej; })),
        [Symbol.asyncIterator]() { return hangQuery; },
      };
      mockSdkQuery.mockReturnValue(hangQuery as any);

      const proc2 = new AgentProcess('agent-2', 'frontend', createConfig());
      proc2.on('error', () => {});
      await proc2.spawn('hello');

      await proc2.stop();

      // interrupt should NOT have been called
      expect(hangQuery.interrupt).not.toHaveBeenCalled();
    });

    it('suppresses output after stop is called', async () => {
      // Simulate a query that emits a message after stop
      let emitAfterStop: (() => void) | null = null;
      let nextCall = 0;
      const slowQuery = {
        close: vi.fn(),
        return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        throw: vi.fn(),
        interrupt: vi.fn(),
        next: vi.fn().mockImplementation(() => {
          nextCall++;
          if (nextCall === 1) {
            return Promise.resolve({
              value: { type: 'system', subtype: 'init', session_id: 'test-sess', tools: [], model: 'test' },
              done: false,
            });
          }
          // Second call — wait for stop then emit
          return new Promise((resolve) => {
            emitAfterStop = () => resolve({
              value: { type: 'assistant', message: { content: [{ type: 'text', text: 'leaked!' }] } },
              done: false,
            });
            // Auto-resolve after a delay to prevent hanging
            setTimeout(() => resolve({ value: undefined, done: true }), 2000);
          });
        }),
        [Symbol.asyncIterator]() { return slowQuery; },
      };
      mockSdkQuery.mockReturnValue(slowQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const outputs: string[] = [];
      proc.on('output', (e) => outputs.push(e.content));

      await proc.spawn('hello');

      // Wait for init to be processed
      await vi.waitFor(() => expect(proc.status).toBe('running'));

      // Start stop — this sets _outputSuppressed = true
      const stopPromise = proc.stop();

      // Emit the delayed message
      if (emitAfterStop) (emitAfterStop as () => void)();

      await stopPromise;

      // The 'leaked!' message should NOT appear in outputs
      expect(outputs.some(o => o.includes('leaked!'))).toBe(false);
    });
  });

  describe('resume()', () => {
    it('throws if no session ID exists', async () => {
      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      await expect(proc.resume()).rejects.toThrow('No session ID to resume');
    });

    it('resets outputSuppressed and creates new AbortController', async () => {
      const mockQuery = createMockQuery([
        { type: 'system', subtype: 'init', session_id: 'sess-123', tools: [], model: 'test' },
      ]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig({ sessionId: 'sess-123' }));
      await proc.spawn('first');
      await vi.waitFor(() => expect(proc.isActive).toBe(false));

      // Spawn again for resume
      const mockQuery2 = createMockQuery([]);
      mockSdkQuery.mockReturnValue(mockQuery2 as any);

      await proc.resume('continue');

      // Should have created a new query (2 total calls)
      expect(mockSdkQuery).toHaveBeenCalledTimes(2);
      // Second call should have a fresh AbortController
      const secondCallArgs = mockSdkQuery.mock.calls[1]![0];
      expect(secondCallArgs.options?.abortController).toBeInstanceOf(AbortController);
    });
  });

  describe('sendInput()', () => {
    it('always returns false (not supported in current mode)', () => {
      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      expect(proc.sendInput('hello')).toBe(false);
    });
  });

  describe('handleSDKMessage — output events', () => {
    it('emits init event on system init message', async () => {
      const mockQuery = createMockQuery([
        { type: 'system', subtype: 'init', session_id: 'sess-abc', tools: ['Read'], model: 'claude-test' },
      ]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const inits: any[] = [];
      proc.on('init', (e) => inits.push(e));

      await proc.spawn('hello');
      await vi.waitFor(() => expect(proc.isActive).toBe(false));

      expect(inits).toHaveLength(1);
      expect(inits[0].session_id).toBe('sess-abc');
      expect(proc.sessionId).toBe('sess-abc');
      expect(proc.status).toBe('stopped'); // stream ended
    });

    it('emits result event on result message', async () => {
      const mockQuery = createMockQuery([
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'done',
          total_cost_usd: 0.05,
          num_turns: 3,
          duration_ms: 10000,
          is_error: false,
          modelUsage: {
            'claude-test': { inputTokens: 100, outputTokens: 50 },
          },
        },
      ]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const results: any[] = [];
      proc.on('result', (e) => results.push(e));

      await proc.spawn('hello');
      await vi.waitFor(() => expect(proc.isActive).toBe(false));

      expect(results).toHaveLength(1);
      expect(results[0].cost_usd).toBe(0.05);
      expect(results[0].input_tokens).toBe(100);
      expect(results[0].output_tokens).toBe(50);
    });

    it('emits tool_use output on assistant message with tool_use block', async () => {
      const mockQuery = createMockQuery([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/test.ts' } },
            ],
          },
        },
      ]);
      mockSdkQuery.mockReturnValue(mockQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const outputs: any[] = [];
      proc.on('output', (e) => outputs.push(e));

      await proc.spawn('hello');
      await vi.waitFor(() => expect(proc.isActive).toBe(false));

      const toolOutput = outputs.find(o => o.streamType === 'tool_use');
      expect(toolOutput).toBeDefined();
      expect(toolOutput.toolName).toBe('Read');
    });
  });

  describe('consumeStream error handling', () => {
    it('sets status to stopped on AbortError', async () => {
      const abortQuery = {
        close: vi.fn(),
        return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        throw: vi.fn(),
        interrupt: vi.fn(),
        next: vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        [Symbol.asyncIterator]() { return abortQuery; },
      };
      mockSdkQuery.mockReturnValue(abortQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      await proc.spawn('hello');

      await vi.waitFor(() => expect(proc.isActive).toBe(false));
      expect(proc.status).toBe('stopped');
    });

    it('sets status to error on unexpected error', async () => {
      const errorQuery = {
        close: vi.fn(),
        return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
        throw: vi.fn(),
        interrupt: vi.fn(),
        next: vi.fn().mockRejectedValue(new Error('unexpected SDK failure')),
        [Symbol.asyncIterator]() { return errorQuery; },
      };
      mockSdkQuery.mockReturnValue(errorQuery as any);

      const proc = new AgentProcess('agent-1', 'frontend', createConfig());
      const errors: Error[] = [];
      proc.on('error', (e) => errors.push(e));

      await proc.spawn('hello');

      await vi.waitFor(() => expect(proc.isActive).toBe(false));
      expect(proc.status).toBe('error');
      expect(errors).toHaveLength(1);
    });
  });
});
