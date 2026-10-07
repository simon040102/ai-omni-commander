/**
 * AI 回對證據驗證（Evidence Validator）— 純函式，零 LLM。
 *
 * 核心理念：**AI 判定、程式驗證判定依據**。save_compliance_review 收到的每筆
 * status='matched' 的 evidence {file, line}，寫入 run 之前由本模組驗證：
 *
 *  1. 路徑解析 — file 視為相對路徑，依 item.side 對 frontend/backend root 依序
 *     解析（both 兩邊都試），再試本專案已登記的規格 root（specRoots——交付物是
 *     規格文件的 architect 任務，證據不在 workspace 裡）；也接受「位於某個
 *     root 之下的絕對路徑」。路徑正規化防 `..` 逃出 root。解析後必須真實存在
 *     且是檔案。
 *  2. 行號 — 1 <= line <= 檔案行數。
 *  3. 內容相關性（±10 行窗口）— 沿用 compliance-engine 的比對原則：
 *     - ui_text → 窗口內含 item.content（多行文字取首個非空行，同引擎 fallback）
 *     - api → 引擎的 path 佔位正規化 regex（{x} / :x / ${x} 等價）在窗口內命中
 *     - param / response_field / db_field → 引擎的識別字規則（word-boundary，
 *       純 CJK 退回 substring）在窗口內命中
 *     - logic → 語意無法字串驗，只驗 1+2、跳過相關性
 *
 * 不碰 DB、不碰 process.cwd() — workspace roots 由呼叫端傳入（絕對路徑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseApiContent, buildApiPathRegex, makeIdentifierTester,
  deriveIdentifierCandidates, apiPathSplits,
  type ChecklistItemType, type ChecklistSide, type WorkspaceRoots,
} from './compliance-engine.js';

export interface EvidenceRef {
  file: string;
  line: number;
}

export interface EvidenceCheckInput {
  itemId: string;
  itemType: ChecklistItemType;
  content: string;
  side: ChecklistSide;
  detail?: Record<string, unknown> | null;
  evidence: EvidenceRef[];
}

export interface EvidenceFailure {
  itemId: string;
  file: string;
  line: number;
  reason: string;
}

export const RELEVANCE_WINDOW = 10;

function shorten(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** side 對應的 root 清單；side 指定的 root 未設定時退回所有可用 workspace root
 *  （side 標錯不應誤殺真實證據——證據仍必須落在某個 root 之下）。
 *
 *  specRoots（本專案已登記的規格來源）一律附在最後：交付物是規格文件的任務
 *  （architect：SA/SD 改寫維護）證據本來就不在 workspace 裡，沒有這組 root
 *  它的每一筆證據都會被「絕對路徑不在 workspace 之下」拒收，逼回對員在
 *  假證據／假 missing／卡死之間選。規格 root 的解析規則與 workspace root
 *  完全相同（產物目錄排除、大小上限、`..` 逃逸防護）——放寬的是「哪些樹算數」，
 *  不是「怎麼驗」。 */
function candidateRoots(side: ChecklistSide, roots: WorkspaceRoots): string[] {
  const specRoots = (roots.specRoots ?? []).filter(r => typeof r === 'string' && r.length > 0);
  const preferred: string[] = [];
  if (side !== 'backend' && roots.frontend) preferred.push(roots.frontend);
  if (side !== 'frontend' && roots.backend) preferred.push(roots.backend);
  if (preferred.length > 0) return [...preferred, ...specRoots];
  const workspaceRoots = [roots.frontend, roots.backend]
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
  return [...workspaceRoots, ...specRoots];
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 同一路徑的去重鍵（win32 大小寫不敏感）。 */
function rootKey(p: string): string {
  return process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
}

/**
 * 把「專案已登記的規格資料夾」解析成**綁定本專案**的證據 root 清單。
 *
 * 綁定的兩道機制：
 *  1. folderPaths 只能是該專案 config_json.specFolders 的 path——別的專案的
 *     規格資料夾不會出現在本專案的設定裡，本來就取不到。
 *  2. 多專案共用的知識庫（`<kb>/<專案 id>/...` 版面）：登記的資料夾底下若直接放著
 *     「以專案 id 命名的子資料夾」（omni 自己的 project id，或任何 UUID 形狀的目錄名
 *     ——spec-agent 知識庫用的是它自己的專案 id，與 omni 的不同號），視為**共用知識庫根**：
 *     **只收 `<kb>/<本專案 id>`**；本專案的子資料夾不存在就整個 root 不收（要用就去登記
 *     自己那一棵的完整路徑）。否則 A 專案登記知識庫根之後就能引用 B 專案的規格當證據。
 *
 * 其餘情況（登記的資料夾就是本專案自己的規格夾）沿用該資料夾本身。
 * 相對路徑、不存在的路徑一律略過（相對路徑在設定期就已被 validateSpecFolders 擋下）。
 */
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** root 底下是否直接放著「別的專案的目錄」（UUID 形狀的目錄名，且不是本專案）。 */
function hasForeignProjectDirs(root: string, projectId: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return false;
  }
  return entries.some(name =>
    UUID_DIR_RE.test(name)
    && name.toLowerCase() !== projectId.toLowerCase()
    && isDir(path.join(root, name)));
}

