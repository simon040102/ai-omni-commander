import { randomUUID } from 'node:crypto';
import { getDb } from '../connection.js';

export interface ProjectNote {
  id: string;
  projectId: string;
  category: string | null;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

function mapRow(r: Record<string, unknown>): ProjectNote {
  return {
    id: r['id'] as string,
    projectId: r['project_id'] as string,
    category: (r['category'] as string | null) ?? null,
    content: r['content'] as string,
    active: (r['active'] as number) === 1,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  };
}

/** Active experience notes for a project (前人踩坑教訓) — injected into execution plans. */
export function getActiveProjectNotes(projectId: string): ProjectNote[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project_id, category, content, active, created_at, updated_at
    FROM project_notes
    WHERE project_id = ? AND active = 1
    ORDER BY created_at ASC
  `).all(projectId) as Array<Record<string, unknown>>;

  return rows.map(mapRow);
}

/** All experience notes for a project, active and archived (Web UI panel). */
export function getAllProjectNotes(projectId: string): ProjectNote[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, project_id, category, content, active, created_at, updated_at
    FROM project_notes
    WHERE project_id = ?
    ORDER BY active DESC, created_at ASC
  `).all(projectId) as Array<Record<string, unknown>>;

  return rows.map(mapRow);
}

/** Create a new project note. Returns the stored note. */
export function createProjectNote(projectId: string, content: string, category?: string | null): ProjectNote {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO project_notes (id, project_id, category, content)
    VALUES (?, ?, ?, ?)
  `).run(id, projectId, category || null, content);

  const row = db.prepare(`
    SELECT id, project_id, category, content, active, created_at, updated_at
    FROM project_notes WHERE id = ?
  `).get(id) as Record<string, unknown>;
  return mapRow(row);
}

/** Archive a project note (soft delete, active=0). Returns the note or null when not found. */
export function archiveProjectNote(noteId: string): ProjectNote | null {
  const db = getDb();
  const result = db.prepare("UPDATE project_notes SET active = 0, updated_at = datetime('now') WHERE id = ?").run(noteId);
  if (result.changes === 0) return null;

  const row = db.prepare(`
    SELECT id, project_id, category, content, active, created_at, updated_at
    FROM project_notes WHERE id = ?
  `).get(noteId) as Record<string, unknown>;
  return mapRow(row);
}
