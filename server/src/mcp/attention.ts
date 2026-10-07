/**
 * 「該注意什麼」摘要——Loop 3 的可行版本：**把 omni 已知的事主動講出來，但不執行任何東西**。
 *
 * omni 知道很多事，卻都要有人來問才說：停滯的任務、逾期的任務、擱置的規格缺口。
 * 這份摘要把它們收在一起，而且**依「要做什麼」分組，不依資料來源分組**——
 * 同樣是「擱置一個月的缺口」，掛在進行中的任務上是「工作卡著」、
 * 掛在已結案的任務上是「帶著未解的問題結案了」，兩者要找的人和要做的事都不同。
 *
 * 純函式，不碰 DB；資料由呼叫端查好傳進來。
 */

export interface AttentionGap {
  id: string;
  category: string;
  description: string;
  createdAt: string;
  taskId: string | null;
  taskTitle: string | null;
  /** 缺口所屬任務的狀態；任務已刪除則為 null */
  taskStatus: string | null;
  projectName: string | null;
}

export interface AttentionTask {
  taskId: string;
  title: string;
  projectName: string | null;
}

export interface StalledEntry extends AttentionTask {
  stalledHours: number;
}

export interface OverdueEntry extends AttentionTask {
  dueDate: string;
  /** 例：「已逾期 3 天」 */
  dueText: string;
  /** 同時也在停滯清單裡（由 buildAttention 填） */
  alsoStalled?: boolean;
}

export interface ProjectCount {
  projectName: string;
  count: number;
}

export interface AttentionInput {
  gaps: AttentionGap[];
  stalled: StalledEntry[];
  overdue: OverdueEntry[];
  /** ISO，含時區 */
  nowIso: string;
  /** 超過幾天算「擱置」（預設 30） */
  staleGapDays?: number;
}

export interface GapGroup {
  /** 任務層級：同一個任務的缺口收成一組，比逐條列好處理 */
  taskId: string | null;
  taskTitle: string | null;
  projectName: string | null;
  gapCount: number;
  oldestDays: number;
  categories: string[];
  /** 抽一條最舊的描述當樣本 */
  sample: string;
  /** 組內缺口 id——比對「上次報過沒」用 */
  gapIds: string[];
}

export interface AttentionSummary {
  /** 進行中的任務上，擱置超過門檻的缺口——**工作卡著，需要有人拍板** */
  blocking: GapGroup[];
  /** 已結案的任務上，仍未裁決的缺口——**帶著未解的問題結案了** */
  closedWithOpenGaps: GapGroup[];
  /** 失敗的任務上仍開著的缺口——任務可能就是卡在這裡失敗的 */
  failedWithOpenGaps: GapGroup[];
  stalled: StalledEntry[];
  overdue: OverdueEntry[];
  /** 量大時逐條列沒人看，先給各專案筆數 */
  stalledByProject: ProjectCount[];
  overdueByProject: ProjectCount[];
  /** 各區筆數，給標題列用 */
  counts: {
    blocking: number; closedWithOpenGaps: number; failedWithOpenGaps: number; stalled: number; overdue: number;
    /** 同時停滯又逾期——同一件事，不該當兩件看 */
    stalledAndOverdue: number;
  };
  /** 什麼都沒有時為 true——讓呼叫端可以安靜，不要推一則「一切正常」 */
  empty: boolean;
}

/** SQLite 的 UTC 時間不帶 Z；補上，否則 Date.parse 會當本地時間、差 8 小時。 */
function utc(s: string): number {
  const t = s.trim();
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
}
const ageDays = (created: string, nowIso: string): number =>
  Math.max(0, Math.floor((Date.parse(nowIso) - utc(created)) / 86_400_000));

function groupByTask(gaps: AttentionGap[], nowIso: string): GapGroup[] {
  const m = new Map<string, AttentionGap[]>();
  for (const g of gaps) {
    const k = g.taskId ?? '(無任務)';
    const arr = m.get(k) ?? [];
    arr.push(g);
    m.set(k, arr);
  }
  return [...m.values()]
    .map(arr => {
      const oldest = arr.reduce((a, b) => (utc(a.createdAt) <= utc(b.createdAt) ? a : b));
      return {
        taskId: arr[0].taskId,
        taskTitle: arr[0].taskTitle,
        projectName: arr[0].projectName,
        gapCount: arr.length,
        oldestDays: ageDays(oldest.createdAt, nowIso),
        categories: [...new Set(arr.map(g => g.category))].sort(),
        sample: oldest.description,
        gapIds: arr.map(g => g.id),
      };
    })
    // 缺口多的、放得久的排前面
    .sort((a, b) => b.gapCount - a.gapCount || b.oldestDays - a.oldestDays);
}

function countByProject(items: AttentionTask[]): ProjectCount[] {
  const m = new Map<string, number>();
  for (const t of items) {
    const k = t.projectName ?? '(未知專案)';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([projectName, count]) => ({ projectName, count }))
    .sort((a, b) => b.count - a.count || a.projectName.localeCompare(b.projectName));
}

