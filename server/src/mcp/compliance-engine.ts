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
  /** 增量回對（save_compliance_review carryForward）：此項沿用上輪 ai_review 的 matched 判定
   *  （原證據經程式重驗仍有效）——只出現在 carryForward 產生的 ai_review run */
  carriedForward?: boolean;
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
 *  退回 substring 比對。與 matchIdentifier 同一套規則，export 供證據驗證重用。
 *  \b 只加在頭/尾為 word char 的一側——頭尾是符號（如 `[OPTION]` 的中括號）時，
 *  該側加 \b 反而永遠不成立（\b 需要相鄰 word char），會造成系統性 missing。 */
export function makeIdentifierTester(ident: string): (s: string) => boolean {
  const hasWordChars = /[A-Za-z0-9_]/.test(ident);
  if (!hasWordChars) return (s: string): boolean => s.includes(ident);
  const lead = /^[A-Za-z0-9_]/.test(ident) ? '\\b' : '';
  const trail = /[A-Za-z0-9_]$/.test(ident) ? '\\b' : '';
  const re = new RegExp(`${lead}${escapeRegex(ident)}${trail}`);
  return (s: string): boolean => re.test(s);
}

/**
 * 候選識別字推導——修正「檢查表寫法 vs 原始碼字面」的系統性落差。
 *
 * 檢查表 content 來自規格的閱讀寫法（`resultList[].oid`、`ADM_CUST_LOG.OID`、
 * `items:[{uuid}]`），這些寫法永遠不會逐字出現在原始碼，造成假 missing。
 * 由 content 推導一組候選（完整字面永遠排第一、優先命中），任一命中即通過：
 * - 純識別字 → 只有完整字面（行為不變）
 * - 巢狀路徑 a.b / a[].b / TABLE.COLUMN → 完整字面 + 葉節點（只取葉，不取中段——
 *   表名/容器名單獨出現不能頂替欄位存在）
 * - 其他結構寫法（[X]、items:[{uuid}]）→ 完整字面 + 識別字 token（≥2 字元）
 * - 純 CJK → 只有完整字面（沿用 substring 退路）
 *
 * 弱化候選仍走 word-boundary（makeIdentifierTester），不退成 substring——
 * 葉節點比對已經變弱，再放寬會把假 missing 換成更糟的假 matched。
 */
export function deriveIdentifierCandidates(content: string): string[] {
  const full = content.trim();
  const candidates: string[] = [full];
  if (/^[A-Za-z0-9_$]+$/.test(full)) return candidates; // 已是純識別字
  // 巢狀路徑（點分隔，容許 [] 陣列記號）→ 葉節點
  if (/^[A-Za-z_$][\w$]*(?:\[\])?(?:\.[A-Za-z_$][\w$]*(?:\[\])?)+$/.test(full)) {
    const segs = full.split('.');
    const leaf = segs[segs.length - 1].replace(/\[\]$/, '');
    if (leaf && leaf !== full) candidates.push(leaf);
    return candidates;
  }
  // 其他結構寫法 → 抽識別字 token（保序、去重、≥2 字元）
  const tokens = full.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const t of tokens) {
    if (t.length >= 2 && !candidates.includes(t)) candidates.push(t);
  }
  return candidates;
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

/** 依候選順序比對（完整字面優先）；回傳首個有命中的候選與其證據。 */
function matchIdentifierCandidates(
  files: ScannedFile[],
  content: string,
  maxHits = 50,
): { evidence: Evidence[]; usedCandidate: string | null } {
  const full = content.trim();
  for (const cand of deriveIdentifierCandidates(content)) {
    const hits = matchIdentifier(files, cand, maxHits);
    if (hits.length > 0) {
      return { evidence: hits, usedCandidate: cand === full ? null : cand };
    }
  }
  return { evidence: [], usedCandidate: null };
}

/** 弱化候選命中時的透明化註記（reviewer 可據此判斷是否可信）。 */
function candidateNote(content: string, usedCandidate: string): string {
  return `matched_candidate：完整字面「${content.trim()}」未出現於原始碼（規格閱讀寫法），以候選識別字「${usedCandidate}」word-boundary 命中`;
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

/**
 * API path 拆分點（Spring 類別層 @RequestMapping + 方法層 @PostMapping 的拆分式註解
 * 讓完整 path 永遠不出現在同一行）。回傳所有 '/' 邊界的 {prefix, suffix} 組合，
 * 最長 prefix 優先（類別層通常吃掉大半 path）。
 */
export function apiPathSplits(apiPath: string): Array<{ prefix: string; suffix: string }> {
  const splits: Array<{ prefix: string; suffix: string }> = [];
  for (let i = 1; i < apiPath.length; i++) {
    if (apiPath[i] === '/') splits.push({ prefix: apiPath.slice(0, i), suffix: apiPath.slice(i) });
  }
  return splits.reverse();
}

/** 命中行 ±3 行內是否出現 method 關鍵字（大小寫不敏感）。
 *  含「method 隱含在 hook 名稱」的慣例（getApi(/putApi(/postApi(…）——多個專案的
 *  前端 API 層都用這種 hook，method 永遠不會以字面出現在呼叫行附近。 */
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
  // getApi( / putApi( — \b 防 targetApi( 誤中 getApi(
  const hookRe = new RegExp(`\\b${lower}api\\s*\\(`);
  const from = Math.max(0, lineIdx - 3);
  const to = Math.min(file.lines.length - 1, lineIdx + 3);
  for (let i = from; i <= to; i++) {
    const line = file.lines[i].toLowerCase();
    if (patterns.some(p => line.includes(p)) || hookRe.test(line)) return true;
  }
  return false;
}

