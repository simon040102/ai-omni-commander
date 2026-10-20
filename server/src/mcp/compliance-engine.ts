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
 * - api      → path 佔位正規化（{x} / :x / ${x} 視為等價）+ method ±3 行檢查；
 *              ±3 行找不到 method 時，再認「路徑常數 ＋ helper 帶動詞」寫法（見 matchApiViaConstants）
 * - param / response_field / db_field → word-boundary 識別字搜尋
 * - logic    → 一律 manual（不計入 missing）
 * - waived   → 跳過比對
 * - superseded → 跳過比對（檢查表字面已被規格變更取代——程式沒錯、檢查表過期。
 *                與 waived 分開統計：豁免只要理由，取代必須指出替代品）
 *
 * 純函式、不碰 DB、不碰 process.cwd() — workspace 路徑由呼叫端傳入（絕對路徑）。
 */
import fs from 'node:fs';
import path from 'node:path';

// ── types ───────────────────────────────────────────────────

export type ChecklistItemType = 'ui_text' | 'api' | 'param' | 'response_field' | 'db_field' | 'logic';
export type ChecklistSide = 'frontend' | 'backend' | 'both';
export type ComplianceStatus = 'matched' | 'missing' | 'manual' | 'waived' | 'superseded';

export interface EngineItem {
  id: string;
  itemType: ChecklistItemType;
  content: string;
  side: ChecklistSide;
  /** detail_json parsed — e.g. { method: 'POST' } for api items */
  detail?: Record<string, unknown> | null;
  waived: boolean;
  /** 已被取代（規格變更後檢查表字面過期）——不計入 missing，也不等於豁免 */
  superseded?: boolean;
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
  /** 已被取代（superseded）——獨立一欄，刻意不混進 waived：
   *  兩者的後續動作不同（取代=規格改了，豁免=我們決定不做） */
  superseded: number;
  /** 自動比對的分母 = total - manual - waived - superseded */
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
  /** 規格來源根目錄（絕對路徑，已綁定本專案——見 evidence-validator.resolveProjectSpecRoots）。
   *  **僅供證據驗證使用（evidence-validator），引擎一律不掃描**：規格文件裡本來就逐字寫著
   *  checklist 的 content，掃進來等於拿規格證明規格，每一項都會假 matched。
   *  交付物是規格文件的任務（architect：SA/SD 改寫維護）才需要——它的產出不在 workspace 裡。 */
  specRoots?: string[];
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

/**
 * 掃描時的證據收集上限——**刻意遠大於 MAX_EVIDENCE**。
 *
 * 【為什麼不能用 MAX_EVIDENCE 當收集上限】
 * 強弱分類（splitEvidenceStrength）要在**收集完之後**才做。若收集在第 2 筆就停，
 * 而前兩筆剛好落在註解或測試碼，真正的實作那一行**根本沒被收進來**，
 * 於是 strong 為空 → 整項被降級成 missing。
 *
 * 2026-09-22 實際踩到：某一輪只是**多寫了 javadoc**，註解行因此排在宣告行前面，
 * 三個原本 matched 的常數當場變 missing——**程式只有變好，判定卻變差**。
 * 誤降級比漏判更難查：實作者會去找一個根本不存在的缺陷。
 */
const EVIDENCE_SCAN_LIMIT = 50;

/**
 * ui_text 超過此字數視為描述型、找不到時回 manual 不報 missing。實測（2026-10，442 次預檢）：
 * >80 字只配對成功 5 次，報 missing 的 30 次有 27 次最後被豁免；41–80 字仍常配對成功、
 * 也抓到過真缺漏（AI 同判 missing 9 次），所以門檻不往下拉。
 */
export const UI_TEXT_LITERAL_MAX_CHARS = 80;

/** ui_text：exact substring。`limit` 是**收集**上限，不是回傳上限——
 *  呼叫端分完強弱之後自己 slice 到 MAX_EVIDENCE。
 *  跨行文字（content 含換行）逐行找不到時，退回以第一個非空行定位證據。 */
function matchSubstring(files: ScannedFile[], text: string, limit = EVIDENCE_SCAN_LIMIT): Evidence[] {
  const collector = new EvidenceCollector(limit);
  const firstLine = text.includes('\n') ? (text.split('\n').map(s => s.trim()).find(s => s.length > 0) ?? text) : text;
  for (const f of files) {
    if (!f.content.includes(text)) continue;
    const probe = f.lines.some(l => l.includes(text)) ? text : firstLine;
    for (let i = 0; i < f.lines.length; i++) {
      if (f.lines[i].includes(probe) && collector.add(f, i)) return collector.hits;
    }
  }
  return collector.hits;
}

/**
 * 證據收集器：**只有 strong 命中收滿 `limit` 才停止掃描**；weak 命中（測試碼、純註解行）
 * 最多留 `limit` 筆，但不會讓掃描提早結束。
 *
 * 【為什麼】（2026-09-28，任務 e6cb66c1）EVIDENCE_SCAN_LIMIT 本來就是為了「註解排在宣告前面」
 * 而放大的，但它是**總數**上限：`查詢`、`狀態`、`page` 這種短字面在 e2e 測試碼裡動輒幾十處，
 * 目錄字母序 `e2e/` 又排在 `src/` 前面——前 50 筆全是 weak，產品碼那一行根本沒被收進來，
 * 於是被判「只在測試碼命中」的 missing。KB 三頁那一輪的 `查詢`／`狀態`／`路徑`／`page` 都是這樣。
 *
 * **判準沒有放寬**：strong／weak 的分類與 splitEvidenceStrength 用同一組判斷
 * （isTestPath ＋ isCommentOnlyLine），呼叫端事後照舊再分一次強弱。只在 weak 裡命中的項目
 * 仍然是 missing；這裡修的只是「掃描在看到產品碼之前就停了」。
 */
class EvidenceCollector {
  readonly hits: Evidence[] = [];
  private strong = 0;
  private weak = 0;
  constructor(private readonly limit: number) {}
  /** 收一筆命中；回傳 true 代表 strong 已收滿、呼叫端可以停止掃描。 */
  add(f: ScannedFile, lineIdx: number): boolean {
    const isWeak = isTestPath(f.relPath) || isCommentOnlyLine(f.lines[lineIdx]);
    if (isWeak) {
      if (this.weak < this.limit) { this.hits.push({ file: f.relPath, line: lineIdx + 1 }); this.weak++; }
      return false;
    }
    this.hits.push({ file: f.relPath, line: lineIdx + 1 });
    this.strong++;
    return this.strong >= this.limit;
  }
}

/** 識別字比對器：有 \w 字元用 word-boundary，純 CJK（無 \w 字元、\b 永遠不成立）
 *  退回 substring 比對。與 matchIdentifier 同一套規則，export 供證據驗證重用。
 *  \b 只加在頭/尾為 word char 的一側——頭尾是符號（如 `[OPTION]` 的中括號）時，
 *  該側加 \b 反而永遠不成立（\b 需要相鄰 word char），會造成系統性 missing。 */
export function makeIdentifierTester(
  ident: string,
  opts: { ignoreCase?: boolean } = {},
): (s: string) => boolean {
  const hasWordChars = /[A-Za-z0-9_]/.test(ident);
  if (!hasWordChars) {
    return opts.ignoreCase
      ? (s: string): boolean => s.toLowerCase().includes(ident.toLowerCase())
      : (s: string): boolean => s.includes(ident);
  }
  const lead = /^[A-Za-z0-9_]/.test(ident) ? '\\b' : '';
  const trail = /[A-Za-z0-9_]$/.test(ident) ? '\\b' : '';
  const re = new RegExp(`${lead}${escapeRegex(ident)}${trail}`, opts.ignoreCase ? 'i' : '');
  return (s: string): boolean => re.test(s);
}

/**
 * `db_field` 專用：忽略大小寫。
 *
 * 為什麼只有這一型忽略（2026-09-21，PF05 的 `CODE_TYPE_UUID` 實例）：
 * 規格寫資料庫欄位一律大寫（`CODE_TYPE_UUID`），而 SQL 與 Java 寫小寫
 * （`code_type_uuid`）——SQL 的識別字本來就不分大小寫，兩種寫法指的是同一個欄位。
 * 大小寫敏感讓**整個 db_field 型別系統性假 missing**：欄位明明在，卻引不到
 * 任何一行通得過驗證的證據，於是只剩兩條路——豁免（等於把「這一項不用做」
 * 寫進紀錄，而它其實做了），或讓 missing 永遠掛著。兩條都是假的。
 *
 * **param / response_field / ui_text 不比照辦理**：那些是程式識別字，
 * `tenantUuid` 與 `tenantuuid` 是兩個不同的東西，大小寫對不上就是真的對不上，
 * 忽略它會放過一個真缺陷。
 */
export function makeDbFieldTester(ident: string): (s: string) => boolean {
  return makeIdentifierTester(ident, { ignoreCase: true });
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
function matchIdentifier(
  files: ScannedFile[],
  ident: string,
  maxHits = 50,
  opts: { ignoreCase?: boolean } = {},
): Evidence[] {
  const hit = makeIdentifierTester(ident, opts);
  // 收集上限只算 strong（見 EvidenceCollector）——weak 命中不可讓掃描在產品碼之前就停下
  const collector = new EvidenceCollector(maxHits);
  for (const f of files) {
    if (!hit(f.content)) continue;
    for (let i = 0; i < f.lines.length; i++) {
      if (hit(f.lines[i]) && collector.add(f, i)) return collector.hits;
    }
  }
  return collector.hits;
}

/** 依候選順序比對（完整字面優先）；回傳首個有命中的候選與其證據。 */
function matchIdentifierCandidates(
  files: ScannedFile[],
  content: string,
  maxHits = 50,
  opts: { ignoreCase?: boolean } = {},
): { evidence: Evidence[]; usedCandidate: string | null } {
  const full = content.trim();
  for (const cand of deriveIdentifierCandidates(content)) {
    const hits = matchIdentifier(files, cand, maxHits, opts);
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
    // 純註解行不算：javadoc 寫「後端是 @DeleteMapping(...)」只是說明，不是這一行程式在送 DELETE。
    // （2026-09-28 任務 e6cb66c1：本案 kb01.ts 的組路徑函式正是靠上方 javadoc 的 @DeleteMapping 字樣
    //  被判 matched——結論碰巧對，理由是錯的；同一個註解放在一支沒接的常數上就是假 matched。）
    if (isCommentOnlyLine(file.lines[i])) continue;
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

// ── api：路徑常數 ＋ helper 帶動詞 ─────────────────────────────
//
// 【問題】（2026-09-28，任務 e6cb66c1；已連三輪誤報：db555981 12 項、49d2db34 18 項與 16 項）
// 前端通行的寫法是路徑放在常數、動詞由呼叫端的 helper 帶：
//
//   export const KB01_API = { search: '/main/kb01/search', delete: (id: string) => `/main/kb01/delete/${id}` };
//   export const deleteGroupApi = (g: string) => `${SM02_API.delete}/${g}`;
//   post(KB01_API.search, cond)   ／   del(KB01_API.delete(row.id))   ／   del(deleteGroupApi(uuid))
//
// "METHOD /path" 的字面永遠不會出現在同一處：path 在常數檔、method 在呼叫檔。
// hasMethodNearby 看的是 path 行 ±3 行，所以一律 matched_path_only。
//
// 【判準——兩件事都要對得起來，缺一不可】
// 1. **常數的完整值 = 規格 path**（錨定比對；前綴常數 `${X.delete}/${g}` 先展開再比）。
//    不可沿用 hit 行：規格 path 的行比對是不錨定的（`/p/list` 會命中 `/p/listAll`），
//    拆分比對也可能落在別的模組（sm01.ts 同時有 `/system/sm02` 前綴與 `/user/sm01/update`）。
// 2. **有一個產品碼呼叫端把「這個常數本身」交給動詞相符的 HTTP helper**：
//    `post(X.k, …)`、`api.post(X.k, …)`、`postApi(X.k, …)`、`del(X.fn(arg), …)`，
//    或同一行 `url: X.k` ＋ ±3 行內的 method 字面（沿用 hasMethodNearby）。
//    測試碼、純註解行的呼叫不算（同 splitEvidenceStrength 的 weak 定義）。
//
// 【刻意不認的】（寧可 missing，不可假 matched）
// - 宣告了但沒有任何呼叫端 → missing，note 寫「宣告不等於有接」（本案 KB02_API.getOne 正是這種）。
// - 呼叫端動詞與規格不符 → missing，note 寫出實際動詞。
// - 常數先指派給區域變數再傳（`const u = X.k; post(u)`）、字串相加（`X.k + '/' + id`）→ 不追。
// - 值裡有展開不了的 `${…}` 前綴（`${BASE}/x`）→ 不當成等於 `/x`。

/** 一個「值是字串」的常數：物件屬性（含巢狀）、頂層常數，或回傳字串的單行箭頭函式。 */
interface PathConstant {
  /** 呼叫端引用它的寫法：`KB01_API.search`、`NEST_API.folder.tree`、`deleteGroupApi` */
  ref: string;
  /** 原始字面（引號內），`${…}` 未展開 */
  raw: string;
  /** 箭頭函式（呼叫端寫 `ref(arg)`）還是值（呼叫端寫 `ref`） */
  isFn: boolean;
  file: string;
  /** 1-based */
  line: number;
}

const CONST_SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue)$/i;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/** 值：可選的箭頭函式頭 ＋ 單行字串／模板字面 */
const VALUE_RE = new RegExp(String.raw`^(\([^)]*\)\s*(?::[^=]+?)?\s*=>\s*)?(['"\x60])((?:\\.|(?!\2).)*)\2`);
const DECL_RE = new RegExp(String.raw`^\s*(?:export\s+)?(?:const|let|var)\s+(${IDENT})\s*(?::[^=]+)?=\s*(.*)$`);
const PROP_RE = new RegExp(String.raw`^\s*['"]?(${IDENT})['"]?\s*:\s*(.*)$`);
const INLINE_PROP_RE = new RegExp(String.raw`(${IDENT})\s*:\s*(\([^)]*\)\s*(?::[^=,]+?)?\s*=>\s*)?(['"\x60])((?:\\.|(?!\3).)*)\3`, 'g');

/** 算大括號淨值前先拿掉字串內容（`${…}` 在模板字面裡，一併拿掉） */
function braceDelta(line: string): number {
  const stripped = line.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
  let d = 0;
  for (const ch of stripped) { if (ch === '{') d++; else if (ch === '}') d--; }
  return d;
}

const pathConstCache = new WeakMap<ScannedFile, PathConstant[]>();

/** 逐行解析一個檔案裡「值是字串」的常數。只認單行值；測試碼整檔不收。 */
function extractPathConstants(f: ScannedFile): PathConstant[] {
  const cached = pathConstCache.get(f);
  if (cached) return cached;
  const out: PathConstant[] = [];
  if (CONST_SOURCE_EXT.test(f.relPath) && !isTestPath(f.relPath) && f.content.includes('/')) {
    // 大括號堆疊：具名框 = 物件字面的一層（const X = { / key: {），null = 其他大括號
    const stack: Array<string | null> = [];
    const chainOk = (): boolean => stack.length > 0 && stack.every(x => x !== null);
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i];
      if (isCommentOnlyLine(line)) continue;
      const delta = braceDelta(line);
      let opened: string | null = null;

      const decl = stack.length === 0 ? line.match(DECL_RE) : null;
      if (decl) {
        const [, name, rest] = decl;
        if (rest.trimStart().startsWith('{')) {
          if (delta > 0) opened = name;
          else {
            // 單行物件：{ list: '/a', listAll: (x) => `/b/${x}` }
            for (const m of rest.matchAll(INLINE_PROP_RE)) {
              out.push({ ref: `${name}.${m[1]}`, raw: m[4], isFn: Boolean(m[2]), file: f.relPath, line: i + 1 });
            }
          }
        } else {
          const v = rest.trim().match(VALUE_RE);
          if (v) out.push({ ref: name, raw: v[3], isFn: Boolean(v[1]), file: f.relPath, line: i + 1 });
        }
      } else if (chainOk()) {
        const prop = line.match(PROP_RE);
        if (prop) {
          const [, key, rest] = prop;
          const chain = [...(stack as string[]), key].join('.');
          if (rest.trimStart().startsWith('{') && delta > 0) opened = key;
          else {
            const v = rest.trim().match(VALUE_RE);
            if (v) out.push({ ref: chain, raw: v[3], isFn: Boolean(v[1]), file: f.relPath, line: i + 1 });
          }
        }
      }

      if (delta > 0) {
        stack.push(opened);
        for (let k = 1; k < delta; k++) stack.push(null);
      } else if (delta < 0) {
        for (let k = 0; k < -delta && stack.length > 0; k++) stack.pop();
      }
    }
  }
  pathConstCache.set(f, out);
  return out;
}

/** 展開值裡引用到其他常數的 `${REF}`（最多三層）；展開不了的 `${…}` 原樣保留（視為佔位）。 */
function foldConstantValue(raw: string, byRef: Map<string, PathConstant[]>): string {
  let v = raw;
  for (let pass = 0; pass < 3 && v.includes('${'); pass++) {
    v = v.replace(/\$\{\s*([A-Za-z_$][\w$.]*)\s*\}/g, (whole, ref: string) => {
      const defs = (byRef.get(ref) ?? []).filter(d => !d.isFn);
      const vals = new Set(defs.map(d => d.raw));
      return vals.size === 1 ? [...vals][0] : whole; // 同名多值 → 不猜
    });
  }
  return v;
}

/** helper 名稱 → HTTP method。`del` 是本案 useEnvelopeApi 的刪除 helper。 */
const HELPER_VERBS: Record<string, string> = {
  get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', del: 'DELETE',
  getapi: 'GET', postapi: 'POST', putapi: 'PUT', patchapi: 'PATCH', deleteapi: 'DELETE', delapi: 'DELETE',
};

interface ConstCallSite { file: ScannedFile; lineIdx: number; verb: string }

interface ConstUsage {
  /** 動詞可判定的 helper 呼叫 */
  sites: ConstCallSite[];
  /** 有引用、但不是可判定動詞的呼叫（例如 onDownloadFileAPI({ api: X.k })）——動詞在 helper 內部，程式判不出來 */
  otherRefs: Evidence[];
}

/** 呼叫若被格式化工具折行（`post<T>(\n  X.k,`），helper 名稱在前 1～2 行——往回併最多兩行再比。 */
const CALL_LOOKBACK_LINES = 2;

/** 找出把常數 `c` 本身交給 HTTP helper 的產品碼呼叫行。 */
function findConstCallSites(files: ScannedFile[], c: PathConstant, ambiguous: boolean): ConstUsage {
  const refRe = escapeRegex(c.ref);
  // 值常數：引用後直接是 , 或 )；函式常數：引用後直接是 (
  const tail = c.isFn ? String.raw`\s*\(` : String.raw`\s*[,)]`;
  const helperCall = new RegExp(
    String.raw`(?:^|[^\w$])(?:[\w$]+\.)*(get|post|put|patch|delete|del|getApi|postApi|putApi|patchApi|deleteApi|delApi)\s*(?:<[^()]*>)?\s*\(\s*${refRe}(?![\w$])${tail}`,
  );
  const urlProp = new RegExp(String.raw`\burl\s*:\s*${refRe}(?![\w$])`);
  const rootName = c.ref.split('.')[0];
  const declBase = path.posix.basename(c.file).replace(/\.[^.]+$/, '');
  const sites: ConstCallSite[] = [];
  const otherRefs: Evidence[] = [];
  const refOnly = new RegExp(String.raw`(?:^|[^\w$.])${refRe}(?![\w$])`);
  for (const f of files) {
    if (isTestPath(f.relPath) || !f.content.includes(c.ref)) continue;
    // 同名常數在多個檔案有不同值 → 呼叫檔必須 import 自宣告檔（或就是宣告檔）才算
    if (ambiguous && f.relPath !== c.file) {
      const importsDecl = f.lines.some(l => /^\s*import\b/.test(l) && new RegExp(String.raw`\b${escapeRegex(rootName)}\b`).test(l)
        && new RegExp(String.raw`['"][^'"]*\b${escapeRegex(declBase)}(?:\.[cm]?[jt]sx?)?['"]`).test(l));
      if (!importsDecl) continue;
    }
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i];
      if (!line.includes(c.ref) || isCommentOnlyLine(line)) continue;
      // 引用必須截在這一行的 ref 為止，前面併入的行只提供 helper 名稱與左括號
      const upto = line.slice(0, line.indexOf(c.ref) + c.ref.length) + line.slice(line.indexOf(c.ref) + c.ref.length).match(/^\s*[,()]?/)![0];
      const joined = [
        ...f.lines.slice(Math.max(0, i - CALL_LOOKBACK_LINES), i).filter(l => !isCommentOnlyLine(l)).map(l => l.trim()),
        upto.trim(),
      ].join(' ');
      const m = upto.match(helperCall) ?? joined.match(helperCall);
      if (m) { sites.push({ file: f, lineIdx: i, verb: HELPER_VERBS[m[1].toLowerCase()] }); continue; }
      if (urlProp.test(line)) {
        const verb = HTTP_METHODS.find(mth => hasMethodNearby(f, i, mth));
        if (verb) { sites.push({ file: f, lineIdx: i, verb }); continue; }
      }
      if (f.relPath !== c.file && refOnly.test(line)) otherRefs.push({ file: f.relPath, line: i + 1 });
    }
  }
  return { sites, otherRefs };
}

