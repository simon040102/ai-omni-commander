import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import {
  validateResolutionNote,
  RESOLUTION_NOTE_MIN_LENGTH,
  listResolvedSpecGaps,
  summarizeGapText,
  formatResolutionLine,
  buildResolutionLines,
} from '../specGapResolution.js';

describe('validateResolutionNote（E1 答案品質）', () => {
  it('rejects missing / empty / whitespace-only note（必填）', () => {
    for (const bad of [undefined, null, '', '   ', '\n\t'] as unknown[]) {
      const r = validateResolutionNote(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('必填');
        expect(r.error).toContain('具體的決定內容');
        expect(r.error).toContain('選 B：刪除前 confirm 彈窗');
      }
    }
  });

  it('rejects too-short notes with min length in the message', () => {
    const r = validateResolutionNote('選B');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('過短');
      expect(r.error).toContain(String(RESOLUTION_NOTE_MIN_LENGTH));
      expect(r.error).toContain('具體的決定內容');
    }
  });

  it('rejects vague blacklist words（含大小寫 / 尾標點變體）', () => {
    for (const vague of ['可以', 'OK', 'ok', '照舊', '同意', '沒問題', '好', '可以。', 'no problem', 'LGTM', '都可以！']) {
      const r = validateResolutionNote(vague);
      expect(r.ok, `should reject "${vague}"`).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('空泛');
        expect(r.error).toContain('選 B：刪除前 confirm 彈窗');
      }
    }
  });

  it('accepts a concrete decision and returns the trimmed note', () => {
    const r = validateResolutionNote('  選 B：刪除前 confirm 彈窗  ');
    expect(r).toEqual({ ok: true, note: '選 B：刪除前 confirm 彈窗' });
  });

  it('accepts long notes that merely contain a vague word（黑名單只比全文相等）', () => {
    const r = validateResolutionNote('可以刪除，但刪除前必須 confirm 彈窗（選 B）');
    expect(r.ok).toBe(true);
  });
});

describe('listResolvedSpecGaps（E2 唯一來源 SQL）', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-1', 'Test', '/tmp')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-1', 'proj-1', 'WA05', 'frontend', 'feature')`).run();
  });

  function insertGap(id: string, opts: { status?: string; note?: string | null; resolvedAt?: string | null; taskId?: string } = {}) {
    db.prepare(`
      INSERT INTO spec_gaps (id, task_id, project_id, category, description, status, resolution_note, resolved_at)
      VALUES (?, ?, 'proj-1', 'logic_unclear', ?, ?, ?, ?)
    `).run(id, opts.taskId ?? 'task-1', `desc-${id}`, opts.status ?? 'resolved', opts.note ?? null, opts.resolvedAt ?? null);
  }

  it('returns only resolved gaps with a non-empty note, ordered by resolved_at ASC', () => {
    insertGap('g-open', { status: 'open', note: null });
    insertGap('g-empty', { status: 'resolved', note: '', resolvedAt: '2026-01-01 00:00:00' });
    insertGap('g-blank', { status: 'resolved', note: '   ', resolvedAt: '2026-01-01 00:00:00' });
    insertGap('g-null', { status: 'resolved', note: null, resolvedAt: '2026-01-01 00:00:00' });
    insertGap('g-late', { status: 'resolved', note: '裁決乙', resolvedAt: '2026-01-02 00:00:00' });
    insertGap('g-early', { status: 'resolved', note: '裁決甲', resolvedAt: '2026-01-01 00:00:00' });

    const gaps = listResolvedSpecGaps(db, 'task-1');
    expect(gaps.map(g => g.id)).toEqual(['g-early', 'g-late']);
    expect(gaps[0]).toMatchObject({ category: 'logic_unclear', description: 'desc-g-early', resolutionNote: '裁決甲', resolvedAt: '2026-01-01 00:00:00' });
  });

  it('scopes to the given task', () => {
    db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-2', 'proj-1', 'WA06', 'frontend', 'feature')`).run();
    insertGap('g-1', { note: '裁決一', resolvedAt: '2026-01-01 00:00:00' });
    insertGap('g-2', { note: '別的任務', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-2' });

    expect(listResolvedSpecGaps(db, 'task-1').map(g => g.id)).toEqual(['g-1']);
  });
});

describe('formatting helpers', () => {
  const gap = (id: string, desc: string, note: string) => ({ id, category: 'other', description: desc, resolutionNote: note, resolvedAt: null });

  it('summarizeGapText collapses whitespace and truncates', () => {
    expect(summarizeGapText('a\n b\t c')).toBe('a b c');
    const long = 'x'.repeat(200);
    expect(summarizeGapText(long, 160)).toBe(`${'x'.repeat(160)}…`);
  });

  it('formatResolutionLine renders Q → 裁決', () => {
    expect(formatResolutionLine(gap('g', '刪除是否需要確認？', '選 B：刪除前 confirm 彈窗'))).toBe(
      '- Q: 刪除是否需要確認？ → 裁決: 選 B：刪除前 confirm 彈窗',
    );
  });

  it('buildResolutionLines honors the char budget and flags truncation', () => {
    const gaps = [gap('g1', 'q1', 'a1'), gap('g2', 'q2', 'a2'), gap('g3', 'q3', 'a3')];
    const full = buildResolutionLines(gaps);
    expect(full.lines).toHaveLength(3);
    expect(full.truncated).toBe(false);

    const lineLen = formatResolutionLine(gaps[0]).length;
    const limited = buildResolutionLines(gaps, lineLen + 1); // 只夠一行
    expect(limited.lines).toHaveLength(1);
    expect(limited.truncated).toBe(true);
  });
});
