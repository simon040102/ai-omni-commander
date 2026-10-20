/**
 * Jev MCP 工具：jev_classify——把「答案能事先列成選項」的判斷批次丟給 Jev。
 * 獨立於 OmniCommander MCP（另一個 server、另一個入口），只共用 utils/typesafe.ts 與金鑰設定。
 * 唯讀：不寫任何 DB，不碰任務／閘門。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compactJson, fitListToLimit } from '../mcp/helpers.js';
import {
  classifyWithJev, JEV_DEFAULT_MODEL,
  type JevQuestion, type JevNamedQuestion, type JevItemResult, type JevAnswer,
} from '../utils/typesafe.js';

export const JEV_MAX_ITEMS = 200;
export const JEV_MAX_TEXT = 8000;
export const JEV_MAX_QUESTIONS = 10;
const NONE_LIKE = /^(none|other|unknown|n\/a|na|其他|都不是|無)$/i;
const QUESTION_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export interface JevToolDeps {
  /** 預設只讀 env TYPESAFE_API_KEY（獨立版）；omni 版注入 omni-key.ts 的 readOmniJevApiKey */
  getApiKey?: () => string;
  fetchImpl?: typeof fetch;
}

export const readEnvJevApiKey = (): string => process.env['TYPESAFE_API_KEY'] ?? '';

const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true });

type QuestionType = 'choice' | 'score' | 'yesno';
interface QuestionDef { question?: string; type?: QuestionType; options?: Record<string, string>; scale?: string[] }

/** 驗證單一題目設定 → JevQuestion，或回錯誤訊息。label 用來在多題時指出是哪一題。 */
function toQuestion(def: QuestionDef, label: string, warnings: string[]): JevQuestion | string {
  const instructions = (def.question ?? '').trim();
  if (!instructions) return `${label}缺少 question（每筆都要回答的問題）。`;
  const t = def.type ?? 'choice';
  if (t === 'choice') {
    const keys = Object.keys(def.options ?? {});
    if (keys.length < 2) return `${label}choice 需要 options 至少 2 個選項（{代號: 具體描述}）。`;
    if (!keys.some(k => NONE_LIKE.test(k))) {
      warnings.push(`${label}選項裡沒有 none/other——沒有退路時 Jev 會被迫硬選一個，結果可能失真。`);
    }
    return { type: 'choice', instructions, options: def.options! };
  }
  if (t === 'score') {
    if (!def.scale || def.scale.length < 2) return `${label}score 需要 scale 至少 2 個由低到高的量尺端點。`;
    return { type: 'score', instructions, scale: def.scale };
  }
  return { type: 'yesno', instructions };
}

function summarize(q: JevQuestion, answers: JevAnswer[]): Record<string, unknown> {
  const ok = answers.filter(a => !a.error);
  const s: Record<string, unknown> = { uncertain: ok.filter(a => a.uncertain).length };
  if (q.type === 'score') {
    const scores = ok.map(a => a.score).filter((x): x is number => typeof x === 'number');
    if (scores.length > 0) s.avgScore = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(3));
  } else {
    const counts: Record<string, number> = {};
    for (const a of ok) if (a.answer) counts[a.answer] = (counts[a.answer] ?? 0) + 1;
    s.counts = counts;
  }
  return s;
}

const questionShape = {
  question: z.string().describe('每筆都要回答的問題'),
  type: z.enum(['choice', 'score', 'yesno']).optional().describe('choice=從 options 挑一個（預設）；score=依 scale 打 0~1 分；yesno=是非題（回「是」的機率）'),
  options: z.record(z.string(), z.string()).optional().describe('choice 用：{選項代號: 具體描述}，至少 2 個，記得含 none/other'),
  scale: z.array(z.string()).optional().describe('score 用：量尺端點，由低到高，例如 ["外觀小問題", "系統掛掉"]，至少 2 個'),
};

