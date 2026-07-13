/**
 * SpecFetchPolicy — 規格抓取「決策邏輯」共用純函式。
 *
 * Web 端（SvnSpecService，async I/O）與 MCP 端（document-tools fetch_svn_specs，
 * sync I/O）是兩份平行的 I/O 實作，但以下三個決策必須一致，統一收斂在這裡：
 *
 * 1. 中文名 fallback 抽取（extractChineseNames）— 兩端的 SVN 與資料夾比對都要用
 * 2. 去重決策（decideDedupe）— content_hash 版：內容相同只 bump 版本，不重寫檔案
 * 3. prepare 失敗歸類（classifyPrepareResult）— 資料夾完全不可用 → error（可升級
 *    [SPEC_FETCH_ERROR] banner）；pull 失敗／dirty → warning（best-effort 用現有內容）
 *
 * 純函式：不 import DB / DocumentParser / config，不碰 process.cwd()，
 * 供 Web Server 與 MCP 兩個 process 共用。
 */

// ── 1. 中文名 fallback ──────────────────────────────────────

/**
 * 從任務 parent_name / title 抽取中文功能名（Asana parent 無功能代碼時的
 * fallback 比對用）：去掉開頭的英數代碼與結尾的「前端/後端/串接」，
 * 留下含 CJK 的名稱（如 "DF01_收文單" → "收文單"、"收文單_前端" → "收文單"）。
 * 多個來源文字去重、保持順序；抽不出中文的來源略過。
 */
export function extractChineseNames(...texts: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    const cn = text.replace(/^[A-Za-z0-9]+[_\s]*/g, '').replace(/[_\s]*(前端|後端|串接)$/g, '');
    if (cn && /[一-鿿]/.test(cn) && !names.includes(cn)) names.push(cn);
  }
  return names;
}

// ── 2. 去重決策（content_hash 版）───────────────────────────

/** documents 既有列的去重判定資訊。 */
export interface ExistingDocInfo {
  /** documents.svn_last_modified（SVN Last Changed Date 或資料夾檔案版本） */
  version: string | null;
  /** documents.content_hash（sha256 hex；舊資料可能為 null） */
  contentHash: string | null;
  /** 快取檔案是否還在磁碟上（不在 → 一律重新下載/複製） */
  fileExists: boolean;
}

/**
 * 去重決策：
 * - `skip`         — 版本沒變且檔案還在 → 只重新 bind，不下載不讀檔
 * - `bump_version` — 內容 hash 相同（版本變了但內容沒變）→ 只更新版本欄位 + bind
 * - `update`       — 內容變了或快取檔遺失 → 覆寫既有 document
 * - `insert`       — 沒有既有列 → 新增 document
 */
export type DedupeDecision = 'skip' | 'bump_version' | 'update' | 'insert';

/**
 * 兩段式呼叫：
 * 1. 下載/讀檔前先以 `newContentHash = null` 呼叫 — 回 'skip' 就直接 bind 結束；
 * 2. 否則下載/讀檔並算出 sha256 後再呼叫一次，依回傳做 bump_version / update / insert。
 */
export function decideDedupe(
  existing: ExistingDocInfo | null,
  newVersion: string | null,
  newContentHash: string | null,
): DedupeDecision {
  if (!existing) return 'insert';
  if (existing.fileExists && newVersion !== null && newVersion !== '' && existing.version === newVersion) {
    return 'skip';
  }
  if (
    existing.fileExists &&
    newContentHash !== null &&
    existing.contentHash !== null &&
    existing.contentHash === newContentHash
  ) {
    return 'bump_version';
  }
  return 'update';
}

// ── 3. prepare 失敗歸類 ─────────────────────────────────────

/** 規格來源問題分級：errors 可升級 [SPEC_FETCH_ERROR] banner；warnings 只列在文件區塊。 */
export interface SpecSourceIssues {
  errors: string[];
  warnings: string[];
}

/**
 * prepareFolder 結果統一歸類（兩端一致）：
 * - 資料夾完全不可用（不存在／不是目錄／非絕對路徑）→ error
 * - pull 失敗／working tree dirty／git status 失敗 → warning（best-effort 用現有內容）
 * warnings 一律加上資料夾路徑前綴，方便多來源時定位。
 */
export function classifyPrepareResult(
  folderPath: string,
  prep: { ok: boolean; warnings: string[]; error?: string },
): SpecSourceIssues {
  const warnings = prep.warnings.map(w => `${folderPath}: ${w}`);
  const errors = prep.ok ? [] : [prep.error || `規格資料夾無法使用：${folderPath}`];
  return { errors, warnings };
}
