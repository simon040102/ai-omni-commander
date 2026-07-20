/**
 * sync_asana_tasks — due_on 截止日期落地測試（mock fetch）。
 * 驗證：INSERT 落地 due_date、只有 due 改變也觸發 UPDATE、無變更不觸發、
 * due 被清除 → null、非字串 due_on → null；讀取面 get_task / list_pending_tasks
 * 回傳 dueDate（list 另附 overdue）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { localTodayYmd } from '../../utils/dueDate.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../svn-status.js', () => ({
  getSvnCredentials: vi.fn().mockReturnValue({ username: 'user', password: 'pass' }),
  isSvnCliAvailable: vi.fn().mockReturnValue(false),
  fetchRemoteLastModified: vi.fn().mockReturnValue(null),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from '../tools/task-tools.js';
import { callTool } from './test-helpers.js';

const ME = { gid: 'me-gid', name: '我' };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedAsanaProject(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES ('proj-1', 'Test', '/tmp/p', 'pg-1')`).run();
  db.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'test-pat')`).run();
}

function stubFetch(mainList: Record<string, unknown>[]) {
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/users/me')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { gid: ME.gid } }) };
    }
    if (u.includes('/tasks?project=')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: mainList }) };
    }
    if (/\/tasks\/[^/]+\/subtasks/.test(u)) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [] }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function rawTask(gid: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name, notes: '', completed: false, num_subtasks: 0, tags: [], custom_fields: [], assignee: ME, ...extra };
}

async function sync(server: McpServer) {
  const result = await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1', force: true, includeSubtasks: false });
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe('sync_asana_tasks — due_on 落地', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerTaskTools(server);
    seedAsanaProject(testDb);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('INSERT 落地 due_date（due_on 原樣 YYYY-MM-DD）', async () => {
    stubFetch([rawTask('g1', '前端', { due_on: '2026-07-25' })]);
    const data = await sync(server);
    expect(data.newTasks).toBe(1);
    const row = testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g1'`).get() as any;
    expect(row.due_date).toBe('2026-07-25');
  });

  it('due_on 缺席或非字串 → due_date 為 null', async () => {
    stubFetch([
      rawTask('g-no-due', '沒到期日'),
      rawTask('g-bad-due', '壞到期日', { due_on: 20260725 }),
    ]);
    await sync(server);
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g-no-due'`).get() as any).due_date).toBeNull();
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g-bad-due'`).get() as any).due_date).toBeNull();
  });

  it('只有 due date 改變也觸發 UPDATE；無任何變更不觸發', async () => {
    stubFetch([rawTask('g1', '前端', { due_on: '2026-07-25' })]);
    await sync(server);

    // 同資料再同步 → 不觸發 UPDATE
    vi.unstubAllGlobals();
    stubFetch([rawTask('g1', '前端', { due_on: '2026-07-25' })]);
    const unchanged = await sync(server);
    expect(unchanged.updatedTasks).toBe(0);

    // 只改 due_on → 觸發 UPDATE
    vi.unstubAllGlobals();
    stubFetch([rawTask('g1', '前端', { due_on: '2026-08-01' })]);
    const changed = await sync(server);
    expect(changed.updatedTasks).toBe(1);
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g1'`).get() as any).due_date).toBe('2026-08-01');
  });

  it('Asana 清除 due date → 本地更新為 null', async () => {
    stubFetch([rawTask('g1', '前端', { due_on: '2026-07-25' })]);
    await sync(server);

    vi.unstubAllGlobals();
    stubFetch([rawTask('g1', '前端', { due_on: null })]);
    const data = await sync(server);
    expect(data.updatedTasks).toBe(1);
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g1'`).get() as any).due_date).toBeNull();
  });
});

describe('讀取面 — dueDate 欄位', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerTaskTools(server);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-1', 'Test', '/tmp/p')`).run();
  });

  function seedTask(id: string, dueDate: string | null) {
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, due_date) VALUES (?, 'proj-1', ?, 'frontend', 'feature', ?)`)
      .run(id, `Task ${id}`, dueDate);
  }

  it('get_task 回傳 dueDate', async () => {
    seedTask('t1', '2026-07-25');
    seedTask('t2', null);

    const withDue = JSON.parse((await callTool(server, 'get_task', { taskId: 't1' })).content[0].text);
    expect(withDue.task.dueDate).toBe('2026-07-25');
    const noDue = JSON.parse((await callTool(server, 'get_task', { taskId: 't2' })).content[0].text);
    expect(noDue.task.dueDate).toBeNull();
  });

  it('list_pending_tasks 回傳 dueDate + overdue（due_date < today）', async () => {
    const today = localTodayYmd();
    seedTask('t-overdue', '2000-01-01');
    seedTask('t-today', today);
    seedTask('t-future', '2999-12-31');
    seedTask('t-none', null);

    const data = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1' })).content[0].text);
    const byId = new Map(data.tasks.map((t: any) => [t.id, t]));
    expect(byId.get('t-overdue')).toMatchObject({ dueDate: '2000-01-01', overdue: true });
    expect(byId.get('t-today')).toMatchObject({ dueDate: today, overdue: false });
    expect(byId.get('t-future')).toMatchObject({ dueDate: '2999-12-31', overdue: false });
    expect(byId.get('t-none')).toMatchObject({ dueDate: null, overdue: false });
  });

  it('resume_task 回傳 dueDate', async () => {
    // resume_task 註冊在 context-tools — 這裡動態註冊避免整包 mock 重複
    const { registerContextTools } = await import('../tools/context-tools.js');
    registerContextTools(server);
    seedTask('t1', '2026-07-25');

    const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 't1' })).content[0].text);
    expect(data.task.dueDate).toBe('2026-07-25');
  });
});
