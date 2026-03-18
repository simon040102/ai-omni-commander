import type { Project, ProjectStatus } from '@omni/shared';
import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

export function createProject(data: {
  id?: string;
  name: string;
  workingDir: string;
  frontendPath?: string | null;
  backendPath?: string | null;
  asanaProjectGid?: string | null;
  configJson?: string;
}): Project {
  const db = getDb();
  const id = data.id || genId();
  db.prepare(`
    INSERT INTO projects (id, name, working_dir, frontend_path, backend_path, asana_project_gid, config_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.name, data.workingDir, data.frontendPath || null, data.backendPath || null, data.asanaProjectGid || null, data.configJson || null);
  return getProject(id)!;
}

export function getProject(id: string): Project | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapProject(row);
}

export function listProjects(): Project[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(mapProject);
}

export function updateProject(id: string, data: Partial<{
  name: string;
  status: ProjectStatus;
  configJson: string;
  frontendPath: string | null;
  backendPath: string | null;
  asanaProjectGid: string | null;
  dbConnectionString: string | null;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name); }
  if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
  if (data.configJson !== undefined) { sets.push('config_json = ?'); values.push(data.configJson); }
  if (data.frontendPath !== undefined) { sets.push('frontend_path = ?'); values.push(data.frontendPath); }
  if (data.backendPath !== undefined) { sets.push('backend_path = ?'); values.push(data.backendPath); }
  if (data.asanaProjectGid !== undefined) { sets.push('asana_project_gid = ?'); values.push(data.asanaProjectGid); }
  if (data.dbConnectionString !== undefined) { sets.push('db_connection_string = ?'); values.push(data.dbConnectionString); }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteProject(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    status: row['status'] as ProjectStatus,
    workingDir: row['working_dir'] as string,
    frontendPath: (row['frontend_path'] as string | null) ?? null,
    backendPath: (row['backend_path'] as string | null) ?? null,
    asanaProjectGid: (row['asana_project_gid'] as string | null) ?? null,
    dbConnectionString: (row['db_connection_string'] as string | null) ?? null,
    configJson: row['config_json'] as string | null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
