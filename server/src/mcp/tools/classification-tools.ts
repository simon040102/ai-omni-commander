/**
 * review_task_classification：用 Jev 檢查任務的類型（bug/feature/refactor）與角色（frontend/backend/fullstack），
 * 只回「Jev 有把握且與現況不同」的建議。**唯讀、不改任何資料**——任務類型與角色決定派工軌道
 * （bug＋無規格走 light 軌）、workspace 與驗收清單，Jev 準度約九成，自動改等於十張可能改錯一張。
 * 由使用者看過確認後再用 update_task 修改。
 *
 * 為什麼需要：同步時的關鍵字規則很粗——標題沒有「前端／後端／串接」一律當 frontend、出現 issue/問題就算 bug。
 * 實測 60 張任務，Jev 以 ≥0.95 信心判出的不一致，抽看多是現有標記錯了（例：「點選複製後發文無法發出」標成 feature）。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { compactJson, fitListToLimit } from '../helpers.js';
import { classifyWithJev, type JevNamedQuestion } from '../../utils/typesafe.js';
import { readOmniJevApiKey } from '../../jev/omni-key.js';

const DEV_LABELS = new Set(['frontend', 'backend', 'fullstack']);
const DESCRIPTION_EXCERPT = 300;

const QUESTIONS: JevNamedQuestion[] = [
  {
    key: 'kind',
    q: {
      type: 'choice',
      instructions: '這張專案管理任務（來自 Asana，台灣軟體外包案）是在做什麼？',
      options: {
        bug: '修正既有功能的錯誤：畫面或資料不正確、按了沒反應、存不進去、查詢失效、報錯、測試回報的問題、與規格不符要修正',
        feature: '開發新的功能或畫面：新作業、新報表、新 API、前端頁面切版、串接、依規格實作尚未存在的東西',
        refactor: '不改行為的程式整理：重構、搬移、拆分共用元件、效能調整',
        other: '都不是：會議、文件、環境設定、部署、純討論',
      },
    },
  },
  {
    key: 'side',
    q: {
      type: 'choice',
      instructions: '這張任務主要要改哪一邊的程式？',
      options: {
        frontend: '前端：畫面、頁面切版、表單、按鈕、前端呼叫 API（串接）',
        backend: '後端：API 實作、SQL／資料庫、報表查詢與匯出、批次、伺服器邏輯',
        fullstack: '前後端都要改',
        other: '都不是，或看不出來',
      },
    },
  },
];

export interface ClassificationToolDeps {
  getApiKey?: () => string;
  fetchImpl?: typeof fetch;
}

interface TaskRow { id: string; title: string; parent_name: string | null; description: string | null; label: string; task_type: string; status: string }

export function registerClassificationTools(server: McpServer, deps: ClassificationToolDeps = {}): void {
  const getApiKey = deps.getApiKey ?? readOmniJevApiKey;

  server.tool(
    'review_task_classification',
    '用 Jev 檢查專案任務的類型（bug/feature/refactor）與角色（frontend/backend/fullstack），只列出「Jev 有把握、且與現在分類不同」的建議。**唯讀、不改任何資料**：類型與角色會影響派工軌道、workspace 與驗收清單，必須把清單給使用者確認後，才用 update_task 修改。任務標題與描述摘要會送到第三方 TypeSafe。',
    {
      projectId: z.string().describe('專案 ID'),
      statuses: z.array(z.enum(['pending', 'in_progress', 'completed', 'failed'])).optional().describe('要檢查的任務狀態（預設 pending、in_progress）'),
      limit: z.number().int().min(1).max(200).optional().describe('最多檢查幾張（預設 100，依最近更新排序）'),
      minConfidence: z.number().min(0).max(1).optional().describe('Jev 信心度至少多少才列為建議（預設 0.8）'),
    },
    { title: 'Review Task Classification', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ projectId, statuses, limit, minConfidence }) => {
      const apiKey = getApiKey();
      if (!apiKey) {
        return { content: [{ type: 'text' as const, text: 'Error: 沒有 TypeSafe API key。到 OmniCommander Web 的 Global Settings →「TypeSafe API Key（Jev）」設定，或設環境變數 TYPESAFE_API_KEY。' }], isError: true };
      }
      const db = getMcpDb();
      const wanted = statuses && statuses.length > 0 ? statuses : ['pending', 'in_progress'];
      const rows = db.prepare(`
        SELECT id, title, parent_name, description, label, task_type, status FROM tasks
        WHERE project_id = ? AND status IN (${wanted.map(() => '?').join(',')})
        ORDER BY updated_at DESC, rowid DESC LIMIT ?
      `).all(projectId, ...wanted, limit ?? 100) as TaskRow[];
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: compactJson({ checked: 0, suggestions: [], note: '沒有符合條件的任務。' }) }] };
      }

      const min = minConfidence ?? 0.8;
      const out = await classifyWithJev({
        apiKey, question: QUESTIONS[0]!.q, questions: QUESTIONS, fetchImpl: deps.fetchImpl,
        items: rows.map(r => ({
          id: r.id,
          text: [r.parent_name, r.title, (r.description ?? '').slice(0, DESCRIPTION_EXCERPT)].filter(Boolean).join(' / '),
        })),
      });

      const byId = new Map(rows.map(r => [r.id, r]));
      const suggestions: Array<Record<string, unknown>> = [];
      let failed = 0;
      for (const res of out.results) {
        if (res.error || !res.answers) { failed++; continue; }
        const row = byId.get(res.id)!;
        const s: Record<string, unknown> = {};
        const kind = res.answers['kind'];
        if (kind?.answer && kind.answer !== 'other' && kind.answer !== row.task_type && (kind.confidence ?? 0) >= min) {
          s.taskType = { current: row.task_type, suggested: kind.answer, confidence: kind.confidence };
        }
        const side = res.answers['side'];
        if (DEV_LABELS.has(row.label) && side?.answer && side.answer !== 'other' && side.answer !== row.label && (side.confidence ?? 0) >= min) {
          s.label = { current: row.label, suggested: side.answer, confidence: side.confidence };
        }
        if (Object.keys(s).length > 0) {
          suggestions.push({ taskId: row.id, title: row.title, status: row.status, ...s });
        }
      }

      const render = (shown: Array<Record<string, unknown>>) => compactJson({
        checked: rows.length, failed, minConfidence: min,
        suggestionCount: suggestions.length,
        note: '僅供參考，資料未做任何修改。請把清單給使用者確認；同意的才用 update_task(taskId, taskType/label) 修改——類型與角色會影響派工軌道（bug＋無規格走 light 軌）、workspace 與驗收清單。',
        ...(shown.length < suggestions.length ? { truncated: `只列前 ${shown.length}/${suggestions.length} 筆` } : {}),
        suggestions: shown,
      });
      const { text } = fitListToLimit(suggestions, render);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