interface ConstApiMatch {
  status: 'matched' | 'missing';
  evidence: Evidence[];
  /** 找不到任何「值 = 規格 path」的常數時為 null（呼叫端沿用原本的 note） */
  note: string | null;
}

/**
 * 「路徑常數 ＋ helper 帶動詞」比對。method 為 null（規格只寫 path）時，任一動詞的呼叫端都算。
 * 判準見上方區塊註解：常數完整值 = 規格 path，**且**有動詞相符的產品碼呼叫端。
 */
export function matchApiViaConstants(files: ScannedFile[], apiPath: string, method: string | null): ConstApiMatch {
  const all = files.flatMap(extractPathConstants);
  if (all.length === 0) return { status: 'missing', evidence: [], note: null };
  const byRef = new Map<string, PathConstant[]>();
  for (const c of all) byRef.set(c.ref, [...(byRef.get(c.ref) ?? []), c]);

  const anchored = new RegExp(`^${buildApiPathRegex(apiPath).source}$`);
  const candidates = all.filter(c => anchored.test(foldConstantValue(c.raw, byRef)));
  if (candidates.length === 0) return { status: 'missing', evidence: [], note: null };

  const wrongVerb: string[] = [];
  const unresolved: Evidence[] = [];
  for (const c of candidates) {
    const defs = byRef.get(c.ref) ?? [];
    const ambiguous = new Set(defs.map(d => foldConstantValue(d.raw, byRef))).size > 1;
    const { sites, otherRefs } = findConstCallSites(files, c, ambiguous);
    unresolved.push(...otherRefs);
    const ok = sites.find(st => method === null || st.verb === method);
    if (ok) {
      const at = `${ok.file.relPath}:${ok.lineIdx + 1}`;
      return {
        status: 'matched',
        evidence: [{ file: ok.file.relPath, line: ok.lineIdx + 1 }, { file: c.file, line: c.line }],
        note: `matched_const_helper：path 是常數 ${c.ref}（${c.file}:${c.line}）的值，`
          + `呼叫端 ${at} 以 ${ok.verb} helper 送出${method ? `（與規格 ${method} 相符）` : ''}`,
      };
    }
    for (const st of sites) wrongVerb.push(`${st.file.relPath}:${st.lineIdx + 1} 以 ${st.verb} 送出`);
  }

  const declared = candidates.map(c => `${c.ref}（${c.file}:${c.line}）`).join('、');
  return {
    status: 'missing',
    evidence: candidates.slice(0, MAX_EVIDENCE).map(c => ({ file: c.file, line: c.line })),
    note: wrongVerb.length > 0
      ? `常數 ${declared} 的值等於此 path，但呼叫端的動詞與規格 ${method} 不符：${wrongVerb.slice(0, 3).join('、')}`
      : unresolved.length > 0
        ? `常數 ${declared} 的值等於此 path，有 ${unresolved.length} 處引用（${unresolved.slice(0, 3).map(e => `${e.file}:${e.line}`).join('、')}），`
          + `但都不是看得出動詞的 HTTP helper 呼叫（動詞在 helper 內部）——程式無法確認 method，需人工查證`
        : `常數 ${declared} 的值等於此 path，但沒有任何呼叫端以 HTTP helper 使用它——宣告不等於有接`,
  };
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

  // path 行 ±3 行找不到 method（或 path 根本沒有逐字出現——前綴常數組字）→ 認「路徑常數 ＋ helper 動詞」
  const viaConst = !methodOk || pathHits.length === 0 ? matchApiViaConstants(files, apiPath, method) : null;
  if (viaConst?.status === 'matched') {
    return { status: 'matched', evidence: viaConst.evidence, ...(viaConst.note ? { note: viaConst.note } : {}) };
  }
  const constNote = viaConst?.note ? `；${viaConst.note}` : '';

  if (pathHits.length === 0) {
    return {
      status: 'missing',
      evidence: viaConst?.evidence ?? [],
      note: `workspace 中找不到此 API path（含拆分比對：prefix+suffix 同檔）${constNote}`,
    };
  }
  const splitNote = usedSplit ? 'matched_split_path：完整 path 未在單行出現，以類別層 prefix + 方法層 suffix 同檔拆分命中' : null;
  if (!methodOk) {
    return {
      status: 'missing',
      evidence: pathHits.slice(0, MAX_EVIDENCE),
      note: `matched_path_only：找到 path 但 ±3 行內找不到 ${method} method 關鍵字（method 不符）${splitNote ? `；${splitNote}` : ''}${constNote}`,
    };
  }
  return { status: 'matched', evidence: pathHits.slice(0, MAX_EVIDENCE), ...(splitNote ? { note: splitNote } : {}) };
}

