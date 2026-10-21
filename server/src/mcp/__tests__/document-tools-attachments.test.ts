/**
 * fetch_task_attachments：原本只認 omni 裡的任務（taskId）；加 taskGid 後，
 * 不在 omni 裡的 Asana 單（別人的／未指派，用 browse_asana_tasks 查到的）也能抓附件。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDocumentTools } from '../tools/document-tools.js';
import { callTool } from './test-helpers.js';

function stubAsanaAttachments(taskGid: string, files: Array<{ gid: string; name: string; bytes: string }>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    if (u.includes(`/tasks/${taskGid}/attachments`)) return json({ data: files.map(f => ({ gid: f.gid, name: f.name, download_url: `https://dl.example/${f.gid}` })) });
    const att = u.match(/\/attachments\/([^/?]+)$/);
    if (att) {
      const f = files.find(x => x.gid === att[1]);
      return json({ data: { name: f?.name, download_url: `https://dl.example/${att[1]}` } });
    }
    const dl = u.match(/^https:\/\/dl\.example\/(.+)$/);
    if (dl) {
      const f = files.find(x => x.gid === dl[1])!;
      const buf = Buffer.from(f.bytes);
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  }));
  return calls;
}

describe('fetch_task_attachments', () => {
  let server: McpServer;
  let tmp: string;
  let prevDbPath: string | undefined;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-1', 'P', '/tmp')`).run();
    testDb.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'pat')`).run();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-att-'));
    prevDbPath = process.env['DB_PATH'];
    process.env['DB_PATH'] = path.join(tmp, 'omni.db');
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerDocumentTools(server);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevDbPath === undefined) delete process.env['DB_PATH']; else process.env['DB_PATH'] = prevDbPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('taskGid：不在 omni 裡的 Asana 單也能抓附件，存到 data/uploads/<專案>/asana_<gid>/', async () => {
    stubAsanaAttachments('9001', [{ gid: 'a1', name: '截圖.png', bytes: 'PNGDATA' }, { gid: 'a2', name: 'log.txt', bytes: 'hello' }]);
    const r = await callTool(server, 'fetch_task_attachments', { projectId: 'proj-1', taskGid: '9001' });
    expect(r.isError).toBeUndefined();
    const dir = path.join(tmp, 'uploads', 'proj-1', 'asana_9001');
    expect(fs.readFileSync(path.join(dir, '1-截圖.png'), 'utf-8')).toBe('PNGDATA');
    expect(fs.readFileSync(path.join(dir, '2-log.txt'), 'utf-8')).toBe('hello');
    expect(r.content[0].text).toContain('Downloaded 2 attachments');
    expect(r.content[0].text).toContain(dir.replace(/\\/g, '/'));
    // 不需要、也不會寫任何任務進 omni
    expect((testDb.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c).toBe(0);
  });

  it('taskId：原本的用法不變（任務的 source_ref 就是 Asana GID），存到 attachments_<taskId 前 8 碼>', async () => {
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, source, source_ref, description) VALUES ('task-12345678', 'proj-1', 'T', 'frontend', 'asana', '9002', '')`).run();
    stubAsanaAttachments('9002', [{ gid: 'b1', name: 'x.png', bytes: 'X' }]);
    const r = await callTool(server, 'fetch_task_attachments', { projectId: 'proj-1', taskId: 'task-12345678' });
    expect(r.isError).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'uploads', 'proj-1', 'attachments_task-123', '1-x.png'))).toBe(true);
  });

  it('taskId 與 taskGid 都沒給 → 錯誤；只給 taskId 但任務不存在 → 錯誤', async () => {
    expect((await callTool(server, 'fetch_task_attachments', { projectId: 'proj-1' })).isError).toBe(true);
    expect((await callTool(server, 'fetch_task_attachments', { projectId: 'proj-1', taskId: 'nope' })).isError).toBe(true);
  });

  it('沒有附件 → 明說沒有，不算錯誤', async () => {
    stubAsanaAttachments('9003', []);
    const r = await callTool(server, 'fetch_task_attachments', { projectId: 'proj-1', taskGid: '9003' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('No attachments');
  });
});
