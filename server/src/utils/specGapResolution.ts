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
  // 去頭尾空白 + 反覆剝除尾端標點與語氣詞（「可以。」「ok!」「都可以喔」「照舊吧」也要攔），再小寫比對。
  // 語氣詞只剝尾端、只影響黑名單比對，不影響實際落地的 note 內容。
  return note.trim().replace(/[\s。．.、，,!！?？~～喔啊啦呀囉唷嘛欸呢哦吧耶捏]+$/u, '').toLowerCase();
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
  /** 'task'＝只管開這個缺口的任務；'project'＝同專案每一支任務都適用 */
  scope: 'task' | 'project';
  /** 這一則是從別的任務帶過來的（scope='project' 時才可能為真）——注入時要標示出處 */
  fromOtherTask: boolean;
}

/**
 * 取「已裁決且 note 非空」的規格缺口——三處迴流（派工 prompt / resume_task /
 * AI 回對計畫）唯一共用的來源 SQL。舊資料（resolved 但 note 為空）不視為裁決。
 *
 * 【為什麼不只看 task_id】缺口是**誰遇到誰開**的，裁決管的卻往往是別人。2026-09-21 實例：
 * 「可收格式清單」與「上傳根目錄設定鍵」兩則開在 KB 任務底下，真正要照它做的是「匯入管線」
 * 那一支——而後者的 resolvedGaps 是空的。implementer 自己用 list_spec_gaps 撈出來才照做，
 * **獨立回對員不會這樣做**，它會照原始規格判 missing，把照裁決做對的東西判成沒做。
 *
 * 所以：本任務自己的裁決 ＋ 同專案標為 scope='project' 的裁決，一起回。
 * 後者帶 fromOtherTask=true，注入時要標明出處，讀的人才分得出「這是給我的」與「這是全案的」。
 */
export function listResolvedSpecGaps(db: Database.Database, taskId: string): ResolvedSpecGap[] {
  const rows = db.prepare(`
    SELECT g.id, g.category, g.description, g.resolution_note, g.resolved_at,
           COALESCE(g.scope, 'task') AS scope,
           CASE WHEN g.task_id = :taskId THEN 0 ELSE 1 END AS from_other_task
    FROM spec_gaps g
    WHERE g.status = 'resolved'
      AND g.resolution_note IS NOT NULL AND TRIM(g.resolution_note) != ''
      AND (
        g.task_id = :taskId
        OR (
          COALESCE(g.scope, 'task') = 'project'
          AND g.project_id = (SELECT project_id FROM tasks WHERE id = :taskId)
        )
      )
    ORDER BY from_other_task ASC, g.resolved_at ASC, g.created_at ASC
  `).all({ taskId }) as Array<{
    id: string; category: string; description: string; resolution_note: string;
    resolved_at: string | null; scope: string; from_other_task: number;
  }>;

  return rows.map(r => ({
    id: r.id,
    category: r.category,
    description: r.description,
    resolutionNote: r.resolution_note,
    resolvedAt: r.resolved_at,
    scope: r.scope === 'project' ? 'project' : 'task',
    fromOtherTask: r.from_other_task === 1,
  }));
}

/**
 * 同專案、別的任務底下、**沒有**標成 project 範圍的已裁決缺口——只回摘要，不注入。
 *
 * 用途：讓接手的人看得到「這個專案還有這些裁決，但它們只掛在別支任務上」。
 * 今天那兩則就是這種——沒有人記得標範圍，於是對需要它的任務等於不存在。
 * **這不是裁決，是線索**：真的管到本任務的，要用 resolve_spec_gap(scope='project') 重新標記，
 * 才會真的被注入。工具不替人猜哪一則相關——猜錯會把不相干的裁決當成規格。
 */
export function listOtherTaskResolvedGapDigest(
  db: Database.Database,
  taskId: string,
  limit = 20,
): Array<{ id: string; taskId: string; taskTitle: string; summary: string }> {
  const rows = db.prepare(`
    SELECT g.id, g.task_id, COALESCE(t.title, '(無標題)') AS task_title, g.description
    FROM spec_gaps g
    LEFT JOIN tasks t ON t.id = g.task_id
    WHERE g.status = 'resolved'
      AND g.resolution_note IS NOT NULL AND TRIM(g.resolution_note) != ''
      AND COALESCE(g.scope, 'task') = 'task'
      AND g.task_id != :taskId
      AND g.project_id = (SELECT project_id FROM tasks WHERE id = :taskId)
    ORDER BY g.resolved_at DESC
    LIMIT :limit
  `).all({ taskId, limit }) as Array<{ id: string; task_id: string; task_title: string; description: string }>;

  return rows.map(r => ({
    id: r.id,
    taskId: r.task_id,
    taskTitle: r.task_title,
    summary: summarizeGapText(r.description, 120),
  }));
}

/** 單行摘要：壓掉換行/連續空白，超過 max 截斷加省略號。 */
export function summarizeGapText(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 一條裁決的注入行：`- Q: {description 摘要} → 裁決: {resolution_note}`。
 *  從別的任務帶過來的（全案適用）要標出來——讀的人才分得出「這是給我這一支的」與
 *  「這是全案的規矩，只是別人先遇到」。不標的話，看到一條與自己功能無關的裁決會以為派錯了。 */
export function formatResolutionLine(gap: ResolvedSpecGap): string {
  const prefix = gap.fromOtherTask ? '[全案適用，由別支任務裁決] ' : '';
  return `- ${prefix}Q: ${summarizeGapText(gap.description)} → 裁決: ${summarizeGapText(gap.resolutionNote, 400)}`;
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
