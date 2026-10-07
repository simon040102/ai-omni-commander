import { describe, it, expect } from 'vitest';
import {
  monthOf, looksLikeToolLimitation, firstRoundPerTask, missRateByType,
  toolLimitationTrend, readTrend, reviewRounds, divergenceByType, divergenceTrend, emergingDivergence,
  gapStats, gapShape, noteChurn, parseDbTime,
  type ReviewRun, type SpecGapRow, type ProjectNoteRow,
} from '../harness-analysis.js';

const run = (taskId: string, runAt: string, results: ReviewRun['results']): ReviewRun =>
  ({ taskId, runAt, source: 'ai_review', results });

describe('monthOf', () => {
  it('取 ISO 前綴的年月', () => {
    expect(monthOf('2026-09-28 10:11:12')).toBe('2026-09');
    expect(monthOf('2026-07-29T14:37:34+08:00')).toBe('2026-07');
  });
  it('取不到就歸 unknown，不要當成某個月混進統計', () => {
    expect(monthOf(null)).toBe('unknown');
    expect(monthOf('')).toBe('unknown');
    expect(monthOf('garbage')).toBe('unknown');
  });
});

describe('looksLikeToolLimitation', () => {
  it('認得 reviewer 實際寫過的幾種講法', () => {
    // 以下字串取自真實 results_json
    expect(looksLikeToolLimitation('[工具假陰性—實際已實作] @RequestMapping("/sm02")(19)+@PostMapping')).toBe(true);
    expect(looksLikeToolLimitation('[證據驗證器限制、非實作缺陷] AdmCustLog.java:15 @Column(name="OID") 已對映')).toBe(true);
    expect(looksLikeToolLimitation('實作正確（真實判定 matched）：Sm09Controller 類 @RequestMapping')).toBe(true);
    expect(looksLikeToolLimitation('實作已確認存在於 docs/SQL/DF08-seed.sql:14-18')).toBe(true);
  });
  it('真缺陷的 note 不應該被掃成工具問題', () => {
    expect(looksLikeToolLimitation('全前端只有註解出現過 searchFolderTree，沒有任何路徑常數也沒有呼叫')).toBe(false);
    expect(looksLikeToolLimitation('ORDER BY 是寫死字串，sortField 根本沒進 repository')).toBe(false);
    expect(looksLikeToolLimitation(null)).toBe(false);
  });
});

describe('firstRoundPerTask', () => {
  it('每個任務只取最早那一輪（harness 好不好看第一輪，不看修完再驗）', () => {
    const runs = [
      run('t1', '2026-09-10', [{ itemId: 'a', itemType: 'api', status: 'missing' }]),
      run('t1', '2026-09-01', [{ itemId: 'a', itemType: 'api', status: 'matched' }]),
      run('t2', '2026-09-05', [{ itemId: 'b', itemType: 'logic', status: 'matched' }]),
    ];
    const first = firstRoundPerTask(runs).sort((a, b) => a.taskId.localeCompare(b.taskId));
    expect(first).toHaveLength(2);
    expect(first[0].runAt).toBe('2026-09-01');   // t1 取較早那筆
    expect(first[0].results[0].status).toBe('matched');
  });
});

describe('missRateByType', () => {
  it('依類型算不符率並由高到低排', () => {
    const runs = [run('t1', '2026-09-01', [
      { itemId: '1', itemType: 'api', status: 'missing' },
      { itemId: '2', itemType: 'api', status: 'matched' },
      { itemId: '3', itemType: 'ui_text', status: 'matched' },
      { itemId: '4', itemType: 'ui_text', status: 'matched' },
      { itemId: '5', itemType: 'ui_text', status: 'matched' },
      { itemId: '6', itemType: 'ui_text', status: 'matched' },
    ])];
    const [api, ui] = missRateByType(runs);
    expect(api).toEqual({ itemType: 'api', total: 2, missing: 1, rate: 50 });
    expect(ui).toEqual({ itemType: 'ui_text', total: 4, missing: 0, rate: 0 });
  });
  it('waived 不算 missing', () => {
    const runs = [run('t1', '2026-09-01', [
      { itemId: '1', itemType: 'api', status: 'waived' },
      { itemId: '2', itemType: 'api', status: 'matched' },
    ])];
    expect(missRateByType(runs)[0].missing).toBe(0);
  });
});

