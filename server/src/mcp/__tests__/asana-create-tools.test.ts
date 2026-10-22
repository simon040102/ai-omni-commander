/**
 * create_asana_task — 在 Asana 建任務（客戶看得到）。分區、自訂欄位一律照名稱對，對不到就回錯不猜；
 * dryRun 只預覽不打寫入 API；部分成功要逐步列出，不可整體回 ok。
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
import { registerAsanaCreateTools } from '../tools/asana-create-tools.js';
import { callTool } from './test-helpers.js';

const ME = 'me-gid';
const NEW_URL = 'https://app.asana.com/0/pg-1/new-1';
const REL_URL = 'https://app.asana.com/0/pg-1/rel-1';

interface Call { method: string; url: string; body: unknown }

function stubAsana(opts: { failAttachment?: boolean; failStory?: boolean; failCreate?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({ method, url: u, body });
    const ok = (b: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => b, text: async () => '' });
    const bad = (status: number, text: string) => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}), text: async () => text });

    if (u.includes('/users/me')) return ok({ data: { gid: ME } });
    if (u.includes('/projects/pg-1/sections')) return ok({ data: [{ gid: 's-bug', name: '問題回報單' }, { gid: 's-doc', name: '公文' }, { gid: 's-bug2', name: '問題回報單（已結案）' }] });
    if (u.includes('/projects/pg-1/custom_field_settings')) return ok({ data: [
      { custom_field: { gid: 'cf-no', name: '問題單號', resource_subtype: 'text' } },
      { custom_field: { gid: 'cf-st', name: '處理狀態', resource_subtype: 'enum', enum_options: [
        { gid: 'opt-todo', name: '待處理', enabled: true }, { gid: 'opt-doing', name: '處理中', enabled: true }, { gid: 'opt-old', name: '已停用', enabled: false },
      ] } },
    ] });
    if (method === 'GET' && /\/tasks\/rel-1\?/.test(u)) return ok({ data: { gid: 'rel-1', name: '原單', permalink_url: REL_URL } });
    if (method === 'POST' && u.endsWith('/tasks')) {
      if (opts.failCreate) return bad(400, '{"errors":[{"message":"custom_fields: Invalid field"}]}');
      return ok({ data: { gid: 'new-1', permalink_url: NEW_URL, name: 'x' } });
    }
    if (method === 'POST' && /\/tasks\/new-1\/attachments$/.test(u)) {
      return opts.failAttachment ? bad(500, 'upload broke') : ok({ data: { gid: 'att-1', name: 'shot.png', permanent_url: 'https://asana/att-1' } });
    }
    if (method === 'POST' && /\/tasks\/rel-1\/stories$/.test(u)) {
      return opts.failStory ? bad(403, 'forbidden') : ok({ data: { gid: 'story-1' } });
    }
    throw new Error(`unexpected fetch: ${method} ${u}`);
  }));
  return calls;
}

const writes = (calls: Call[]) => calls.filter(c => c.method !== 'GET');

describe('create_asana_task', () => {
  let server: McpServer;
  let tmpDir: string;
  let savedDbPath: string | undefined;
  let imgPath: string;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES ('p1', 'P', '/tmp', 'pg-1')`).run();
    testDb.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'pat')`).run();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asana-create-'));
    savedDbPath = process.env['DB_PATH'];
    process.env['DB_PATH'] = path.join(tmpDir, 'omni.db'); // 稽核檔寫進隔離的 data dir
    imgPath = path.join(tmpDir, 'shot.png');
    fs.writeFileSync(imgPath, Buffer.from('89504e470d0a1a0a', 'hex'));
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerAsanaCreateTools(server);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedDbPath === undefined) delete process.env['DB_PATH']; else process.env['DB_PATH'] = savedDbPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const base = { projectId: 'p1', name: '新單標題', notes: '問題描述' };
  const send = (args: Record<string, unknown>) =>
    callTool(server, 'create_asana_task', { ...base, userApproved: true, approvalNote: '使用者說：開吧', ...args });

  it('分區對不到 → 回錯並列出可用分區，不打任何寫入 API（也不自動建分區）', async () => {
    const calls = stubAsana();
    const r = await send({ section: '不存在的區' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('問題回報單');
    expect(r.content[0].text).toContain('公文');
    expect(writes(calls)).toHaveLength(0);
  });

  it('分區部分符合多筆 → 回錯列出候選；完全符合優先於部分符合', async () => {
    let calls = stubAsana();
    const amb = await send({ section: '回報', dryRun: true });
    expect(amb.isError).toBe(true);
    expect(amb.content[0].text).toContain('問題回報單（已結案）');
    calls = stubAsana();
    const exact = await send({ section: '問題回報單', dryRun: true });
    expect(exact.isError).toBeUndefined();
    expect(JSON.parse(exact.content[0].text).preview.section).toEqual({ name: '問題回報單', gid: 's-bug' });
    expect(writes(calls)).toHaveLength(0);
  });

  it('自訂欄位名稱對不到、選項對不到、選項已停用 → 回錯列出可用的，不打寫入 API', async () => {
    for (const [cf, expectText] of [
      [{ 問題編號: 'X' }, '問題單號'],
      [{ 處理狀態: '已完成' }, '待處理'],
      [{ 處理狀態: '已停用' }, '待處理'],
    ] as const) {
      const calls = stubAsana();
      const r = await send({ customFields: cf });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(expectText);
      expect(writes(calls)).toHaveLength(0);
    }
  });

  it('dryRun：回傳完整內容（解析後的分區／欄位 GID、原單留言），不打任何寫入 API，不需要 userApproved', async () => {
    const calls = stubAsana();
    const r = await callTool(server, 'create_asana_task', {
      ...base, section: '公文', customFields: { 問題單號: 'ODAS-120', 處理狀態: '待處理' },
      relatedTaskGid: 'rel-1', attachmentPaths: [imgPath], dryRun: true,
    });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out.dryRun).toBe(true);
    expect(out.preview.section).toEqual({ name: '公文', gid: 's-doc' });
    expect(out.preview.customFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '問題單號', gid: 'cf-no', value: 'ODAS-120' }),
      expect.objectContaining({ name: '處理狀態', gid: 'cf-st', value: 'opt-todo', display: '待處理' }),
    ]));
    expect(out.preview.notes).toContain(`原單：${REL_URL}`);
    expect(out.preview.relatedComment).toContain('已另開單：');
    expect(out.preview.attachments[0].path).toBe(imgPath);
    expect(writes(calls)).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, 'audit'))).toBe(false);
  });

  it('不是 dryRun 卻沒有 userApproved → 拒絕，不打寫入 API', async () => {
    const calls = stubAsana();
    const r = await callTool(server, 'create_asana_task', base);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('userApproved');
    expect(writes(calls)).toHaveLength(0);
  });

  it('subtask：帶 parentTaskGid → 建立時掛在母任務下；沒帶分區就不加進專案', async () => {
    const calls = stubAsana();
    const r = await send({ parentTaskGid: 'parent-1' });
    expect(r.isError).toBeUndefined();
    const create = writes(calls).find(c => c.url.endsWith('/tasks'))!;
    const data = (create.body as { data: Record<string, unknown> }).data;
    expect(data['parent']).toBe('parent-1');
    expect(data['projects']).toBeUndefined();
    expect(data['memberships']).toBeUndefined();
  });

  it('一般任務：帶分區 → 用 memberships 放進該分區；欄位以 GID 送出；不帶指派就不指派', async () => {
    const calls = stubAsana();
    const r = await send({ section: '公文', customFields: { 問題單號: 'ODAS-120', 處理狀態: '處理中' } });
    expect(r.isError).toBeUndefined();
    const data = (writes(calls).find(c => c.url.endsWith('/tasks'))!.body as { data: Record<string, unknown> }).data;
    expect(data['memberships']).toEqual([{ project: 'pg-1', section: 's-doc' }]);
    expect(data['custom_fields']).toEqual({ 'cf-no': 'ODAS-120', 'cf-st': 'opt-doing' });
    expect(data['assignee']).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out).toMatchObject({ ok: true, gid: 'new-1', permalinkUrl: NEW_URL, section: '公文' });
  });

  it('relatedTaskGid：新單描述附「原單：URL」、原單留言「已另開單：新單 URL」，回應標明已留言', async () => {
    const calls = stubAsana();
    const r = await send({ relatedTaskGid: 'rel-1' });
    expect(r.isError).toBeUndefined();
    const create = (writes(calls).find(c => c.url.endsWith('/tasks'))!.body as { data: Record<string, unknown> }).data;
    expect(String(create['notes'])).toMatch(new RegExp(`問題描述[\\s\\S]*原單：${REL_URL.replace(/[/.]/g, '\\$&')}$`));
    const story = writes(calls).find(c => c.url.endsWith('/tasks/rel-1/stories'))!;
    expect((story.body as { data: { text: string } }).data.text).toBe(`已另開單：${NEW_URL}`);
    expect(JSON.parse(r.content[0].text).relatedCommented).toBe(true);
  });

  it('html_notes：原單連結附在 </body> 前；沒包 <body> 會自動包', async () => {
    const calls = stubAsana();
    await send({ htmlNotes: '<strong>重要</strong>', relatedTaskGid: 'rel-1' });
    const data = (writes(calls).find(c => c.url.endsWith('/tasks'))!.body as { data: Record<string, unknown> }).data;
    expect(data['notes']).toBeUndefined();
    expect(data['html_notes']).toBe(`<body><strong>重要</strong>\n原單：<a href="${REL_URL}">${REL_URL}</a></body>`);
  });

  it('部分失敗：任務建好但附件上傳與原單留言失敗 → isError，逐步列出哪一步失敗，仍給新單網址', async () => {
    stubAsana({ failAttachment: true, failStory: true });
    const r = await send({ relatedTaskGid: 'rel-1', attachmentPaths: [imgPath] });
    expect(r.isError).toBe(true);
    const text = r.content[0].text;
    expect(text).toContain('部分成功');
    expect(text).toContain(NEW_URL);
    const out = JSON.parse(text.slice(text.indexOf('{')));
    expect(out.ok).toBe(false);
    expect(out.steps.createTask.ok).toBe(true);
    expect(out.steps.attachments[0]).toMatchObject({ ok: false, path: imgPath });
    expect(out.steps.attachments[0].error).toContain('upload broke');
    expect(out.steps.relatedComment).toMatchObject({ ok: false });
    expect(out.steps.relatedComment.error).toContain('403');
  });

  it('建立本身失敗 → 回 Asana 原始錯誤訊息，不做後續步驟', async () => {
    const calls = stubAsana({ failCreate: true });
    const r = await send({ relatedTaskGid: 'rel-1', attachmentPaths: [imgPath] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('custom_fields: Invalid field');
    expect(writes(calls).filter(c => !c.url.endsWith('/tasks'))).toHaveLength(0);
  });

  it('附件檔不存在 → 建立前就退回（不留下建了一半的單）', async () => {
    const calls = stubAsana();
    const r = await send({ attachmentPaths: [path.join(tmpDir, 'nope.png')] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('File not found');
    expect(writes(calls)).toHaveLength(0);
  });

  it('指派給目前使用者 → 提示下次 sync_asana_tasks 會匯入；派給別人則不提示', async () => {
    stubAsana();
    const mine = JSON.parse((await send({ assigneeGid: ME })).content[0].text);
    expect(mine.syncHint).toContain('sync_asana_tasks');
    stubAsana();
    const other = JSON.parse((await send({ assigneeGid: 'other-gid' })).content[0].text);
    expect(other.syncHint).toBeUndefined();
  });

  it('稽核：每次建立寫入稽核檔；原單已在 omni 裡時另寫 [ASANA_CREATE_TASK] 到該任務紀錄', async () => {
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, source, source_ref) VALUES ('omni-rel', 'p1', '原單', 'frontend', 'asana', 'rel-1')`).run();
    stubAsana();
    const r = await send({ relatedTaskGid: 'rel-1' });
    expect(r.isError).toBeUndefined();
    const audit = fs.readFileSync(path.join(tmpDir, 'audit', 'asana-create-task.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ projectId: 'p1', gid: 'new-1', approvalNote: '使用者說：開吧', name: '新單標題' });
    const log = testDb.prepare(`SELECT content FROM agent_outputs WHERE task_id = 'omni-rel'`).all() as Array<{ content: string }>;
    expect(log.some(l => l.content.startsWith('[ASANA_CREATE_TASK]') && l.content.includes('使用者說：開吧') && l.content.includes(NEW_URL))).toBe(true);
  });
});
