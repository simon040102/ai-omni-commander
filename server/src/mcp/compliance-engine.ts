/**
 * 規格回對引擎（Spec Compliance Engine）— 純程式比對，零 LLM。
 *
 * 「理解規格」與「比對程式碼」分離：subagent 讀規格時用 save_spec_checklist
 * 抽出結構化 checklist（存 DB、可人工審），本引擎在任務完成時逐項用
 * substring / 正則比對 workspace 程式碼，全部命中才能標 completed。
 *
 * 設計重點：
 * - 檔案掃描一次讀進記憶體（多個 item 共用同一份掃描結果）
 * - ui_text  → exact substring（區分全形半形，不 trim 內部空白）
 * - api      → path 佔位正規化（{x} / :x / ${x} 視為等價）+ method ±3 行檢查
 * - param / response_field / db_field → word-boundary 識別字搜尋
 * - logic    → 一律 manual（不計入 missing）
 * - waived   → 跳過比對
 *
 * 純函式、不碰 DB、不碰 process.cwd() — workspace 路徑由呼叫端傳入（絕對路徑）。
 */
import fs from 'node:fs';
import path from 'node:path';

// ── types ───────────────────────────────────────────────────

export type ChecklistItemType = 'ui_text' | 'api' | 'param' | 'response_field' | 'db_field' | 'logic';
export type ChecklistSide = 'frontend' | 'backend' | 'both';
export type ComplianceStatus = 'matched' | 'missing' | 'manual' | 'waived';

export interface EngineItem {
  id: string;
  itemType: ChecklistItemType;
  content: string;
  side: ChecklistSide;
  /** detail_json parsed — e.g. { method: 'POST' } for api items */
  detail?: Record<string, unknown> | null;
  waived: boolean;
}

export interface Evidence {
  /** workspace-relative path, forward slashes */
  file: string;
  line: number;
}

export interface ItemResult {
  itemId: string;
  itemType: ChecklistItemType;
  content: string;
  status: ComplianceStatus;
  evidence?: Evidence[];
  note?: string;
  /** 引擎 × AI 分歧偵測：只出現在 ai_review run，且只在最新 engine run 對同一項的判定與 AI 相反時才有值 */
  engineStatus?: 'matched' | 'missing';
}

export interface ComplianceSummary {
  total: number;
  matched: number;
  missing: number;
  manual: number;
  waived: number;
  /** 自動比對的分母 = total - manual - waived */
  autoTotal: number;
  /** matched / autoTotal，百分比整數；autoTotal=0 時為 100 */
  score: number;
}

export interface ComplianceResult {
  items: ItemResult[];
  summary: ComplianceSummary;
}

/** side → 掃描的 workspace 根目錄（絕對路徑，呼叫端已驗證存在） */
export interface WorkspaceRoots {
  frontend?: string;
  backend?: string;
}

// ── file scanning ───────────────────────────────────────────

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.git', 'coverage', 'out']);
const EXT_WHITELIST = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.vue', '.html', '.json',
  '.java', '.xml', '.properties', '.sql', '.yml', '.yaml',
]);
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

export interface ScannedFile {
  /** workspace-relative path, forward slashes */
  relPath: string;
  content: string;
  lines: string[];
}

/**
 * 遞迴掃描 workspace，回傳白名單副檔名的檔案內容。
 * 排除 node_modules/dist/build/target/.git/coverage/out，單檔 >2MB 跳過。
 */
export function scanWorkspace(root: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!EXT_WHITELIST.has(path.extname(entry.name).toLowerCase())) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(full, 'utf-8');
          const relPath = path.relative(root, full).split(path.sep).join('/');
          files.push({ relPath, content, lines: content.split('\n') });
        } catch { /* unreadable file — skip */ }
      }
    }
  };
  walk(root);
  return files;
}

// ── matching helpers ────────────────────────────────────────

const MAX_EVIDENCE = 2;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ui_text：exact substring，回傳最多 MAX_EVIDENCE 筆證據。
 *  跨行文字（content 含換行）逐行找不到時，退回以第一個非空行定位證據。 */
function matchSubstring(files: ScannedFile[], text: string): Evidence[] {
  const evidence: Evidence[] = [];
  const firstLine = text.includes('\n') ? (text.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? text) : text;
  for (const f of files) {
    if (!f.content.includes(text)) continue;
    const probe = f.lines.some(l => l.includes(text)) ? text : firstLine;
    for (let i = 0; i < f.lines.length; i++) {
      if (f.lines[i].includes(probe)) {
        evidence.push({ file: f.relPath, line: i + 1 });
        if (evidence.length >= MAX_EVIDENCE) return evidence;
      }
    }
  }
  return evidence;
}

/** 識別字比對器：有 \w 字元用 word-boundary，純 CJK（無 \w 字元、\b 永遠不成立）
 *  退回 substring 比對。與 matchIdentifier 同一套規則，export 供證據驗證重用。 */
