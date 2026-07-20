/**
 * Shared recursive Asana subtask fetcher.
 *
 * Asana 專案任務清單 API（GET /tasks?project=）抓不到未 multi-home 進專案的
 * subtask。實際結構常是三層：母任務（模組）→ 功能 subtask → 工作項目 subtask
 * （前端/串接/後端/UT，有指派人）——真正要派工的項目在下層，主清單完全看不到。
 *
 * 這個模組是兩條同步路徑的單一真相來源：
 * - MCP sync_asana_tasks（server/src/mcp/tools/task-tools.ts，stdio process）
 * - Web AsanaSyncService.syncOnce（經 AsanaMcpClient.getMyTasksForProjectDetailed）
 *
 * 設計約束：
 * - 純函式 + 注入 fetch：不碰 process.cwd()、不讀環境變數、不 log —— 兩個
 *   process 都能用，也可用 mock fetch 測試。
 * - Asana 保持唯讀：只發 GET。
 * - 節流：層內小併發（預設 4）+ 總請求上限（預設 300 支/次，超過截斷+警告）。
 * - 429 退避：模組內建「退避一次再重試」的簡單版（Retry-After 或 1 秒）；
 *   Web 端注入的 apiFetch 本身已有多次退避，疊加無害。
 * - completed 語意與主查詢 completed_since=now 一致：completed 的母任務不往下抓、
 *   completed 的 subtask 不收錄也不下探。
 * - 去重以 gid 為鍵：subtask 已 multi-home 進專案（出現在主清單）時不重複收錄，
 *   也不從 subtask 端下探（主清單那份自己就是遞迴種子）。
 */

const DEFAULT_API_BASE = 'https://app.asana.com/api/1.0';
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_REQUESTS = 300;
const DEFAULT_CONCURRENCY = 4;
const RETRY_AFTER_CAP_MS = 60_000;

/** Minimal structural type satisfied by both undici Response and test doubles. */
export interface AsanaResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** Authorized GET against the Asana API (caller supplies auth headers/timeout). */
export type AsanaFetchFn = (url: string) => Promise<AsanaResponseLike>;

export interface SubtaskEntry {
  /** Raw Asana task object — same opt_fields shape as the main project query. */
  task: Record<string, unknown>;
  /** gid of the top-level (main-list) task this subtask descends from — 用於 section 繼承。 */
  rootGid: string;
  /** 1 = 主清單任務的直接 subtask；2 = 孫層；… */
  depth: number;
}

export interface FetchSubtasksOptions {
  /** Authorized fetch (must add Authorization header itself). */
  fetchFn: AsanaFetchFn;
  /** opt_fields for the subtask query — 與主查詢一致（必須含 num_subtasks 才能遞迴）。 */
  optFields: string;
  apiBase?: string;
  /** 遞迴深度上限（預設 3：母→功能→工作項目，再留一層保險）。 */
  maxDepth?: number;
  /** 單次同步 subtask API 請求總量上限（含分頁與 429 重試，預設 300）。 */
  maxRequests?: number;
  /** 同層併發抓取的母任務數（預設 4）。 */
  concurrency?: number;
  /** 額外要去重的 gid（通常不用——rootTasks 的 gid 會自動列入）。 */
  knownGids?: Iterable<string>;
  /** 可注入的 sleep（測 429 退避用）。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchSubtasksResult {
  /** 去重後、未完成的 subtask（含遞迴各層）。 */
  entries: SubtaskEntry[];
  /** 實際發出的 subtask API 請求數（含分頁與 429 重試）。 */
  requestCount: number;
  /** 是否因請求上限而截斷。 */
  truncated: boolean;
  /** 截斷 / 單一母任務抓取失敗等警告（best-effort，不會 throw）。 */
  warnings: string[];
}

interface FrontierItem {
  gid: string;
  name: string;
  rootGid: string;
  /** 最近的有截止日祖先的 due_on（含自己）——subtask 沒填日期時往下繼承。 */
  inheritedDue: string | null;
}

