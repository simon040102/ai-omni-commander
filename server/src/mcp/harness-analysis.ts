/**
 * Harness 自我分析（Loop 4 的第一步：讓 omni 讀自己的 trace）。
 *
 * omni 累積了大量回對結果、規格缺口、專案筆記，但沒有任何東西讀它們——
 * 於是「工具比對規則有洞」這種訊息只存在 reviewer 手寫的 note 裡，沒人看見。
 *
 * **所有統計一律按月份切，不給單一總數。**
 * 這條規則是踩過才立的：某次把「reviewer 自述工具假陰性」加總得到 21%，
 * 據此差點去修比對規則；按月切開才看到 7 月 41% → 9 月 4%——
 * 問題在 7/29 那個 commit 就修掉了，總數只是舊帳還掛在那裡。
 * 單一總數會把「已經修好的」和「現在還在壞的」混成同一個數字。
 *
 * 純函式，不碰 DB、不碰檔案系統；資料由呼叫端查好傳進來。
 */

export type ReviewStatus = 'matched' | 'missing' | 'waived';

/** spec_compliance_runs.results_json 裡的單筆判定。 */
export interface ReviewItem {
  itemId: string;
  itemType: string;
  content?: string;
  status: ReviewStatus | string;
  note?: string | null;
  /** 程式預檢對同一項的判定，用來找引擎 ╳ AI 分歧 */
  engineStatus?: string | null;
}

export interface ReviewRun {
  taskId: string;
  /** ISO-ish 字串，取前 7 碼當月份 */
  runAt: string;
  source: string;
  results: ReviewItem[];
}

