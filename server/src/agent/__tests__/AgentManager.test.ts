import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for AgentManager debounce and taskDoneAgents behavior.
 * Uses heavy mocking since AgentManager has many dependencies (DB, EventBus, SDK).
 */

// --- Mock DB queries ---
const mockGetAgent = vi.fn().mockReturnValue(null);
const mockUpdateAgent = vi.fn();
const mockCreateAgent = vi.fn();
const mockGetAgentsByProject = vi.fn().mockReturnValue([]);
const mockGetAgentsByRole = vi.fn().mockReturnValue([]);
const mockGetRunningAgents = vi.fn().mockReturnValue([]);

vi.mock('../../db/queries/agents.js', () => ({
  getAgent: (...args: unknown[]) => mockGetAgent(...args),
  updateAgent: (...args: unknown[]) => mockUpdateAgent(...args),
  createAgent: (...args: unknown[]) => mockCreateAgent(...args),
  getAgentsByProject: (...args: unknown[]) => mockGetAgentsByProject(...args),
  getAgentsByRole: (...args: unknown[]) => mockGetAgentsByRole(...args),
  getRunningAgents: (...args: unknown[]) => mockGetRunningAgents(...args),
}));

vi.mock('../../db/queries/projects.js', () => ({
  getProject: vi.fn().mockReturnValue({ id: 'proj-1', mode: 'spec', status: 'executing' }),
  updateProject: vi.fn(),
}));

vi.mock('../../db/queries/tasks.js', () => ({
  getTask: vi.fn().mockReturnValue(null),
  updateTask: vi.fn(),
}));

vi.mock('../../db/queries/events.js', () => ({
  logAgentOutput: vi.fn(),
  createIntervention: vi.fn(),
  clearAgentOutputs: vi.fn(),
  getAgentOutputs: vi.fn().mockReturnValue([]),
}));

vi.mock('../../db/queries/plans.js', () => ({
  createPlan: vi.fn(),
}));

vi.mock('../../db/queries/globalConfig.js', () => ({
  getGlobalMcpServers: vi.fn().mockReturnValue([]),
}));

vi.mock('../../config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    claudePath: 'claude',
    dbPath: ':memory:',
    aiContextDir: '/tmp',
    port: 3456,
  }),
}));

// Mock SDK query — factory cannot reference top-level vars (hoisting)
vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  function makeMockQuery() {
    const q = {
      close: vi.fn(),
      return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
      throw: vi.fn(),
      interrupt: vi.fn(),
      next: vi.fn().mockResolvedValue({ value: undefined, done: true }),
      [Symbol.asyncIterator]() { return q; },
    };
    return q;
  }
  return {
    query: vi.fn().mockImplementation(() => makeMockQuery()),
  };
});

import { AgentManager } from '../AgentManager.js';
import { EventBus } from '../../eventbus/EventBus.js';

// Minimal ContextSync mock
const mockContextSync = {
  init: vi.fn(),
  writeContract: vi.fn(),
  writeSchema: vi.fn(),
} as any;

