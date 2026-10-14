import { describe, it, expect, vi } from 'vitest';
import { checkTypesafeKey, resolveTypesafeApiKey } from '../typesafe.js';

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
