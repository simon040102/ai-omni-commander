/**
 * 規格裁決（spec gap resolution）共用純函式。
 *
 * spec_gap = 問題，resolution_note = 使用者的裁決（答案）。裁決唯一生效管道 = DB：
 * resolve_spec_gap / Web resolve endpoint 寫入（E1 答案品質驗證），三處下游只從
 * DB 讀（E2 迴流）：ExecutionPipeline 派工 prompt、resume_task、AI 回對計畫。
 * 來源 SQL 三處一致（本模組單一真相）：
 *   status='resolved' AND resolution_note IS NOT NULL AND TRIM(resolution_note)!=''
 *   ORDER BY resolved_at ASC
 * Web（getDb）與 MCP（getMcpDb）兩個 process 共用——db handle 由呼叫端傳入，
 * 本模組不碰 process.cwd()、不自行開連線。
 */
import type Database from 'better-sqlite3';

// ── E1：resolutionNote 答案品質驗證 ─────────────────────────

/** 裁決備註最短長度（trim 後字元數）。 */
export const RESOLUTION_NOTE_MIN_LENGTH = 5;

/**
 * 空泛詞黑名單：trim（去尾標點）後全文等於這些詞 → 拒絕。
 * 這種「答案」等於沒回答——裁決效力等同規格，寫得含糊等於規格含糊。
 * 比對時一律先 normalize（小寫 + 去頭尾空白 + 去尾標點），故此清單存小寫。
 */
export const VAGUE_RESOLUTION_NOTES: readonly string[] = [
  '可以', '可', '好', '好的', '好喔', '好啊', '沒問題', '没问题', '沒意見', '没意见',
  '照舊', '照旧', '照做', '同意', '都可以', '都行', '行', '嗯', '恩', '是', '對', '对',
  '確認', '确认', '收到', '了解', '瞭解', '知道了', '就這樣', '就这样', '維持現狀', '维持现状',
  'ok', 'okay', 'k', 'yes', 'yep', 'yeah', 'sure', 'fine', 'no problem',
  'lgtm', 'approved', 'approve', 'confirm', 'confirmed', 'agree', 'agreed',
];

/** 共用的錯誤說明尾段（要求具體決定 + 範例）。 */
const NOTE_GUIDANCE =
  '請寫「具體的決定內容」（例如「選 B：刪除前 confirm 彈窗」）。' +
  '裁決效力等同規格，會自動注入後續派工與 AI 回對——寫得含糊等於規格含糊。';

function normalizeNote(note: string): string {
  // 去頭尾空白 + 去尾常見標點（「可以。」「ok!」也要攔），再小寫比對
  return note.trim().replace(/[\s。．.、，,!！?？~～]+$/u, '').toLowerCase();
}

export type ResolutionNoteValidation =
  | { ok: true; note: string }
  | { ok: false; error: string };

/**
 * 驗證裁決備註：必填、trim 後 ≥ RESOLUTION_NOTE_MIN_LENGTH 字元、不得為空泛詞。
 * 通過時回傳 trim 後的 note（寫 DB 用這個）。
 */
export function validateResolutionNote(note: unknown): ResolutionNoteValidation {
  if (typeof note !== 'string' || note.trim() === '') {
    return { ok: false, error: `resolutionNote 必填——${NOTE_GUIDANCE}` };
  }
  const trimmed = note.trim();
  const normalized = normalizeNote(trimmed);
  if (VAGUE_RESOLUTION_NOTES.includes(normalized)) {
    return { ok: false, error: `resolutionNote 過於空泛（「${trimmed}」）——${NOTE_GUIDANCE}` };
  }
  if (trimmed.length < RESOLUTION_NOTE_MIN_LENGTH) {
    return { ok: false, error: `resolutionNote 過短（trim 後 ${trimmed.length} 字元，至少 ${RESOLUTION_NOTE_MIN_LENGTH}）——${NOTE_GUIDANCE}` };
  }
  return { ok: true, note: trimmed };
}

// ── E2：已裁決缺口的唯一來源查詢 + 注入格式 ────────────────

export interface ResolvedSpecGap {
  id: string;
  category: string;
  description: string;
  resolutionNote: string;
  resolvedAt: string | null;
}

/**
 * 取任務「已裁決且 note 非空」的規格缺口——三處迴流（派工 prompt / resume_task /
 * AI 回對計畫）唯一共用的來源 SQL。舊資料（resolved 但 note 為空）不視為裁決。
 */
export function listResolvedSpecGaps(db: Database.Database, taskId: string): ResolvedSpecGap[] {
  const rows = db.prepare(`
    SELECT id, category, description, resolution_note, resolved_at
    FROM spec_gaps
    WHERE task_id = ? AND status = 'resolved' AND resolution_note IS NOT NULL AND TRIM(resolution_note) != ''
    ORDER BY resolved_at ASC, created_at ASC
  `).all(taskId) as Array<{ id: string; category: string; description: string; resolution_note: string; resolved_at: string | null }>;

  return rows.map(r => ({
    id: r.id,
    category: r.category,
    description: r.description,
    resolutionNote: r.resolution_note,
    resolvedAt: r.resolved_at,
  }));
}

/** 單行摘要：壓掉換行/連續空白，超過 max 截斷加省略號。 */
export function summarizeGapText(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 一條裁決的注入行：`- Q: {description 摘要} → 裁決: {resolution_note}`。 */
export function formatResolutionLine(gap: ResolvedSpecGap): string {
  return `- Q: ${summarizeGapText(gap.description)} → 裁決: ${summarizeGapText(gap.resolutionNote, 400)}`;
}

/**
 * 依字元預算組裁決行（比照元件知識庫的預算模式）：超出預算的行不印、標 truncated。
 * budget 省略 = 不設上限（派工 prompt 用；review plan 帶 4000 防肥）。
 */
export function buildResolutionLines(
  gaps: ResolvedSpecGap[],
  budget?: number,
): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let remaining = budget ?? Number.POSITIVE_INFINITY;
  let truncated = false;
  for (const gap of gaps) {
    const line = formatResolutionLine(gap);
    if (line.length + 1 > remaining) { truncated = true; break; }
    remaining -= line.length + 1;
    lines.push(line);
  }
  return { lines, truncated };
}