export function makeIdentifierTester(ident: string): (s: string) => boolean {
  const hasWordChars = /[A-Za-z0-9_]/.test(ident);
  const re = hasWordChars ? new RegExp(`\\b${escapeRegex(ident)}\\b`) : null;
  return (s: string): boolean => (re ? re.test(s) : s.includes(ident));
}

/** word-boundary 識別字搜尋（識別字含底線，\b 對 _ 有效）。回傳所有命中（供 db_field 排序用）。
 *  content 不含任何 \w 字元（如純中文）時 \b 永遠不成立，退回 substring 比對避免系統性 missing。 */
function matchIdentifier(files: ScannedFile[], ident: string, maxHits = 50): Evidence[] {
  const hit = makeIdentifierTester(ident);
  const evidence: Evidence[] = [];
  for (const f of files) {
    if (!hit(f.content)) continue;
    for (let i = 0; i < f.lines.length; i++) {
      if (hit(f.lines[i])) {
        evidence.push({ file: f.relPath, line: i + 1 });
        if (evidence.length >= maxHits) return evidence;
      }
    }
  }
  return evidence;
}

// ── api matching ────────────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

export interface ParsedApi {
  method: string | null;
  path: string;
}

/** 從 content 解析 method + path（容忍只有 path，如 "/api/wa05/save"）。 */
export function parseApiContent(content: string, detail?: Record<string, unknown> | null): ParsedApi {
  let method: string | null = null;
  let apiPath = content.trim();

  const m = apiPath.match(/^([A-Za-z]+)\s+(\S.*)$/);
  if (m && (HTTP_METHODS as readonly string[]).includes(m[1].toUpperCase())) {
    method = m[1].toUpperCase();
    apiPath = m[2].trim();
  }
  const detailMethod = typeof detail?.['method'] === 'string' ? (detail['method'] as string).toUpperCase() : null;
  if (detailMethod && (HTTP_METHODS as readonly string[]).includes(detailMethod)) {
    method = detailMethod;
  }
  return { method, path: apiPath };
}

/**
 * path 佔位正規化 → 比對用正則。
 * `{xxx}`、`:xxx`、`${xxx}` 佔位視為等價（規格寫 {id}，程式寫 :id 或 ${id} 都算命中）。
 */
export function buildApiPathRegex(apiPath: string): RegExp {
  // 逐字元切出佔位片段：{xxx} / ${xxx} / :xxx
  const PLACEHOLDER = /(\$\{[^}]+\}|\{[^}]+\}|:[A-Za-z_$][\w$]*)/g;
  const parts = apiPath.split(PLACEHOLDER);
  const pattern = parts
    .map(part => {
      if (!part) return '';
      if (PLACEHOLDER.test(part)) {
        PLACEHOLDER.lastIndex = 0;
        // 任一種佔位寫法都算等價
        return String.raw`(?:\$\{[^}/]+\}|\{[^}/]+\}|:[A-Za-z_$][\w$]*)`;
      }
      PLACEHOLDER.lastIndex = 0;
      return escapeRegex(part);
    })
    .join('');
  return new RegExp(pattern);
}

/** 命中行 ±3 行內是否出現 method 關鍵字（大小寫不敏感）。 */
function hasMethodNearby(file: ScannedFile, lineIdx: number, method: string): boolean {
  const lower = method.toLowerCase();
  const patterns = [
    `@${lower}mapping`,          // @PostMapping / @GetMapping ...
    `.${lower}(`,                // axios.post( / router.get( ...
    `method: '${lower}'`,        // method: 'post'
    `method: "${lower}"`,        // method: "post"
    `method:'${lower}'`,
    `method:"${lower}"`,
    `method = '${lower}'`,
    `method = "${lower}"`,
    `requestmethod.${lower}`,    // RequestMethod.POST
  ];
  const from = Math.max(0, lineIdx - 3);
  const to = Math.min(file.lines.length - 1, lineIdx + 3);
  for (let i = from; i <= to; i++) {
    const line = file.lines[i].toLowerCase();
    if (patterns.some(p => line.includes(p))) return true;
  }
  return false;
}

interface ApiMatchResult {
  status: 'matched' | 'missing';
  evidence: Evidence[];
  note?: string;
}

function matchApi(files: ScannedFile[], item: EngineItem): ApiMatchResult {
  const { method, path: apiPath } = parseApiContent(item.content, item.detail);
  if (!apiPath) {
    return { status: 'missing', evidence: [], note: 'API path 無法解析（content 應為 "POST /api/xxx" 或 "/api/xxx"）' };
  }
  const pathRe = buildApiPathRegex(apiPath);

  const pathHits: Evidence[] = [];
  let methodOk = method === null; // 沒指定 method → 找到 path 就算命中
  for (const f of files) {
    if (!pathRe.test(f.content)) continue;
    for (let i = 0; i < f.lines.length; i++) {
      if (!pathRe.test(f.lines[i])) continue;
      if (method !== null && hasMethodNearby(f, i, method)) {
        methodOk = true;
        // method 命中的證據排最前
        pathHits.unshift({ file: f.relPath, line: i + 1 });
      } else {
        pathHits.push({ file: f.relPath, line: i + 1 });
      }
      if (methodOk && pathHits.length >= MAX_EVIDENCE) break;
    }
    if (methodOk && pathHits.length >= MAX_EVIDENCE) break;
  }

  if (pathHits.length === 0) {
    return { status: 'missing', evidence: [], note: 'workspace 中找不到此 API path' };
  }
  if (!methodOk) {
    return {
      status: 'missing',
      evidence: pathHits.slice(0, MAX_EVIDENCE),
      note: `matched_path_only：找到 path 但 ±3 行內找不到 ${method} method 關鍵字（method 不符）`,
    };
  }
  return { status: 'matched', evidence: pathHits.slice(0, MAX_EVIDENCE) };
}