// ── db_field evidence prioritization ────────────────────────

/** db_field 證據優先序：.sql → .java 的 @Column/欄位定義行附近 → 其他。 */
// ── 假 matched 的兩個來源：只命中測試碼、只命中註解 ──────────────
//
// 【為什麼要處理】2026-09-21 一天之內踩了三次：
//   1. ui_text「這份是掃描檔，沒有可擷取的文字」**只在 implementer 自己的測試治具裡**命中，
//      產品程式碼一個字都沒有（那句話屬於還沒做的 PDF 轉換器）——預檢給 100 分。
//   2. param `intervalHours` 命中的是 `JobWorkerProperties.java` 的 **javadoc 說明文字**，
//      實作根本沒有這個參數。
//   3. db_field `CODE_TYPE_UUID` 命中的是一段**作廢 DML 的 WHERE 子句**。
//
// **假 matched 比假 missing 危險得多**：missing 會有人回頭看，而**沒有人會回頭打開一個
// 綠色的項目**。所以這裡把「只在測試碼／只在註解命中」降級成 missing，並在 note 寫明
// 是哪一種——沿用 `matched_path_only` 的既有作法（回 missing ＋ 說明），不新增狀態值。
//
// 【保守原則】判不出來一律當成產品程式碼（不降級）。誤降級會讓做對的東西被判沒做，
// 而那種誤判比漏掉更難查——實作者會去找一個根本不存在的缺陷。