describe('AgentManager', () => {
  let manager: AgentManager;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    eventBus = new EventBus();
    manager = new AgentManager(eventBus, mockContextSync);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('sendInputToAgent — debounce', () => {
    it('buffers rapid inputs and merges after 1.5s', async () => {
      // Set up a fake agent in the DB so _doSendInput can find session ID
      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'frontend', projectId: 'proj-1',
        sessionId: 'sess-1', status: 'stopped', taskId: 'task-1',
      });

      // Send 3 inputs rapidly
      const p1 = manager.sendInputToAgent('agent-1', 'fix button color');
      const p2 = manager.sendInputToAgent('agent-1', 'also fix header');
      const p3 = manager.sendInputToAgent('agent-1', 'and footer too');

      // Before debounce fires, nothing should have happened
      // (no SDK query calls yet from _doSendInput)

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(1600);

      // All 3 promises should resolve
      const results = await Promise.all([p1, p2, p3]);
      expect(results).toEqual([true, true, true]);

      // Check that _doSendInput was called with merged text
      // The SDK query should have been called with the merged prompt
      const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockQuery = vi.mocked(sdkQuery);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('does not merge inputs separated by more than 1.5s', async () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'frontend', projectId: 'proj-1',
        sessionId: 'sess-1', status: 'stopped', taskId: 'task-1',
      });

      const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockQuery = vi.mocked(sdkQuery);

      // First input
      const p1 = manager.sendInputToAgent('agent-1', 'first message');
      await vi.advanceTimersByTimeAsync(1600);
      await p1;

      const callCount1 = mockQuery.mock.calls.length;

      // Second input after debounce window
      const p2 = manager.sendInputToAgent('agent-1', 'second message');
      await vi.advanceTimersByTimeAsync(1600);
      await p2;

      // Should have been 2 separate calls
      expect(mockQuery.mock.calls.length).toBe(callCount1 + 1);
    });

    it('different agents have independent debounce timers', async () => {
      mockGetAgent.mockImplementation((id: string) => ({
        id, role: 'frontend', projectId: 'proj-1',
        sessionId: `sess-${id}`, status: 'stopped', taskId: 'task-1',
      }));

      const p1 = manager.sendInputToAgent('agent-1', 'msg for agent 1');
      const p2 = manager.sendInputToAgent('agent-2', 'msg for agent 2');

      await vi.advanceTimersByTimeAsync(1600);
      await Promise.all([p1, p2]);

      const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk');
      const mockQuery = vi.mocked(sdkQuery);
      // Both agents should have gotten their own query
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('returns false when agent has no session ID', async () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'frontend', projectId: 'proj-1',
        sessionId: null, status: 'stopped', taskId: null,
      });

      const p = manager.sendInputToAgent('agent-1', 'hello');
      await vi.advanceTimersByTimeAsync(1600);
      const result = await p;

      expect(result).toBe(false);
    });

    it('returns false for axure agents that are not running', async () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'axure', projectId: 'proj-1',
        sessionId: 'sess-1', status: 'stopped', taskId: null,
      });

      const p = manager.sendInputToAgent('agent-1', 'hello');
      await vi.advanceTimersByTimeAsync(1600);
      const result = await p;

      expect(result).toBe(false);
    });
  });

  describe('taskDoneAgents — no auto-resume after user input', () => {
    it('clears taskDoneAgents but exhausts autoResumeCount when sending input', async () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'frontend', projectId: 'proj-1',
        sessionId: 'sess-1', status: 'stopped', taskId: 'task-1',
      });

      // Simulate that agent previously completed via [TASK_COMPLETE]
      // Access private field for testing
      (manager as any).taskDoneAgents.add('agent-1');

      const p = manager.sendInputToAgent('agent-1', 'hello chat');
      await vi.advanceTimersByTimeAsync(1600);
      await p;

      // taskDoneAgents is cleared (PTY mode needs this so old [TASK_COMPLETE] in JSONL
      // doesn't re-trigger stop after resume)
      expect((manager as any).taskDoneAgents.has('agent-1')).toBe(false);

      // autoResumeCount is exhausted so the agent won't loop after answering user's question
      const maxResumes = 3; // MAX_AUTO_RESUMES
      expect((manager as any).autoResumeCount.get('agent-1')).toBe(maxResumes);
    });

    it('handleAgentComplete skips auto-resume for taskDone agents', async () => {
      // Access private method for testing
      const handleComplete = (manager as any).handleAgentComplete.bind(manager);

      // Mark agent as task-done
      (manager as any).taskDoneAgents.add('agent-1');

      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'frontend', projectId: 'proj-1',
        sessionId: 'sess-1', status: 'running', taskId: 'task-1',
      });

      // Spy on resumeAgent to ensure it's NOT called
      const resumeSpy = vi.spyOn(manager as any, 'resumeAgent').mockResolvedValue(undefined);

      await handleComplete('agent-1', 'proj-1', 'task-1', {
        is_error: false,
        subtype: 'success',
        cost_usd: 0.01,
        num_turns: 1,
        duration_ms: 5000,
      });

      // Should NOT have auto-resumed
      expect(resumeSpy).not.toHaveBeenCalled();
    });

    it('handleAgentComplete DOES auto-resume for non-taskDone agents', async () => {
      // Use real timers for this test — handleAgentComplete has internal setTimeout(1000)
      vi.useRealTimers();

      const handleComplete = (manager as any).handleAgentComplete.bind(manager);

      // Agent is NOT in taskDoneAgents
      expect((manager as any).taskDoneAgents.has('agent-1')).toBe(false);

      mockGetAgent.mockReturnValue({
        id: 'agent-1', role: 'frontend', projectId: 'proj-1',
        sessionId: 'sess-1', status: 'running', taskId: 'task-1',
      });

      const resumeSpy = vi.spyOn(manager as any, 'resumeAgent').mockResolvedValue(undefined);

      await handleComplete('agent-1', 'proj-1', 'task-1', {
        is_error: false,
        subtype: 'success',
        cost_usd: 0.01,
        num_turns: 1,
        duration_ms: 5000,
      });

      // Should have auto-resumed (first attempt)
      expect(resumeSpy).toHaveBeenCalled();

      // Restore fake timers for other tests
      vi.useFakeTimers();
    });
  });
});
