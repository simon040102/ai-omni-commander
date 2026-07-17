/**
 * Stale (卡死) task detection — shared query helpers for MCP tools.
 *
 * A task can sit in `in_progress` forever when its subagent dies / a session is
 * restarted and nobody marks it completed/failed. next_task and list_pending_tasks
 * default filters never surface these, so they rot silently.
 *
 * "停滯時數" (stalled hours) = now − COALESCE(最後一筆 agent_outputs.timestamp,
 * tasks.updated_at). Computed with SQLite julianday so it is UTC-consistent with
 * how timestamps are stored (`datetime('now')`, UTC without 'Z') — no timezone /
 * Z-suffix ambiguity. Always a non-negative integer (clock skew → clamp to 0).
 */
import type Database from 'better-sqlite3';

/** 預設停滯門檻（小時）。超過此時數的 in_progress 任務視為疑似卡死。 */
export const DEFAULT_STALE_THRESHOLD_HOURS = 24;

/**
 * SQL fragment computing stalled hours for a `tasks` row aliased as `t`.
 * Latest output timestamp across ANY agent bound to the task (covers both the
 * synthetic mcp-{taskId} agent and legacy spawn-path agents), falling back to
 * tasks.updated_at when the task has produced no output at all.
 */
const STALLED_HOURS_SQL = `CAST(
  (julianday('now') - julianday(COALESCE(
    (SELECT MAX(o.timestamp) FROM agent_outputs o WHERE o.task_id = t.id),
    t.updated_at
  ))) * 24 AS INTEGER
)`;

/** Compute stalled hours for a single task id. Returns 0 when the task is unknown. */
export function getStalledHours(db: Database.Database, taskId: string): number {
  const row = db.prepare(
    `SELECT ${STALLED_HOURS_SQL} AS hours FROM tasks t WHERE t.id = ?`,
  ).get(taskId) as { hours: number | null } | undefined;
  const h = row?.hours ?? 0;
  return h < 0 ? 0 : h;
}

export interface StalledTask {
  taskId: string;
  title: string;
  label: string;
  stalledHours: number;
}

/**
 * List a project's in_progress tasks whose stalledHours ≥ threshold, most stalled
 * first. Used by next_task to surface a "疑似停滯任務" section without altering the
 * recommendation itself.
 */
export function listStalledTasks(
  db: Database.Database,
  projectId: string,
  thresholdHours: number = DEFAULT_STALE_THRESHOLD_HOURS,
): StalledTask[] {
  const rows = db.prepare(`
    SELECT t.id AS id, t.title AS title, t.label AS label, ${STALLED_HOURS_SQL} AS hours
    FROM tasks t
    WHERE t.project_id = ? AND t.status = 'in_progress'
  `).all(projectId) as Array<{ id: string; title: string; label: string; hours: number | null }>;

  return rows
    .map(r => ({ taskId: r.id, title: r.title, label: r.label, stalledHours: (r.hours ?? 0) < 0 ? 0 : (r.hours ?? 0) }))
    .filter(r => r.stalledHours >= thresholdHours)
    .sort((a, b) => b.stalledHours - a.stalledHours);
}
