import { describe, it, expect, vi } from 'vitest';
import { fetchAsanaSubtasksTree, type AsanaResponseLike } from '../asanaSubtasks.js';

/** Build a raw Asana task object (main-query opt_fields shape). */
function task(gid: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { gid, name, notes: '', completed: false, num_subtasks: 0, ...extra };
}

type Page = { data?: Record<string, unknown>[]; next_page?: { uri?: string } | null };

function okRes(body: Page): AsanaResponseLike {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

function errRes(status: number, retryAfter?: string): AsanaResponseLike {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter ?? null : null) },
    json: async () => ({}),
  };
}

/** fetchFn backed by a parentGid → subtasks map (single page each). */
function mapFetch(byParent: Record<string, Record<string, unknown>[]>) {
  return vi.fn(async (url: string): Promise<AsanaResponseLike> => {
    const m = url.match(/\/tasks\/([^/]+)\/subtasks/);
    if (!m) throw new Error(`unexpected url: ${url}`);
    return okRes({ data: byParent[m[1]!] || [] });
  });
}

const OPT_FIELDS = 'name,notes,completed,num_subtasks,assignee.gid,parent.gid,parent.name';

describe('fetchAsanaSubtasksTree', () => {
  it('三層遞迴：母→功能→工作項目全數收錄，parent 缺時以直接母任務補上', async () => {
    const root = task('root-1', '系統管理', { num_subtasks: 1 });
    const fetchFn = mapFetch({
      'root-1': [task('feat-1', '銀行代碼放行', { num_subtasks: 2 })],
      'feat-1': [task('work-fe', '前端'), task('work-be', '後端')],
    });

    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['feat-1', 'work-fe', 'work-be']);
    expect(result.entries.map(e => e.depth)).toEqual([1, 2, 2]);
    // rootGid 一律指回主清單的根任務（section 繼承用）
    expect(result.entries.every(e => e.rootGid === 'root-1')).toBe(true);
    // parent 未由 API 帶回 → 以遍歷脈絡補上「直接母任務」（前端的 parent 是功能層，不是根）
    const workFe = result.entries.find(e => e.task['gid'] === 'work-fe')!;
    expect(workFe.task['parent']).toEqual({ gid: 'feat-1', name: '銀行代碼放行' });
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('API 已帶 parent 時不覆寫', async () => {
    const root = task('r', '模組', { num_subtasks: 1 });
    const fetchFn = mapFetch({
      r: [task('s', '功能', { parent: { gid: 'r', name: '模組', notes: 'original' } })],
    });
    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS });
    expect(result.entries[0]!.task['parent']).toEqual({ gid: 'r', name: '模組', notes: 'original' });
  });

  it('深度上限：預設 3 層，第 4 層不抓', async () => {
    const root = task('d0', 'L0', { num_subtasks: 1 });
    const fetchFn = mapFetch({
      d0: [task('d1', 'L1', { num_subtasks: 1 })],
      d1: [task('d2', 'L2', { num_subtasks: 1 })],
      d2: [task('d3', 'L3', { num_subtasks: 1 })], // d3 還有 subtask，但已達深度 3
      d3: [task('d4', 'L4')],
    });

    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['d1', 'd2', 'd3']);
    // 不會對 d3 發 subtasks 請求
    expect(fetchFn.mock.calls.map(c => c[0]).some((u: string) => u.includes('/tasks/d3/'))).toBe(false);
    expect(result.requestCount).toBe(3);
  });

  it('completed 的母任務不往下抓', async () => {
    const root = task('done-root', '已完成模組', { completed: true, num_subtasks: 5 });
    const fetchFn = mapFetch({ 'done-root': [task('x', '不該被抓到')] });

    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS });

    expect(result.entries).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('num_subtasks=0 的任務不發請求', async () => {
    const fetchFn = mapFetch({});
    const result = await fetchAsanaSubtasksTree([task('r', '無子任務')], { fetchFn, optFields: OPT_FIELDS });
    expect(result.entries).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('completed 的 subtask 跳過且不下探', async () => {
    const root = task('r', '模組', { num_subtasks: 2 });
    const fetchFn = mapFetch({
      r: [
        task('done-sub', '已完成功能', { completed: true, num_subtasks: 3 }),
        task('live-sub', '進行中功能'),
      ],
      'done-sub': [task('ghost', '不該被抓到')],
    });

    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['live-sub']);
    expect(fetchFn.mock.calls.map(c => c[0]).some((u: string) => u.includes('done-sub'))).toBe(false);
  });

  it('gid 去重：已 multi-home 進主清單的 subtask 不重複收錄（主清單那份自己是種子）', async () => {
    // B 同時是 A 的 subtask、又 multi-home 進專案（出現在主清單）
    const rootA = task('A', '模組A', { num_subtasks: 1 });
    const rootB = task('B', '功能B', { num_subtasks: 1 });
    const fetchFn = mapFetch({
      A: [task('B', '功能B', { num_subtasks: 1 })], // 與主清單重複 → 跳過
      B: [task('C', '工作項目C')],
    });

    const result = await fetchAsanaSubtasksTree([rootA, rootB], { fetchFn, optFields: OPT_FIELDS });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['C']);
    expect(result.entries[0]!.rootGid).toBe('B');
  });

  it('分頁：跟隨 next_page.uri 抓完所有頁', async () => {
    const root = task('r', '模組', { num_subtasks: 150 });
    const fetchFn = vi.fn(async (url: string): Promise<AsanaResponseLike> => {
      if (url.includes('page=2')) return okRes({ data: [task('s2', '第二頁')] });
      if (url.includes('/tasks/r/subtasks')) {
        return okRes({ data: [task('s1', '第一頁')], next_page: { uri: 'https://app.asana.com/api/1.0/tasks/r/subtasks?page=2' } });
      }
      throw new Error(`unexpected url: ${url}`);
    });

    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['s1', 's2']);
    expect(result.requestCount).toBe(2);
  });

  it('請求總量上限：達上限即截斷並附警告', async () => {
    const roots = [
      task('r1', 'R1', { num_subtasks: 1 }),
      task('r2', 'R2', { num_subtasks: 1 }),
      task('r3', 'R3', { num_subtasks: 1 }),
    ];
    const fetchFn = mapFetch({ r1: [task('s1', 'S1')], r2: [task('s2', 'S2')], r3: [task('s3', 'S3')] });

    const result = await fetchAsanaSubtasksTree(roots, {
      fetchFn, optFields: OPT_FIELDS, maxRequests: 2, concurrency: 1,
    });

    expect(result.requestCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some(w => w.includes('上限 2'))).toBe(true);
    expect(result.entries.length).toBe(2); // 第三支被截斷
  });

  it('429 退避一次後重試成功（依 Retry-After 等待）', async () => {
    const root = task('r', '模組', { num_subtasks: 1 });
    let calls = 0;
    const fetchFn = vi.fn(async (): Promise<AsanaResponseLike> => {
      calls++;
      if (calls === 1) return errRes(429, '2');
      return okRes({ data: [task('s', '功能')] });
    });
    const sleep = vi.fn(async () => {});

    const result = await fetchAsanaSubtasksTree([root], { fetchFn, optFields: OPT_FIELDS, sleep });

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(result.entries.map(e => e.task['gid'])).toEqual(['s']);
    expect(result.requestCount).toBe(2); // 含重試
    expect(result.warnings).toEqual([]);
  });

  it('非 429 失敗：記警告、該母任務跳過，不 throw（best-effort）', async () => {
    const roots = [task('bad', '壞掉的', { num_subtasks: 1 }), task('good', '好的', { num_subtasks: 1 })];
    const fetchFn = vi.fn(async (url: string): Promise<AsanaResponseLike> => {
      if (url.includes('/tasks/bad/')) return errRes(500);
      return okRes({ data: [task('s', '功能')] });
    });

    const result = await fetchAsanaSubtasksTree(roots, { fetchFn, optFields: OPT_FIELDS, concurrency: 1 });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['s']);
    expect(result.warnings.some(w => w.includes('HTTP 500') && w.includes('壞掉的'))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('fetchFn 本身 reject（timeout/DNS）：同樣轉警告不 throw，其他母任務照抓', async () => {
    const roots = [task('boom', '逾時的', { num_subtasks: 1 }), task('good', '好的', { num_subtasks: 1 })];
    const fetchFn = vi.fn(async (url: string): Promise<AsanaResponseLike> => {
      if (url.includes('/tasks/boom/')) throw new Error('The operation was aborted due to timeout');
      return okRes({ data: [task('s', '功能')] });
    });

    const result = await fetchAsanaSubtasksTree(roots, { fetchFn, optFields: OPT_FIELDS, concurrency: 1 });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['s']);
    expect(result.warnings.some(w => w.includes('timeout') && w.includes('逾時的'))).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('截止日繼承：subtask 沒填 → 繼承最近有日期的祖先；自己有 → 保留不覆蓋', async () => {
    // root(due=07-31) → feat(無 due) → workA(無 due)、workB(自己有 08-15)
    // root2(無 due) → feat2(due=08-01) → workC(無 due)
    const roots = [
      { ...task('root', '模組', { num_subtasks: 1 }), due_on: '2026-07-31' },
      task('root2', '模組2', { num_subtasks: 1 }),
    ];
    const fetchFn = mapFetch({
      root: [task('feat', '功能', { num_subtasks: 2 })],
      feat: [task('workA', '前端'), { ...task('workB', '後端'), due_on: '2026-08-15' }],
      root2: [{ ...task('feat2', '功能2', { num_subtasks: 1 }), due_on: '2026-08-01' }],
      feat2: [task('workC', '串接')],
    });

    const result = await fetchAsanaSubtasksTree(roots, { fetchFn, optFields: OPT_FIELDS, concurrency: 1 });
    const byGid = Object.fromEntries(result.entries.map(e => [e.task['gid'], e.task['due_on'] ?? null]));

    expect(byGid['feat']).toBe('2026-07-31');   // 第一層繼承 root
    expect(byGid['workA']).toBe('2026-07-31');  // 第二層沿鏈繼承 root
    expect(byGid['workB']).toBe('2026-08-15');  // 自己有 → 不覆蓋
    expect(byGid['feat2']).toBe('2026-08-01');  // 自己有（root2 無 due）
    expect(byGid['workC']).toBe('2026-08-01');  // 繼承最近祖先 feat2，而非 root2 的 null
  });

  it('knownGids 額外去重', async () => {
    const root = task('r', '模組', { num_subtasks: 2 });
    const fetchFn = mapFetch({ r: [task('known', '已知'), task('fresh', '新的')] });

    const result = await fetchAsanaSubtasksTree([root], {
      fetchFn, optFields: OPT_FIELDS, knownGids: ['known'],
    });

    expect(result.entries.map(e => e.task['gid'])).toEqual(['fresh']);
  });
});
