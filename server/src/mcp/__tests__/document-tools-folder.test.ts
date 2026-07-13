/**
 * fetch_svn_specs — 本地資料夾規格來源整合測試。
 * 真 temp 資料夾 fixture（不 mock FolderSpecSource），驗證 documents /
 * task_documents / task_spec_versions 寫入與回應格式。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDocumentTools } from '../tools/document-tools.js';
import { callTool } from './test-helpers.js';

let tmpBase: string;
let specDir: string;
let specFilePath: string;
let originalDbPath: string | undefined;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProjectWithFolders(db: Database.Database, projectId: string, folders: Array<{ path: string; gitPull?: boolean }>) {
  db.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES (?, ?, ?, ?)`).run(
    projectId, 'Folder Test', '/tmp', JSON.stringify({ specFolders: folders }),
  );
}

function seedTask(db: Database.Database, taskId: string, projectId: string, parentName: string) {
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, parent_name) VALUES (?, ?, ?, ?, ?, ?)`).run(
    taskId, projectId, `${parentName} 查詢作業_前端`, 'frontend', 'feature', parentName,
  );
}

beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-folderspec-'));
  specDir = path.join(tmpBase, 'specs');
  fs.mkdirSync(specDir, { recursive: true });
  specFilePath = path.join(specDir, 'SPEC_WA05_查詢作業.md');
  fs.writeFileSync(specFilePath, '# WA05 查詢作業規格\n\n欄位：部門代碼', 'utf-8');

  // Point getDataDir() at a temp dir so uploads never land in the repo's data/
  originalDbPath = process.env['DB_PATH'];
  process.env['DB_PATH'] = path.join(tmpBase, 'data', 'omni.db');
  fs.mkdirSync(path.join(tmpBase, 'data'), { recursive: true });
});

afterAll(() => {
  if (originalDbPath === undefined) delete process.env['DB_PATH'];
  else process.env['DB_PATH'] = originalDbPath;
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('fetch_svn_specs — folder source', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerDocumentTools(server);
  });

  it('fetches specs from a configured local folder: documents + task_documents + task_spec_versions', async () => {
    seedProjectWithFolders(testDb, 'proj-f1', [{ path: specDir, gitPull: false }]);
    seedTask(testDb, 'task-f1', 'proj-f1', 'WA05');

    const result = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f1', taskId: 'task-f1' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain('Found 1 spec files for WA05');
    expect(text).toContain('(folder)');
    expect(text).toContain('SPEC_WA05_查詢作業.md');

    // documents row: source='folder', source_url = absolute path (forward slashes), version = mtime ISO
    const doc = testDb.prepare("SELECT * FROM documents WHERE project_id = 'proj-f1'").get() as any;
    expect(doc).toBeTruthy();
    expect(doc.source).toBe('folder');
    expect(doc.filename).toBe('[SD] SPEC_WA05_查詢作業.md');
    expect(doc.source_url).toBe(specFilePath.replace(/\\/g, '/'));
    expect(doc.svn_last_modified).toBe(fs.statSync(specFilePath).mtime.toISOString());
    expect(doc.parsed_text).toContain('WA05 查詢作業規格');
    expect(fs.existsSync(doc.file_path)).toBe(true);

    // task binding
    const binding = testDb.prepare("SELECT * FROM task_documents WHERE task_id = 'task-f1' AND document_id = ?").get(doc.id);
    expect(binding).toBeTruthy();

    // spec version record (file_ref = absolute path)
    const version = testDb.prepare("SELECT * FROM task_spec_versions WHERE task_id = 'task-f1'").get() as any;
    expect(version).toBeTruthy();
    expect(version.file_ref).toBe(specFilePath.replace(/\\/g, '/'));
    expect(version.last_modified).toBe(doc.svn_last_modified);
  });

  it('second fetch with unchanged file → dedupe (still one documents row)', async () => {
    seedProjectWithFolders(testDb, 'proj-f2', [{ path: specDir, gitPull: false }]);
    seedTask(testDb, 'task-f2', 'proj-f2', 'WA05');

    await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f2', taskId: 'task-f2' });
    const result2 = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f2', taskId: 'task-f2' });
    expect(result2.isError).toBeUndefined();

    const count = testDb.prepare("SELECT COUNT(*) AS cnt FROM documents WHERE project_id = 'proj-f2'").get() as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('docType is inferred from filename convention ([SA] tag)', async () => {
    const saDir = path.join(tmpBase, 'sa-specs');
    fs.mkdirSync(saDir, { recursive: true });
    fs.writeFileSync(path.join(saDir, 'WA06_SA_需求規格.md'), '# SA', 'utf-8');

    seedProjectWithFolders(testDb, 'proj-f3', [{ path: saDir, gitPull: false }]);
    seedTask(testDb, 'task-f3', 'proj-f3', 'WA06');

    const result = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f3', taskId: 'task-f3' });
    expect(result.content[0].text).toContain('[SA]');
    const doc = testDb.prepare("SELECT doc_type FROM documents WHERE project_id = 'proj-f3'").get() as any;
    expect(doc.doc_type).toBe('SA');
  });

  it('no spec sources configured at all → explicit error', async () => {
    testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-f4', 'None', '/tmp')`).run();
    seedTask(testDb, 'task-f4', 'proj-f4', 'WA05');

    const result = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f4', taskId: 'task-f4' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no spec sources configured');
  });

  it('folder does not exist → classified as error-level (Errors section), isError when nothing found', async () => {
    seedProjectWithFolders(testDb, 'proj-f5', [{ path: path.join(tmpBase, 'missing-folder'), gitPull: true }]);
    seedTask(testDb, 'task-f5', 'proj-f5', 'WA05');

    const result = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f5', taskId: 'task-f5' });
    expect(result.isError).toBe(true);
    const text = result.content[0].text as string;
    // 完全不可用的資料夾 → Errors 區塊（與 Web 端 errors 同級），不是 Warnings
    expect(text).toContain('Errors:');
    expect(text).toContain('不存在');
    expect(text).not.toContain('Warnings:');
  });

  it('matches by Chinese-name fallback when the filename has no function code (aligned with Web side)', async () => {
    const cnDir = path.join(tmpBase, 'cn-specs');
    fs.mkdirSync(cnDir, { recursive: true });
    fs.writeFileSync(path.join(cnDir, '收文單作業規格.md'), '# 收文單規格', 'utf-8');

    seedProjectWithFolders(testDb, 'proj-f7', [{ path: cnDir, gitPull: false }]);
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, parent_name) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'task-f7', 'proj-f7', 'DF01_收文單_前端', 'frontend', 'feature', 'DF01_收文單',
    );

    const result = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f7', taskId: 'task-f7' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('收文單作業規格.md');

    const doc = testDb.prepare("SELECT * FROM documents WHERE project_id = 'proj-f7'").get() as any;
    expect(doc).toBeTruthy();
    expect(doc.source).toBe('folder');
  });

  it('content unchanged but mtime changed → bump_version: one row, version refreshed (aligned with Web side)', async () => {
    const bumpDir = path.join(tmpBase, 'bump-specs');
    fs.mkdirSync(bumpDir, { recursive: true });
    const bumpFile = path.join(bumpDir, 'SPEC_WA07_列印作業.md');
    fs.writeFileSync(bumpFile, '# WA07 規格', 'utf-8');

    seedProjectWithFolders(testDb, 'proj-f8', [{ path: bumpDir, gitPull: false }]);
    seedTask(testDb, 'task-f8', 'proj-f8', 'WA07');

    await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f8', taskId: 'task-f8' });
    const before = testDb.prepare("SELECT id, svn_last_modified, parsed_text FROM documents WHERE project_id = 'proj-f8'").get() as any;

    // Touch mtime only — content identical
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(bumpFile, future, future);
    const newVersion = fs.statSync(bumpFile).mtime.toISOString();
    expect(newVersion).not.toBe(before.svn_last_modified);

    const result2 = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f8', taskId: 'task-f8' });
    expect(result2.isError).toBeUndefined();

    const rows = testDb.prepare("SELECT id, svn_last_modified, parsed_text FROM documents WHERE project_id = 'proj-f8'").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);                  // same document (no re-insert)
    expect(rows[0].svn_last_modified).toBe(newVersion);  // version bumped
    expect(rows[0].parsed_text).toBe(before.parsed_text); // content untouched

    const tsv = testDb.prepare("SELECT last_modified FROM task_spec_versions WHERE task_id = 'task-f8'").get() as any;
    expect(tsv.last_modified).toBe(newVersion);
  });

  it('no matching files for the function code → "No spec files found" listing spec folders', async () => {
    seedProjectWithFolders(testDb, 'proj-f6', [{ path: specDir, gitPull: false }]);
    // Title must not share a Chinese name with the fixture file (fallback matching)
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, parent_name) VALUES (?, ?, ?, ?, ?, ?)`).run(
      'task-f6', 'proj-f6', 'ZZ99 發票開立_前端', 'frontend', 'feature', 'ZZ99',
    );

    const result = await callTool(server, 'fetch_svn_specs', { projectId: 'proj-f6', taskId: 'task-f6' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('No spec files found');
    expect(result.content[0].text).toContain('Spec folders:');
  });
});
