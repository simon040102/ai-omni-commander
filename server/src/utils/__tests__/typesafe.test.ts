import { describe, it, expect, vi } from 'vitest';
import {
  checkTypesafeKey, resolveTypesafeApiKey, buildJevRequest, buildJevRequestMulti, parseJevAnswer, classifyWithJev,
  type JevQuestion,
} from '../typesafe.js';

const CHOICE: JevQuestion = { type: 'choice', instructions: '這張任務是哪一類？', options: { bug: '程式錯誤', feature: '新功能', other: '都不是' } };
const SCORE: JevQuestion = { type: 'score', instructions: '嚴重程度？', scale: ['外觀小問題', '系統掛掉'] };

function choiceBody(choice: string, confidence: number, probabilities: Record<string, number>) {
  return { model: 'jev-1.13.0', answers: { answer: { type: 'choice', choice, confidence, probabilities } }, usage: { input_tokens: 100, output_tokens: 10 } };
}

describe('buildJevRequest', () => {
  it('choice：選項描述放 criteria，資料放 state.item，共用背景放 state.context', () => {
    const req = buildJevRequest(CHOICE, '登入頁送出就當掉', '富邦專案');
    expect(req).toEqual({
      model: 'jev-latest',
      state: { item: '登入頁送出就當掉', context: '富邦專案' },
      questions: { answer: { type: 'choice', instructions: '這張任務是哪一類？', criteria: CHOICE.type === 'choice' ? CHOICE.options : {} } },
    });
  });

  it('score：量尺依序放 criteria 陣列；沒有 context 就不帶', () => {
    const req = buildJevRequest(SCORE, 'x', undefined, 'jev-preview');
    expect(req.model).toBe('jev-preview');
    expect(req.state).toEqual({ item: 'x' });
    expect(req.questions.answer).toEqual({ type: 'score', instructions: '嚴重程度？', criteria: ['外觀小問題', '系統掛掉'] });
  });
});

describe('parseJevAnswer', () => {
  it('choice：回選中選項、信心度、機率；信心度低於門檻標 uncertain', () => {
    const ok = parseJevAnswer(CHOICE, choiceBody('bug', 0.9, { bug: 0.95, feature: 0.03, other: 0.02 }), 0.5);
    expect(ok).toEqual({ answer: 'bug', confidence: 0.9, probabilities: { bug: 0.95, feature: 0.03, other: 0.02 } });
    const low = parseJevAnswer(CHOICE, choiceBody('feature', 0.3, { bug: 0.4, feature: 0.45, other: 0.15 }), 0.5);
    expect(low.uncertain).toBe(true);
  });

  it('score：回 0~1 分數，nearest 是機率最高的量尺端點文字', () => {
    const body = { answers: { answer: { type: 'score', score: 0.82, confidence: 0.7, legend: { 0: '外觀小問題', 1: '系統掛掉' }, probabilities: { 0: 0.18, 1: 0.82 } } } };
    expect(parseJevAnswer(SCORE, body, 0.5)).toEqual({ score: 0.82, nearest: '系統掛掉', confidence: 0.7 });
  });

  it('回應缺 answers → 回錯誤而不是丟例外', () => {
    expect(parseJevAnswer(CHOICE, {}, 0.5).error).toBeTruthy();
  });
});

describe('是非題（yesno → API 的 noul）與一次問多題', () => {
  it('buildJevRequestMulti：多題放同一個 questions，yesno 轉成 noul', () => {
    const req = buildJevRequestMulti([
      { key: 'leak', q: { type: 'yesno', instructions: '有印出密碼嗎？' } },
      { key: 'kind', q: CHOICE },
    ], 'console.log(pwd)');
    expect(req.questions).toEqual({
      leak: { type: 'noul', instructions: '有印出密碼嗎？' },
      kind: { type: 'choice', instructions: CHOICE.instructions, criteria: CHOICE.type === 'choice' ? CHOICE.options : {} },
    });
  });

  it('parseJevAnswer yesno：回「是」的機率與 yes/no；0.3～0.7 之間標 uncertain', () => {
    const YES: JevQuestion = { type: 'yesno', instructions: 'q' };
    const body = (p: number) => ({ answers: { leak: { type: 'noul', noul: p } } });
    expect(parseJevAnswer(YES, body(0.96), 0.5, 'leak')).toEqual({ answer: 'yes', probability: 0.96 });
    expect(parseJevAnswer(YES, body(0.1), 0.5, 'leak')).toEqual({ answer: 'no', probability: 0.1 });
    expect(parseJevAnswer(YES, body(0.55), 0.5, 'leak').uncertain).toBe(true);
  });

  it('classifyWithJev 帶 questions：每筆回 answers{key: …}，一筆只送一次請求', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({
      answers: { leak: { type: 'noul', noul: 0.9 }, kind: { type: 'choice', choice: 'bug', confidence: 0.8 } },
      usage: { input_tokens: 10, output_tokens: 1 },
    }), { status: 200 }));
    const out = await classifyWithJev({
      apiKey: 'k', question: CHOICE, items: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }],
      questions: [{ key: 'leak', q: { type: 'yesno', instructions: 'q' } }, { key: 'kind', q: CHOICE }],
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(f).toHaveBeenCalledTimes(2);
    expect(out.results[0]).toEqual({ id: 'a', answers: { leak: { answer: 'yes', probability: 0.9 }, kind: { answer: 'bug', confidence: 0.8 } } });
  });
});

