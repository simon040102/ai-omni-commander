import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

function createFreshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('schema.ts — runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFreshDb();
  });

  it('creates all v2 tables on a blank database', () => {
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);

    expect(names).toContain('projects');
    expect(names).toContain('agents');
    expect(names).toContain('tasks');
    expect(names).toContain('task_dependencies');
    expect(names).toContain('events');
    expect(names).toContain('agent_outputs');
    expect(names).toContain('documents');
    expect(names).toContain('interventions');
    expect(names).toContain('agent_plans');
    expect(names).toContain('recent_paths');
    expect(names).toContain('workspace_skills');
  });

  it('projects table has v2 columns (frontend_path, backend_path, no mode)', () => {
    runMigrations(db);

    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);

    expect(colNames).toContain('frontend_path');
    expect(colNames).toContain('backend_path');
    expect(colNames).toContain('asana_project_gid');
    expect(colNames).not.toContain('mode');
  });

  it('tasks table has v2 columns (task_type, source, source_ref, branch_name)', () => {
    runMigrations(db);

    const cols = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);

    expect(colNames).toContain('task_type');
    expect(colNames).toContain('source');
    expect(colNames).toContain('source_ref');
    expect(colNames).toContain('branch_name');
  });

  it('workspace_skills table exists and can be written to', () => {
    runMigrations(db);

    // Create a project first (foreign key)
    db.prepare("INSERT INTO projects (id, name, working_dir) VALUES ('p1', 'Test', '/tmp')").run();

    db.prepare(`
      INSERT INTO workspace_skills (project_id, workspace_type, path, has_claude_md, has_claude_dir, skills_json)
      VALUES ('p1', 'frontend', '/tmp/fe', 1, 0, '[]')
    `).run();

    const row = db.prepare('SELECT * FROM workspace_skills WHERE project_id = ?').get('p1') as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row['workspace_type']).toBe('frontend');
    expect(row['has_claude_md']).toBe(1);
  });

  it('is idempotent — running twice does not error', () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('v1→v2 migration: rebuilds projects table and extracts workspace paths', () => {
    // Simulate a v1 database with 'mode' column
    db.exec(`
      CREATE TABLE projects (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        mode          TEXT NOT NULL DEFAULT 'spec',
        status        TEXT NOT NULL DEFAULT 'setup',
        working_dir   TEXT NOT NULL,
        config_json   TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Insert a v1 project with workspaces in config_json
    const config = JSON.stringify({
      workspaces: [
        { label: 'frontend', path: '/app/web' },
        { label: 'backend', path: '/app/server' },
      ],
    });
    db.prepare(
      "INSERT INTO projects (id, name, mode, status, working_dir, config_json) VALUES (?, ?, ?, ?, ?, ?)"
    ).run('proj-1', 'My Project', 'spec', 'completed', '/app', config);

    // Run migrations — should detect v1 and migrate
    runMigrations(db);

    // Verify mode column is gone
    const cols = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('mode');
    expect(colNames).toContain('frontend_path');
    expect(colNames).toContain('backend_path');

    // Verify data survived migration
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-1') as Record<string, unknown>;
    expect(proj).toBeTruthy();
    expect(proj['name']).toBe('My Project');
    expect(proj['frontend_path']).toBe('/app/web');
    expect(proj['backend_path']).toBe('/app/server');
    // 'completed' status migrated to 'idle'
    expect(proj['status']).toBe('idle');
  });

  it('v1→v2 migration: interviewing status becomes idle', () => {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'spec',
        status TEXT NOT NULL DEFAULT 'setup', working_dir TEXT NOT NULL,
        config_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    db.prepare(
      "INSERT INTO projects (id, name, mode, status, working_dir) VALUES (?, ?, ?, ?, ?)"
    ).run('proj-2', 'Interview Proj', 'creative', 'interviewing', '/app');

    runMigrations(db);

    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get('proj-2') as Record<string, unknown>;
    expect(proj['status']).toBe('idle');
  });

  it('projects table enforces valid status values', () => {
    runMigrations(db);

    expect(() => {
      db.prepare("INSERT INTO projects (id, name, working_dir, status) VALUES ('x', 'x', '/x', 'invalid_status')").run();
    }).toThrow();
  });
});