export function registerJevTools(server: McpServer, deps: JevToolDeps = {}): void {
  const getApiKey = deps.getApiKey ?? readEnvJevApiKey;

  server.tool(
    'jev_classify',
    '用 Jev（TypeSafe 的封閉式判斷模型）批次分類、打分或判是非：每筆資料問同樣的問題，答案只能從你給的選項挑（choice）、落在你給的量尺上（score）或是／否（yesno）。零點幾秒一筆、極便宜，適合「資料量大＋每筆都問同一個封閉問題」：留言／任務／缺口分類、名單篩選、風險打分、程式快篩、挑模型等級。'
    + '單題：用 question＋type＋options/scale。**同一筆要問多題**（例：一份 diff 同時問「有沒有改弱測試」「有沒有印出機密」）用 questions，一筆只送一次請求。'
    + '不會產生文字或理由；準度不及大模型——結果僅供參考，不可當成完成閘門或 AI 回對 matched/missing 的依據。'
    + '選項描述要寫具體情境（「找一個檔案的路徑」）而不是形容詞（「簡單的」）；choice 一定要留一個 none/other 選項。資料會送到 TypeSafe（第三方）。',
    {
      ...{ ...questionShape, question: questionShape.question.optional().describe('單題用：每筆都要回答的問題，例如「這張任務屬於哪一類？」（用 questions 時不用填）') },
      questions: z.array(z.object({
        key: z.string().describe('這題的代號（英文字母開頭，英數與底線），結果用它對應'),
        ...questionShape,
      })).max(JEV_MAX_QUESTIONS).optional().describe(`多題：同一筆資料一次問多題（最多 ${JEV_MAX_QUESTIONS} 題），結果在每筆的 answers{key}`),
      items: z.array(z.object({
        id: z.string().describe('你自己的識別碼（原樣帶回）'),
        text: z.string().describe(`要判斷的資料（每筆最多 ${JEV_MAX_TEXT} 字）`),
      })).min(1).max(JEV_MAX_ITEMS).describe(`要判斷的資料，一次最多 ${JEV_MAX_ITEMS} 筆`),
      context: z.string().optional().describe('所有筆共用的背景（例如專案說明、分類規則補充）'),
      minConfidence: z.number().min(0).max(1).optional().describe('choice/score 信心度低於此值標 uncertain（預設 0.5）；yesno 的「是」機率在 0.3～0.7 之間標 uncertain'),
      model: z.string().optional().describe(`預設 ${JEV_DEFAULT_MODEL}；可用 jev-preview`),
    },
    { title: 'Jev Classify', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ question, type, options, scale, questions, items, context, minConfidence, model }) => {
      const warnings: string[] = [];
      let single: JevQuestion | null = null;
      let multi: JevNamedQuestion[] | null = null;

      if (questions && questions.length > 0) {
        const seen = new Set<string>();
        multi = [];
        for (const def of questions) {
          if (!QUESTION_KEY_RE.test(def.key)) return err(`題目代號「${def.key}」不合法：要英文字母開頭，只能用英數與底線（最多 40 字）。`);
          if (seen.has(def.key)) return err(`題目代號重複：${def.key}`);
          seen.add(def.key);
          const q = toQuestion(def, `題目 ${def.key}：`, warnings);
          if (typeof q === 'string') return err(q);
          multi.push({ key: def.key, q });
        }
      } else {
        const q = toQuestion({ question, type, options, scale }, '', warnings);
        if (typeof q === 'string') return err(q);
        single = q;
      }

      if (items.length > JEV_MAX_ITEMS) return err(`一次最多 ${JEV_MAX_ITEMS} 筆（收到 ${items.length}）。`);
      const tooLong = items.filter(i => i.text.length > JEV_MAX_TEXT).map(i => i.id);
      if (tooLong.length > 0) return err(`以下項目超過 ${JEV_MAX_TEXT} 字，請先截取重點：${tooLong.slice(0, 20).join(', ')}`);

      const apiKey = getApiKey();
      if (!apiKey) {
        return err('沒有 TypeSafe API key。到 OmniCommander Web 的 Global Settings →「TypeSafe API Key（Jev）」設定，或設環境變數 TYPESAFE_API_KEY。');
      }

      const out = await classifyWithJev({
        apiKey, question: single ?? multi![0]!.q, ...(multi ? { questions: multi } : {}),
        items, context, model, minConfidence, fetchImpl: deps.fetchImpl,
      });

      const failed = out.results.filter(r => r.error).length;
      if (failed === items.length) {
        return err(`全部 ${items.length} 筆都失敗：${out.results[0]?.error ?? '未知錯誤'}`);
      }
      const okResults = out.results.filter(r => !r.error);
      const summary: Record<string, unknown> = multi
        ? {
            total: items.length, failed,
            byQuestion: Object.fromEntries(multi.map(({ key, q }) => [key, summarize(q, okResults.map(r => r.answers?.[key] ?? { error: 'missing' }))])),
          }
        : { total: items.length, failed, ...summarize(single!, okResults) };

      const render = (shown: JevItemResult[]) => compactJson({
        model: out.model,
        ...(multi ? { questions: multi.map(({ key, q }) => ({ key, type: q.type })) } : { type: single!.type }),
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
