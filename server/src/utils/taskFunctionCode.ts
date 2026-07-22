import { extractFunctionCode, extractFunctionCodeFromSpecFilenames } from '../svn/SvnSpecService.js';

/** Asana 自訂欄位「功能代碼」的欄位名（人工填、權威來源）。 */
export const FUNCTION_CODE_FIELD = '功能代碼';

/** Minimal better-sqlite3 surface used here (keeps this module test-friendly). */
export interface FunctionCodeDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

/**
 * 正規化 custom field「功能代碼」的值：
 * - 先用 extractFunctionCode 抽（吃「SM07」「SM07 系統管理」「LM01」等含數字代碼）
 * - 抽不到但本身是純字母粗碼（如模組層「LM」）→ 照用（比 UUID 短碼好，歸得到組）
 * - 都不是代碼樣式（純中文、亂填）→ null，讓 taskFunctionCode 往下個來源退
 */
function normalizeFunctionCode(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const extracted = extractFunctionCode(trimmed);
  if (extracted) return extracted;
  // 純字母粗碼（extractFunctionCode 需要數字才回；這裡放行 2~10 個字母）
  if (/^[A-Za-z]{2,10}$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

/** 從 task row 的 custom_fields JSON 取「功能代碼」欄位值並正規化。 */
function functionCodeFromCustomFields(db: FunctionCodeDb, taskId: string, fieldName: string): string | null {
  try {
    const row = db.prepare('SELECT custom_fields FROM tasks WHERE id = ?').get(taskId) as { custom_fields: string | null } | undefined;
    const raw = row?.custom_fields;
    if (!raw) return null;
    const cf = JSON.parse(raw) as Record<string, unknown>;
    const val = cf[fieldName];
    if (typeof val !== 'string') return null;
    return normalizeFunctionCode(val);
  } catch {
    return null;
  }
}

/**
 * 任務功能代碼，來源優先序：
 *   1. custom_fields.功能代碼（Asana 人工填、權威——subtask 由祖先繼承而來也在此）
 *   2. parent_name 抽取（Asana 母任務常帶 DF08_… 代碼）
 *   3. title 抽取
 *   4. 綁定規格文件檔名 fallback（純中文任務名，代碼只存在於檔名，如 `[SA] SM002_系統參數.md`），
 *      以任務名精確吻合檔名中文名者優先
 * 全部落空才是真正的「共用」（無代碼）。
 *
 * 林同棪那種不用 custom field 的專案：來源 1 直接落空（值不存在或非代碼樣式），
 * 自然退回既有的 parent_name / title / 檔名鏈，行為不變。
 */
export function taskFunctionCode(
  db: FunctionCodeDb,
  taskId: unknown,
  parentName: unknown,
  title: unknown,
  functionCodeField: string = FUNCTION_CODE_FIELD,
): string | null {
  // 1. custom field（權威）
  if (typeof taskId === 'string' && taskId) {
    const fromCf = functionCodeFromCustomFields(db, taskId, functionCodeField);
    if (fromCf) return fromCf;
  }
  // 2. parent_name
  const p = typeof parentName === 'string' ? extractFunctionCode(parentName) : null;
  if (p) return p;
  // 3. title
  const t = typeof title === 'string' ? extractFunctionCode(title) : null;
  if (t) return t;
  // 4. fallback：綁定規格檔名（任務名為純中文時代碼只存在於檔名）
  if (typeof taskId === 'string' && taskId) {
    try {
      const docs = db.prepare(`
        SELECT d.filename FROM task_documents td JOIN documents d ON d.id = td.document_id
        WHERE td.task_id = ?
      `).all(taskId) as Array<{ filename: string }>;
      const preferName = typeof parentName === 'string' && parentName ? parentName
        : (typeof title === 'string' ? title : null);
      return extractFunctionCodeFromSpecFilenames(docs.map(d => d.filename), preferName);
    } catch { /* fall through to null */ }
  }
  return null;
}
