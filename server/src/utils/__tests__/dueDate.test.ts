import { describe, it, expect } from 'vitest';
import { normalizeDueDate, localTodayYmd, isOverdue, describeDueDate } from '../dueDate.js';

describe('normalizeDueDate', () => {
  it('keeps YYYY-MM-DD strings as-is', () => {
    expect(normalizeDueDate('2026-07-25')).toBe('2026-07-25');
  });

  it('non-string values → null (undefined / null / number / object)', () => {
    expect(normalizeDueDate(undefined)).toBeNull();
    expect(normalizeDueDate(null)).toBeNull();
    expect(normalizeDueDate(20260725)).toBeNull();
    expect(normalizeDueDate({ date: '2026-07-25' })).toBeNull();
  });

  it('empty / whitespace-only strings → null', () => {
    expect(normalizeDueDate('')).toBeNull();
    expect(normalizeDueDate('   ')).toBeNull();
  });
});

describe('localTodayYmd', () => {
  it('formats the local date as YYYY-MM-DD with zero padding', () => {
    expect(localTodayYmd(new Date(2026, 0, 5))).toBe('2026-01-05'); // month index 0 = January
    expect(localTodayYmd(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('isOverdue', () => {
  const today = '2026-07-20';

  it('due before today → overdue', () => {
    expect(isOverdue('2026-07-19', today)).toBe(true);
  });

  it('due today or later → not overdue', () => {
    expect(isOverdue('2026-07-20', today)).toBe(false);
    expect(isOverdue('2026-07-21', today)).toBe(false);
  });

  it('null / undefined → not overdue', () => {
    expect(isOverdue(null, today)).toBe(false);
    expect(isOverdue(undefined, today)).toBe(false);
  });
});

describe('describeDueDate', () => {
  const today = '2026-07-20';

  it('past due → 已逾期 N 天', () => {
    expect(describeDueDate('2026-07-18', today)).toBe('已逾期 2 天');
    expect(describeDueDate('2026-07-19', today)).toBe('已逾期 1 天');
  });

  it('due today → 今天到期', () => {
    expect(describeDueDate('2026-07-20', today)).toBe('今天到期');
  });

  it('future due → N 天後到期 (crosses month boundary correctly)', () => {
    expect(describeDueDate('2026-07-23', today)).toBe('3 天後到期');
    expect(describeDueDate('2026-08-01', today)).toBe('12 天後到期');
  });

  it('no due date or unparseable → null', () => {
    expect(describeDueDate(null, today)).toBeNull();
    expect(describeDueDate(undefined, today)).toBeNull();
    expect(describeDueDate('not-a-date', today)).toBeNull();
  });
});
