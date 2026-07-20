/**
 * AsanaMcpClient — Web 同步路徑的 subtask 遞迴抓取（mock global fetch）。
 * 驗證：主清單+subtask 合併、assignee 過濾在合併後、section 繼承根任務、
 * includeSubtasks=false 舊行為、截斷/失敗時 subtaskFetchIncomplete=true。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AsanaMcpClient } from '../AsanaMcpClient.js';
import type { Config } from '../../config.js';

const ME = { gid: 'me-gid', name: '我' };
const OTHER = { gid: 'other-gid', name: '別人' };

function rawTask(gid: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name, notes: '', completed: false, num_subtasks: 0, tags: [], custom_fields: [], ...extra };
}

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function stubFetch(handlers: {
  mainList?: Record<string, unknown>[];
  subtasksByParent?: Record<string, Record<string, unknown>[] | { status: number }>;
}) {
  const mainList = handlers.mainList ?? [];
  const byParent = handlers.subtasksByParent ?? {};
  const fetchMock = vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/users/me')) return jsonRes({ data: { gid: ME.gid } });
    if (u.includes('/tasks?project=')) return jsonRes({ data: mainList });
    const m = u.match(/\/tasks\/([^/]+)\/subtasks/);
    if (m) {
      const entry = byParent[m[1]!];
      if (entry && !Array.isArray(entry)) return jsonRes({}, entry.status);
      return jsonRes({ data: entry || [] });
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('AsanaMcpClient — subtask 遞迴抓取（getMyTasksForProjectDetailed）', () => {
  let client: AsanaMcpClient;

  beforeEach(() => {
    client = new AsanaMcpClient({ asanaPat: 'pat', asanaWorkspace: null } as Config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('三層合併：指派給我的工作項目 subtask 被收錄，parent=直接母任務、section 繼承根任務', async () => {
    stubFetch({
      mainList: [
        rawTask('root-1', '系統管理', {
          num_subtasks: 1, assignee: OTHER,
          memberships: [{ project: { gid: 'pg-1' }, section: { name: '模組A' } }],
        }),
      ],
      subtasksByParent: {
        'root-1': [rawTask('feat-1', '銀行代碼放行', { num_subtasks: 2, assignee: OTHER, parent: { gid: 'root-1', name: '系統管理' } })],
        'feat-1': [
          rawTask('work-fe', '前端', { assignee: ME, parent: { gid: 'feat-1', name: '銀行代碼放行' } }),
          rawTask('work-be', '後端', { assignee: OTHER, parent: { gid: 'feat-1', name: '銀行代碼放行' } }),
        ],
      },
    });

    const result = await client.getMyTasksForProjectDetailed('pg-1');

    expect(result.subtaskCount).toBe(3);
    expect(result.subtaskFetchIncomplete).toBe(false);
    // 只有指派給我的 work-fe 通過過濾（母任務/功能層指派別人不影響下探）
    expect(result.tasks.map(t => t.gid)).toEqual(['work-fe']);
    expect(result.tasks[0]!.parent).toMatchObject({ gid: 'feat-1', name: '銀行代碼放行' });
    expect(result.tasks[0]!.section).toBe('模組A'); // 繼承根任務 section
    expect(result.tasks[0]!.assignee).toEqual(ME);
  });

  it('includeSubtasks=false → 不打 subtasks API（舊行為）', async () => {
    const fetchMock = stubFetch({
      mainList: [rawTask('root-1', '系統管理', { num_subtasks: 1, assignee: ME })],
      subtasksByParent: { 'root-1': [rawTask('s', '不該被抓', { assignee: ME })] },
    });

    const result = await client.getMyTasksForProjectDetailed('pg-1', { includeSubtasks: false });

    expect(result.subtaskCount).toBe(0);
    expect(result.tasks.map(t => t.gid)).toEqual(['root-1']);
    expect(fetchMock.mock.calls.map(c => String(c[0])).some(u => u.includes('/subtasks'))).toBe(false);
  });

  it('getMyTasksForProject（相容包裝）也含 subtask', async () => {
    stubFetch({
      mainList: [rawTask('root-1', '模組', { num_subtasks: 1, assignee: OTHER })],
      subtasksByParent: { 'root-1': [rawTask('s1', '前端', { assignee: ME, parent: { gid: 'root-1', name: '模組' } })] },
    });

    const tasks = await client.getMyTasksForProject('pg-1');
    expect(tasks.map(t => t.gid)).toEqual(['s1']);
  });

  it('subtask 抓取部分失敗 → subtaskFetchIncomplete=true（AsanaSyncService 據此跳過刪除）', async () => {
    stubFetch({
      mainList: [
        rawTask('bad', '壞掉的', { num_subtasks: 1, assignee: ME }),
        rawTask('good', '好的', { num_subtasks: 1, assignee: ME }),
      ],
      subtasksByParent: {
        bad: { status: 500 },
        good: [rawTask('s1', '前端', { assignee: ME, parent: { gid: 'good', name: '好的' } })],
      },
    });

    const result = await client.getMyTasksForProjectDetailed('pg-1');

    expect(result.subtaskFetchIncomplete).toBe(true);
    expect(result.subtaskWarnings.some(w => w.includes('HTTP 500'))).toBe(true);
    // best-effort：其他母任務的 subtask 照收
    expect(result.tasks.map(t => t.gid).sort()).toEqual(['bad', 'good', 's1']);
  });
});
