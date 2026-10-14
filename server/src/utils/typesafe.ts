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
