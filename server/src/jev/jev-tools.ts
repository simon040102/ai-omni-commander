/**
 * Jev MCP 工具：jev_classify——把「答案能事先列成選項」的判斷批次丟給 Jev。
 * 獨立於 OmniCommander MCP（另一個 server、另一個入口），只共用 utils/typesafe.ts 與金鑰設定。
 * 唯讀：不寫任何 DB，不碰任務／閘門。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { getDbPath, compactJson, fitListToLimit } from '../mcp/helpers.js';
import {
  classifyWithJev, resolveTypesafeApiKey, JEV_DEFAULT_MODEL, TYPESAFE_API_KEY_CONFIG,
  type JevQuestion, type JevItemResult,
} from '../utils/typesafe.js';

export const JEV_MAX_ITEMS = 200;
export const JEV_MAX_TEXT = 8000;
const NONE_LIKE = /^(none|other|unknown|n\/a|na|其他|都不是|無)$/i;

export interface JevToolDeps {
  getApiKey?: () => string;
  fetchImpl?: typeof fetch;
}

/** 金鑰：OmniCommander 全域設定（DB）優先、env TYPESAFE_API_KEY 備援——與 Web 設定頁同一套規則。DB 不在也能只靠 env 跑。 */
export function readJevApiKey(): string {
  let dbKey = '';
  try {
    const db = new Database(getDbPath(), { readonly: true, fileMustExist: true });
    try {
      dbKey = (db.prepare('SELECT value FROM global_config WHERE key = ?').get(TYPESAFE_API_KEY_CONFIG) as { value: string } | undefined)?.value ?? '';
    } finally {
      db.close();
    }
  } catch { /* DB 不存在或還沒有 global_config → 只看 env */ }
  return resolveTypesafeApiKey(dbKey, process.env['TYPESAFE_API_KEY']).key;
}

const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true });

export function registerJevTools(server: McpServer, deps: JevToolDeps = {}): void {
  const getApiKey = deps.getApiKey ?? readJevApiKey;

  server.tool(
    'jev_classify',
    '用 Jev（TypeSafe 的封閉式判斷模型）批次分類或打分：每筆資料問同一個問題，答案只能從你給的選項挑（choice）或落在你給的量尺上（score）。零點幾秒一筆、極便宜，適合「資料量大＋每筆都問同一個封閉問題」：留言／任務／缺口分類、名單篩選、風險打分、挑模型等級。'
    + '不會產生文字或理由；準度不及大模型——結果僅供參考，不可當成完成閘門或 AI 回對 matched/missing 的依據。'
    + '選項描述要寫具體情境（「找一個檔案的路徑」）而不是形容詞（「簡單的」）；choice 一定要留一個 none/other 選項。資料會送到 TypeSafe（第三方）。',
    {
      question: z.string().min(1).describe('每筆都要回答的問題，例如「這張任務屬於哪一類？」'),
      type: z.enum(['choice', 'score']).optional().describe('choice=從 options 挑一個（預設）；score=依 scale 打 0~1 分'),
      options: z.record(z.string(), z.string()).optional().describe('choice 用：{選項代號: 具體描述}，至少 2 個，記得含 none/other'),
      scale: z.array(z.string()).optional().describe('score 用：量尺端點，由低到高，例如 ["外觀小問題", "系統掛掉"]，至少 2 個'),
      items: z.array(z.object({
        id: z.string().describe('你自己的識別碼（原樣帶回）'),
        text: z.string().describe(`要判斷的資料（每筆最多 ${JEV_MAX_TEXT} 字）`),
      })).min(1).max(JEV_MAX_ITEMS).describe(`要判斷的資料，一次最多 ${JEV_MAX_ITEMS} 筆`),
      context: z.string().optional().describe('所有筆共用的背景（例如專案說明、分類規則補充）'),
      minConfidence: z.number().min(0).max(1).optional().describe('信心度低於此值標 uncertain（預設 0.5）'),
      model: z.string().optional().describe(`預設 ${JEV_DEFAULT_MODEL}；可用 jev-preview`),
    },
    { title: 'Jev Classify', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ question, type, options, scale, items, context, minConfidence, model }) => {
      const qType = type ?? 'choice';
      let q: JevQuestion;
      const warnings: string[] = [];
      if (qType === 'choice') {
        const keys = Object.keys(options ?? {});
        if (keys.length < 2) return err('choice 需要 options 至少 2 個選項（{代號: 具體描述}）。');
        if (!keys.some(k => NONE_LIKE.test(k))) {
          warnings.push('選項裡沒有 none/other——沒有退路時 Jev 會被迫硬選一個，結果可能失真。');
        }
        q = { type: 'choice', instructions: question, options: options! };
      } else {
        if (!scale || scale.length < 2) return err('score 需要 scale 至少 2 個由低到高的量尺端點。');
        q = { type: 'score', instructions: question, scale };
      }
      if (items.length > JEV_MAX_ITEMS) return err(`一次最多 ${JEV_MAX_ITEMS} 筆（收到 ${items.length}）。`);
      const tooLong = items.filter(i => i.text.length > JEV_MAX_TEXT).map(i => i.id);
      if (tooLong.length > 0) return err(`以下項目超過 ${JEV_MAX_TEXT} 字，請先截取重點：${tooLong.slice(0, 20).join(', ')}`);

      const apiKey = getApiKey();
      if (!apiKey) {
        return err('沒有 TypeSafe API key。到 OmniCommander Web 的 Global Settings →「TypeSafe API Key（Jev）」設定，或設環境變數 TYPESAFE_API_KEY。');
      }

      const out = await classifyWithJev({
        apiKey, question: q, items, context, model, minConfidence, fetchImpl: deps.fetchImpl,
      });

      const ok = out.results.filter(r => !r.error);
      const summary: Record<string, unknown> = {
        total: items.length,
        uncertain: ok.filter(r => r.uncertain).length,
        failed: out.results.length - ok.length,
      };
      if (q.type === 'choice') {
        const counts: Record<string, number> = {};
        for (const r of ok) if (r.answer) counts[r.answer] = (counts[r.answer] ?? 0) + 1;
        summary.counts = counts;
      } else {
        const scores = ok.map(r => r.score).filter((s): s is number => typeof s === 'number');
        if (scores.length > 0) {
          summary.avgScore = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3));
        }
      }
      if (summary.failed === items.length) {
        return err(`全部 ${items.length} 筆都失敗：${out.results[0]?.error ?? '未知錯誤'}`);
      }

      const render = (shown: JevItemResult[]) => compactJson({
        model: out.model,
        type: q.type,
        summary,
        usage: out.usage,
        ...(warnings.length ? { warnings } : {}),
        note: '僅供參考：Jev 準度不及大模型，不可當成完成閘門或 AI 回對判定依據；uncertain 的項目請人工或大模型複核。',
        ...(shown.length < out.results.length ? { truncated: `回應過長，只列前 ${shown.length}/${out.results.length} 筆；summary 為全部統計。` } : {}),
        results: shown,
      });
      const { text } = fitListToLimit(out.results, render);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