describe('classifyWithJev', () => {
  it('保持輸入順序、限制同時請求數、加總 usage', async () => {
    let inFlight = 0, maxInFlight = 0;
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      const item = JSON.parse(init.body as string).state.item as string;
      return new Response(JSON.stringify(choiceBody(item.startsWith('b') ? 'bug' : 'feature', 0.9, {})), { status: 200 });
    });
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, text: i % 2 ? 'b-crash' : 'f-new' }));
    const out = await classifyWithJev({ apiKey: 'k', question: CHOICE, items, concurrency: 3, fetchImpl: f as unknown as typeof fetch });
    expect(out.results.map(r => r.id)).toEqual(items.map(i => i.id));
    expect(out.results[1].answer).toBe('bug');
    expect(out.results[0].answer).toBe('feature');
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(out.usage).toEqual({ inputTokens: 1000, outputTokens: 100 });
    expect(out.model).toBe('jev-1.13.0');
  });

  it('500 自動重試一次；400 不重試，只讓那一筆失敗', async () => {
    const calls: Record<string, number> = {};
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const item = JSON.parse(init.body as string).state.item as string;
      calls[item] = (calls[item] ?? 0) + 1;
      if (item === 'flaky' && calls[item] === 1) return new Response('{}', { status: 500 });
      if (item === 'bad') return new Response('{"detail":"Invalid request."}', { status: 400 });
      return new Response(JSON.stringify(choiceBody('bug', 0.9, {})), { status: 200 });
    });
    const out = await classifyWithJev({
      apiKey: 'k', question: CHOICE, retryDelayMs: 0,
      items: [{ id: 'a', text: 'flaky' }, { id: 'b', text: 'bad' }, { id: 'c', text: 'ok' }],
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(calls).toEqual({ flaky: 2, bad: 1, ok: 1 });
    expect(out.results[0].answer).toBe('bug');
    expect(out.results[1].error).toContain('400');
    expect(out.results[2].answer).toBe('bug');
  });
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('checkTypesafeKey', () => {
  it('200 → 成功，列出可用模型，帶 Bearer 呼叫 /v1/models', async () => {
    const f = fakeFetch(200, { models: [{ name: 'jev-latest' }, { name: 'jev-preview' }] });
    const r = await checkTypesafeKey('k-123', f as unknown as typeof fetch);
    expect(r.success).toBe(true);
    expect(r.message).toContain('jev-latest');
    expect(r.message).toContain('jev-preview');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-123');
  });

  it('401 → 失敗並帶狀態碼', async () => {
    const r = await checkTypesafeKey('bad', fakeFetch(401, { error: 'unauthorized' }) as unknown as typeof fetch);
    expect(r.success).toBe(false);
    expect(r.message).toContain('401');
  });

  it('網路錯誤 → 失敗，不丟例外', async () => {
    const f = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const r = await checkTypesafeKey('k', f as unknown as typeof fetch);
    expect(r.success).toBe(false);
    expect(r.message).toContain('ECONNRESET');
  });

  it('沒有 key → 直接失敗、不發請求', async () => {
    const f = fakeFetch(200, {});
    const r = await checkTypesafeKey('', f as unknown as typeof fetch);
    expect(r.success).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('resolveTypesafeApiKey', () => {
  it('DB 優先，其次 env，都沒有回 none', () => {
    expect(resolveTypesafeApiKey('db-key', 'env-key')).toEqual({ key: 'db-key', source: 'db' });
    expect(resolveTypesafeApiKey('', 'env-key')).toEqual({ key: 'env-key', source: 'env' });
    expect(resolveTypesafeApiKey('', undefined)).toEqual({ key: '', source: 'none' });
  });
});