describe('toolLimitationTrend — 這個工具存在的理由', () => {
  // 真實案例：加總得到 21%，據此差點去修比對規則；
  // 按月切開才看到問題在某個 commit 就修掉了，剩下的只是舊帳。
  const runs = [
    run('t1', '2026-07-05', [
      { itemId: '1', itemType: 'api', status: 'missing', note: '[工具假陰性—實際已實作]' },
      { itemId: '2', itemType: 'api', status: 'missing', note: '實作正確（真實判定 matched）' },
      { itemId: '3', itemType: 'api', status: 'missing', note: '真的沒做' },
      { itemId: '4', itemType: 'api', status: 'matched' },
    ]),
    run('t2', '2026-09-20', [
      { itemId: '5', itemType: 'api', status: 'missing', note: '真的沒做' },
      { itemId: '6', itemType: 'api', status: 'missing', note: 'ORDER BY 寫死' },
      { itemId: '7', itemType: 'api', status: 'missing', note: '欄位名打錯' },
    ]),
  ];

  it('按月切，不把不同月份混成一個數字', () => {
    const t = toolLimitationTrend(runs);
    expect(t).toEqual([
      { month: '2026-07', missing: 3, flagged: 2, pct: 66.7 },
      { month: '2026-09', missing: 3, flagged: 0, pct: 0 },
    ]);
  });

  it('只看總和會得到 33%，看趨勢才知道已經修好了', () => {
    const t = toolLimitationTrend(runs);
    const naiveTotal = t.reduce((a, b) => a + b.flagged, 0) / t.reduce((a, b) => a + b.missing, 0);
    expect(Math.round(naiveTotal * 100)).toBe(33);   // 誤導人的總和
    expect(t[t.length - 1].pct).toBe(0);              // 最近一個月的真相
  });

  it('matched 的項目不進分母', () => {
    expect(toolLimitationTrend(runs)[0].missing).toBe(3);   // 該月有 4 項，只有 3 項 missing
  });
});

describe('readTrend', () => {
  const mk = (month: string, missing: number, pct: number) =>
    ({ month, missing, flagged: Math.round(missing * pct / 100), pct });

  it('樣本不足就說樣本不足，不要硬給結論', () => {
    expect(readTrend([mk('2026-09', 3, 50)])).toContain('樣本不足');
    expect(readTrend([])).toContain('樣本不足');
  });
  it('在收斂 → 明講不要照總數去改規則', () => {
    const s = readTrend([mk('2026-07', 160, 41), mk('2026-09', 187, 4)]);
    expect(s).toContain('在收斂');
    expect(s).toContain('不要照總數');
  });
  it('在惡化 → 指向最近的案例', () => {
    expect(readTrend([mk('2026-07', 100, 5), mk('2026-09', 100, 40)])).toContain('在惡化');
  });
  it('持平 → 說那是固定盲點', () => {
    expect(readTrend([mk('2026-07', 100, 20), mk('2026-09', 100, 22)])).toContain('持平');
  });
  it('樣本太少的月份不參與判讀（避免單月雜訊主導）', () => {
    const s = readTrend([mk('2026-06', 2, 100), mk('2026-07', 160, 41), mk('2026-09', 187, 4)]);
    expect(s).toContain('2026-07');   // 從 07 起算，不是從樣本只有 2 筆的 06
  });
});

describe('reviewRounds', () => {
  it('算重審率與跑三輪以上的任務', () => {
    const runs = [
      run('t1', '2026-09-01', []), run('t1', '2026-09-02', []), run('t1', '2026-09-03', []),
      run('t2', '2026-09-01', []), run('t2', '2026-09-02', []),
      run('t3', '2026-09-01', []),
      run('t4', '2026-09-01', []),
    ];
    const r = reviewRounds(runs);
    expect(r.totalTasks).toBe(4);
    expect(r.needsRework).toBe(2);
    expect(r.reworkRate).toBe(50);
    expect(r.heavyTasks).toEqual([{ taskId: 't1', rounds: 3 }]);
    expect(r.distribution).toEqual([{ rounds: 1, tasks: 2 }, { rounds: 2, tasks: 1 }, { rounds: 3, tasks: 1 }]);
  });
  it('沒有資料不會除以零', () => {
    expect(reviewRounds([]).reworkRate).toBe(0);
  });
});

describe('divergenceByType', () => {
  it('兩個方向分開計——意義完全不同', () => {
    const runs = [run('t1', '2026-09-01', [
      // 字面存在但實際沒接上：AI 通常是對的
      { itemId: '1', itemType: 'param', status: 'missing', engineStatus: 'matched' },
      // 比對規則抓不到的寫法：規則要補
      { itemId: '2', itemType: 'api', status: 'matched', engineStatus: 'missing' },
      { itemId: '3', itemType: 'api', status: 'matched', engineStatus: 'missing' },
      // 一致的不算分歧
      { itemId: '4', itemType: 'api', status: 'matched', engineStatus: 'matched' },
    ])];
    const d = divergenceByType(runs);
    expect(d[0]).toEqual({ itemType: 'api', engineMatchedAiMissing: 0, engineMissingAiMatched: 2 });
    expect(d[1]).toEqual({ itemType: 'param', engineMatchedAiMissing: 1, engineMissingAiMatched: 0 });
  });
  it('engine 判 manual 或沒有 engineStatus 的不算分歧', () => {
    const runs = [run('t1', '2026-09-01', [
      { itemId: '1', itemType: 'logic', status: 'missing', engineStatus: 'manual' },
      { itemId: '2', itemType: 'logic', status: 'missing' },
    ])];
    expect(divergenceByType(runs)).toEqual([]);
  });
});

