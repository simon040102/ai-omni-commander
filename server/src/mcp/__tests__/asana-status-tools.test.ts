/**
 * update_asana_task_status — 改 Asana 任務的狀態欄位（單選自訂欄位，如「處理狀態」）。
 * 欄位與選項從任務本身讀、完全相符才改，對不到回錯不猜；不碰分區、不碰完成勾選。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAsanaStatusTools } from '../tools/asana-status-tools.js';
import { callTool } from './test-helpers.js';

const URL_T1 = 'https://app.asana.com/0/pg-1/t1';
interface Call { method: string; url: string; body: unknown }

function stubAsana(opts: { current?: string | null; failPut?: boolean } = {}) {
  const calls: Call[] = [];
  const current = opts.current === undefined ? '處理中' : opts.current;
  const options = [
    { gid: 'opt-todo', name: '代辦', enabled: true },
    { gid: 'opt-doing', name: '處理中', enabled: true },
    { gid: 'opt-test', name: '待測試', enabled: true },
    { gid: 'opt-old', name: '舊狀態', enabled: false },
  ];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ method, url: u, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => b, text: async () => '' });
    const bad = (status: number, text: string) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}), text: async () => text });
    if (method === 'GET' && /\/tasks\/t1\?/.test(u)) {
      return ok({ data: {
        gid: 't1', name: 'ODAS-120 查詢失效', permalink_url: URL_T1,
        custom_fields: [
          { gid: 'cf-no', name: '問題單號', resource_subtype: 'text', display_value: 'ODAS-120' },
          { gid: 'cf-st', name: '處理狀態', resource_subtype: 'enum', enum_value: current ? options.find(o => o.name === current) : null, display_value: current, enum_options: options },
        ],
      } });
    }
    if (method === 'PUT' && /\/tasks\/t1$/.test(u)) return opts.failPut ? bad(403, 'forbidden') : ok({ data: { gid: 't1' } });
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }));
  return calls;
}
const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET');

describe('update_asana_task_status', () => {
  let server: McpServer;
  let tmpDir: string;
  let savedDbPath: string | undefined;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES ('p1', 'P', '/tmp', 'pg-1')`).run();
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, source, source_ref) VALUES ('omni-t1', 'p1', 'ODAS-120', 'frontend', 'asana', 't1')`).run();
    testDb.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'pat')`).run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asana-status-'));
    savedDbPath = process.env['DB_PATH'];
    process.env['DB_PATH'] = path.join(tmpDir, 'omni.db');
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerAsanaStatusTools(server);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedDbPath === undefined) delete process.env['DB_PATH']; else process.env['DB_PATH'] = savedDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = { taskGid: 't1', field: '處理狀態' };
  const send = (args: Record<string, unknown>) =>
    callTool(server, 'update_asana_task_status', { ...base, userApproved: true, approvalNote: '使用者說：改待測試', ...args });

  it('dryRun：列出單名、網址、從哪個狀態改成哪個，不打寫入 API、不需要 userApproved', async () => {
    const calls = stubAsana();
    const r = await callTool(server, 'update_asana_task_status', { ...base, status: '待測試', dryRun: true });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out.preview).toMatchObject({ task: 'ODAS-120 查詢失效', url: URL_T1, field: '處理狀態', from: '處理中', to: '待測試' });
    expect(writes(calls)).toHaveLength(0);
  });

  it('正式送出：PUT 只帶該欄位的選項 GID（不碰分區、不碰完成勾選），回報從→到', async () => {
    const calls = stubAsana();
    const r = await send({ status: '待測試' });
    expect(r.isError).toBeUndefined();
    const ws = writes(calls);
    expect(ws).toHaveLength(1);
    expect(ws[0]!.method).toBe('PUT');
    expect(ws[0]!.body).toEqual({ data: { custom_fields: { 'cf-st': 'opt-test' } } });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, from: '處理中', to: '待測試', url: URL_T1 });
  });

  it('沒有 userApproved 的正式送出 → 拒絕，不打任何 API', async () => {
    const calls = stubAsana();
    const r = await callTool(server, 'update_asana_task_status', { ...base, status: '待測試' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('userApproved');
    expect(calls).toHaveLength(0);
  });

  it('選項對不到或已停用 → 回錯列出可用選項（不含停用的），不寫入', async () => {
    for (const s of ['已修復', '舊狀態']) {
      const calls = stubAsana();
      const r = await send({ status: s });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('待測試');
      expect(r.content[0].text).not.toContain('舊狀態」、');
      expect(writes(calls)).toHaveLength(0);
    }
  });

  it('欄位名稱對不到、或不是單選欄位 → 回錯列出這張單的單選欄位，不寫入', async () => {
    let calls = stubAsana();
    let r = await send({ field: '狀態', status: '待測試' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('處理狀態');
    expect(writes(calls)).toHaveLength(0);
    calls = stubAsana();
    r = await send({ field: '問題單號', status: '待測試' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('不是單選');
    expect(writes(calls)).toHaveLength(0);
  });

  it('已經是該狀態 → 不送出，回報不必修改', async () => {
    const calls = stubAsana({ current: '待測試' });
    const r = await send({ status: '待測試' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, changed: false });
    expect(writes(calls)).toHaveLength(0);
  });

  it('Asana 拒絕 → 回原始錯誤訊息', async () => {
    stubAsana({ failPut: true });
    const r = await send({ status: '待測試' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('403');
  });

  it('用 omni taskId 也可以；改成功寫稽核檔＋該任務的 [ASANA_STATUS] 紀錄', async () => {
    stubAsana({ current: null });
    const r = await callTool(server, 'update_asana_task_status', { taskId: 'omni-t1', field: '處理狀態', status: '代辦', userApproved: true, approvalNote: '使用者說：改代辦' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ from: null, to: '代辦' });
    const audit = fs.readFileSync(path.join(tmpDir, 'audit', 'asana-status.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit[0]).toMatchObject({ taskGid: 't1', field: '處理狀態', from: null, to: '代辦', approvalNote: '使用者說：改代辦' });
    const log = testDb.prepare(`SELECT content FROM agent_outputs WHERE task_id = 'omni-t1'`).all() as Array<{ content: string }>;
    expect(log.some(l => l.content.startsWith('[ASANA_STATUS]') && l.content.includes('（空） → 代辦') && l.content.includes('使用者說：改代辦'))).toBe(true);
  });
});
