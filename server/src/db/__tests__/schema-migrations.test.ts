import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

/**
 * v12/v13/v17 table-rebuild migrations: simulate an OLD DB (6-value spec_gaps CHECK,
 * 3-value documents CHECK), re-run migrations, and verify data survives and the
 * new CHECK values (spec_changed / verification / sa_sd_mismatch) are accepted.
 */
describe('schema migrations (v10–v17)', () => {
  function oldShapeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Downgrade spec_gaps and documents to the pre-v12/v13 shape
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      DROP TABLE spec_gaps;
      CREATE TABLE spec_gaps (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category        TEXT NOT NULL CHECK(category IN ('sa_missing', 'sd_missing', 'field_undefined',
                                                          'api_undefined', 'logic_unclear', 'other')),
        description     TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
        resolution_note TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT
      );
      DROP TABLE documents;
      CREATE TABLE documents (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename      TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        file_type     TEXT,
        doc_type      TEXT CHECK(doc_type IN ('SA', 'SD', 'other')) DEFAULT 'other',
        parsed_text   TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        source        TEXT NOT NULL DEFAULT 'upload',
        source_url    TEXT,
        svn_last_modified TEXT,
        content_hash  TEXT
      );
    `);
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  }

  it('rebuilds spec_gaps/documents with extended CHECKs, keeping existing rows', () => {
    const db = oldShapeDb();
    db.prepare("INSERT INTO projects (id, name, working_dir) VALUES ('p1','P','/tmp')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t1','p1','T','frontend','other')").run();
    db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('g1','t1','p1','other','old gap')").run();
    db.prepare("INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES ('d1','p1','f.md','/tmp/f.md','SA')").run();
    db.prepare("INSERT INTO task_documents (task_id, document_id) VALUES ('t1','d1')").run();

    // Old CHECKs reject the new values before migration
    expect(() => db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('gx','t1','p1','spec_changed','x')").run()).toThrow();
    expect(() => db.prepare("INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES ('dx','p1','e.png','/tmp/e.png','verification')").run()).toThrow();

    runMigrations(db); // triggers v12 + v13 rebuilds

    // Existing rows survive
    expect((db.prepare("SELECT description FROM spec_gaps WHERE id='g1'").get() as any).description).toBe('old gap');
    expect((db.prepare("SELECT doc_type FROM documents WHERE id='d1'").get() as any).doc_type).toBe('SA');
    expect(db.prepare("SELECT 1 FROM task_documents WHERE task_id='t1' AND document_id='d1'").get()).toBeTruthy();

    // New values now accepted
    db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('g2','t1','p1','spec_changed','changed')").run();
    db.prepare("INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES ('d2','p1','e.png','/tmp/e.png','verification')").run();

    // Idempotent: another run keeps all rows
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) as c FROM spec_gaps').get() as any).c).toBe(2);
    expect((db.prepare('SELECT COUNT(*) as c FROM documents').get() as any).c).toBe(2);
  });

  it('v17: rebuilds a 7-value spec_gaps CHECK to accept sa_sd_mismatch, keeping existing rows', () => {
    // Simulate a post-v12 / pre-v17 DB: spec_gaps has 'spec_changed' but not 'sa_sd_mismatch'
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      DROP TABLE spec_gaps;
      CREATE TABLE spec_gaps (
        id              TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        category        TEXT NOT NULL CHECK(category IN ('sa_missing', 'sd_missing', 'field_undefined',
                                                          'api_undefined', 'logic_unclear', 'other', 'spec_changed')),
        description     TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
        resolution_note TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at     TEXT
      );
    `);
    db.exec('PRAGMA foreign_keys = ON');

    db.prepare("INSERT INTO projects (id, name, working_dir) VALUES ('p1','P','/tmp')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t1','p1','T','frontend','other')").run();
    db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('g1','t1','p1','spec_changed','old gap')").run();

    // The 7-value CHECK rejects the new value before migration
    expect(() => db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('gx','t1','p1','sa_sd_mismatch','x')").run()).toThrow();

    runMigrations(db); // triggers the v17 rebuild (v12 skips: 'spec_changed' already present)

    // Existing row survives
    expect((db.prepare("SELECT description FROM spec_gaps WHERE id='g1'").get() as any).description).toBe('old gap');

    // New value now accepted
    db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('g2','t1','p1','sa_sd_mismatch','SA 說必填 vs SD optional')").run();

    // Indexes recreated
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='spec_gaps'").all() as any[];
    expect(indexes.map(i => i.name)).toEqual(expect.arrayContaining(['idx_spec_gaps_project', 'idx_spec_gaps_task', 'idx_spec_gaps_status']));

    // Idempotent: another run keeps all rows
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) as c FROM spec_gaps').get() as any).c).toBe(2);
  });

  it('runs table rebuilds inside a transaction (atomic — no half-rebuilt table)', () => {
    // Source-level guard: every DROP/RENAME rebuild block must be wrapped in
    // BEGIN IMMEDIATE … COMMIT (PRAGMA foreign_keys stays outside — it is a
    // no-op inside a transaction).
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schema.ts'), 'utf-8');
    const rebuildBlocks = src.match(/BEGIN IMMEDIATE;/g) || [];
    // agents + tasks + spec_gaps(v12) + documents(v13) + spec_gaps(v17)
    expect(rebuildBlocks.length).toBe(5);
    expect((src.match(/\bCOMMIT;/g) || []).length).toBe(5);
    // No rebuild exec string may contain PRAGMA foreign_keys (must stay outside the tx)
    for (const block of src.split('BEGIN IMMEDIATE;').slice(1)) {
      const body = block.split('COMMIT;')[0]!;
      expect(body).not.toContain('PRAGMA foreign_keys');
    }

    // Behavioral: full migration on an old-shape DB completes with data intact,
    // no dangling open transaction, and FK enforcement restored.
    const db = oldShapeDb();
    db.prepare("INSERT INTO projects (id, name, working_dir) VALUES ('p1','P','/tmp')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t1','p1','T','frontend','other')").run();
    db.prepare("INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('g1','t1','p1','other','g')").run();
    runMigrations(db);
    expect(db.inTransaction).toBe(false);
    expect((db.prepare('SELECT COUNT(*) as c FROM spec_gaps').get() as any).c).toBe(1);
    expect((db.pragma('foreign_keys') as any[])[0].foreign_keys).toBe(1);
  });

  it('creates idx_agent_outputs_task index (idempotent)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db); // idempotent
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_outputs'").all() as any[];
    expect(indexes.map(i => i.name)).toEqual(expect.arrayContaining(['idx_agent_outputs_agent', 'idx_agent_outputs_task']));
  });

  it('v18: adds tasks.due_date on old DBs (ALTER), keeps data, and is idempotent', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    // Simulate a pre-v18 DB: drop the column that the new base CREATE provides
    db.exec('ALTER TABLE tasks DROP COLUMN due_date');
    expect((db.prepare('PRAGMA table_info(tasks)').all() as any[]).some(c => c.name === 'due_date')).toBe(false);

    db.prepare("INSERT INTO projects (id, name, working_dir) VALUES ('p1','P','/tmp')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t1','p1','T','frontend','other')").run();

    runMigrations(db); // v18 ALTER TABLE ADD COLUMN

    const cols = db.prepare('PRAGMA table_info(tasks)').all() as any[];
    expect(cols.some(c => c.name === 'due_date')).toBe(true);
    // Existing rows survive with NULL due_date
    const row = db.prepare("SELECT title, due_date FROM tasks WHERE id='t1'").get() as any;
    expect(row.title).toBe('T');
    expect(row.due_date).toBeNull();

    // Column accepts YYYY-MM-DD values
    db.prepare("UPDATE tasks SET due_date = '2026-07-25' WHERE id='t1'").run();
    expect((db.prepare("SELECT due_date FROM tasks WHERE id='t1'").get() as any).due_date).toBe('2026-07-25');

    // Idempotent: another run keeps the column and the data
    runMigrations(db);
    expect((db.prepare("SELECT due_date FROM tasks WHERE id='t1'").get() as any).due_date).toBe('2026-07-25');
  });

  it('fresh DBs get tasks.due_date from the base CREATE TABLE', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(tasks)').all() as any[];
    expect(cols.filter(c => c.name === 'due_date')).toHaveLength(1);
  });

  it('creates project_notes and task_spec_versions tables', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    db.prepare("INSERT INTO projects (id, name, working_dir) VALUES ('p1','P','/tmp')").run();
    db.prepare("INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t1','p1','T','frontend','other')").run();

    db.prepare("INSERT INTO project_notes (id, project_id, category, content) VALUES ('n1','p1','ui','note')").run();
    const note = db.prepare("SELECT * FROM project_notes WHERE id='n1'").get() as any;
    expect(note.active).toBe(1);

    db.prepare("INSERT INTO task_spec_versions (task_id, file_ref, last_modified) VALUES ('t1','https://svn/x.docx','2026-01-01')").run();
    // upsert on same (task_id, file_ref)
    db.prepare("INSERT OR REPLACE INTO task_spec_versions (task_id, file_ref, last_modified) VALUES ('t1','https://svn/x.docx','2026-02-02')").run();
    const rows = db.prepare("SELECT * FROM task_spec_versions WHERE task_id='t1'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].last_modified).toBe('2026-02-02');
  });
});