interface AsanaPage {
  data?: Record<string, unknown>[];
  next_page?: { uri?: string } | null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(raw: string | null | undefined): number {
  const sec = Number.parseInt(raw || '1', 10);
  const ms = (Number.isFinite(sec) && sec > 0 ? sec : 1) * 1000;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/** Simple worker pool — runs `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Recursively fetch incomplete subtasks for every main-list task with
 * `num_subtasks > 0`, down to `maxDepth` levels. Returns raw task objects
 * (same opt_fields as the main query) tagged with their root task's gid.
 *
 * `rootTasks` should be the FULL main-list result BEFORE any assignee
 * filtering — 過濾以「任務本身的 assignee」判，母任務被濾掉不代表其
 * subtask 不歸我（先抓全樹再過濾）。
 */
export async function fetchAsanaSubtasksTree(
  rootTasks: Array<Record<string, unknown>>,
  options: FetchSubtasksOptions,
): Promise<FetchSubtasksResult> {
  const apiBase = options.apiBase ?? DEFAULT_API_BASE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const sleep = options.sleep ?? defaultSleep;
  const { fetchFn, optFields } = options;

  const seen = new Set<string>(options.knownGids ?? []);
  for (const t of rootTasks) {
    const gid = String(t['gid'] || '');
    if (gid) seen.add(gid);
  }

  const state = { requestCount: 0, truncated: false, warnings: [] as string[] };
  const entries: SubtaskEntry[] = [];

  /** One counted, 429-retried GET. Returns null on cap/failure (warning recorded). */
  const fetchPage = async (url: string, parentName: string): Promise<AsanaPage | null> => {
    if (state.requestCount >= maxRequests) {
      state.truncated = true;
      return null;
    }
    // best-effort 契約：fetchFn 本身 reject（timeout/DNS/網路錯）也只轉警告，
    // 不可讓單支 flaky 請求把整輪 sync（含主清單 upsert）炸掉。
    try {
      state.requestCount++;
      let res = await fetchFn(url);
      if (res.status === 429) {
        await sleep(parseRetryAfterMs(res.headers?.get('Retry-After')));
        if (state.requestCount >= maxRequests) {
          state.truncated = true;
          return null;
        }
        state.requestCount++;
        res = await fetchFn(url);
      }
      if (!res.ok) {
        state.warnings.push(`subtask 抓取失敗（HTTP ${res.status}）：母任務「${parentName}」`);
        return null;
      }
      return await res.json() as AsanaPage;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.warnings.push(`subtask 抓取失敗（${msg}）：母任務「${parentName}」`);
      return null;
    }
  };

  // Seeds: incomplete main-list tasks that report subtasks.
  /** due_on 有效值（非空字串）才算有日期。 */
  const ownDue = (t: Record<string, unknown>): string | null => {
    const v = t['due_on'];
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  };

  let frontier: FrontierItem[] = rootTasks
    .filter(t => !t['completed'] && Number(t['num_subtasks'] || 0) > 0)
    .map(t => ({
      gid: String(t['gid'] || ''),
      name: String(t['name'] || ''),
      rootGid: String(t['gid'] || ''),
      inheritedDue: ownDue(t),
    }))
    .filter(t => !!t.gid);

  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && !state.truncated; depth++) {
    const next: FrontierItem[] = [];

    await runPool(frontier, concurrency, async (parent) => {
      let url: string | null = `${apiBase}/tasks/${parent.gid}/subtasks?limit=100&opt_fields=${optFields}`;
      while (url) {
        const page = await fetchPage(url, parent.name);
        if (!page) return;

        for (const sub of page.data || []) {
          const gid = String(sub['gid'] || '');
          if (!gid || seen.has(gid)) continue; // 去重：multi-home 進專案的 subtask 主清單已有
          seen.add(gid);
          if (sub['completed']) continue; // completed subtask 跳過，也不下探

          // parent 通常由 opt_fields 帶回；缺時以遍歷脈絡補上（parent_name = 直接母任務）
          if (!sub['parent']) {
            sub['parent'] = { gid: parent.gid, name: parent.name };
          }

          // 截止日繼承：subtask 自己沒填 → 用「最近有日期的祖先」的 due_on。
          // 直接改寫 raw task 的 due_on，兩條同步路徑（MCP/Web）零改動自然落地。
          const effectiveDue = ownDue(sub) ?? parent.inheritedDue;
          if (!ownDue(sub) && effectiveDue) {
            sub['due_on'] = effectiveDue;
          }

          entries.push({ task: sub, rootGid: parent.rootGid, depth });

          if (Number(sub['num_subtasks'] || 0) > 0) {
            next.push({ gid, name: String(sub['name'] || ''), rootGid: parent.rootGid, inheritedDue: effectiveDue });
          }
        }
        url = page.next_page?.uri || null;
      }
    });

    frontier = next;
  }

  if (state.truncated) {
    state.warnings.push(`subtask API 請求達上限 ${maxRequests} 支，結果已截斷（可能遺漏部分 subtask）`);
  }

  return { entries, requestCount: state.requestCount, truncated: state.truncated, warnings: state.warnings };
}
