/**
 * browse_asana_tasks — 即時查 Asana 上「全部／別人的／未指派」的任務，唯讀、不寫 DB。
 * 同步照舊只存派給我的；這支是使用者明確要看別人或未指派的單時才用。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAsanaBrowseTools } from '../tools/asana-browse-tools.js';
import { callTool } from './test-helpers.js';

const ME = { gid: 'me-gid', name: '我' };
const OTHER = { gid: 'other-gid', name: '別人' };
const raw = (gid: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ gid, name, notes: '', completed: false, num_subtasks: 0, tags: [], custom_fields: [], permalink_url: `https://app.asana.com/0/${gid}`, ...extra });
const inSection = (name: string) => ({ memberships: [{ project: { gid: 'pg-1' }, section: { name } }] });

function stubAsana(opts: { onDetail?: boolean } = {}) {
  const main = [
    raw('t-mine', 'ODAS-80 我的單', { assignee: ME, ...inSection('問題回報單') }),
    raw('t-other', 'ODAS-90 別人的單', { assignee: OTHER, ...inSection('問題回報單') }),
    raw('t-none', 'ODAS-100 沒人接的單', { assignee: null, notes: '登入頁送出就當掉', ...inSection('問題回報單') }),
    raw('t-root', 'DF01 收文單', { assignee: OTHER, num_subtasks: 1, ...inSection('公文') }),
  ];
  const subs: Record<string, unknown[]> = {
    't-root': [raw('t-sub', 'DF01 前端', { assignee: null, parent: { gid: 't-root', name: 'DF01 收文單' } })],
  };
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    calls.push(u);
    const ok = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });
    if (u.includes('/users/me')) return ok({ data: { gid: ME.gid } });
    if (u.includes('/tasks?project=')) return ok({ data: main });
    const sub = u.match(/\/tasks\/([^/?]+)\/subtasks/);
    if (sub) return ok({ data: subs[sub[1]!] || [] });
    const stories = u.match(/\/tasks\/([^/?]+)\/stories/);
    if (stories) return ok({ data: [
      { type: 'comment', text: '這張麻煩看一下', created_by: { name: 'PM' }, created_at: '2026-10-20T01:00:00Z' },
      { type: 'system', text: 'assigned to 別人', created_at: '2026-10-19T01:00:00Z' },
    ] });
    const detail = u.match(/\/tasks\/([^/?]+)\?/);
    if (detail && opts.onDetail !== false) return ok({ data: raw(detail[1]!, 'ODAS-100 沒人接的單', { assignee: null, notes: '完整描述：登入頁送出就當掉，附重現步驟', ...inSection('問題回報單') }) });
    throw new Error(`unexpected fetch: ${u}`);
  }));
  return calls;
}

describe('browse_asana_tasks', () => {
  let server: McpServer;
  const taskCount = () => (testDb.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES ('p1', 'P', '/tmp', 'pg-1')`).run();
    testDb.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'pat')`).run();
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerAsanaBrowseTools(server);
  });
  afterEach(() => vi.unstubAllGlobals());

  const list = async (args: Record<string, unknown>) => {
    const r = await callTool(server, 'browse_asana_tasks', { projectId: 'p1', ...args });
    expect(r.isError).toBeUndefined();
    return JSON.parse(r.content[0].text);
  };

  it('scope=all：派給我／別人／未指派（含 subtask）都列出，帶負責人與區段；不寫 DB', async () => {
    stubAsana();
    const out = await list({ scope: 'all' });
    const byGid = Object.fromEntries(out.tasks.map((t: { gid: string }) => [t.gid, t]));
    expect(Object.keys(byGid).sort()).toEqual(['t-mine', 't-none', 't-other', 't-root', 't-sub']);
    expect(byGid['t-other'].assignee).toBe('別人');
    expect(byGid['t-none'].assignee).toBe('（未指派）');
    expect(byGid['t-mine'].mine).toBe(true);
    expect(byGid['t-sub'].section).toBe('公文');          // subtask 繼承根任務區段
    expect(byGid['t-sub'].parent).toBe('DF01 收文單');
    expect(taskCount()).toBe(0);
  });

  it('scope=others 只回派給別人的；scope=unassigned 只回沒人接的', async () => {
    stubAsana();
    expect((await list({ scope: 'others' })).tasks.map((t: { gid: string }) => t.gid).sort()).toEqual(['t-other', 't-root']);
    stubAsana();
    expect((await list({ scope: 'unassigned' })).tasks.map((t: { gid: string }) => t.gid).sort()).toEqual(['t-none', 't-sub']);
  });

  it('keyword 比對標題與描述、section 比對區段（不分大小寫、部分符合）', async () => {
    stubAsana();
    expect((await list({ scope: 'all', keyword: '當掉' })).tasks.map((t: { gid: string }) => t.gid)).toEqual(['t-none']);
    stubAsana();
    const bySection = await list({ scope: 'all', section: '回報' });
    expect(bySection.tasks.map((t: { gid: string }) => t.gid).sort()).toEqual(['t-mine', 't-none', 't-other']);
  });

  it('已在 omni 裡的單標出 omniTaskId', async () => {
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, source, source_ref) VALUES ('omni-1', 'p1', 'ODAS-80', 'frontend', 'asana', 't-mine')`).run();
    stubAsana();
    const out = await list({ scope: 'all' });
    expect(out.tasks.find((t: { gid: string }) => t.gid === 't-mine').omniTaskId).toBe('omni-1');
    expect(out.tasks.find((t: { gid: string }) => t.gid === 't-other').omniTaskId).toBeUndefined();
  });

  it('taskGid：查單張詳情（全文描述＋留言，不含系統紀錄），不需要是我的單、不寫 DB', async () => {
    stubAsana();
    const r = await callTool(server, 'browse_asana_tasks', { taskGid: 't-none' });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    expect(out.task.notes).toContain('附重現步驟');
    expect(out.task.assignee).toBe('（未指派）');
    expect(out.comments).toEqual([{ author: 'PM', at: '2026-10-20T01:00:00Z', text: '這張麻煩看一下' }]);
    expect(taskCount()).toBe(0);
  });

  it('沒給 projectId 也沒給 taskGid → 錯誤；專案沒設 Asana GID → 錯誤', async () => {
    expect((await callTool(server, 'browse_asana_tasks', {})).isError).toBe(true);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p2', 'Q', '/tmp')`).run();
    expect((await callTool(server, 'browse_asana_tasks', { projectId: 'p2' })).isError).toBe(true);
  });
});
