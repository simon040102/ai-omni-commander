/**
 * Shared pure task classification — keyword-based label / taskType detection.
 *
 * Single source of truth for:
 * - TaskClassifier (server/src/orchestrator/TaskClassifier.ts — Asana sync path)
 * - MCP sync_asana_tasks (server/src/mcp/tools/task-tools.ts)
 * - Client-side import drawer (web/src/components/dashboard/AsanaImportDrawer.tsx —
 *   cannot import server code; its inline regex + default MUST stay aligned with
 *   this module)
 *
 * Pure functions only: no spawn, no logging, no cwd/fs access — safe for both
 * the Web server and the MCP (stdio) process.
 */
import type { TaskType, TaskLabel } from '@omni/shared';

export interface ClassificationResult {
  taskType: TaskType;
  label: TaskLabel;
}

/**
 * Explicit Chinese role markers in the title. Returns null when no marker
 * is present (caller decides the default).
 * 前端 / 串接 → frontend; 後端 → backend.
 */
export function detectLabelFromTitle(title: string): TaskLabel | null {
  if (/前端|串接/.test(title)) return 'frontend';
  if (/後端/.test(title)) return 'backend';
  return null;
}

/** Label detection with the canonical default: no marker → 'frontend'. */
export function detectLabel(title: string): TaskLabel {
  return detectLabelFromTitle(title) ?? 'frontend';
}

/** Keyword-based task type detection (English + zh-TW keywords). */
export function detectTaskType(title: string, description?: string): TaskType {
  const text = `${title} ${description || ''}`.toLowerCase();
  if (/bug|fix|error|crash|broken|fail|issue|problem|wrong|incorrect|失效|錯誤/.test(text)) return 'bug';
  if (/refactor|restructure|reorganize|重構/.test(text)) return 'refactor';
  if (/add|create|implement|build|new|feature|新增|開發/.test(text)) return 'feature';
  return 'other';
}

/** Full classification: keyword taskType + label (default frontend). */
export function classifyTask(title: string, description?: string): ClassificationResult {
  return { taskType: detectTaskType(title, description), label: detectLabel(title) };
}
