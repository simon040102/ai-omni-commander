import { describe, it, expect } from 'vitest';
import { parseServerDate } from '../datetime';

describe('parseServerDate', () => {
  it('treats a SQLite "YYYY-MM-DD HH:MM:SS" string as UTC (appends Z)', () => {
    // SQLite datetime('now') has no T and no Z — must be read as UTC, not local.
    const d = parseServerDate('2026-07-16 08:30:00');
    expect(d.toISOString()).toBe('2026-07-16T08:30:00.000Z');
  });

  it('leaves an ISO string with Z intact', () => {
    const d = parseServerDate('2026-07-16T08:30:00.000Z');
    expect(d.toISOString()).toBe('2026-07-16T08:30:00.000Z');
  });

  it('respects an explicit numeric timezone offset', () => {
    const d = parseServerDate('2026-07-16T08:30:00+08:00');
    expect(d.toISOString()).toBe('2026-07-16T00:30:00.000Z');
  });

  it('returns an invalid Date for an empty string', () => {
    expect(Number.isNaN(parseServerDate('').getTime())).toBe(true);
  });

  it('does not append Z to a date-only value (no time component)', () => {
    // No time → no tz coercion; just ensure it parses without throwing.
    const d = parseServerDate('2026-07-16');
    expect(d.getUTCFullYear()).toBe(2026);
  });
});