export function buildAttention(input: AttentionInput): AttentionSummary {
  const threshold = input.staleGapDays ?? 30;
  const stale = input.gaps.filter(g => ageDays(g.createdAt, input.nowIso) > threshold);

  // 已結案的不看天數門檻：結案那一刻就該處理完，放多久都一樣是「帶著問題結案」
  const closed = input.gaps.filter(g => g.taskStatus === 'completed');
  const failed = input.gaps.filter(g => g.taskStatus === 'failed');
  // 進行中／待辦／任務已刪除 → 超過門檻才算卡住
  const blocking = stale.filter(g => g.taskStatus !== 'completed' && g.taskStatus !== 'failed');
  const stalledIds = new Set(input.stalled.map(t => t.taskId));

  const summary: AttentionSummary = {
    blocking: groupByTask(blocking, input.nowIso),
    closedWithOpenGaps: groupByTask(closed, input.nowIso),
    failedWithOpenGaps: groupByTask(failed, input.nowIso),
    stalled: [...input.stalled].sort((a, b) => b.stalledHours - a.stalledHours),
    overdue: input.overdue
      .map(t => ({ ...t, alsoStalled: stalledIds.has(t.taskId) }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    stalledByProject: countByProject(input.stalled),
    overdueByProject: countByProject(input.overdue),
    counts: {
      blocking: blocking.length,
      closedWithOpenGaps: closed.length,
      failedWithOpenGaps: failed.length,
      stalled: input.stalled.length,
      overdue: input.overdue.length,
      stalledAndOverdue: input.overdue.filter(t => stalledIds.has(t.taskId)).length,
    },
    empty: false,
  };
  // 重疊數只是另外幾區的交集，不算獨立的一件事
  const { stalledAndOverdue: _overlap, ...primary } = summary.counts;
  summary.empty = Object.values(primary).every(n => n === 0);
  return summary;
}

// ── 每日推送：只推新的變化 ─────────────────────────────────
//
// 每天推「105 個停滯」，第三天就沒人看了。所以推送只講「比上次多了什麼」，
// 完整清單要看再用 get_attention_summary 查。

/** 上次推送時看到的東西（存成 JSON，下次比對用） */
export interface AttentionSnapshot {
  blockingGapIds: string[];
  closedGapIds: string[];
  failedGapIds: string[];
  stalledTaskIds: string[];
  overdueTaskIds: string[];
}

export function snapshotOf(s: AttentionSummary): AttentionSnapshot {
  const ids = (gs: GapGroup[]) => gs.flatMap(g => g.gapIds);
  return {
    blockingGapIds: ids(s.blocking),
    closedGapIds: ids(s.closedWithOpenGaps),
    failedGapIds: ids(s.failedWithOpenGaps),
    stalledTaskIds: s.stalled.map(t => t.taskId),
    overdueTaskIds: s.overdue.map(t => t.taskId),
  };
}

export interface NewGapGroup extends GapGroup {
  /** 這組裡上次沒報過的缺口數 */
  newGapCount: number;
}

export interface AttentionDiff {
  /** 沒有上次快照——這次只建立基線，不逐條列 */
  baseline: boolean;
  newBlocking: NewGapGroup[];
  newClosedWithOpenGaps: NewGapGroup[];
  newFailedWithOpenGaps: NewGapGroup[];
  newStalled: StalledEntry[];
  newOverdue: OverdueEntry[];
  /** 上次有、這次沒了（被處理掉）的筆數 */
  cleared: { blocking: number; closedWithOpenGaps: number; failedWithOpenGaps: number; stalled: number; overdue: number };
  /** false → 呼叫端保持安靜 */
  hasNews: boolean;
}

function newGroups(groups: GapGroup[], seen: string[]): NewGapGroup[] {
  const set = new Set(seen);
  return groups
    .map(g => ({ ...g, newGapCount: g.gapIds.filter(id => !set.has(id)).length }))
    .filter(g => g.newGapCount > 0);
}

const goneCount = (prev: string[], cur: string[]): number => {
  const c = new Set(cur);
  return prev.filter(id => !c.has(id)).length;
};

export function diffAttention(prev: AttentionSnapshot | null, cur: AttentionSummary): AttentionDiff {
  const noCleared = { blocking: 0, closedWithOpenGaps: 0, failedWithOpenGaps: 0, stalled: 0, overdue: 0 };
  if (!prev) {
    return {
      baseline: true, newBlocking: [], newClosedWithOpenGaps: [], newFailedWithOpenGaps: [],
      newStalled: [], newOverdue: [], cleared: noCleared, hasNews: !cur.empty,
    };
  }
  const now = snapshotOf(cur);
  const stalledSeen = new Set(prev.stalledTaskIds);
  const overdueSeen = new Set(prev.overdueTaskIds);
  const d: AttentionDiff = {
    baseline: false,
    newBlocking: newGroups(cur.blocking, prev.blockingGapIds),
    newClosedWithOpenGaps: newGroups(cur.closedWithOpenGaps, prev.closedGapIds),
    newFailedWithOpenGaps: newGroups(cur.failedWithOpenGaps, prev.failedGapIds),
    newStalled: cur.stalled.filter(t => !stalledSeen.has(t.taskId)),
    newOverdue: cur.overdue.filter(t => !overdueSeen.has(t.taskId)),
    cleared: {
      blocking: goneCount(prev.blockingGapIds, now.blockingGapIds),
      closedWithOpenGaps: goneCount(prev.closedGapIds, now.closedGapIds),
      failedWithOpenGaps: goneCount(prev.failedGapIds, now.failedGapIds),
      stalled: goneCount(prev.stalledTaskIds, now.stalledTaskIds),
      overdue: goneCount(prev.overdueTaskIds, now.overdueTaskIds),
    },
    hasNews: false,
  };
  d.hasNews =
    d.newBlocking.length + d.newClosedWithOpenGaps.length + d.newFailedWithOpenGaps.length +
    d.newStalled.length + d.newOverdue.length > 0 ||
    Object.values(d.cleared).some(n => n > 0);
  return d;
}

/** 本地日期 YYYY-MM-DD */
export function localYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 每天最多一次，且要過了設定的鐘點（本地時間）。server 重啟不會重推。 */
export function shouldRunDigest(lastRunYmd: string | null, now: Date, hour: number): boolean {
  if (now.getHours() < hour) return false;
  return lastRunYmd !== localYmd(now);
}
