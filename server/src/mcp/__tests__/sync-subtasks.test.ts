/**
 * sync_asana_tasks — subtask 遞迴抓取整合測試（mock fetch）。
 * 驗證：主清單+subtask 合併後的 upsert、parent_name=直接母任務、
 * section 繼承根任務、assignee 過濾在合併後、includeSubtasks=false 舊行為。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

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

const ME = { gid: 'me-gid', name: '我' };
const OTHER = { gid: 'other-gid', name: '別人' };

function rawTask(gid: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name, notes: '', completed: false, num_subtasks: 0, tags: [], custom_fields: [], ...extra };
}

/**
 * 實測 HN_FEDI 結構：母任務（模組，掛專案）→ 功能 subtask（未掛專案）→
 * 工作項目 subtask（前端/後端，有指派人）。
 */
function stubThreeLevelFetch(overrides?: { mainList?: Record<string, unknown>[]; subtasksByParent?: Record<string, Record<string, unknown>[]> }) {
  const mainList = overrides?.mainList ?? [
    rawTask('root-1', '系統管理', {
      num_subtasks: 1,
      assignee: OTHER,
      memberships: [{ project: { gid: 'pg-1' }, section: { name: '模組A' } }],
    }),
  ];
  const subtasksByParent: Record<string, Record<string, unknown>[]> = overrides?.subtasksByParent ?? {
    'root-1': [
      rawTask('feat-1', '銀行代碼放行', { num_subtasks: 2, assignee: OTHER, parent: { gid: 'root-1', name: '系統管理' } }),
    ],
    'feat-1': [
      rawTask('work-fe', '前端', { assignee: ME, parent: { gid: 'feat-1', name: '銀行代碼放行' } }),
      rawTask('work-be', '後端', { assignee: OTHER, parent: { gid: 'feat-1', name: '銀行代碼放行' } }),
    ],
  };

  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/users/me')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { gid: ME.gid } }) };
    }
    if (u.includes('/tasks?project=')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: mainList }) };
    }
    const m = u.match(/\/tasks\/([^/]+)\/subtasks/);
    if (m) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: subtasksByParent[m[1]!] || [] }) };
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('sync_asana_tasks — subtask 遞迴抓取', () => {
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

  it('工作項目 subtask 指派給我 → 匯入；parent_name=直接母任務；section 繼承根任務', async () => {
    stubThreeLevelFetch();

    const result = await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.newTasks).toBe(1);
    expect(data.subtasks).toMatchObject({ fetched: 3, truncated: false });
    expect(data.message).toContain('含 subtask 3 筆');

    const rows = testDb.prepare(`SELECT title, label, parent_name, section, source_ref, assignee FROM tasks WHERE source = 'asana'`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '前端',
      label: 'frontend',            // 分類器：標題「前端」
      parent_name: '銀行代碼放行',   // 直接母任務（功能層），不是根任務
      section: '模組A',              // subtask 無 memberships → 繼承根任務 section
      source_ref: 'work-fe',
      assignee: '我',
    });
  });

  it('assignee 過濾在合併後：母任務/功能層指派別人不影響下探，指派別人的工作項目不匯入', async () => {
    stubThreeLevelFetch();

    await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' });

    const gids = (testDb.prepare(`SELECT source_ref FROM tasks WHERE source = 'asana'`).all() as Array<{ source_ref: string }>).map(r => r.source_ref);
    expect(gids).toContain('work-fe');
    expect(gids).not.toContain('work-be'); // 指派別人
    expect(gids).not.toContain('root-1');  // 母任務指派別人 — 但仍被當種子下探
    expect(gids).not.toContain('feat-1');
  });

  it('existingByGid 去重：已存在的 subtask 任務更新而非重建', async () => {
    // 預先塞舊資料（標題舊、parent_name 空）
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status, source, source_ref)
      VALUES ('local-1', 'proj-1', '舊標題', 'frontend', 'feature', 'pending', 'asana', 'work-fe')`).run();
    stubThreeLevelFetch();

    const data = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);

    expect(data.newTasks).toBe(0);
    expect(data.updatedTasks).toBe(1);
    const rows = testDb.prepare(`SELECT id, title, parent_name FROM tasks WHERE source_ref = 'work-fe'`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1); // 不重複建
    expect(rows[0]).toMatchObject({ id: 'local-1', title: '前端', parent_name: '銀行代碼放行' });
  });

  it('subtask 已 multi-home 進專案（主清單有）→ 不重複、主清單 section 優先', async () => {
    stubThreeLevelFetch({
      mainList: [
        rawTask('root-1', '系統管理', {
          num_subtasks: 1, assignee: OTHER,
          memberships: [{ project: { gid: 'pg-1' }, section: { name: '模組A' } }],
        }),
        // feat-1 multi-home 進專案，掛在自己的 section
        rawTask('feat-1', '銀行代碼放行', {
          num_subtasks: 1, assignee: ME, parent: { gid: 'root-1', name: '系統管理' },
          memberships: [{ project: { gid: 'pg-1' }, section: { name: '放行區' } }],
        }),
      ],
      subtasksByParent: {
        'root-1': [rawTask('feat-1', '銀行代碼放行', { num_subtasks: 1, assignee: ME, parent: { gid: 'root-1', name: '系統管理' } })],
        'feat-1': [rawTask('work-fe', '前端', { assignee: ME, parent: { gid: 'feat-1', name: '銀行代碼放行' } })],
      },
    });

    const data = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);

    expect(data.newTasks).toBe(2); // feat-1（主清單）+ work-fe（subtask），無重複
    const featRows = testDb.prepare(`SELECT section FROM tasks WHERE source_ref = 'feat-1'`).all() as Array<{ section: string }>;
    expect(featRows).toHaveLength(1);
    expect(featRows[0]!.section).toBe('放行區'); // 用主清單自己的 membership，不被繼承覆蓋
    const workRows = testDb.prepare(`SELECT section, parent_name FROM tasks WHERE source_ref = 'work-fe'`).all() as Array<Record<string, unknown>>;
    // work-fe 從 feat-1（主清單種子）下探 → 繼承 feat-1 的 section
    expect(workRows[0]).toMatchObject({ section: '放行區', parent_name: '銀行代碼放行' });
  });

  it('includeSubtasks=false → 不打 subtasks API，退回舊行為', async () => {
    const fetchMock = stubThreeLevelFetch();

    const data = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1', includeSubtasks: false })).content[0].text);

    expect(data.newTasks).toBe(0); // 主清單唯一任務指派別人
    expect(data.subtasks).toEqual({ skipped: 'includeSubtasks=false' });
    expect(fetchMock.mock.calls.map(c => String(c[0])).some(u => u.includes('/subtasks'))).toBe(false);
  });

  it('completed 母任務不下探（與 completed_since=now 語意一致）', async () => {
    const fetchMock = stubThreeLevelFetch({
      mainList: [rawTask('root-1', '已完成模組', { completed: true, num_subtasks: 3, assignee: ME })],
      subtasksByParent: { 'root-1': [rawTask('x', '不該被抓', { assignee: ME })] },
    });

    const data = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);

    expect(data.subtasks.fetched).toBe(0);
    expect(fetchMock.mock.calls.map(c => String(c[0])).some(u => u.includes('/subtasks'))).toBe(false);
  });
});