export interface SpecGapRow {
  id: string;
  category: string;
  status: string;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface ProjectNoteRow {
  id: string;
  category?: string | null;
  active: number;
  createdAt: string;
}

/** 月份鍵：`2026-09`。取不到就歸 `unknown`。 */
export function monthOf(ts: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(String(ts ?? ''));
  return m ? `${m[1]}-${m[2]}` : 'unknown';
}

/**
 * reviewer 在 note 裡自述「這筆其實是工具的問題，程式有做」的關鍵字。
 *
 * ⚠ 這是**關鍵字掃描，不是事實**——reviewer 用什麼字眼由它自己決定，
 * 換個講法就掃不到，講反話也會誤判。這個數字只能當「往哪裡看」的指引，
 * 不可當成「有 N 筆確定是誤判」。要精確就得讓 reviewer 填結構化旗標
 * （本分析工具存在的理由之一，就是證明那個旗標值得做）。
 */
const TOOL_LIMITATION = /假陰性|工具限制|工具的?問題|證據驗證器限制|非實作缺陷|實作正確|實作已確認|實際已實作|實作存在|真實判定\s*matched/;

export function looksLikeToolLimitation(note: string | null | undefined): boolean {
  return TOOL_LIMITATION.test(String(note ?? ''));
}

// ── 1. 每個任務的第一輪回對 ────────────────────────────────

/**
 * 只取每個任務**最早**那一輪 ai_review。
 * 理由：第二輪以後是「修完再驗」，本來就該過；harness 好不好，看第一輪。
 */
export function firstRoundPerTask(runs: ReviewRun[]): ReviewRun[] {
  const first = new Map<string, ReviewRun>();
  for (const r of runs) {
    const cur = first.get(r.taskId);
    if (!cur || r.runAt < cur.runAt) first.set(r.taskId, r);
  }
  return [...first.values()];
}

export interface TypeRate {
  itemType: string;
  total: number;
  missing: number;
  /** 百分比，一位小數 */
  rate: number;
}

/** 第一輪各檢查項類型的不符率——高的地方代表 prompt 或比對規則沒把要求傳達到。 */
export function missRateByType(firstRuns: ReviewRun[]): TypeRate[] {
  const tot = new Map<string, number>();
  const miss = new Map<string, number>();
  for (const r of firstRuns) {
    for (const it of r.results) {
      tot.set(it.itemType, (tot.get(it.itemType) ?? 0) + 1);
      if (it.status === 'missing') miss.set(it.itemType, (miss.get(it.itemType) ?? 0) + 1);
    }
  }
  return [...tot.entries()]
    .map(([itemType, total]) => {
      const m = miss.get(itemType) ?? 0;
      return { itemType, total, missing: m, rate: total ? Math.round((m / total) * 1000) / 10 : 0 };
    })
    .sort((a, b) => b.rate - a.rate);
}

// ── 2. 工具自述問題的趨勢（本工具最重要的一張表）──────────

export interface MonthTrend {
  month: string;
  missing: number;
  flagged: number;
  /** 百分比，一位小數 */
  pct: number;
}

/**
 * 按月看「reviewer 說這是工具問題」的比例。
 * **一定要看趨勢，不要看總和**——修好的問題會以舊帳的形式留在總和裡。
 */
export function toolLimitationTrend(runs: ReviewRun[]): MonthTrend[] {
  const byMonth = new Map<string, { missing: number; flagged: number }>();
  for (const r of runs) {
    const mo = monthOf(r.runAt);
    for (const it of r.results) {
      if (it.status !== 'missing') continue;
      const b = byMonth.get(mo) ?? { missing: 0, flagged: 0 };
      b.missing++;
      if (looksLikeToolLimitation(it.note)) b.flagged++;
      byMonth.set(mo, b);
    }
  }
  return [...byMonth.entries()]
    .map(([month, b]) => ({
      month, missing: b.missing, flagged: b.flagged,
      pct: b.missing ? Math.round((b.flagged / b.missing) * 1000) / 10 : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * 趨勢的白話判讀。給的是**方向**不是結論——
 * 「已經在收斂」和「還在惡化」要用不同的方式處理，數字本身不會說。
 */
export function readTrend(trend: MonthTrend[]): string {
  const solid = trend.filter(t => t.month !== 'unknown' && t.missing >= 10);
  if (solid.length < 2) return '樣本不足（需要至少兩個月、每月 10 筆以上的不符）才看得出趨勢。';
  const first = solid[0], last = solid[solid.length - 1];
  const delta = last.pct - first.pct;
  if (delta <= -10) {
    return `在收斂：${first.month} ${first.pct}% → ${last.month} ${last.pct}%。`
      + `**剩下的多半是舊帳，不要照總數去改比對規則**——先確認最近一個月還在發生的是哪幾筆。`;
  }
  if (delta >= 10) {
    return `在惡化：${first.month} ${first.pct}% → ${last.month} ${last.pct}%。比對規則可能跟不上新出現的寫法，值得查最近的案例。`;
  }
  return `持平：${first.month} ${first.pct}% → ${last.month} ${last.pct}%。持續穩定地誤判，代表有個一直沒修的固定盲點。`;
}

// ── 3. 重審輪數 ────────────────────────────────────────────

export interface RoundStats {
  /** 輪數 → 有幾個任務 */
  distribution: Array<{ rounds: number; tasks: number }>;
  totalTasks: number;
  /** 第一輪沒過（需要重審）的任務數 */
  needsRework: number;
  /** 百分比 */
  reworkRate: number;
  /** 跑三輪以上的任務 id——reviewer 反覆抓同一件事，通常是規格或 prompt 的問題 */
  heavyTasks: Array<{ taskId: string; rounds: number }>;
}

export function reviewRounds(runs: ReviewRun[]): RoundStats {
  const byTask = new Map<string, number>();
  for (const r of runs) byTask.set(r.taskId, (byTask.get(r.taskId) ?? 0) + 1);

  const dist = new Map<number, number>();
  const heavy: Array<{ taskId: string; rounds: number }> = [];
  for (const [taskId, rounds] of byTask) {
    dist.set(rounds, (dist.get(rounds) ?? 0) + 1);
    if (rounds >= 3) heavy.push({ taskId, rounds });
  }
  const totalTasks = byTask.size;
  const needsRework = [...byTask.values()].filter(n => n >= 2).length;
  return {
    distribution: [...dist.entries()].map(([rounds, tasks]) => ({ rounds, tasks })).sort((a, b) => a.rounds - b.rounds),
    totalTasks,
    needsRework,
    reworkRate: totalTasks ? Math.round((needsRework / totalTasks) * 1000) / 10 : 0,
    heavyTasks: heavy.sort((a, b) => b.rounds - a.rounds),
  };
}

// ── 4. 引擎 ╳ AI 分歧 ──────────────────────────────────────

export interface Divergence {
  itemType: string;
  /** 預檢說有、AI 說沒有——字面存在但實際沒接上，通常 AI 是對的 */
  engineMatchedAiMissing: number;
  /** 預檢說沒有、AI 說有——比對規則抓不到的寫法，通常是規則要補 */
  engineMissingAiMatched: number;
}

export function divergenceByType(runs: ReviewRun[]): Divergence[] {
  const m = new Map<string, Divergence>();
  for (const r of runs) {
    for (const it of r.results) {
      if (!it.engineStatus || it.engineStatus === 'manual') continue;
      if (it.engineStatus === it.status) continue;
      const d = m.get(it.itemType) ?? { itemType: it.itemType, engineMatchedAiMissing: 0, engineMissingAiMatched: 0 };
      if (it.engineStatus === 'matched' && it.status === 'missing') d.engineMatchedAiMissing++;
      else if (it.engineStatus === 'missing' && it.status === 'matched') d.engineMissingAiMatched++;
      m.set(it.itemType, d);
    }
  }
  return [...m.values()].sort(
    (a, b) => (b.engineMatchedAiMissing + b.engineMissingAiMatched) - (a.engineMatchedAiMissing + a.engineMissingAiMatched),
  );
}

export interface DivergenceMonth {
  itemType: string;
  month: string;
  /**
   * 該月該類型的**全部**項目數（分母）。
   *
   * ⚠ 不可用「帶 engineStatus 的項目」當分母——save_compliance_review 只在
   * 程式預檢與 AI **判定不一致時**才寫 engineStatus（一致的項目根本沒有這個欄位），
   * 所以「帶 engineStatus 的」全是分歧項，拿它當分母比例必然接近 100%。
   * 這個錯實際犯過：單元測試全過（因為測試資料是照錯誤假設造的），拿真資料一跑才露餡。
   *
   * 已知偏差：該任務若從沒跑過程式預檢，它的項目也會進分母，比例會略為偏低。
   */
  compared: number;
  /** 預檢說沒有、AI 說有——比對規則抓不到的寫法 */
  ruleGap: number;
  /** 百分比 */
  ruleGapRate: number;
}

/**
 * 分歧的**月份趨勢，用比例**。
 *
 * 加總版的 divergenceByType 會藏住兩種相反的狀況，兩種都實際發生過：
 * - 某類在 7 月大量出現、修掉後只剩舊帳 → 總數誇大一個已修好的問題
 * - 某類前兩個月是 0、這個月突然 80 → 總數把全新的問題攤平成「中等偏高」
 * 用筆數不用比例也不行：那個月可能只是回對量變多。
 */
export function divergenceTrend(runs: ReviewRun[]): DivergenceMonth[] {
  const m = new Map<string, { compared: number; ruleGap: number }>();
  for (const r of runs) {
    const mo = monthOf(r.runAt);
    for (const it of r.results) {
      // logic 程式預檢一律判 manual，根本不進比對，不能算進分母
      if (it.itemType === 'logic') continue;
      const key = `${it.itemType}\u0000${mo}`;
      const b = m.get(key) ?? { compared: 0, ruleGap: 0 };
      b.compared++;
      if (it.engineStatus === 'missing' && it.status === 'matched') b.ruleGap++;
      m.set(key, b);
    }
  }
  return [...m.entries()]
    .map(([key, b]) => {
      const [itemType, month] = key.split('\u0000');
      return { itemType, month, compared: b.compared, ruleGap: b.ruleGap,
        ruleGapRate: b.compared ? Math.round((b.ruleGap / b.compared) * 1000) / 10 : 0 };
    })
    .sort((a, b) => a.itemType.localeCompare(b.itemType) || a.month.localeCompare(b.month));
}

/**
 * 找出「最近一個月才冒出來、或明顯變嚴重」的類型——那才是現在該修的，不是總數最大的。
 * 門檻：最近一個月至少 20 筆可比、且比例 ≥ 5%，並比前一個有資料的月份高出 5 個百分點以上（或前面根本沒有）。
 */
export function emergingDivergence(trend: DivergenceMonth[]): Array<{ itemType: string; month: string; rate: number; prevRate: number | null; ruleGap: number }> {
  const byType = new Map<string, DivergenceMonth[]>();
  for (const t of trend) {
    if (t.month === 'unknown') continue;
    const arr = byType.get(t.itemType) ?? [];
    arr.push(t);
    byType.set(t.itemType, arr);
  }
  const out: Array<{ itemType: string; month: string; rate: number; prevRate: number | null; ruleGap: number }> = [];
  for (const [itemType, arr] of byType) {
    const sorted = [...arr].sort((a, b) => a.month.localeCompare(b.month));
    const last = sorted[sorted.length - 1];
    if (last.compared < 20 || last.ruleGapRate < 5) continue;
    const prev = [...sorted].reverse().slice(1).find(x => x.compared >= 20) ?? null;
    if (!prev || last.ruleGapRate - prev.ruleGapRate >= 5) {
      out.push({ itemType, month: last.month, rate: last.ruleGapRate, prevRate: prev ? prev.ruleGapRate : null, ruleGap: last.ruleGap });
    }
  }
  return out.sort((a, b) => b.rate - a.rate);
}

// ── 5. 規格缺口的裁決速度 ──────────────────────────────────

export interface GapStats {
  category: string;
  open: number;
  resolved: number;
  /**
   * 已裁決的中位**小時**（沒有已裁決的就是 null）。
   * 刻意用小時不用天：實測中位數是 30 分鐘、86% 在一天內——
   * 用天會把「30 分鐘」和「23 小時」都捨入成 0，資訊全沒了。
   */
  medianResolveHours: number | null;
  /** 仍開著的最久天數（開著的缺口以天計才有意義） */
  oldestOpenDays: number | null;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
const hours = (a: string, b: string): number => Math.max(0, (Date.parse(b) - Date.parse(a)) / HOUR);
const days = (a: string, b: string): number => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / DAY));

/** SQLite 的 datetime('now') 是 UTC 但不帶 Z；不補的話 Date.parse 會當成本地時間，差 8 小時。 */
export function parseDbTime(s: string): string {
  const t = s.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) return t;
  return t.replace(' ', 'T') + 'Z';
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** 久未裁決的分類＝那個 prompt 沒把「需要人拍板」講到位，或那類缺口本來就沒人在乎。 */
export function gapStats(gaps: SpecGapRow[], nowIso: string): GapStats[] {
  const m = new Map<string, { open: number; resolved: number; resolveHours: number[]; openDays: number[] }>();
  for (const g of gaps) {
    const b = m.get(g.category) ?? { open: 0, resolved: 0, resolveHours: [], openDays: [] };
    const created = parseDbTime(g.createdAt);
    if (g.status === 'resolved' && g.resolvedAt) {
      b.resolved++;
      b.resolveHours.push(hours(created, parseDbTime(g.resolvedAt)));
    } else {
      b.open++;
      b.openDays.push(days(created, nowIso));
    }
    m.set(g.category, b);
  }
  return [...m.entries()]
    .map(([category, b]) => {
      const med = median(b.resolveHours.map(h => Math.round(h * 10)));
      return {
        category, open: b.open, resolved: b.resolved,
        medianResolveHours: med === null ? null : med / 10,
        oldestOpenDays: b.openDays.length ? Math.max(...b.openDays) : null,
      };
    })
    .sort((a, b) => b.open - a.open);
}

export interface GapShape {
  resolved: number;
  open: number;
  /** 已裁決的落在哪個時間帶 */
  resolvedWithin: { hour: number; day: number; week: number; later: number };
  /** 開著的已經放多久 */
  openFor: { underWeek: number; weekToMonth: number; overMonth: number };
  /** 白話判讀 */
  reading: string;
}

/**
 * 缺口的整體形狀。實測是**兩極化**：要嘛同一個 session 當場拍板（中位 30 分鐘），
 * 要嘛就一直沒人管（開著的最久 80 多天）——中間幾乎沒有「排隊中」的。
 * 那代表未裁決的不是在等，是被遺棄；處理方式跟「裁決太慢」完全不同。
 */
export function gapShape(gaps: SpecGapRow[], nowIso: string): GapShape {
  const w = { hour: 0, day: 0, week: 0, later: 0 };
  const o = { underWeek: 0, weekToMonth: 0, overMonth: 0 };
  let resolved = 0, open = 0;
  for (const g of gaps) {
    const created = parseDbTime(g.createdAt);
    if (g.status === 'resolved' && g.resolvedAt) {
      resolved++;
      const h = hours(created, parseDbTime(g.resolvedAt));
      if (h <= 1) w.hour++; else if (h <= 24) w.day++; else if (h <= 24 * 7) w.week++; else w.later++;
    } else {
      open++;
      const d = days(created, nowIso);
      if (d < 7) o.underWeek++; else if (d <= 30) o.weekToMonth++; else o.overMonth++;
    }
  }

  let reading: string;
  if (resolved + open < 10) {
    reading = '樣本不足，看不出形狀。';
  } else {
    const fastPct = resolved ? Math.round(((w.hour + w.day) / resolved) * 100) : 0;
    const stalePct = open ? Math.round((o.overMonth / open) * 100) : 0;
    if (fastPct >= 70 && stalePct >= 50) {
      reading = `**兩極化**：已裁決的 ${fastPct}% 在一天內處理完，但開著的 ${stalePct}% 已經放超過一個月。`
        + `未裁決的不是在排隊，是**被遺棄了**——多半是當初那個 session 結束後就沒人再回來看。`
        + `要處理的是「誰會再看到它」，不是「裁決太慢」。`;
    } else if (stalePct >= 50) {
      reading = `開著的缺口 ${stalePct}% 已超過一個月未動——堆積中。`;
    } else if (fastPct >= 70) {
      reading = `裁決速度正常：已裁決的 ${fastPct}% 在一天內處理完，開著的多半還新。`;
    } else {
      reading = '沒有明顯的形狀——裁決時間分散。';
    }
  }
  return { resolved, open, resolvedWithin: w, openFor: o, reading };
}

// ── 6. 專案筆記的汰換率 ────────────────────────────────────

export interface NoteChurn {
  category: string;
  active: number;
  archived: number;
  /** 封存比例％——高代表那類「經驗」常被推翻，記下來的品質有問題 */
  archiveRate: number;
}

export function noteChurn(notes: ProjectNoteRow[]): NoteChurn[] {
  const m = new Map<string, { active: number; archived: number }>();
  for (const n of notes) {
    const cat = n.category || '(未分類)';
    const b = m.get(cat) ?? { active: 0, archived: 0 };
    if (n.active) b.active++; else b.archived++;
    m.set(cat, b);
  }
  return [...m.entries()]
    .map(([category, b]) => {
      const tot = b.active + b.archived;
      return { category, active: b.active, archived: b.archived, archiveRate: tot ? Math.round((b.archived / tot) * 1000) / 10 : 0 };
    })
    .sort((a, b) => b.archiveRate - a.archiveRate);
}