/** 測試碼路徑：Java 的 src/test、JS/TS 的 __tests__ 與 *.test.* / *.spec.*、e2e/、以及 *Test.java。
 *
 *  `e2e/` 是 2026-09-28（任務 e6cb66c1）補的：Playwright 的共用治具放在 `e2e/helpers/*.ts`，
 *  檔名不帶 .spec，原本被當成產品碼——`page` 這類識別字因此以 e2e 治具「證明」有實作。 */
export function isTestPath(relPath: string): boolean {
  const p = relPath.toLowerCase();
  return /(^|\/)src\/test\//.test(p)
    || /(^|\/)__tests__\//.test(p)
    || /(^|\/)e2e\//.test(p)
    || /(^|\/)tests?\//.test(p)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)
    || /(^|\/)[^/]*test\.java$/.test(p)
    || /(^|\/)[^/]*testfixture\.java$/.test(p);
}

/**
 * 這一行是不是純註解。**只認整行註解**——行內尾註（`foo(); // 說明`）不算，
 * 因為那一行仍然有程式碼，命中在哪一半分不出來，寧可當成程式碼。
 */
export function isCommentOnlyLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')
    || t.startsWith('#') || t.startsWith('--') || t.startsWith('<!--');
}

export interface EvidenceStrength {
  /** 產品程式碼、非純註解行的命中——這些才算實作 */
  strong: Evidence[];
  /** 只在測試碼或註解裡的命中 */
  weak: Evidence[];
  /** weak 的成因（strong 為空時才有意義） */
  weakReason: '測試碼' | '註解' | '測試碼與註解' | null;
}