export function resolveProjectSpecRoots(
  projectId: string,
  folderPaths: Array<string | null | undefined>,
  knownProjectIds: string[] = [],
): string[] {
  const otherIds = knownProjectIds.filter(id => typeof id === 'string' && id.length > 0 && id !== projectId);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string): void => {
    const key = rootKey(p);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(path.normalize(p));
  };
  for (const raw of folderPaths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || !path.isAbsolute(trimmed)) continue;
    const root = path.normalize(trimmed);
    if (!isDir(root)) continue;
    const ownScoped = projectId.length > 0 ? path.join(root, projectId) : '';
    if (ownScoped && isDir(ownScoped)) {
      push(ownScoped); // 知識庫版面（或剛好同名子夾）——只收自己那一棵
      continue;
    }
    // 沒有自己的子資料夾，但底下有「別人的專案資料夾」→ 是共用知識庫根，整個不收。
    // 判別兩路：已知的 omni project id，或 UUID 形狀的目錄名（外部工具的知識庫
    // 用它自己的專案編號，omni 認不得——但版面一樣是一個專案一個 UUID 目錄）。
    if (otherIds.some(id => isDir(path.join(root, id))) || hasForeignProjectDirs(root, projectId)) continue;
    push(root);
  }
  return out;
}

/** target 是否位於 root 之下（不含 root 本身）。path.relative 在 win32 已做大小寫不敏感比較。 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

type Resolution = { ok: true; resolved: string } | { ok: false; reason: string };

/** 產物/相依目錄不可當證據（同 compliance-engine 的掃描排除清單）。 */
const EVIDENCE_EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.git', 'coverage', 'out']);
/** 證據檔案大小上限（同引擎掃描上限）——防 reviewer 引用超大/二進位檔拖垮驗證。 */
const EVIDENCE_MAX_FILE_BYTES = 2 * 1024 * 1024;

function hasExcludedSegment(relFromRoot: string): boolean {
  return relFromRoot.split(/[\\/]+/).some(seg => EVIDENCE_EXCLUDED_DIRS.has(seg));
}

function checkResolvedFile(root: string, resolved: string): { ok: true } | { ok: false; reason: string } {
  if (hasExcludedSegment(path.relative(root, resolved))) {
    return { ok: false, reason: '證據不可引用產物/相依目錄（node_modules/dist/build/target/.git/coverage/out）——請引用原始碼檔案' };
  }
  let size: number;
  try { size = fs.statSync(resolved).size; } catch { return { ok: false, reason: '檔案無法讀取' }; }
  if (size > EVIDENCE_MAX_FILE_BYTES) {
    return { ok: false, reason: `檔案過大（>${EVIDENCE_MAX_FILE_BYTES / 1024 / 1024}MB）——請引用原始碼檔案` };
  }
  return { ok: true };
}

/** 解析 evidence.file：相對路徑對每個 root 試（正規化防 `..` 逃出）；絕對路徑必須在某個 root 之下。
 *  rootList 由 candidateRoots 組出（workspace roots + 本專案的 specRoots）。 */
export function resolveEvidenceFile(file: string, rootList: string[]): Resolution {
  if (rootList.length === 0) {
    return { ok: false, reason: '沒有可解析的 root（workspace 未設定，專案也沒有登記的規格資料夾）' };
  }
  if (path.isAbsolute(file)) {
    const resolved = path.normalize(file);
    const root = rootList.find(r => isInsideRoot(r, resolved));
    if (!root) {
      return { ok: false, reason: '絕對路徑不在 workspace 或本專案已登記的規格資料夾之下' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, reason: '檔案不存在' };
    if (!isFile(resolved)) return { ok: false, reason: '不是檔案' };
    const check = checkResolvedFile(root, resolved);
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, resolved };
  }
  let sawEscape = false;
  let excludedReason: string | null = null;
  for (const root of rootList) {
    const resolved = path.resolve(root, file);
    if (!isInsideRoot(root, resolved)) {
      sawEscape = true; // `..` 逃出 root
      continue;
    }
    if (isFile(resolved)) {
      const check = checkResolvedFile(root, resolved);
      if (!check.ok) { excludedReason = check.reason; continue; }
      return { ok: true, resolved };
    }
  }
  if (excludedReason) return { ok: false, reason: excludedReason };
  if (sawEscape) return { ok: false, reason: '路徑逃出 root（含 ..）' };
  return { ok: false, reason: '檔案不存在（以 workspace／規格資料夾相對路徑解析）' };
}

/** ±RELEVANCE_WINDOW 行窗口內的內容相關性檢查。回傳 null=通過，否則失敗原因。
 *  allLines（證據檔完整內容）供 API 拆分比對用：Spring 類別層 prefix 常在窗口外
 *  （檔案頂端），完整 path 未在窗口命中時，允許「suffix 在窗口 + prefix 在同檔任一行」。
 *  未提供 allLines 時只驗完整 path（向後相容）。 */
