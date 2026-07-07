import { getDb } from '../connection.js';

/**
 * Upsert the SVN last-modified date of a spec file successfully fetched for a task.
 * Used by SvnSpecService (web path); the MCP fetch_svn_specs path writes the same
 * table directly. check_spec_changes compares these records against SVN later.
 */
export function recordTaskSpecVersion(taskId: string, fileRef: string, lastModified: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO task_spec_versions (task_id, file_ref, last_modified, recorded_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(taskId, fileRef, lastModified);
}
