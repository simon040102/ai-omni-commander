/**
 * AI 回對證據驗證（Evidence Validator）— 純函式，零 LLM。
 *
 * 核心理念：**AI 判定、程式驗證判定依據**。save_compliance_review 收到的每筆
 * status='matched' 的 evidence {file, line}，寫入 run 之前由本模組驗證：
 *
 *  1. 路徑解析 — file 視為 workspace 相對路徑，依 item.side 對 frontend/backend
 *     root 依序解析（both 兩邊都試）；也接受「位於 workspace 之下的絕對路徑」。
 *     路徑正規化防 `..` 逃出 workspace。解析後必須真實存在且是檔案。
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

/** side 對應的 root 清單；side 指定的 root 未設定時退回所有可用 root
 *  （side 標錯不應誤殺真實證據——證據仍必須落在某個 workspace 之下）。 */
function candidateRoots(side: ChecklistSide, roots: WorkspaceRoots): string[] {
  const preferred: string[] = [];
  if (side !== 'backend' && roots.frontend) preferred.push(roots.frontend);
  if (side !== 'frontend' && roots.backend) preferred.push(roots.backend);
  if (preferred.length > 0) return preferred;
  return [roots.frontend, roots.backend].filter((r): r is string => typeof r === 'string' && r.length > 0);
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

/** 解析 evidence.file：相對路徑對每個 root 試（正規化防 `..` 逃出）；絕對路徑必須在某個 root 之下。 */
export function resolveEvidenceFile(file: string, rootList: string[]): Resolution {
  if (rootList.length === 0) {
    return { ok: false, reason: '沒有可解析的 workspace root' };
  }
  if (path.isAbsolute(file)) {
    const resolved = path.normalize(file);
    const root = rootList.find(r => isInsideRoot(r, resolved));
    if (!root) {
      return { ok: false, reason: '絕對路徑不在 workspace 之下' };
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
      sawEscape = true; // `..` 逃出 workspace
      continue;
    }
    if (isFile(resolved)) {
      const check = checkResolvedFile(root, resolved);
      if (!check.ok) { excludedReason = check.reason; continue; }
      return { ok: true, resolved };
    }
  }
  if (excludedReason) return { ok: false, reason: excludedReason };
  if (sawEscape) return { ok: false, reason: '路徑逃出 workspace（含 ..）' };
  return { ok: false, reason: '檔案不存在（以 workspace 相對路徑解析）' };
}

/** ±RELEVANCE_WINDOW 行窗口內的內容相關性檢查。回傳 null=通過，否則失敗原因。 */
export function checkRelevance(
  itemType: ChecklistItemType,
  content: string,
  detail: Record<string, unknown> | null,
  windowLines: string[],
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
      return `±${RELEVANCE_WINDOW} 行內找不到 API path「${shorten(apiPath)}」`;
    }
    case 'param':
    case 'response_field':
    case 'db_field': {
      const hit = makeIdentifierTester(content);
      if (windowLines.some(l => hit(l))) return null;
      return `±${RELEVANCE_WINDOW} 行內找不到識別字「${shorten(content)}」（word-boundary）`;
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
      const reason = checkRelevance(input.itemType, input.content, input.detail ?? null, lines.slice(from, to));
      if (reason) {
        failures.push({ itemId: input.itemId, file: ev.file, line: ev.line, reason });
      }
    }
  }
  return failures;
}
