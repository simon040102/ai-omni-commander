import { describe, it, expect } from 'vitest';
import { buildAttention, snapshotOf, diffAttention, shouldRunDigest, type AttentionGap } from '../attention.js';

const NOW = '2026-09-28T00:00:00Z';
// 照真實資料形狀：SQLite 的 datetime 是 UTC 但不帶 Z
const gap = (id: string, taskId: string | null, taskStatus: string | null, createdAt: string, category = 'logic_unclear'): AttentionGap =>
  ({ id, category, description: `缺口 ${id}`, createdAt, taskId, taskTitle: taskId ? `任務 ${taskId}` : null, taskStatus, projectName: 'P' });

describe('buildAttention — 依「要做什麼」分組', () => {
  const gaps = [
    gap('1', 'tA', 'in_progress', '2026-07-01 00:00:00'),                   // 進行中、擱置 89 天 → 卡住
    gap('2', 'tA', 'in_progress', '2026-08-01 00:00:00', 'field_undefined'), // 同任務 → 併成一組
    gap('3', 'tB', 'in_progress', '2026-09-25 00:00:00'),                   // 進行中但才 3 天 → 不算卡住
    gap('4', 'tC', 'completed',   '2026-09-27 00:00:00'),                   // 已結案，才 1 天也要列
    gap('5', 'tD', 'failed',      '2026-07-01 00:00:00'),
  ];
  const s = buildAttention({ gaps, stalled: [], overdue: [], nowIso: NOW });

  it('進行中且擱置超過門檻 → 卡住；同一個任務的缺口併成一組', () => {
    expect(s.blocking).toHaveLength(1);
    expect(s.blocking[0]).toMatchObject({ taskId: 'tA', gapCount: 2, oldestDays: 89 });
    expect(s.blocking[0].categories).toEqual(['field_undefined', 'logic_unclear']);
    expect(s.counts.blocking).toBe(2);
  });

  it('進行中但還新的缺口不算卡住（還在正常處理的時間內）', () => {
    expect(s.blocking.find(g => g.taskId === 'tB')).toBeUndefined();
  });

  it('已結案的不看天數——結案那一刻就該處理完，放一天跟放一個月都是「帶著問題結案」', () => {
    expect(s.closedWithOpenGaps).toHaveLength(1);
    expect(s.closedWithOpenGaps[0].taskId).toBe('tC');
  });

  it('失敗任務的缺口單獨一組（任務可能就是卡在這裡失敗的）', () => {
    expect(s.failedWithOpenGaps[0].taskId).toBe('tD');
  });

  it('樣本取最舊那條', () => {
    expect(s.blocking[0].sample).toBe('缺口 1');
  });
});

describe('buildAttention — 門檻與邊界', () => {
  it('可調擱置門檻', () => {
    const gaps = [gap('1', 't', 'in_progress', '2026-09-20 00:00:00')];   // 8 天
    expect(buildAttention({ gaps, stalled: [], overdue: [], nowIso: NOW }).blocking).toHaveLength(0);
    expect(buildAttention({ gaps, stalled: [], overdue: [], nowIso: NOW, staleGapDays: 7 }).blocking).toHaveLength(1);
  });

  it('時間不帶 Z 也不會差 8 小時（剛好 30 天整不算超過）', () => {
    const gaps = [gap('1', 't', 'in_progress', '2026-08-29 00:00:00')];   // 剛好 30 天
    expect(buildAttention({ gaps, stalled: [], overdue: [], nowIso: NOW }).blocking).toHaveLength(0);
  });

  it('任務已刪除的缺口（taskStatus=null）擱置夠久也算卡住，不要被靜默丟掉', () => {
    const gaps = [gap('1', null, null, '2026-07-01 00:00:00')];
    const s = buildAttention({ gaps, stalled: [], overdue: [], nowIso: NOW });
    expect(s.blocking).toHaveLength(1);
    expect(s.blocking[0].taskId).toBeNull();
  });

  it('什麼都沒有 → empty=true，讓呼叫端可以安靜（不要推一則「一切正常」）', () => {
    expect(buildAttention({ gaps: [], stalled: [], overdue: [], nowIso: NOW }).empty).toBe(true);
  });

  it('只有停滯或逾期也不算 empty', () => {
    const s = buildAttention({ gaps: [], stalled: [{ taskId: 't', title: 'T', projectName: 'P', stalledHours: 50 }], overdue: [], nowIso: NOW });
    expect(s.empty).toBe(false);
  });

  it('停滯依時數由多到少、逾期依到期日由早到晚', () => {
    const s = buildAttention({
      gaps: [],
      stalled: [
        { taskId: 'a', title: 'A', projectName: 'P', stalledHours: 30 },
        { taskId: 'b', title: 'B', projectName: 'P', stalledHours: 90 },
      ],
      overdue: [
        { taskId: 'x', title: 'X', projectName: 'P', dueDate: '2026-09-20', dueText: '已逾期 8 天' },
        { taskId: 'y', title: 'Y', projectName: 'P', dueDate: '2026-09-01', dueText: '已逾期 27 天' },
      ],
      nowIso: NOW,
    });
    expect(s.stalled.map(t => t.taskId)).toEqual(['b', 'a']);
    expect(s.overdue.map(t => t.taskId)).toEqual(['y', 'x']);
  });
});

