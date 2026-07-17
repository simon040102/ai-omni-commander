/**
 * Stale (卡死) task detection — getStalledHours / listStalledTasks.
 * In-memory DB with timestamps shifted via SQLite datetime modifiers so the
 * julianday-based計算 is exercised end-to-end (UTC-consistent, no Z ambiguity).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { getStalledHours, listStalledTasks, DEFAULT_STALE_THRESHOLD_HOURS } from '../stale-tasks.js';

let db: Database.Database;

function freshDb(): Database.Database {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  runMigrations(d);
  return d;
}

function seedProject() {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-1', 'Test', '/tmp')`).run();
}

/** Insert an in_progress task and shift its updated_at back by `hoursAgo`. */
function seedTask(id: string, hoursAgo: number, opts: { status?: string; title?: string; label?: string } = {}) {
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, label, task_type, status)
    VALUES (?, 'proj-1', ?, ?, 'feature', ?)
  `).run(id, opts.title || `Task ${id}`, opts.label || 'backend', opts.status || 'in_progress');
  db.prepare(`UPDATE tasks SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${hoursAgo} hours`, id);
}

/** Add an output for mcp-{taskId} whose timestamp is `hoursAgo` in the past. */
function addOutput(taskId: string, hoursAgo: number, content = 'progress') {
  db.prepare(`INSERT OR IGNORE INTO agents (id, project_id, role, status, model) VALUES (?, 'proj-1', 'quick', 'running', 'external')`).run(`mcp-${taskId}`);
  const info = db.prepare(`INSERT INTO agent_outputs (agent_id, task_id, stream_type, content) VALUES (?, ?, 'system', ?)`).run(`mcp-${taskId}`, taskId, content);
  db.prepare(`UPDATE agent_outputs SET timestamp = datetime('now', ?) WHERE id = ?`).run(`-${hoursAgo} hours`, info.lastInsertRowid);
}

describe('stale-tasks', () => {
  beforeEach(() => {
    db = freshDb();
    seedProject();
  });

  describe('getStalledHours', () => {
    it('falls back to updated_at when the task has no outputs', () => {
      seedTask('t1', 30);
      const h = getStalledHours(db, 't1');
      expect(h).toBeGreaterThanOrEqual(29);
      expect(h).toBeLessThanOrEqual(31);
    });

    it('uses the latest output timestamp over updated_at (activity resets staleness)', () => {
      seedTask('t2', 30);      // updated 30h ago
      addOutput('t2', 2);      // but reported 2h ago
      const h = getStalledHours(db, 't2');
      expect(h).toBeGreaterThanOrEqual(1);
      expect(h).toBeLessThanOrEqual(3);
    });

    it('uses the MOST RECENT output when several exist', () => {
      seedTask('t3', 40);
      addOutput('t3', 20);
      addOutput('t3', 5);
      const h = getStalledHours(db, 't3');
      expect(h).toBeGreaterThanOrEqual(4);
      expect(h).toBeLessThanOrEqual(6);
    });

    it('returns 0 for a freshly-updated task', () => {
      seedTask('t4', 0);
      expect(getStalledHours(db, 't4')).toBe(0);
    });

    it('returns 0 for an unknown task id', () => {
      expect(getStalledHours(db, 'nope')).toBe(0);
    });
  });

  describe('listStalledTasks', () => {
    it('returns only in_progress tasks over the threshold, most stalled first', () => {
      seedTask('stale-old', 50);
      seedTask('stale-mid', 30);
      seedTask('fresh', 2);
      seedTask('done-old', 100, { status: 'completed' });   // not in_progress → ignored
      seedTask('pending-old', 100, { status: 'pending' });  // not in_progress → ignored

      const stalled = listStalledTasks(db, 'proj-1', DEFAULT_STALE_THRESHOLD_HOURS);
      expect(stalled.map(s => s.taskId)).toEqual(['stale-old', 'stale-mid']);
      expect(stalled[0]!.stalledHours).toBeGreaterThanOrEqual(stalled[1]!.stalledHours);
      expect(stalled[0]).toMatchObject({ taskId: 'stale-old', label: 'backend' });
    });

    it('honors a custom threshold', () => {
      seedTask('t-10h', 10);
      seedTask('t-40h', 40);
      expect(listStalledTasks(db, 'proj-1', 5).map(s => s.taskId).sort()).toEqual(['t-10h', 't-40h']);
      expect(listStalledTasks(db, 'proj-1', 20).map(s => s.taskId)).toEqual(['t-40h']);
    });

    it('returns [] when nothing is stalled', () => {
      seedTask('fresh', 1);
      expect(listStalledTasks(db, 'proj-1', DEFAULT_STALE_THRESHOLD_HOURS)).toEqual([]);
    });
  });
});
