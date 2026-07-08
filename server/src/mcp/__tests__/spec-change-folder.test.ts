/**
 * check_spec_changes — 本地資料夾規格來源的版本比對。
 * svn-status 整層 mock 成「svn CLI 不可用」：只有本地 file_ref 時不得 throw，
 * 版本比對走 FolderSpecSource（mtime / git date）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(undefined),
}));

// svn CLI 不可用 — 若有任何 remote ref 應 throw；只有本地 ref 則完全不需要 svn
vi.mock('../svn-status.js', () => ({
  getSvnCredentials: () => ({ username: '', password: '' }),
  isSvnCliAvailable: () => false,
  fetchRemoteLastModified: vi.fn(() => { throw new Error('svn unavailable'); }),
}));

import { runSpecChangeCheck, isLocalFileRef, specFileName } from '../spec-change.js';

let tmpBase: string;
let specDir: string;
let specFile: string;
let testDb: Database.Database;

beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'specchange-'));
  specDir = path.join(tmpBase, 'specs');
  fs.mkdirSync(specDir, { recursive: true });
  specFile = path.join(specDir, 'SPEC_WA05.md');
  fs.writeFileSync(specFile, '# v1', 'utf-8');
});

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database, opts: { specFolders?: Array<{ path: string; gitPull?: boolean }> } = {}) {
  db.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES ('proj-1', 'P', '/tmp', ?)`).run(
    JSON.stringify({ specFolders: opts.specFolders ?? [{ path: specDir, gitPull: false }] }),
  );
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-1', 'proj-1', 'WA05 查詢', 'frontend', 'feature')`).run();
}

function recordVersion(db: Database.Database, lastModified: string) {
  db.prepare(`
    INSERT OR REPLACE INTO task_spec_versions (task_id, file_ref, last_modified, recorded_at)
    VALUES ('task-1', ?, ?, datetime('now'))
  `).run(specFile.replace(/\\/g, '/'), lastModified);
}

describe('isLocalFileRef', () => {
  it('distinguishes local absolute paths from SVN URLs', () => {
    expect(isLocalFileRef('D:/specs/a.md')).toBe(true);
    expect(isLocalFileRef('D:\\specs\\a.md')).toBe(true);
    expect(isLocalFileRef('\\\\nas\\share\\a.md')).toBe(true);
    expect(isLocalFileRef('https://svn01.example.com/svn/Repo/a.docx')).toBe(false);
  });

  it('specFileName handles backslash paths', () => {
    expect(specFileName('D:\\specs\\SPEC_WA05.md')).toBe('SPEC_WA05.md');
    expect(specFileName('https://svn/x/SPEC%20A.docx')).toBe('SPEC A.docx');
  });
});

describe('runSpecChangeCheck — folder source', () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it('local ref unchanged → no change reported, svn CLI never required', async () => {
    seed(testDb);
    recordVersion(testDb, fs.statSync(specFile).mtime.toISOString());

    const result = await runSpecChangeCheck(testDb, [{ id: 'task-1', project_id: 'proj-1', title: 'WA05 查詢' }]);

    expect(result.filesChecked).toBe(1);
    expect(result.changedTotal).toBe(0);
    expect(result.tasks[0]!.unknown).toBeUndefined();
  });

  it('local ref with older recorded version → spec_changed gap + version bumped', async () => {
    seed(testDb);
    recordVersion(testDb, '2020-01-01T00:00:00.000Z');

    const result = await runSpecChangeCheck(testDb, [{ id: 'task-1', project_id: 'proj-1', title: 'WA05 查詢' }]);

    expect(result.changedTotal).toBe(1);
    expect(result.tasks[0]!.changed[0]!.filename).toBe('SPEC_WA05.md');
    expect(result.tasks[0]!.changed[0]!.current).toBe(fs.statSync(specFile).mtime.toISOString());

    const gap = testDb.prepare("SELECT * FROM spec_gaps WHERE task_id = 'task-1'").get() as any;
    expect(gap.category).toBe('spec_changed');
    expect(gap.description).toContain('SPEC_WA05.md');

    const v = testDb.prepare("SELECT last_modified FROM task_spec_versions WHERE task_id = 'task-1'").get() as any;
    expect(v.last_modified).toBe(fs.statSync(specFile).mtime.toISOString());
  });

  it('folder removed from project config → file reported as unknown, never "no change"', async () => {
    seed(testDb, { specFolders: [] });
    recordVersion(testDb, '2020-01-01T00:00:00.000Z');

    const result = await runSpecChangeCheck(testDb, [{ id: 'task-1', project_id: 'proj-1', title: 'WA05 查詢' }]);

    expect(result.changedTotal).toBe(0);
    expect(result.tasks[0]!.unknown).toEqual(['SPEC_WA05.md']);
    expect(result.tasks[0]!.unknownNote).toContain('不視為未變更');
  });

  it('remote SVN ref present while svn CLI unavailable → throws loudly', async () => {
    seed(testDb);
    testDb.prepare(`
      INSERT INTO task_spec_versions (task_id, file_ref, last_modified, recorded_at)
      VALUES ('task-1', 'https://svn01.example.com/svn/Repo/SPEC.docx', '2020-01-01', datetime('now'))
    `).run();

    await expect(
      runSpecChangeCheck(testDb, [{ id: 'task-1', project_id: 'proj-1', title: 'WA05 查詢' }]),
    ).rejects.toThrow(/svn CLI/);
  });
});
