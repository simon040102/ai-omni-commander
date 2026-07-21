/**
 * SvnSpecService.fetchFolderSpecsForTask — Web 端本地資料夾規格來源整合測試。
 * 與 MCP 端（document-tools-folder.test.ts）驗同樣的三個對齊決策：
 * 中文名 fallback、content_hash 去重（bump_version）、prepare 失敗歸類（error 級）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDb: () => testDb,
}));

import { DocumentParser } from '../../documents/DocumentParser.js';
import { SvnSpecService } from '../SvnSpecService.js';

let tmpBase: string;
let uploadsDir: string;
let cacheDir: string;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database, projectId: string, taskId: string, parentName: string, title: string) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run(projectId, 'Web Folder Test', '/tmp');
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, parent_name) VALUES (?, ?, ?, 'frontend', 'feature', ?)`)
    .run(taskId, projectId, title, parentName);
}

beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'web-folderspec-'));
  uploadsDir = path.join(tmpBase, 'uploads');
  cacheDir = path.join(tmpBase, 'svn-cache');
});

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SvnSpecService.fetchFolderSpecsForTask (folder source, Web side)', () => {
  let svc: SvnSpecService;

  beforeEach(() => {
    testDb = freshDb();
    svc = new SvnSpecService(new DocumentParser(uploadsDir), cacheDir);
  });

  it('matches by Chinese-name fallback when the filename has no function code', async () => {
    const specDir = path.join(tmpBase, 'cn-specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, '收文單作業規格.md'), '# 收文單規格', 'utf-8');

    seed(testDb, 'proj-w1', 'task-w1', 'DF01_收文單', 'DF01_收文單_前端');

    const r = await svc.fetchFolderSpecsForTask(
      'proj-w1', 'task-w1', 'DF01_收文單', [{ path: specDir, gitPull: false }], 'frontend', 'DF01_收文單_前端',
    );

    expect(r.errors).toEqual([]);
    expect(r.docIds).toHaveLength(1);
    const doc = testDb.prepare("SELECT * FROM documents WHERE project_id = 'proj-w1'").get() as any;
    expect(doc.source).toBe('folder');
    expect(doc.filename).toContain('收文單作業規格.md');
    expect(doc.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('content unchanged but version (mtime) changed → bump_version: one row, version refreshed', async () => {
    const specDir = path.join(tmpBase, 'bump-specs');
    fs.mkdirSync(specDir, { recursive: true });
    const filePath = path.join(specDir, 'SPEC_WA05_查詢作業.md');
    fs.writeFileSync(filePath, '# WA05 規格', 'utf-8');

    seed(testDb, 'proj-w2', 'task-w2', 'WA05', 'WA05 查詢作業_前端');
    const folders = [{ path: specDir, gitPull: false }];

    const r1 = await svc.fetchFolderSpecsForTask('proj-w2', 'task-w2', 'WA05', folders, 'frontend');
    expect(r1.docIds).toHaveLength(1);
    const before = testDb.prepare("SELECT id, svn_last_modified, parsed_text FROM documents WHERE project_id = 'proj-w2'").get() as any;

    // Touch mtime only — content identical
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(filePath, future, future);
    const newVersion = fs.statSync(filePath).mtime.toISOString();
    expect(newVersion).not.toBe(before.svn_last_modified);

    const r2 = await svc.fetchFolderSpecsForTask('proj-w2', 'task-w2', 'WA05', folders, 'frontend');
    expect(r2.errors).toEqual([]);
    expect(r2.docIds).toEqual([before.id]);

    const rows = testDb.prepare("SELECT id, svn_last_modified, parsed_text FROM documents WHERE project_id = 'proj-w2'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);           // same document (no re-insert)
    expect(rows[0].svn_last_modified).toBe(newVersion); // version bumped
    expect(rows[0].parsed_text).toBe(before.parsed_text); // content untouched

    // task_spec_versions follows the new version
    const tsv = testDb.prepare("SELECT last_modified FROM task_spec_versions WHERE task_id = 'task-w2'").get() as any;
    expect(tsv.last_modified).toBe(newVersion);
  });

  it('same version on re-fetch → skip: still one row, binding restored', async () => {
    const specDir = path.join(tmpBase, 'skip-specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'SPEC_WA06_維護作業.md'), '# WA06', 'utf-8');

    seed(testDb, 'proj-w3', 'task-w3', 'WA06', 'WA06 維護作業_前端');
    const folders = [{ path: specDir, gitPull: false }];

    await svc.fetchFolderSpecsForTask('proj-w3', 'task-w3', 'WA06', folders, 'frontend');
    const r2 = await svc.fetchFolderSpecsForTask('proj-w3', 'task-w3', 'WA06', folders, 'frontend');
    expect(r2.docIds).toHaveLength(1);
    const count = testDb.prepare("SELECT COUNT(*) AS cnt FROM documents WHERE project_id = 'proj-w3'").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('.html Axure 原型 → 綁為 doc_type=other、[HTML] 標記、原樣存不轉檔', async () => {
    const specDir = path.join(tmpBase, 'html-specs');
    fs.mkdirSync(specDir, { recursive: true });
    const htmlPath = path.join(specDir, 'SM009_系統參數放行.html');
    const htmlBody = '<html><body>系統參數放行原型</body></html>';
    fs.writeFileSync(htmlPath, htmlBody, 'utf-8');
    // 同資料夾另放真 SA 規格，驗證 HTML 不會取代 SA
    fs.writeFileSync(path.join(specDir, 'SM009_SA_需求規格.md'), '# SM009 SA', 'utf-8');

    seed(testDb, 'proj-w5', 'task-w5', 'SM009', 'SM009 系統參數放行_前端');

    const r = await svc.fetchFolderSpecsForTask(
      'proj-w5', 'task-w5', 'SM009', [{ path: specDir, gitPull: false }], 'frontend',
    );
    expect(r.errors).toEqual([]);
    expect(r.docIds).toHaveLength(2);

    const html = testDb.prepare(
      "SELECT * FROM documents WHERE project_id = 'proj-w5' AND filename LIKE '%.html'",
    ).get() as any;
    expect(html).toBeTruthy();
    expect(html.doc_type).toBe('other');           // HTML 歸 other，不充當 SA/SD
    expect(html.filename).toBe('[HTML] SM009_系統參數放行.html');
    expect(html.parsed_text).toContain('[HTML file - use Read tool to view:');
    // 原樣存：磁碟檔案內容與原始 HTML 完全一致（未轉 md）
    expect(fs.readFileSync(html.file_path, 'utf-8')).toBe(htmlBody);
    expect(fs.existsSync(html.file_path.replace(/\.html$/, '.md'))).toBe(false);

    // 真 SA 規格仍以 SA 綁定（前端規格齊全檢查靠這個，HTML 不充數）
    const sa = testDb.prepare(
      "SELECT doc_type FROM documents WHERE project_id = 'proj-w5' AND filename LIKE '%.md'",
    ).get() as any;
    expect(sa.doc_type).toBe('SA');
  });

  it('unusable folder (missing path) → classified as error, not warning', async () => {
    seed(testDb, 'proj-w4', 'task-w4', 'WA05', 'WA05 查詢作業_前端');

    const r = await svc.fetchFolderSpecsForTask(
      'proj-w4', 'task-w4', 'WA05', [{ path: path.join(tmpBase, 'nope'), gitPull: true }], 'frontend',
    );

    expect(r.docIds).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('不存在');
    expect(r.warnings).toEqual([]);
  });
});