describe('parseDbTime', () => {
  it('SQLite 的 UTC 時間不帶 Z——補上，否則 Date.parse 會當本地時間、差 8 小時', () => {
    expect(parseDbTime('2026-09-01 08:00:00')).toBe('2026-09-01T08:00:00Z');
    expect(Date.parse(parseDbTime('2026-09-01 08:00:00'))).toBe(Date.parse('2026-09-01T08:00:00Z'));
  });
  it('已經帶時區的不動', () => {
    expect(parseDbTime('2026-09-01T08:00:00Z')).toBe('2026-09-01T08:00:00Z');
    expect(parseDbTime('2026-09-01T08:00:00+08:00')).toBe('2026-09-01T08:00:00+08:00');
  });
});

describe('divergenceTrend / emergingDivergence', () => {
  // 照**真實資料的形狀**造：save_compliance_review 只在分歧時才寫 engineStatus，
  // 一致的項目**沒有**這個欄位。
  // （第一版測試讓一致的項目也帶 engineStatus:'matched'——測試全過，
  //   但那是照錯誤假設造的資料，拿真資料一跑比例全變 ~100%。）
  const items = (type: string, gap: number, ok: number) => [
    ...Array.from({ length: gap }, (_, i) => ({ itemId: `g${i}`, itemType: type, status: 'matched', engineStatus: 'missing' })),
    ...Array.from({ length: ok }, (_, i) => ({ itemId: `k${i}`, itemType: type, status: 'matched' })),
  ];

  it('回歸：分母是全部項目，不是「帶 engineStatus 的」（那些全是分歧項）', () => {
    const t = divergenceTrend([run('a', '2026-09-01', items('api', 5, 95))]);
    expect(t[0].compared).toBe(100);      // 不是 5
    expect(t[0].ruleGapRate).toBe(5);     // 不是 100
  });

  it('按月、用比例算（不是筆數）', () => {
    const t = divergenceTrend([
      run('a', '2026-07-01', items('api', 10, 90)),
      run('b', '2026-09-01', items('api', 20, 380)),   // 筆數變 2 倍，比例反而變一半
    ]);
    expect(t).toEqual([
      { itemType: 'api', month: '2026-07', compared: 100, ruleGap: 10, ruleGapRate: 10 },
      { itemType: 'api', month: '2026-09', compared: 400, ruleGap: 20, ruleGapRate: 5 },
    ]);
  });

  it('前兩個月是 0、這個月才冒出來 → 標為新問題（總數會把它攤平）', () => {
    const t = divergenceTrend([
      run('a', '2026-07-01', items('ui_text', 0, 100)),
      run('b', '2026-08-01', items('ui_text', 0, 100)),
      run('c', '2026-09-01', items('ui_text', 30, 70)),
    ]);
    const e = emergingDivergence(t);
    expect(e).toEqual([{ itemType: 'ui_text', month: '2026-09', rate: 30, prevRate: 0, ruleGap: 30 }]);
  });

  it('在收斂的不算新問題（即使最近一個月筆數還不少）', () => {
    const t = divergenceTrend([
      run('a', '2026-07-01', items('api', 40, 60)),    // 40%
      run('b', '2026-09-01', items('api', 12, 88)),    // 12%，下降中
    ]);
    expect(emergingDivergence(t)).toEqual([]);
  });

  it('樣本太少的月份不當基準也不當結論', () => {
    const t = divergenceTrend([run('a', '2026-09-01', items('param', 3, 5))]);  // 只有 8 筆
    expect(emergingDivergence(t)).toEqual([]);
  });

  it('logic 不進分母（程式預檢一律判 manual，根本沒比對）', () => {
    const t = divergenceTrend([run('a', '2026-09-01', [
      { itemId: '1', itemType: 'logic', status: 'missing' },
      { itemId: '2', itemType: 'logic', status: 'matched' },
    ])]);
    expect(t).toEqual([]);
  });
});

