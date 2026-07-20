import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockShowToast, mockGetDb } = vi.hoisted(() => ({
  mockShowToast: vi.fn(),
  mockGetDb: vi.fn(),
}));

vi.mock('../windowsToast.js', () => ({ showToast: mockShowToast, toastsMightShow: () => true }));
vi.mock('../../db/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { handleMcpEventToast, notifyTaskStatusToast, NEEDS_HUMAN_MARKER } from '../toastEvents.js';

function stubTaskTitle(title: string | undefined): void {
  mockGetDb.mockReturnValue({
    prepare: () => ({ get: () => (title === undefined ? undefined : { title }) }),
  });
}

beforeEach(() => {
  mockShowToast.mockReset();
  mockGetDb.mockReset();
  stubTaskTitle('SM27 專案成員維護');
});

describe('notifyTaskStatusToast', () => {
  it('shows completed toast with task title', () => {
    notifyTaskStatusToast('task-1', 'completed');
    expect(mockShowToast).toHaveBeenCalledWith('✅ 任務完成', 'SM27 專案成員維護');
  });

  it('shows failed toast with task title', () => {
    notifyTaskStatusToast('task-1', 'failed');
    expect(mockShowToast).toHaveBeenCalledWith('❌ 任務失敗', 'SM27 專案成員維護');
  });

  it('ignores other statuses', () => {
    notifyTaskStatusToast('task-1', 'in_progress');
    notifyTaskStatusToast('task-1', 'pending');
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('falls back to taskId when the task row is missing', () => {
    stubTaskTitle(undefined);
    notifyTaskStatusToast('task-x', 'completed');
    expect(mockShowToast).toHaveBeenCalledWith('✅ 任務完成', 'task-x');
  });

  it('falls back to taskId and does not throw when the db lookup throws', () => {
    mockGetDb.mockImplementation(() => { throw new Error('db closed'); });
    expect(() => notifyTaskStatusToast('task-y', 'failed')).not.toThrow();
    expect(mockShowToast).toHaveBeenCalledWith('❌ 任務失敗', 'task-y');
  });
});

describe('handleMcpEventToast — task.statusChange', () => {
  it('triggers on completed with correct payload', () => {
    handleMcpEventToast('task.statusChange', { taskId: 'task-1', newStatus: 'completed' });
    expect(mockShowToast).toHaveBeenCalledWith('✅ 任務完成', 'SM27 專案成員維護');
  });

  it('triggers on failed', () => {
    handleMcpEventToast('task.statusChange', { taskId: 'task-1', newStatus: 'failed' });
    expect(mockShowToast).toHaveBeenCalledWith('❌ 任務失敗', 'SM27 專案成員維護');
  });

  it('falls back to the legacy "status" field when newStatus is absent', () => {
    handleMcpEventToast('task.statusChange', { taskId: 'task-1', status: 'completed' });
    expect(mockShowToast).toHaveBeenCalledWith('✅ 任務完成', 'SM27 專案成員維護');
  });

  it('does NOT trigger for non-terminal statuses', () => {
    handleMcpEventToast('task.statusChange', { taskId: 'task-1', newStatus: 'in_progress' });
    handleMcpEventToast('task.statusChange', { taskId: 'task-1', newStatus: 'pending' });
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});

describe('handleMcpEventToast — agent.output', () => {
  it('triggers when content contains [NEEDS_HUMAN]', () => {
    handleMcpEventToast('agent.output', {
      taskId: 'task-1',
      content: `做到一半卡住了 ${NEEDS_HUMAN_MARKER} 需要使用者提供測試帳號`,
    });
    expect(mockShowToast).toHaveBeenCalledWith('⚠ 需要人工介入', 'SM27 專案成員維護');
  });

  it('does not trigger for ordinary output', () => {
    handleMcpEventToast('agent.output', { taskId: 'task-1', content: '一般進度回報' });
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('does not trigger when content is missing/non-string', () => {
    handleMcpEventToast('agent.output', { taskId: 'task-1' });
    handleMcpEventToast('agent.output', { taskId: 'task-1', content: 123 });
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});

describe('handleMcpEventToast — task.specGap', () => {
  it('triggers on newly reported gaps with description truncated to 60 chars', () => {
    const description = '規'.repeat(100);
    handleMcpEventToast('task.specGap', { taskId: 'task-1', action: 'reported', description });
    expect(mockShowToast).toHaveBeenCalledWith('📋 新規格缺口', '規'.repeat(60));
  });

  it('passes short descriptions through unchanged', () => {
    handleMcpEventToast('task.specGap', { action: 'reported', description: '刪除確認訊息文字未定義' });
    expect(mockShowToast).toHaveBeenCalledWith('📋 新規格缺口', '刪除確認訊息文字未定義');
  });

  it('does not trigger on resolved gaps', () => {
    handleMcpEventToast('task.specGap', { action: 'resolved', description: 'x' });
    expect(mockShowToast).not.toHaveBeenCalled();
  });
});

describe('handleMcpEventToast — other events', () => {
  it('ignores unrelated events', () => {
    handleMcpEventToast('task.milestone', { taskId: 'task-1', milestone: 'm' });
    handleMcpEventToast('agent.started', { agentId: 'a' });
    handleMcpEventToast('project.updated', {});
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('never throws even when showToast itself throws', () => {
    mockShowToast.mockImplementation(() => { throw new Error('boom'); });
    expect(() => handleMcpEventToast('task.statusChange', { taskId: 'task-1', newStatus: 'completed' })).not.toThrow();
  });
});
