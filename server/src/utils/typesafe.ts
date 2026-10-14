// TypeSafe（Jev）連線設定與檢查。金鑰存 global_config 的 `typesafe.apiKey`，
// env `TYPESAFE_API_KEY` 只當備援——與 Asana PAT 同一套慣例。

export const TYPESAFE_API_BASE = 'https://api.typesafe.ai/v1';
export const TYPESAFE_API_KEY_CONFIG = 'typesafe.apiKey';

export type TypesafeKeySource = 'db' | 'env' | 'none';

export function resolveTypesafeApiKey(dbKey: string | null | undefined, envKey: string | undefined): { key: string; source: TypesafeKeySource } {
  if (dbKey) return { key: dbKey, source: 'db' };
  if (envKey) return { key: envKey, source: 'env' };
  return { key: '', source: 'none' };
}

// ── Jev 分類／打分 ─────────────────────────────────────────
// API：POST /v1/systemone，一次一筆 state、可多題。這裡固定一題（key=answer），
// 多筆資料用有上限的併發逐筆送。實測格式（2026-10）：
//   choice → { choice, confidence, probabilities: {選項: 機率} }
//   score  → { score: 0~1, confidence, legend: {index: 量尺文字}, probabilities: {index: 機率} }

export const JEV_DEFAULT_MODEL = 'jev-latest';
const QUESTION_KEY = 'answer';

export type JevQuestion =
  | { type: 'choice'; instructions: string; options: Record<string, string> }
  | { type: 'score'; instructions: string; scale: string[] };

export interface JevItem { id: string; text: string }

export interface JevItemResult {
  id: string;
  answer?: string;
  score?: number;
  nearest?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  uncertain?: boolean;
  error?: string;
}

export function buildJevRequest(q: JevQuestion, text: string, context?: string, model = JEV_DEFAULT_MODEL) {
  return {
    model,
    state: context ? { item: text, context } : { item: text },
    questions: {
      [QUESTION_KEY]: q.type === 'choice'
        ? { type: 'choice', instructions: q.instructions, criteria: q.options }
        : { type: 'score', instructions: q.instructions, criteria: q.scale },
    },
  };
}

export function parseJevAnswer(q: JevQuestion, body: unknown, minConfidence: number): Omit<JevItemResult, 'id'> {
  const a = (body as { answers?: Record<string, Record<string, unknown>> })?.answers?.[QUESTION_KEY];
  if (!a) return { error: 'Jev 回應缺少 answers' };
  const confidence = typeof a.confidence === 'number' ? a.confidence : undefined;
  const uncertain = confidence !== undefined && confidence < minConfidence ? { uncertain: true } : {};
  if (q.type === 'choice') {
    return {
      answer: String(a.choice),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(a.probabilities ? { probabilities: a.probabilities as Record<string, number> } : {}),
      ...uncertain,
    };
  }
  const probs = (a.probabilities ?? {}) as Record<string, number>;
  const legend = (a.legend ?? {}) as Record<string, string>;
  const top = Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0];
  return {
    score: typeof a.score === 'number' ? a.score : undefined,
    ...(top !== undefined ? { nearest: legend[top] ?? q.scale[Number(top)] } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...uncertain,
  };
}

export interface ClassifyOptions {
  apiKey: string;
  question: JevQuestion;
  items: JevItem[];
  context?: string;
  model?: string;
  minConfidence?: number;
  concurrency?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/** 逐筆送 Jev（有上限的併發、保持輸入順序）。單筆失敗只標該筆 error，不影響其他筆，不丟例外。 */
export async function classifyWithJev(opts: ClassifyOptions): Promise<{
  results: JevItemResult[];
  usage: { inputTokens: number; outputTokens: number };
  model?: string;
}> {
  const {
    apiKey, question, items, context, model = JEV_DEFAULT_MODEL, minConfidence = 0.5,
    concurrency = 8, timeoutMs = 15_000, retryDelayMs = 500, fetchImpl = fetch,
  } = opts;
  const results: JevItemResult[] = new Array(items.length);
  const usage = { inputTokens: 0, outputTokens: 0 };
  let resolvedModel: string | undefined;

  const callOnce = (item: JevItem) => fetchImpl(`${TYPESAFE_API_BASE}/systemone`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildJevRequest(question, item.text, context, model)),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const runOne = async (index: number) => {
    const item = items[index];
    try {
      let res: Response | undefined;
      // 429／5xx／網路錯誤重試一次；4xx 是請求本身有問題，重送也一樣
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await callOnce(item);
          if (res.status !== 429 && res.status < 500) break;
        } catch (err) {
          if (attempt === 1) throw err;
        }
        if (attempt === 0) await new Promise(r => setTimeout(r, retryDelayMs));
      }
      if (!res || !res.ok) {
        results[index] = { id: item.id, error: `Jev API 回傳 ${res?.status ?? '無回應'}` };
        return;
      }
      const body = await res.json() as { model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      resolvedModel ??= body.model;
      usage.inputTokens += body.usage?.input_tokens ?? 0;
      usage.outputTokens += body.usage?.output_tokens ?? 0;
      results[index] = { id: item.id, ...parseJevAnswer(question, body, minConfidence) };
    } catch (err) {
      results[index] = { id: item.id, error: err instanceof Error ? err.message : String(err) };
    }
  };

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) await runOne(next++);
  });
  await Promise.all(workers);
  return { results, usage, ...(resolvedModel ? { model: resolvedModel } : {}) };
}

/** 用 GET /v1/models 驗證金鑰——不送任何業務資料。永不丟例外。 */
export async function checkTypesafeKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<{ success: boolean; message: string }> {
  if (!apiKey) return { success: false, message: 'No TypeSafe API key configured' };
  try {
    const res = await fetchImpl(`${TYPESAFE_API_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { success: false, message: `TypeSafe API returned ${res.status}` };
    const body = await res.json().catch(() => ({})) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map(m => m.name).filter(Boolean);
    return { success: true, message: `TypeSafe connection successful${names.length ? `（可用模型：${names.join('、')}）` : ''}` };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}