// ── db_field evidence prioritization ────────────────────────

/** db_field 證據優先序：.sql → .java 的 @Column/欄位定義行附近 → 其他。 */
function prioritizeDbFieldEvidence(files: ScannedFile[], hits: Evidence[]): Evidence[] {
  const fileByPath = new Map(files.map(f => [f.relPath, f]));
  const rank = (e: Evidence): number => {
    if (e.file.toLowerCase().endsWith('.sql')) return 0;
    if (e.file.toLowerCase().endsWith('.java')) {
      const f = fileByPath.get(e.file);
      if (f) {
        const from = Math.max(0, e.line - 1 - 2);
        const to = Math.min(f.lines.length - 1, e.line - 1 + 2);
        for (let i = from; i <= to; i++) {
          if (/@Column|CREATE\s+TABLE|ALTER\s+TABLE/i.test(f.lines[i])) return 1;
        }
      }
      return 2;
    }
    return 3;
  };
  return [...hits].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_EVIDENCE);
}

// ── engine entry point ──────────────────────────────────────

/**
 * 逐項比對 checklist items 與 workspace 程式碼。
 * roots 已由呼叫端依 task.label 解析並驗證存在；item.side 再過濾要掃哪些 root。
 */
export function runComplianceEngine(items: EngineItem[], roots: WorkspaceRoots): ComplianceResult {
  // 一次掃描，所有 item 共用
  const scanned: Partial<Record<'frontend' | 'backend', ScannedFile[]>> = {};
  if (roots.frontend) scanned.frontend = scanWorkspace(roots.frontend);
  if (roots.backend) scanned.backend = scanWorkspace(roots.backend);

  const filesFor = (side: ChecklistSide): ScannedFile[] => {
    if (side === 'frontend') return scanned.frontend ?? [];
    if (side === 'backend') return scanned.backend ?? [];
    return [...(scanned.frontend ?? []), ...(scanned.backend ?? [])];
  };

  const results: ItemResult[] = [];
  for (const item of items) {
    const base = { itemId: item.id, itemType: item.itemType, content: item.content };

    if (item.waived) {
      results.push({ ...base, status: 'waived' });
      continue;
    }
    if (item.itemType === 'logic') {
      results.push({ ...base, status: 'manual', note: '邏輯類項目需人工/LLM 確認，不做程式比對' });
      continue;
    }

    const files = filesFor(item.side);
    if (files.length === 0) {
      results.push({ ...base, status: 'missing', note: `side=${item.side} 沒有對應的 workspace 可掃描` });
      continue;
    }

    switch (item.itemType) {
      case 'ui_text': {
        const evidence = matchSubstring(files, item.content);
        results.push(evidence.length > 0
          ? { ...base, status: 'matched', evidence }
          : { ...base, status: 'missing', note: 'workspace 中找不到此文字（exact substring，區分全形半形）' });
        break;
      }
      case 'api': {
        const r = matchApi(files, item);
        results.push({ ...base, status: r.status, ...(r.evidence.length > 0 ? { evidence: r.evidence } : {}), ...(r.note ? { note: r.note } : {}) });
        break;
      }
      case 'db_field': {
        const hits = matchIdentifier(files, item.content);
        results.push(hits.length > 0
          ? { ...base, status: 'matched', evidence: prioritizeDbFieldEvidence(files, hits) }
          : { ...base, status: 'missing', note: 'workspace 中找不到此 DB 欄位識別字（word-boundary）' });
        break;
      }
      case 'param':
      case 'response_field': {
        const hits = matchIdentifier(files, item.content, MAX_EVIDENCE);
        results.push(hits.length > 0
          ? { ...base, status: 'matched', evidence: hits.slice(0, MAX_EVIDENCE) }
          : { ...base, status: 'missing', note: 'workspace 中找不到此識別字（word-boundary，不誤中子字串）' });
        break;
      }
    }
  }

  const matched = results.filter(r => r.status === 'matched').length;
  const missing = results.filter(r => r.status === 'missing').length;
  const manual = results.filter(r => r.status === 'manual').length;
  const waived = results.filter(r => r.status === 'waived').length;
  const total = results.length;
  const autoTotal = total - manual - waived;

  return {
    items: results,
    summary: {
      total, matched, missing, manual, waived, autoTotal,
      score: autoTotal > 0 ? Math.round((matched / autoTotal) * 100) : 100,
    },
  };
}
