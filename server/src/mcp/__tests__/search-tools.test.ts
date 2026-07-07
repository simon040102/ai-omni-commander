import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(true),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchTools } from '../tools/search-tools.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
}

function seedDoc(db: Database.Database, id: string, filename: string, parsedText: string | null) {
  db.prepare(`INSERT INTO documents (id, project_id, filename, file_path, parsed_text) VALUES (?, 'proj-1', ?, ?, ?)`)
    .run(id, filename, `/nonexistent/${filename}`, parsedText);
}

describe('search-tools', () => {
  let server: McpServer;
  let tmpDir: string;
  let savedDbPath: string | undefined;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerSearchTools(server);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-search-test-'));
    savedDbPath = process.env['DB_PATH'];
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (savedDbPath !== undefined) process.env['DB_PATH'] = savedDbPath;
    else delete process.env['DB_PATH'];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('search_documents', () => {
    it('searches parsed_text and pointer-referenced markdown files, case-insensitively', async () => {
      seedProject(testDb);
      seedDoc(testDb, 'doc-inline', 'inline.md', '第一行\n查詢按鈕：QueryButton\n第三行\n第四行');

      const mdPath = path.join(tmpDir, 'converted.md');
      fs.writeFileSync(mdPath, 'line1\nline2\nAPI path: /api/querybutton/list\nline4', 'utf-8');
      seedDoc(testDb, 'doc-md', '[SA] spec.docx', `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`);

      const result = await callTool(server, 'search_documents', { projectId: 'proj-1', query: 'QUERYBUTTON' });
      const data = JSON.parse(result.content[0].text);

      expect(data.hitCount).toBe(2);
      const files = data.hits.map((h: any) => h.filename);
      expect(files).toContain('inline.md');
      expect(files).toContain('[SA] spec.docx');
      // snippet contains 2 lines of context and marks the hit line
      const inlineHit = data.hits.find((h: any) => h.filename === 'inline.md');
      expect(inlineHit.line).toBe(2);
      expect(inlineHit.snippet).toContain('> 2| 查詢按鈕：QueryButton');
      expect(inlineHit.snippet).toContain('第四行');
    });

    it('collects unreadable pointer files into errors instead of failing', async () => {
      seedProject(testDb);
      seedDoc(testDb, 'doc-bad', 'bad.docx', '[Document saved at: /nonexistent/gone.md]');
      seedDoc(testDb, 'doc-ok', 'ok.txt', 'hello target world');

      const result = await callTool(server, 'search_documents', { projectId: 'proj-1', query: 'target' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.hitCount).toBe(1);
      expect(data.errors).toHaveLength(1);
      expect(data.errors[0]).toContain('bad.docx');
    });

    it('respects maxResults', async () => {
      seedProject(testDb);
      seedDoc(testDb, 'doc-many', 'many.txt', Array.from({ length: 10 }, (_, i) => `hit line ${i}`).join('\n'));
      const data = JSON.parse((await callTool(server, 'search_documents', { projectId: 'proj-1', query: 'hit', maxResults: 3 })).content[0].text);
      expect(data.hitCount).toBe(3);
      expect(data.truncated).toBe(true);
    });

    it('returns error for unknown project and a hint when no documents exist', async () => {
      const unknown = await callTool(server, 'search_documents', { projectId: 'nope', query: 'x' });
      expect(unknown.isError).toBe(true);

      seedProject(testDb);
      const empty = await callTool(server, 'search_documents', { projectId: 'proj-1', query: 'x' });
      expect(empty.content[0].text).toContain('沒有任何文件');
    });
  });

  describe('find_axure_snapshot', () => {
    function setupSnapshots(projectId: string, files: string[]) {
      // getDataDir() = dirname(DB_PATH); snapshots root = dataDir/../docs/axure-snapshots
      process.env['DB_PATH'] = path.join(tmpDir, 'data', 'omni.db');
      const dir = path.join(tmpDir, 'docs', 'axure-snapshots', projectId);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of files) fs.writeFileSync(path.join(dir, f), '<html></html>', 'utf-8');
      return dir;
    }

    it('finds html files by code prefix, case-insensitively', async () => {
      setupSnapshots('proj-1', ['WA05-list.html', 'wa05-edit.html', 'WA06-list.html', 'WA05-notes.txt']);

      const result = await callTool(server, 'find_axure_snapshot', { projectId: 'proj-1', code: 'wa05' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.files.every((f: string) => /wa05/i.test(path.basename(f)))).toBe(true);
      expect(data.files.every((f: string) => f.endsWith('.html'))).toBe(true);
    });

    it('distinguishes missing directory from no matching files', async () => {
      process.env['DB_PATH'] = path.join(tmpDir, 'data', 'omni.db');
      const missing = await callTool(server, 'find_axure_snapshot', { projectId: 'no-such-project', code: 'WA05' });
      expect(missing.content[0].text).toContain('目錄不存在');

      setupSnapshots('proj-1', ['DF01-list.html']);
      const noMatch = await callTool(server, 'find_axure_snapshot', { projectId: 'proj-1', code: 'WA05' });
      expect(noMatch.content[0].text).toContain('沒有以 "WA05" 開頭');
    });

    it('rejects path traversal in params', async () => {
      const result = await callTool(server, 'find_axure_snapshot', { projectId: '../etc', code: 'WA05' });
      expect(result.isError).toBe(true);
    });
  });
});
