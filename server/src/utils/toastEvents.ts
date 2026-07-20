/**
 * Maps task/agent events to Windows toast notifications (server-side).
 *
 * Two call sites share these helpers so the mapping exists exactly once:
 * - index.ts /api/mcp-notify — events POSTed by the MCP process
 *   (task.statusChange / agent.output / task.specGap)
 * - MessageRouter task.update — Web UI / WS clients writing status directly
 *
 * Everything here is fire-and-forget: helpers never throw, and showToast
 * itself is also fully guarded (platform check, config switch, throttling).
 */
import { showToast, toastsMightShow } from './windowsToast.js';
import { getDb } from '../db/connection.js';
import { logger } from './logger.js';

/** Marker agents emit in report_output content when human help is required. */
export const NEEDS_HUMAN_MARKER = '[NEEDS_HUMAN]';

/** Spec-gap descriptions are truncated to this length in the toast body. */
const SPEC_GAP_PREVIEW_LEN = 60;

/** Look up the task title for display; fall back to the raw id, never throw. */
function getTaskTitle(taskId: unknown): string {
  const id = typeof taskId === 'string' ? taskId : '';
  if (!id) return '';
  try {
    const row = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(id) as { title?: string } | undefined;
    return row?.title || id;
  } catch (err) {
    logger.debug({ err, taskId: id }, 'toastEvents: task title lookup failed');
    return id;
  }
}

/**
 * Toast for a task status transition. Only `completed` / `failed` notify;
 * every other status is a silent no-op.
 */
export function notifyTaskStatusToast(taskId: string, status: string): void {
  try {
    // Skip the title DB lookup entirely when no toast could show (non-win32 / disabled)
    if (!toastsMightShow()) return;
    if (status === 'completed') {
      showToast('✅ 任務完成', getTaskTitle(taskId));
    } else if (status === 'failed') {
      showToast('❌ 任務失敗', getTaskTitle(taskId));
    }
  } catch (err) {
    logger.debug({ err, taskId, status }, 'toastEvents: notifyTaskStatusToast failed');
  }
}

/**
 * Inspect an MCP-notify event and raise a toast when it matters:
 * - task.statusChange with newStatus/status completed|failed
 * - agent.output whose content contains [NEEDS_HUMAN]
 * - task.specGap with action 'reported' (new gap)
 */
export function handleMcpEventToast(event: string, data: Record<string, unknown>): void {
  try {
    if (event === 'task.statusChange') {
      const status = typeof data['newStatus'] === 'string'
        ? data['newStatus']
        : (typeof data['status'] === 'string' ? data['status'] : '');
      const taskId = typeof data['taskId'] === 'string' ? data['taskId'] : '';
      notifyTaskStatusToast(taskId, status);
    } else if (event === 'agent.output') {
      const content = typeof data['content'] === 'string' ? data['content'] : '';
      if (content.includes(NEEDS_HUMAN_MARKER)) {
        showToast('⚠ 需要人工介入', getTaskTitle(data['taskId']));
      }
    } else if (event === 'task.specGap') {
      if (data['action'] === 'reported') {
        const description = typeof data['description'] === 'string' ? data['description'] : '';
        showToast('📋 新規格缺口', description.slice(0, SPEC_GAP_PREVIEW_LEN));
      }
    }
  } catch (err) {
    logger.debug({ err, event }, 'toastEvents: handleMcpEventToast failed');
  }
}