export function checkRelevance(
  itemType: ChecklistItemType,
  content: string,
  detail: Record<string, unknown> | null,
  windowLines: string[],
  allLines?: string[],
): string | null {
  switch (itemType) {
    case 'logic':
      return null; // 語意無法字串驗——只驗檔案存在 + 行號有效
    case 'ui_text': {
      // 多行文字取首個非空行（同引擎 matchSubstring 的 fallback）；
      // 也接受整段文字跨行落在窗口內
      const probe = content.includes('\n')
        ? (content.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? content)
        : content;
      if (windowLines.some(l => l.includes(probe)) || windowLines.join('\n').includes(content)) return null;
      return `±${RELEVANCE_WINDOW} 行內找不到文字「${shorten(probe)}」`;
    }
    case 'api': {
      const { path: apiPath } = parseApiContent(content, detail);
      if (!apiPath) return 'API path 無法解析（content 應為 "POST /api/xxx" 或 "/api/xxx"）';
      const re = buildApiPathRegex(apiPath);
      if (windowLines.some(l => re.test(l))) return null;
      // 拆分比對：suffix 在窗口內 + prefix 在同檔任一行（不可只憑尾段——prefix 必須同檔）
      if (allLines) {
        for (const sp of apiPathSplits(apiPath)) {
          if (windowLines.some(l => buildApiPathRegex(sp.suffix).test(l))
            && allLines.some(l => buildApiPathRegex(sp.prefix).test(l))) return null;
        }
      }
      return `±${RELEVANCE_WINDOW} 行內找不到 API path「${shorten(apiPath)}」（含拆分比對：prefix 需在同檔）`;
    }
    case 'param':
    case 'response_field':
    case 'db_field': {
      // 候選識別字（完整字面優先；巢狀路徑取葉節點、結構寫法取 token）——
      // 任一候選在窗口內 word-boundary 命中即通過，見 deriveIdentifierCandidates
      //
      // db_field 忽略大小寫：規格寫 CODE_TYPE_UUID、SQL 與 Java 寫 code_type_uuid，
      // 指的是同一個欄位（SQL 識別字本來就不分大小寫）。param / response_field
      // **不比照**——那是程式識別字，大小寫對不上就是真的對不上。見 makeDbFieldTester。
      const ignoreCase = itemType === 'db_field';
      for (const cand of deriveIdentifierCandidates(content)) {
        const hit = makeIdentifierTester(cand, { ignoreCase });
        if (windowLines.some(l => hit(l))) return null;
      }
      return `±${RELEVANCE_WINDOW} 行內找不到識別字「${shorten(content)}」（word-boundary，含葉節點/token 候選${ignoreCase ? '，不分大小寫' : ''}）`;
    }
  }
}

/**
 * 驗證所有 matched 項目的證據。回傳失敗清單（空陣列 = 全數通過）。
 * 呼叫端須保證 roots 至少有一個存在的 workspace root——roots 全空時
 * 應由呼叫端跳過驗證並註記「證據未經程式驗證」。
 */
export function validateReviewEvidence(inputs: EvidenceCheckInput[], roots: WorkspaceRoots): EvidenceFailure[] {
  const failures: EvidenceFailure[] = [];
  const lineCache = new Map<string, string[] | null>();
  const readLines = (p: string): string[] | null => {
    const cached = lineCache.get(p);
    if (cached !== undefined) return cached;
    let lines: string[] | null;
    try {
      lines = fs.readFileSync(p, 'utf-8').split('\n');
    } catch {
      lines = null;
    }
    lineCache.set(p, lines);
    return lines;
  };

  for (const input of inputs) {
    const rootList = candidateRoots(input.side, roots);
    for (const ev of input.evidence) {
      const res = resolveEvidenceFile(ev.file, rootList);
      if (!res.ok) {
        failures.push({ itemId: input.itemId, file: ev.file, line: ev.line, reason: res.reason });
        continue;
      }
      const lines = readLines(res.resolved);
      if (!lines) {
        failures.push({ itemId: input.itemId, file: ev.file, line: ev.line, reason: '檔案無法讀取' });
        continue;
      }
      if (!Number.isInteger(ev.line) || ev.line < 1 || ev.line > lines.length) {
        failures.push({ itemId: input.itemId, file: ev.file, line: ev.line, reason: `行號超界（檔案共 ${lines.length} 行）` });
        continue;
      }
      const from = Math.max(0, ev.line - 1 - RELEVANCE_WINDOW);
      const to = Math.min(lines.length, ev.line + RELEVANCE_WINDOW); // slice end exclusive
      const reason = checkRelevance(input.itemType, input.content, input.detail ?? null, lines.slice(from, to), lines);
      if (reason) {
        failures.push({ itemId: input.itemId, file: ev.file, line: ev.line, reason });
      }
    }
  }
  return failures;
}
