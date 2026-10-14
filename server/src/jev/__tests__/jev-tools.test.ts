import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerJevTools } from '../jev-tools.js';
import { callTool } from '../../mcp/__tests__/test-helpers.js';

const SECRET = 'apikey_secret_should_never_leak';

function setup(opts: { key?: string; fetchImpl?: typeof fetch } = {}) {
  const server = new McpServer({ name: 'jev-test', version: '0.0.1' }, { capabilities: { tools: {} } });
  registerJevTools(server, {
    getApiKey: () => opts.key ?? SECRET,
    fetchImpl: opts.fetchImpl ?? (vi.fn(async (_u: string, init: RequestInit) => {
      const item = JSON.parse(init.body as string).state.item as string;
      const choice = item.includes('當掉') ? 'bug' : 'feature';
      const confidence = item.includes('模糊') ? 0.2 : 0.9;
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: { answer: { type: 'choice', choice, confidence, probabilities: { [choice]: 0.9 } } },
        usage: { input_tokens: 50, output_tokens: 5 },
      }), { status: 200 });
    }) as unknown as typeof fetch),
  });
  return server;
}

const OPTIONS = { bug: '程式錯誤、當機、資料錯', feature: '新功能、新畫面', other: '都不是' };

describe('jev_classify', () => {
  it('沒有金鑰 → 錯誤並說明去哪設定', async () => {
    const r = await callTool(setup({ key: '' }), 'jev_classify', { question: 'q', options: OPTIONS, items: [{ id: '1', text: 'x' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('TYPESAFE_API_KEY');
    expect(r.content[0].text).toContain('Global Settings');
  });

  it('choice 少於 2 個選項 → 錯誤；score 沒有量尺 → 錯誤', async () => {
    const s = setup();
    const a = await callTool(s, 'jev_classify', { question: 'q', options: { only: 'x' }, items: [{ id: '1', text: 'x' }] });
    expect(a.isError).toBe(true);
    const b = await callTool(s, 'jev_classify', { question: 'q', type: 'score', items: [{ id: '1', text: 'x' }] });
    expect(b.isError).toBe(true);
  });

  it('批次分類：逐筆結果、依答案統計、低信心標 uncertain、附僅供參考說明、不洩漏金鑰', async () => {
    const r = await callTool(setup(), 'jev_classify', {
      question: '這張任務是哪一類？',
      options: OPTIONS,
      items: [
        { id: 'T1', text: '登入頁送出就當掉' },
        { id: 'T2', text: '新增匯出 Excel 功能' },
        { id: 'T3', text: '描述很模糊的一張' },
      ],
    });
    expect(r.isError).toBeUndefined();
    const text = r.content[0].text as string;
    expect(text).not.toContain(SECRET);
    const out = JSON.parse(text);
    expect(out.results.map((x: { id: string }) => x.id)).toEqual(['T1', 'T2', 'T3']);
    expect(out.results[0].answer).toBe('bug');
    expect(out.results[2].uncertain).toBe(true);
    expect(out.summary.counts).toEqual({ bug: 1, feature: 2 });
    expect(out.summary.uncertain).toBe(1);
    expect(out.usage.inputTokens).toBe(150);
    expect(out.note).toContain('僅供參考');
  });

  it('沒有 none/other 類選項時提醒（Jev 會被迫硬選一個）', async () => {
    const r = await callTool(setup(), 'jev_classify', {
      question: 'q', options: { bug: 'a', feature: 'b' }, items: [{ id: '1', text: '當掉' }],
    });
    expect(JSON.parse(r.content[0].text).warnings.join('')).toContain('none');
  });
});