describe('gapStats', () => {
  const NOW = '2026-09-28T00:00:00Z';
  const gaps: SpecGapRow[] = [
    { id: '1', category: 'logic_unclear', status: 'open', createdAt: '2026-07-01T00:00:00Z' },
    { id: '2', category: 'logic_unclear', status: 'open', createdAt: '2026-09-20T00:00:00Z' },
    { id: '3', category: 'logic_unclear', status: 'resolved', createdAt: '2026-09-01T00:00:00Z', resolvedAt: '2026-09-03T00:00:00Z' },
    { id: '4', category: 'field_undefined', status: 'resolved', createdAt: '2026-09-01T00:00:00Z', resolvedAt: '2026-09-11T00:00:00Z' },
  ];
  it('分開算未裁決／已裁決、中位數與最久未決', () => {
    const [lu, fu] = gapStats(gaps, NOW);
    expect(lu).toEqual({ category: 'logic_unclear', open: 2, resolved: 1, medianResolveHours: 48, oldestOpenDays: 89 });
    expect(fu.medianResolveHours).toBe(240);
    expect(fu.oldestOpenDays).toBeNull();
  });
  it('裁決中位數用小時，不能被捨入成 0（實測中位數是 30 分鐘）', () => {
    const r = gapStats([
      { id: 'a', category: 'c', status: 'resolved', createdAt: '2026-09-01 08:00:00', resolvedAt: '2026-09-01 08:30:00' },
    ], NOW);
    expect(r[0].medianResolveHours).toBe(0.5);
  });
  it('資料庫格式（不帶 Z）與現在時間相減不會差 8 小時', () => {
    // 前一天 16:00 UTC 建立 → 到 NOW（00:00 UTC）是 8 小時，不到 1 天
    const r = gapStats([{ id: 'a', category: 'c', status: 'open', createdAt: '2026-09-27 16:00:00' }], NOW);
    expect(r[0].oldestOpenDays).toBe(0);
  });
  it('標 resolved 但沒有 resolvedAt 的算未裁決（不可當成已處理）', () => {
    const r = gapStats([{ id: 'x', category: 'c', status: 'resolved', createdAt: '2026-09-01T00:00:00Z' }], NOW);
    expect(r[0].open).toBe(1);
    expect(r[0].resolved).toBe(0);
  });
});

describe('gapShape', () => {
  const NOW = '2026-09-28T00:00:00Z';
  const resolvedFast = (i: number): SpecGapRow =>
    ({ id: `r${i}`, category: 'c', status: 'resolved', createdAt: '2026-09-01 08:00:00', resolvedAt: '2026-09-01 08:20:00' });
  const openStale = (i: number): SpecGapRow =>
    ({ id: `o${i}`, category: 'c', status: 'open', createdAt: '2026-07-01 08:00:00' });

  it('當場拍板 + 長期擱置 → 判成兩極化，並指出是「被遺棄」不是「排隊」', () => {
    const s = gapShape([...Array.from({ length: 8 }, (_, i) => resolvedFast(i)), ...Array.from({ length: 6 }, (_, i) => openStale(i))], NOW);
    expect(s.resolvedWithin.hour).toBe(8);
    expect(s.openFor.overMonth).toBe(6);
    expect(s.reading).toContain('兩極化');
    expect(s.reading).toContain('被遺棄');
  });
  it('開著的都還新 → 不誤判成堆積', () => {
    const fresh = Array.from({ length: 6 }, (_, i): SpecGapRow =>
      ({ id: `f${i}`, category: 'c', status: 'open', createdAt: '2026-09-26 08:00:00' }));
    const s = gapShape([...Array.from({ length: 8 }, (_, i) => resolvedFast(i)), ...fresh], NOW);
    expect(s.openFor.underWeek).toBe(6);
    expect(s.reading).toContain('正常');
  });
  it('樣本不足就說樣本不足', () => {
    expect(gapShape([resolvedFast(0)], NOW).reading).toContain('樣本不足');
  });
});

describe('noteChurn', () => {
  it('封存率高＝那類經驗常被推翻', () => {
    const notes: ProjectNoteRow[] = [
      { id: '1', category: 'api', active: 0, createdAt: '2026-09-01' },
      { id: '2', category: 'api', active: 0, createdAt: '2026-09-01' },
      { id: '3', category: 'api', active: 1, createdAt: '2026-09-01' },
      { id: '4', category: 'ui', active: 1, createdAt: '2026-09-01' },
    ];
    const [api, ui] = noteChurn(notes);
    expect(api).toEqual({ category: 'api', active: 1, archived: 2, archiveRate: 66.7 });
    expect(ui.archiveRate).toBe(0);
  });
  it('沒分類的歸一類，不要丟掉', () => {
    expect(noteChurn([{ id: '1', active: 1, createdAt: '2026-09-01' }])[0].category).toBe('(未分類)');
  });
});