/** 把命中分成「算實作的」與「不算實作的」。 */
export function splitEvidenceStrength(files: ScannedFile[], hits: Evidence[]): EvidenceStrength {
  const fileByPath = new Map(files.map(f => [f.relPath, f]));
  const strong: Evidence[] = [];
  const weak: Evidence[] = [];
  let sawTest = false;
  let sawComment = false;

  for (const e of hits) {
    if (isTestPath(e.file)) { weak.push(e); sawTest = true; continue; }
    const line = fileByPath.get(e.file)?.lines[e.line - 1];
    // 取不到那一行就當程式碼（保守）
    if (line !== undefined && isCommentOnlyLine(line)) { weak.push(e); sawComment = true; continue; }
    strong.push(e);
  }

  const weakReason = strong.length > 0 || weak.length === 0
    ? null
    : (sawTest && sawComment ? '測試碼與註解' : sawTest ? '測試碼' : '註解');
  return { strong, weak, weakReason };
}

/** 只命中 weak 時的 missing 說明——要講清楚「查得到字串」與「有實作」是兩件事。 */
export function weakEvidenceNote(s: EvidenceStrength): string {
  const where = s.weak.slice(0, 3).map(e => `${e.file}:${e.line}`).join('、');
  return `假 matched 已擋下：字串只在**${s.weakReason}**裡命中（${where}${s.weak.length > 3 ? ` 等 ${s.weak.length} 處` : ''}），`
    + `產品程式碼查無。**查得到字串不等於有實作**——測試治具與註解提到某個名字，`
    + `只代表有人寫過那幾個字。這一項照實判 missing；若實作確實存在於別處，補一筆引用實作行的證據。`;
}

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
    // superseded 先於 logic 判斷：被取代的項目連 manual 都不必列，字面已不存在於現行規格
    if (item.superseded) {
      results.push({ ...base, status: 'superseded', note: '檢查表字面已被規格變更取代（見檢查表的 supersededSpecRef / supersededText），不計入 missing' });
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
        const strength = splitEvidenceStrength(files, matchSubstring(files, item.content));
        // 長描述型：找得到照樣 matched（證據可當回對員的線索），找不到不報 missing——
        // 這種長度多是規格描述句、不是畫面字面，字面比對抓不到不代表沒做，交 AI 回對判。
        const isLongDescription = [...item.content].length > UI_TEXT_LITERAL_MAX_CHARS;
        results.push(strength.strong.length > 0
          ? { ...base, status: 'matched', evidence: strength.strong.slice(0, MAX_EVIDENCE) }
          : isLongDescription
            ? { ...base, status: 'manual', note: `超過 ${UI_TEXT_LITERAL_MAX_CHARS} 字的描述型文字，不做字面比對（找不到不代表沒做），交 AI 回對判定` }
          : strength.weak.length > 0
            ? { ...base, status: 'missing', evidence: strength.weak.slice(0, MAX_EVIDENCE), note: weakEvidenceNote(strength) }
            : { ...base, status: 'missing', note: 'workspace 中找不到此文字（exact substring，區分全形半形）' });
        break;
      }
      case 'api': {
        const r = matchApi(files, item);
        results.push({ ...base, status: r.status, ...(r.evidence.length > 0 ? { evidence: r.evidence } : {}), ...(r.note ? { note: r.note } : {}) });
        break;
      }
      case 'db_field': {
        // 忽略大小寫：規格寫大寫、SQL 與 Java 寫小寫，指的是同一個欄位。見 makeDbFieldTester。
        const { evidence: hits, usedCandidate } = matchIdentifierCandidates(
          files, item.content, 50, { ignoreCase: true },
        );
        const dbStrength = splitEvidenceStrength(files, hits);
        results.push(dbStrength.strong.length > 0
          ? {
              ...base, status: 'matched', evidence: prioritizeDbFieldEvidence(files, dbStrength.strong),
              ...(usedCandidate ? { note: candidateNote(item.content, usedCandidate) } : {}),
            }
          : dbStrength.weak.length > 0
            ? { ...base, status: 'missing', evidence: dbStrength.weak.slice(0, MAX_EVIDENCE), note: weakEvidenceNote(dbStrength) }
            : { ...base, status: 'missing', note: 'workspace 中找不到此 DB 欄位識別字（word-boundary，含候選：表.欄位取欄位名）' });
        break;
      }
      case 'param':
      case 'response_field': {
        const { evidence: hits, usedCandidate } = matchIdentifierCandidates(files, item.content, EVIDENCE_SCAN_LIMIT);
        const idStrength = splitEvidenceStrength(files, hits);
        results.push(idStrength.strong.length > 0
          ? {
              ...base, status: 'matched', evidence: idStrength.strong.slice(0, MAX_EVIDENCE),
              ...(usedCandidate ? { note: candidateNote(item.content, usedCandidate) } : {}),
            }
          : idStrength.weak.length > 0
            ? { ...base, status: 'missing', evidence: idStrength.weak.slice(0, MAX_EVIDENCE), note: weakEvidenceNote(idStrength) }
            : { ...base, status: 'missing', note: 'workspace 中找不到此識別字（word-boundary，不誤中子字串；含巢狀葉節點/token 候選）' });
        break;
      }
    }
  }

  const matched = results.filter(r => r.status === 'matched').length;
  const missing = results.filter(r => r.status === 'missing').length;
  const manual = results.filter(r => r.status === 'manual').length;
  const waived = results.filter(r => r.status === 'waived').length;
  const superseded = results.filter(r => r.status === 'superseded').length;
  const total = results.length;
  const autoTotal = total - manual - waived - superseded;

  return {
    items: results,
    summary: {
      total, matched, missing, manual, waived, superseded, autoTotal,
      score: autoTotal > 0 ? Math.round((matched / autoTotal) * 100) : 100,
    },
  };
}
