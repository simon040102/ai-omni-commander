import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import {
  validateResolutionNote,
  RESOLUTION_NOTE_MIN_LENGTH,
  listResolvedSpecGaps,
  listOtherTaskResolvedGapDigest,
  summarizeGapText,
  formatResolutionLine,
  buildResolutionLines,
  buildRulingsBlock,
} from '../specGapResolution.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    for (const vague of ['可以', 'OK', 'ok', '照舊', '同意', '沒問題', '好', '可以。', 'no problem', 'LGTM', '都可以！', '都可以喔。', '照舊吧', '沒問題喔', '好啊啦']) {
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

  function insertGap(id: string, opts: { status?: string; note?: string | null; resolvedAt?: string | null; taskId?: string; scope?: string; projectId?: string } = {}) {
    db.prepare(`
      INSERT INTO spec_gaps (id, task_id, project_id, category, description, status, resolution_note, resolved_at, scope)
      VALUES (?, ?, ?, 'logic_unclear', ?, ?, ?, ?, ?)
    `).run(id, opts.taskId ?? 'task-1', opts.projectId ?? 'proj-1', `desc-${id}`, opts.status ?? 'resolved', opts.note ?? null, opts.resolvedAt ?? null, opts.scope ?? 'task');
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

  // ══════════════════════════════════════════════════════════
  // scope='project'：裁決是「誰遇到誰開」的，管的卻往往是別人
  //
  // 2026-09-21 實例：「可收格式清單」與「上傳根目錄設定鍵」開在 KB 任務底下，
  // 真正要照做的是「匯入管線」那一支——而它的 resolvedGaps 是空的。implementer
  // 自己 list_spec_gaps 撈出來才照做，但**獨立回對員不會這樣做**，會照原始規格
  // 判 missing，把已經照裁決做對的東西判成沒做。
  // ══════════════════════════════════════════════════════════
  describe('scope（跨任務適用）', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-2', 'proj-1', '匯入管線', 'backend', 'feature')`).run();
      db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-2', 'Other', '/tmp2')`).run();
      db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-x', 'proj-2', '別專案', 'backend', 'feature')`).run();
    });

    it('別支任務標 project 的裁決會注入，且標記 fromOtherTask', () => {
      insertGap('g-mine', { note: '我自己的裁決', resolvedAt: '2026-01-02 00:00:00' });
      insertGap('g-shared', { note: '上傳根目錄走 Spring 屬性', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-2', scope: 'project' });

      const gaps = listResolvedSpecGaps(db, 'task-1');
      expect(gaps.map(g => g.id).sort()).toEqual(['g-mine', 'g-shared']);
      expect(gaps.find(g => g.id === 'g-shared')).toMatchObject({ scope: 'project', fromOtherTask: true });
      expect(gaps.find(g => g.id === 'g-mine')).toMatchObject({ scope: 'task', fromOtherTask: false });
    });

    it('★ 別支任務標 task 的裁決不可注入（否則不相干的裁決會被當成規格）', () => {
      insertGap('g-theirs', { note: '只管他們那一支', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-2', scope: 'task' });
      expect(listResolvedSpecGaps(db, 'task-1')).toEqual([]);
    });

    it('★ 別專案標 project 的裁決不可跨專案注入', () => {
      insertGap('g-other-proj', { note: '別的專案的全案裁決', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-x', projectId: 'proj-2', scope: 'project' });
      expect(listResolvedSpecGaps(db, 'task-1')).toEqual([]);
    });

    it('自己任務的裁決排在前面（先看自己的，再看全案的）', () => {
      insertGap('g-shared', { note: '全案', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-2', scope: 'project' });
      insertGap('g-mine', { note: '自己的', resolvedAt: '2026-01-09 00:00:00' });
      expect(listResolvedSpecGaps(db, 'task-1').map(g => g.id)).toEqual(['g-mine', 'g-shared']);
    });

    // v22 遷移用 `ADD COLUMN scope TEXT NOT NULL DEFAULT 'task'`，SQLite 會把既有列
    // 回填成 'task'，所以 NULL 在實務上不會出現（第一版測試假設會，是錯的）。
    // 真正該釘的是：**沒帶 scope 建立的缺口仍然照常注入**——這是 report_spec_gap 的
    // 實際路徑，加了這一欄不可以讓既有裁決從注入清單裡消失。
    it('★ 建立時未指定 scope 的缺口視同 task，且照常注入（加欄位不得讓既有裁決消失）', () => {
      db.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description, status, resolution_note, resolved_at)
        VALUES ('g-nocol', 'task-1', 'proj-1', 'logic_unclear', 'desc', 'resolved', '舊裁決', '2026-01-01 00:00:00')
      `).run();
      const gaps = listResolvedSpecGaps(db, 'task-1');
      expect(gaps.map(g => g.id)).toEqual(['g-nocol']);
      expect(gaps[0].scope).toBe('task');
      expect(gaps[0].fromOtherTask).toBe(false);
    });
  });

  describe('listOtherTaskResolvedGapDigest（線索，不是裁決）', () => {
    beforeEach(() => {
      db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-2', 'proj-1', '匯入管線', 'backend', 'feature')`).run();
    });

    it('列出同專案、別支任務、未標 project 的已裁決缺口', () => {
      insertGap('g-hint', { note: '可收格式清單照舊碼', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-2', scope: 'task' });
      const hints = listOtherTaskResolvedGapDigest(db, 'task-1');
      expect(hints).toHaveLength(1);
      expect(hints[0]).toMatchObject({ id: 'g-hint', taskId: 'task-2', taskTitle: '匯入管線' });
    });

    it('★ 已經標成 project 的不再出現在線索裡（它已經被注入了，再列一次會讓人以為還沒處理）', () => {
      insertGap('g-done', { note: '已標全案', resolvedAt: '2026-01-01 00:00:00', taskId: 'task-2', scope: 'project' });
      expect(listOtherTaskResolvedGapDigest(db, 'task-1')).toEqual([]);
    });

    it('★ 自己任務的裁決不出現在線索裡（那些已經在 resolvedGaps）', () => {
      insertGap('g-mine', { note: '自己的裁決', resolvedAt: '2026-01-01 00:00:00' });
      expect(listOtherTaskResolvedGapDigest(db, 'task-1')).toEqual([]);
    });
  });
});

describe('formatting helpers', () => {
  const gap = (id: string, desc: string, note: string, fromOtherTask = false) => ({
    id, category: 'other', description: desc, resolutionNote: note, resolvedAt: null,
    scope: (fromOtherTask ? 'project' : 'task') as 'task' | 'project', fromOtherTask,
  });

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

  // 從別支任務帶過來的裁決要標出處：不標的話，讀的人看到一條與自己功能無關的裁決
  // 會以為派錯了而忽略它——那正是這個機制要防的事。
  it('formatResolutionLine 標示「由別支任務裁決、全案適用」', () => {
    const line = formatResolutionLine(gap('g', '上傳根目錄設定鍵？', '走 Spring 屬性，不進清冊', true));
    expect(line).toContain('[全案適用，由別支任務裁決]');
    expect(line).toContain('走 Spring 屬性');
  });

  // ★ 負向：自己任務的裁決不可被標成別人的（標了會讓人以為不是給自己的）
  it('★ 自己任務的裁決不帶「別支任務」前綴', () => {
    expect(formatResolutionLine(gap('g', 'q', 'a'))).not.toContain('別支任務');
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

// ── buildRulingsBlock：派工與回對共用同一份裁決區塊 ──────────────────
// 原本派工全塞（每則還被截短到 160／400 字）、回對只給前 4000 字（約 10 則）——
// 兩邊看到的裁決不一樣，回對員判 missing 的東西可能正是照裁決做對的。
// 新規則：預算內全列；超過就把**全部**裁決全文寫檔，prompt 列放得下的本任務裁決＋檔案指引。
// 不能無上限塞：回對計畫有 25000 字總上限，裁決段在前面，塞爆會把尾端的檢查表擠掉。
describe('buildRulingsBlock（派工與回對共用）', () => {
  const g = (id: string, desc: string, note: string, fromOtherTask = false) => ({
    id, category: 'other', description: desc, resolutionNote: note, resolvedAt: '2026-09-01 00:00:00',
    scope: (fromOtherTask ? 'project' : 'task') as 'task' | 'project', fromOtherTask,
  });
  let dataDir: string;
  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rulings-')); });
  const opts = (inlineBudget: number) => ({ taskId: 'T1', dataDir, inlineBudget });

  it('預算內 → 全部逐條列出，不寫檔（小專案行為不變）', () => {
    const r = buildRulingsBlock([g('own', '自己的', '選 A'), g('p1', '全案一', '選 B', true)], opts(5000));
    expect(r.lines.join('\n')).toContain('選 A');
    expect(r.lines.join('\n')).toContain('選 B');
    expect(r.rulingsFile).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'rulings'))).toBe(false);
  });

  it('超出預算 → 全部裁決全文寫進檔案，一則都不少、也不截短；prompt 指出檔案與則數', () => {
    const longNote = '裁決內容'.repeat(200);   // 800 字，原本會被截到 400
    const project = Array.from({ length: 30 }, (_, i) => g(`p${i}`, `全案問題 ${i}`, `${longNote}#${i}`, true));
    const r = buildRulingsBlock([g('own', '自己的問題', '自己的裁決'), ...project], opts(2000));

    const text = r.lines.join('\n');
    expect(text).toContain('自己的裁決');            // 放得下的本任務裁決照列
    expect(text).not.toContain('全案問題 0');         // 全案的不逐條塞進 prompt
    expect(r.rulingsFile).toBeTruthy();
    expect(text).toContain(r.rulingsFile!);          // 指出檔案位置
    expect(text).toContain('30');                    // 講清楚還有幾則沒列

    const file = fs.readFileSync(r.rulingsFile!, 'utf8');
    expect(file).toContain('自己的裁決');            // 檔案是完整清單，本任務的也在
    for (let i = 0; i < 30; i++) expect(file).toContain(`全案問題 ${i}`);
    expect(file).toContain(`${longNote}#29`);       // 全文，不截短
    expect(file).toContain('p7');                   // 帶 gapId，查得回來源
  });

  it('本任務自己的裁決也超過預算 → 放得下的照列、其餘在檔案（不會無上限撐爆 prompt）', () => {
    const own = Array.from({ length: 50 }, (_, i) => g(`o${i}`, `自己的 ${i}`, '照做'.repeat(50)));
    const r = buildRulingsBlock(own, opts(1000));
    const text = r.lines.join('\n');
    expect(text.length).toBeLessThan(1000 + 600);   // 預算＋一行指引
    expect(text).toContain('自己的 0');
    expect(text).not.toContain('自己的 49');
    const file = fs.readFileSync(r.rulingsFile!, 'utf8');
    for (let i = 0; i < 50; i++) expect(file).toContain(`自己的 ${i}`);
  });

  it('同樣的輸入兩次 → 一樣的輸出（派工與回對看到的一模一樣）', () => {
    const gaps = [g('own', 'q', 'a'), ...Array.from({ length: 30 }, (_, i) => g(`p${i}`, `q${i}`, 'x'.repeat(200), true))];
    const a = buildRulingsBlock(gaps, opts(1000));
    const b = buildRulingsBlock(gaps, opts(1000));
    expect(a.lines).toEqual(b.lines);
  });

  it('沒有任何裁決 → 空', () => {
    const r = buildRulingsBlock([], opts(500));
    expect(r.lines).toEqual([]);
    expect(r.rulingsFile).toBeNull();
  });
});