interface ApiMatchResult {
  status: 'matched' | 'missing';
  evidence: Evidence[];
  note?: string;
}

/**
 * 檔內找出「行比對正則」：完整 path 在單行出現 → 用完整正則；
 * 否則嘗試拆分比對——某個 {prefix, suffix} 拆點的 prefix 與 suffix 都出現在
 * **同一檔案**內（Spring 類別層 + 方法層拆分式註解），此時以 suffix 正則定位命中行。
 * prefix 不在同檔 → 不算（不可只憑尾段命中——/search 這種尾段到處都是）。
 */
function apiLineRegexForFile(f: ScannedFile, fullRe: RegExp, splits: Array<{ prefix: string; suffix: string }>): { re: RegExp; split: boolean } | null {
  if (fullRe.test(f.content)) return { re: fullRe, split: false };
  for (const sp of splits) {
    if (buildApiPathRegex(sp.prefix).test(f.content) && buildApiPathRegex(sp.suffix).test(f.content)) {
      return { re: buildApiPathRegex(sp.suffix), split: true };
    }
  }
  return null;
}

function matchApi(files: ScannedFile[], item: EngineItem): ApiMatchResult {
  const { method, path: apiPath } = parseApiContent(item.content, item.detail);
  if (!apiPath) {
    return { status: 'missing', evidence: [], note: 'API path 無法解析（content 應為 "POST /api/xxx" 或 "/api/xxx"）' };
  }
  const fullRe = buildApiPathRegex(apiPath);
  const splits = apiPathSplits(apiPath);

  const pathHits: Evidence[] = [];
  let methodOk = method === null; // 沒指定 method → 找到 path 就算命中
  let usedSplit = false;
  for (const f of files) {
    const lineMatch = apiLineRegexForFile(f, fullRe, splits);
    if (!lineMatch) continue;
    for (let i = 0; i < f.lines.length; i++) {
      if (!lineMatch.re.test(f.lines[i])) continue;
      if (lineMatch.split) usedSplit = true;
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
    return { status: 'missing', evidence: [], note: 'workspace 中找不到此 API path（含拆分比對：prefix+suffix 同檔）' };
  }
  const splitNote = usedSplit ? 'matched_split_path：完整 path 未在單行出現，以類別層 prefix + 方法層 suffix 同檔拆分命中' : null;
  if (!methodOk) {
    return {
      status: 'missing',
      evidence: pathHits.slice(0, MAX_EVIDENCE),
      note: `matched_path_only：找到 path 但 ±3 行內找不到 ${method} method 關鍵字（method 不符）${splitNote ? `；${splitNote}` : ''}`,
    };
  }
  return { status: 'matched', evidence: pathHits.slice(0, MAX_EVIDENCE), ...(splitNote ? { note: splitNote } : {}) };
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
        const { evidence: hits, usedCandidate } = matchIdentifierCandidates(files, item.content);
        results.push(hits.length > 0
          ? {
              ...base, status: 'matched', evidence: prioritizeDbFieldEvidence(files, hits),
              ...(usedCandidate ? { note: candidateNote(item.content, usedCandidate) } : {}),
            }
          : { ...base, status: 'missing', note: 'workspace 中找不到此 DB 欄位識別字（word-boundary，含候選：表.欄位取欄位名）' });
        break;
      }
      case 'param':
      case 'response_field': {
        const { evidence: hits, usedCandidate } = matchIdentifierCandidates(files, item.content, MAX_EVIDENCE);
        results.push(hits.length > 0
          ? {
              ...base, status: 'matched', evidence: hits.slice(0, MAX_EVIDENCE),
              ...(usedCandidate ? { note: candidateNote(item.content, usedCandidate) } : {}),
            }
          : { ...base, status: 'missing', note: 'workspace 中找不到此識別字（word-boundary，不誤中子字串；含巢狀葉節點/token 候選）' });
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