describe('buildAttention — 量大時要能看出重點', () => {
  // 真實資料：停滯 105、逾期 124，逐條列出沒人會看；而且兩邊大量重疊
  const stalled = [
    { taskId: 'a', title: 'A', projectName: 'P1', stalledHours: 90 },
    { taskId: 'b', title: 'B', projectName: 'P1', stalledHours: 50 },
    { taskId: 'c', title: 'C', projectName: 'P2', stalledHours: 30 },
  ];
  const overdue = [
    { taskId: 'a', title: 'A', projectName: 'P1', dueDate: '2026-09-01', dueText: '已逾期 27 天' },
    { taskId: 'z', title: 'Z', projectName: 'P2', dueDate: '2026-09-10', dueText: '已逾期 18 天' },
  ];
  const s = buildAttention({ gaps: [], stalled, overdue, nowIso: NOW });

  it('依專案彙總筆數（多的排前面）', () => {
    expect(s.stalledByProject).toEqual([{ projectName: 'P1', count: 2 }, { projectName: 'P2', count: 1 }]);
    expect(s.overdueByProject).toEqual([{ projectName: 'P1', count: 1 }, { projectName: 'P2', count: 1 }]);
  });

  it('同時停滯又逾期的任務要標出來（同一件事不該當兩件看）', () => {
    expect(s.overdue.find(t => t.taskId === 'a')?.alsoStalled).toBe(true);
    expect(s.overdue.find(t => t.taskId === 'z')?.alsoStalled).toBe(false);
    expect(s.counts.stalledAndOverdue).toBe(1);
  });
});

describe('diffAttention — 只推新的變化', () => {
  const day1 = buildAttention({
    gaps: [gap('g1', 'tA', 'in_progress', '2026-07-01 00:00:00'), gap('g2', 'tC', 'completed', '2026-09-01 00:00:00')],
    stalled: [{ taskId: 's1', title: 'S1', projectName: 'P', stalledHours: 50 }],
    overdue: [{ taskId: 'o1', title: 'O1', projectName: 'P', dueDate: '2026-09-01', dueText: '已逾期 27 天' }],
    nowIso: NOW,
  });

  it('沒有上次快照 → 視為建立基線，不把全部當成「新的」轟炸', () => {
    const d = diffAttention(null, day1);
    expect(d.baseline).toBe(true);
    expect(d.hasNews).toBe(true);
    expect(d.newStalled).toEqual([]);
  });

  it('跟上次一模一樣 → 沒有新消息（呼叫端該保持安靜）', () => {
    const d = diffAttention(snapshotOf(day1), day1);
    expect(d.baseline).toBe(false);
    expect(d.hasNews).toBe(false);
  });

  it('新出現的才列；已經報過的不重報；消失的只計數', () => {
    const day2 = buildAttention({
      gaps: [
        gap('g1', 'tA', 'in_progress', '2026-07-01 00:00:00'),
        gap('g3', 'tA', 'in_progress', '2026-07-15 00:00:00'),   // 同任務多一條 → 這組算新的
        gap('g2', 'tC', 'completed', '2026-09-01 00:00:00'),
      ],
      stalled: [
        { taskId: 's1', title: 'S1', projectName: 'P', stalledHours: 74 },
        { taskId: 's2', title: 'S2', projectName: 'P', stalledHours: 30 },
      ],
      overdue: [],                                               // o1 處理掉了
      nowIso: NOW,
    });
    const d = diffAttention(snapshotOf(day1), day2);
    expect(d.hasNews).toBe(true);
    expect(d.newBlocking.map(g => g.taskId)).toEqual(['tA']);
    expect(d.newBlocking[0].newGapCount).toBe(1);
    expect(d.newClosedWithOpenGaps).toEqual([]);
    expect(d.newStalled.map(t => t.taskId)).toEqual(['s2']);
    expect(d.newOverdue).toEqual([]);
    expect(d.cleared.overdue).toBe(1);
  });

  it('只有東西消失（變好）也算值得說一聲', () => {
    const day2 = buildAttention({
      gaps: [gap('g1', 'tA', 'in_progress', '2026-07-01 00:00:00'), gap('g2', 'tC', 'completed', '2026-09-01 00:00:00')],
      stalled: [],                                               // s1 有人接手了
      overdue: [{ taskId: 'o1', title: 'O1', projectName: 'P', dueDate: '2026-09-01', dueText: '已逾期 28 天' }],
      nowIso: NOW,
    });
    const d = diffAttention(snapshotOf(day1), day2);
    expect(d.cleared.stalled).toBe(1);
    expect(d.hasNews).toBe(true);
  });
});

describe('shouldRunDigest — 每天一次、固定時間之後', () => {
  const at = (s: string) => new Date(s);   // 本地時間
  it('今天還沒跑、已過設定時間 → 跑', () => {
    expect(shouldRunDigest('2026-09-27', at('2026-09-28T09:30:00'), 9)).toBe(true);
  });
  it('還沒到設定時間 → 不跑', () => {
    expect(shouldRunDigest('2026-09-27', at('2026-09-28T08:59:00'), 9)).toBe(false);
  });
  it('今天已經跑過 → 不跑（server 重啟也不會重推）', () => {
    expect(shouldRunDigest('2026-09-28', at('2026-09-28T15:00:00'), 9)).toBe(false);
  });
  it('從沒跑過 → 過了時間就跑', () => {
    expect(shouldRunDigest(null, at('2026-09-28T10:00:00'), 9)).toBe(true);
  });
});
