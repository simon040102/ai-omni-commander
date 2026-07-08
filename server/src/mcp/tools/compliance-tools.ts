/**
 * MCP tools for the 規格回對 (Spec Compliance) workflow.
 * save_spec_checklist, get_spec_checklist, waive_checklist_item,
 * run_spec_compliance（程式預檢）, get_compliance_review_plan, save_compliance_review（AI 回對）
 *
 * 「理解規格」與「回對程式碼」分離：subagent 讀完 SA/SD 立即抽出結構化
 * checklist（save_spec_checklist，一次、存 DB、可人工審）。任務完成時分兩步：
 * 1. run_spec_compliance — 純程式（substring/正則，零 LLM）快速預檢，抓文字/
 *    路徑錯字（advisory，source='engine'，不解鎖完成閘門）
 * 2. AI 回對 — orchestrator 用 get_compliance_review_plan 取得派工計畫，派
 *    「獨立的 AI 審查 agent」（不是寫 code 的 implementer）讀規格原文 +
 *    checklist + 實際程式碼逐項判定，save_compliance_review 寫回
 *    （source='ai_review'）。update_task_status(completed) 只認最新一次
 *    ai_review run 的 missing=0。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { ensureMcpAgent, parseJson, truncateResponse } from '../helpers.js';
import { getFlowState } from '../flow-gate.js';
import {
  runComplianceEngine,
  type EngineItem, type ChecklistItemType, type ChecklistSide, type ItemResult, type WorkspaceRoots,
} from '../compliance-engine.js';

export const CHECKLIST_ITEM_TYPES = ['ui_text', 'api', 'param', 'response_field', 'db_field', 'logic'] as const;
export const CHECKLIST_SIDES = ['frontend', 'backend', 'both'] as const;
const MAX_ITEMS_PER_SAVE = 200;

export interface ChecklistRow {
  id: string;
  task_id: string;
  project_id: string;
  item_type: ChecklistItemType;
  content: string;
  side: ChecklistSide | null;
  detail_json: string | null;
  source_ref: string | null;
  waived: number;
  waive_reason: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  task_id: string;
  run_at: string;
  total: number;
  matched: number;
  missing: number;
  manual: number;
  waived: number;
  results_json: string;
  source: string;
}

const MAX_REVIEW_RESULTS = 500;

function rowToItem(r: ChecklistRow): Record<string, unknown> {
  return {
    id: r.id,
    itemType: r.item_type,
    content: r.content,
    side: r.side ?? 'both',
    detail: parseJson<Record<string, unknown> | null>(r.detail_json, null),
    sourceRef: r.source_ref,
    waived: r.waived === 1,
    waiveReason: r.waive_reason,
    createdAt: r.created_at,
  };
}

function getLatestRun(db: ReturnType<typeof getMcpDb>, taskId: string): RunRow | undefined {
  return db.prepare(
    'SELECT * FROM spec_compliance_runs WHERE task_id = ? ORDER BY run_at DESC, rowid DESC LIMIT 1'
  ).get(taskId) as RunRow | undefined;
}

export function registerComplianceTools(server: McpServer): void {

  // ── save_spec_checklist ───────────────────────────────────
  server.tool(
    'save_spec_checklist',
    '儲存規格檢查表（規格回對的輸入）。**讀完 SA/SD 規格後立即抽取：每一個欄位名/按鈕文字/訊息文字/API/DB 欄位都是一項，content 必須從規格逐字抄**（不可翻譯或改寫）。任務完成時先用 run_spec_compliance 做程式預檢，再由獨立 AI 回對 agent（get_compliance_review_plan → save_compliance_review）逐項驗證，最新 AI 回對的 missing 不為 0 無法標 completed。itemType 對應：ui_text=規格逐字文字（按鈕/標題/訊息）；api=路徑（如 "POST /api/wa05/save"）；param/response_field/db_field=識別字；logic=規則描述（程式預檢不比對，由 AI 回對驗證）。',
    {
      taskId: z.string().describe('任務 ID'),
      items: z.array(z.object({
        itemType: z.enum(CHECKLIST_ITEM_TYPES).describe('項目類型：ui_text=規格逐字文字 / api=API 路徑（如 "POST /api/wa05/save"）/ param=請求參數識別字 / response_field=回應欄位識別字 / db_field=DB 欄位識別字 / logic=邏輯規則描述'),
        content: z.string().min(1).describe('比對內容：ui_text 從規格逐字抄；api 為 "METHOD /path" 或 "/path"；param/response_field/db_field 為識別字；logic 為規則描述'),
        side: z.enum(CHECKLIST_SIDES).optional().describe('比對哪一側 workspace（預設 both）'),
        sourceRef: z.string().optional().describe('規格出處（規格檔名+章節，如 "SPEC_WA05.docx §3.2"）'),
        detail: z.record(z.string(), z.unknown()).optional().describe('補充資訊（自由物件，如 api 的 { "method": "POST" }）'),
      })).min(1).max(MAX_ITEMS_PER_SAVE).describe(`檢查表項目（一次最多 ${MAX_ITEMS_PER_SAVE} 項）`),
      replace: z.boolean().optional().describe('true=先刪除此任務既有的未豁免項目再插入（waived 項目保留）；預設 false=append'),
    },
    { title: 'Save Spec Checklist', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, items, replace }) => {
      const db = getMcpDb();
      // zod 已限制上限，這裡再防呆一次（涵蓋不經 zod 的呼叫路徑）
      if (items.length > MAX_ITEMS_PER_SAVE) {
        return { content: [{ type: 'text' as const, text: `Error: 一次最多 ${MAX_ITEMS_PER_SAVE} 項（收到 ${items.length}）。分批呼叫 save_spec_checklist。` }], isError: true };
      }
      const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const insert = db.prepare(`
        INSERT INTO spec_checklist_items (id, task_id, project_id, item_type, content, side, detail_json, source_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let removed = 0;
      db.transaction(() => {
        if (replace) {
          removed = db.prepare('DELETE FROM spec_checklist_items WHERE task_id = ? AND waived = 0').run(taskId).changes;
        }
        for (const item of items) {
          insert.run(
            randomUUID(), taskId, task.project_id,
            item.itemType, item.content, item.side ?? 'both',
            item.detail ? JSON.stringify(item.detail) : null,
            item.sourceRef ?? null,
          );
        }
      })();

      const total = (db.prepare('SELECT COUNT(*) as c FROM spec_checklist_items WHERE task_id = ?').get(taskId) as { c: number }).c;
      const notifyOk = await notifyWebServer({
        event: 'task.checklistSaved',
        data: { taskId, projectId: task.project_id, count: items.length, total, action: 'saved' },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      const replaceNote = replace ? `（replace：移除 ${removed} 筆未豁免舊項目，waived 項目保留）` : '';
      return {
        content: [{
          type: 'text' as const,
          text: `Spec checklist saved：+${items.length} 項${replaceNote}，此任務目前共 ${total} 項${warning}。實作完成後先呼叫 run_spec_compliance(taskId="${taskId}") 做程式預檢，再由 orchestrator 派獨立 AI 回對 agent（get_compliance_review_plan → save_compliance_review）。`,
        }],
      };
    },
  );

  // ── get_spec_checklist ────────────────────────────────────
  server.tool(
    'get_spec_checklist',
    '取得任務的規格檢查表（含 waived 項目）與最新一次 run_spec_compliance 的比對摘要（無 run 則為 null）。**檢查表可能很大，回應分頁：用 limit/offset 逐頁取，直到 hasMore=false 才算看完全部項目**（AI 規格回對必須看過每一項，含 logic 類）。',
    {
      taskId: z.string().describe('任務 ID'),
      limit: z.number().int().positive().max(200).optional().describe('每頁最多幾項（預設 50、上限 200）'),
      offset: z.number().int().min(0).optional().describe('略過項數，用於分頁（預設 0）'),
    },
    { title: 'Get Spec Checklist', readOnlyHint: true, openWorldHint: false },
    async ({ taskId, limit, offset }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId) as { id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const effLimit = limit ?? 50;
      const effOffset = offset ?? 0;

      const total = (db.prepare('SELECT COUNT(*) as c FROM spec_checklist_items WHERE task_id = ?').get(taskId) as { c: number }).c;
      const rows = db.prepare('SELECT * FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?')
        .all(taskId, effLimit, effOffset) as ChecklistRow[];
      const run = getLatestRun(db, taskId);
      const hasMore = effOffset + rows.length < total;

      const text = JSON.stringify({
        taskId,
        total,
        count: rows.length,
        offset: effOffset,
        hasMore,
        items: rows.map(rowToItem),
        latestRun: run ? {
          id: run.id,
          runAt: run.run_at,
          source: run.source,
          total: run.total,
          matched: run.matched,
          missing: run.missing,
          manual: run.manual,
          waived: run.waived,
        } : null,
      }, null, 2);

      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(text, `檢查表共 ${total} 項，本頁 offset=${effOffset}、count=${rows.length}${hasMore ? '、hasMore=true → 用 offset 續取下一頁' : ''}。若單頁仍被截斷，改用更小的 limit 重取。`),
        }],
      };
    },
  );

  // ── waive_checklist_item ──────────────────────────────────
  server.tool(
    'waive_checklist_item',
    '豁免一項規格檢查表項目（不再計入 run_spec_compliance 的 missing）。**必須附理由**（例如「規格此欄位屬 Phase 2，本次不實作——使用者已確認」）。豁免會記入任務輸出紀錄供人工稽核。',
    {
      itemId: z.string().describe('檢查表項目 ID（save_spec_checklist / get_spec_checklist 回傳的 id）'),
      reason: z.string().min(1).describe('豁免理由（必填，會記入任務輸出紀錄）'),
    },
    { title: 'Waive Checklist Item', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ itemId, reason }) => {
      const db = getMcpDb();
      if (!reason.trim()) {
        return { content: [{ type: 'text' as const, text: 'Error: 豁免理由（reason）不可為空白。' }], isError: true };
      }
      const item = db.prepare('SELECT * FROM spec_checklist_items WHERE id = ?').get(itemId) as ChecklistRow | undefined;
      if (!item) {
        return { content: [{ type: 'text' as const, text: `Error: Checklist item "${itemId}" not found. 用 get_spec_checklist(taskId) 確認 itemId。` }], isError: true };
      }
      if (item.waived === 1) {
        return { content: [{ type: 'text' as const, text: `Checklist item ${itemId} is already waived（理由：${item.waive_reason || '(無)'}).` }] };
      }

      db.prepare('UPDATE spec_checklist_items SET waived = 1, waive_reason = ? WHERE id = ?').run(reason.trim(), itemId);

      // 記入任務輸出紀錄（同 report_output 通道）供人工稽核
      const { agentId, created, role, title } = ensureMcpAgent(db, item.task_id, item.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: item.project_id, taskId: item.task_id, role, title, model: 'external (MCP)' },
        });
      }
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, item.task_id, `[WAIVE] ${item.content}: ${reason.trim()}`);

      const notifyOk = await notifyWebServer({
        event: 'task.checklistSaved',
        data: { taskId: item.task_id, projectId: item.project_id, itemId, action: 'waived' },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return {
        content: [{
          type: 'text' as const,
          text: `Checklist item waived（${item.content}）${warning}。若已有 AI 回對結果，需重新 AI 回對（get_compliance_review_plan → save_compliance_review）更新結果；程式預檢可重跑 run_spec_compliance(taskId="${item.task_id}")。`,
        }],
      };
    },
  );

  // ── run_spec_compliance ───────────────────────────────────
  server.tool(
    'run_spec_compliance',
    '快速程式預檢（advisory）：用**純程式**（substring/正則，零 LLM）逐項比對規格檢查表與 workspace 程式碼，抓文字/路徑錯字。**不能取代 AI 回對、不解鎖完成閘門**——完成閘門只認獨立 AI 回對（get_compliance_review_plan → save_compliance_review）的結果。比對規則：ui_text=exact substring；api=path 佔位正規化（{x} / :x / ${x} 等價）+ method ±3 行檢查；param/response_field/db_field=word-boundary 識別字；logic=一律 manual（不計 missing）。',
    {
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Run Spec Compliance', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, project_id, label FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; label: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const rows = db.prepare('SELECT * FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(taskId) as ChecklistRow[];
      if (rows.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `此任務沒有規格檢查表——先用 save_spec_checklist(taskId="${taskId}", items=[...]) 從 SA/SD 規格抽取（content 逐字抄）。無 checklist 的任務不受完成閘門影響。`,
          }],
        };
      }

      const project = db.prepare('SELECT frontend_path, backend_path FROM projects WHERE id = ?').get(task.project_id) as
        { frontend_path: string | null; backend_path: string | null } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${task.project_id}" not found` }], isError: true };
      }

      // task.label 決定掃哪些 workspace：frontend → frontendPath；backend → backendPath；其他（fullstack 等）→ 兩者
      const roots: WorkspaceRoots = {};
      if (task.label === 'frontend') {
        if (project.frontend_path) roots.frontend = project.frontend_path;
      } else if (task.label === 'backend') {
        if (project.backend_path) roots.backend = project.backend_path;
      } else {
        if (project.frontend_path) roots.frontend = project.frontend_path;
        if (project.backend_path) roots.backend = project.backend_path;
      }

      if (!roots.frontend && !roots.backend) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 專案沒有可掃描的 workspace 路徑（label=${task.label}，frontendPath=${project.frontend_path || 'N/A'}，backendPath=${project.backend_path || 'N/A'}）。用 update_project 設定 workspace 路徑。`,
          }],
          isError: true,
        };
      }
      for (const [side, root] of Object.entries(roots)) {
        if (!fs.existsSync(root)) {
          return { content: [{ type: 'text' as const, text: `Error: workspace 路徑不存在：${side}=${root}。確認專案設定的路徑正確。` }], isError: true };
        }
      }

      const engineItems: EngineItem[] = rows.map(r => ({
        id: r.id,
        itemType: r.item_type,
        content: r.content,
        side: r.side ?? 'both',
        detail: parseJson<Record<string, unknown> | null>(r.detail_json, null),
        waived: r.waived === 1,
      }));

      const result = runComplianceEngine(engineItems, roots);
      const { summary } = result;

      // 寫入 run 記錄（source='engine'：程式預檢，不解鎖完成閘門）
      const runId = randomUUID();
      db.prepare(`
        INSERT INTO spec_compliance_runs (id, task_id, total, matched, missing, manual, waived, results_json, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'engine')
      `).run(runId, taskId, summary.total, summary.matched, summary.missing, summary.manual, summary.waived, JSON.stringify(result.items));

      // agent_outputs（同 report_output 通道）
      const { agentId, created, role, title } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: task.project_id, taskId, role, title, model: 'external (MCP)' },
        });
      }
      const outputLine = `[SPEC_COMPLIANCE] ${summary.matched}/${summary.autoTotal} 符合（missing ${summary.missing}）`;
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, taskId, outputLine);

      const notifyOk = await notifyWebServer({
        event: 'task.milestone',
        data: { taskId, projectId: task.project_id, milestone: `規格回對：${summary.matched}/${summary.autoTotal}`, details: outputLine },
      });
      // 讓開著的 SpecCompliance 面板 refetch（best-effort）
      notifyWebServer({
        event: 'task.checklistSaved',
        data: { taskId, projectId: task.project_id, runId, action: 'run' },
      }).catch(() => {});

      // 回傳：missing 排最前面完整列出
      const order: Record<string, number> = { missing: 0, manual: 1, matched: 2, waived: 3 };
      const sortedItems = [...result.items].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

      // Phase 3：runtimeCheckPlan — 已在程式碼確認的 ui_text，建議用 Playwright 實測渲染
      const matchedUiTexts = result.items
        .filter((r: ItemResult) => r.itemType === 'ui_text' && r.status === 'matched')
        .map((r: ItemResult) => r.content);
      const runtimeCheckPlan = matchedUiTexts.length > 0 ? {
        instruction: '以下欄位/文字已在程式碼中確認，建議用 Playwright MCP 開啟頁面確認實際有渲染，截圖用 report_verification_evidence(taskId, filePath) 上傳。',
        uiTexts: matchedUiTexts,
      } : null;

      const nextStep = `【注意】本結果為快速程式預檢（advisory），**不能取代 AI 回對、不解鎖完成閘門**。下一步：由 orchestrator 呼叫 get_compliance_review_plan(taskId="${taskId}") 派獨立 AI 回對 agent 逐項驗證（save_compliance_review 寫回），最新 AI 回對 missing=0 才可標 completed。`;
      const verdict = summary.missing === 0
        ? `✅ 程式預檢 missing=0。${nextStep}`
        : `❌ 程式預檢發現 ${summary.missing} 項 missing——先修正後重跑 run_spec_compliance(taskId="${taskId}")，或對有正當理由的項目用 waive_checklist_item(itemId, reason) 豁免。${nextStep}`;

      const notifyWarning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(JSON.stringify({
            runId,
            taskId,
            summary,
            verdict: verdict + notifyWarning,
            items: sortedItems,
            runtimeCheckPlan,
          }, null, 2), 'items 過多——用 get_spec_checklist(taskId) 查看完整清單。'),
        }],
      };
    },
  );

  // ── get_compliance_review_plan ────────────────────────────
  server.tool(
    'get_compliance_review_plan',
    '取得「AI 規格回對」的派工計畫（給 orchestrator）。回傳一份完整 prompt：由 orchestrator 派**獨立的 AI 審查 subagent**（絕不可由寫 code 的 implementer 自評）讀 SA/SD 規格原文 + get_spec_checklist 檢查表 + 實際程式碼，逐項判定 matched/missing（必附 file+line 證據），最後用 save_compliance_review 一次寫回。完成閘門只認此 AI 回對結果（最新 ai_review run 的 missing=0）。light 軌任務（get_execution_plan 判軌）驗證對象改為原始 BUG 內容（任務描述 + Asana 留言 + 附件），標準不變。',
    {
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Get Compliance Review Plan', readOnlyHint: true, openWorldHint: false },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, project_id, title, description, label FROM tasks WHERE id = ?').get(taskId) as
        { id: string; project_id: string; title: string; description: string | null; label: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // 任務軌道（get_execution_plan 判軌後寫入 flow_state；無值 = full 向後相容）
      const track = getFlowState(db, taskId)?.track === 'light' ? 'light' : 'full';

      const items = db.prepare('SELECT * FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(taskId) as ChecklistRow[];
      const activeItems = items.filter(i => i.waived === 0);
      if (activeItems.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `此任務沒有未豁免的規格檢查表項目——AI 回對沒有可驗證的對象。先用 save_spec_checklist(taskId="${taskId}", items=[...]) 從 SA/SD 規格抽取檢查表（content 逐字抄），再呼叫 get_compliance_review_plan。`,
          }],
        };
      }

      const project = db.prepare('SELECT id, name, frontend_path, backend_path FROM projects WHERE id = ?').get(task.project_id) as
        { id: string; name: string; frontend_path: string | null; backend_path: string | null } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${task.project_id}" not found` }], isError: true };
      }

      // 依 task.label 決定 reviewer 的 workspace（同 run_spec_compliance 的規則）
      const workspaces: string[] = [];
      if (task.label === 'frontend') {
        if (project.frontend_path) workspaces.push(`frontend: ${project.frontend_path}`);
      } else if (task.label === 'backend') {
        if (project.backend_path) workspaces.push(`backend: ${project.backend_path}`);
      } else {
        if (project.frontend_path) workspaces.push(`frontend: ${project.frontend_path}`);
        if (project.backend_path) workspaces.push(`backend: ${project.backend_path}`);
      }
      if (workspaces.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 專案沒有可審查的 workspace 路徑（label=${task.label}，frontendPath=${project.frontend_path || 'N/A'}，backendPath=${project.backend_path || 'N/A'}）。用 update_project 設定 workspace 路徑。`,
          }],
          isError: true,
        };
      }

      // 規格文件路徑（同 get_task includeDocuments：task 綁定優先，沒有則退回專案層）
      const taskDocs = db.prepare(`
        SELECT d.filename, d.file_path, d.doc_type
        FROM task_documents td JOIN documents d ON d.id = td.document_id
        WHERE td.task_id = ?
      `).all(taskId) as Array<{ filename: string; file_path: string; doc_type: string | null }>;
      const docs = taskDocs.length > 0
        ? taskDocs
        : db.prepare('SELECT filename, file_path, doc_type FROM documents WHERE project_id = ?')
            .all(task.project_id) as Array<{ filename: string; file_path: string; doc_type: string | null }>;
      const docLines = docs.length > 0
        ? docs.map(d => `- [${d.doc_type || 'other'}] ${d.filename} — ${d.file_path}`).join('\n')
        : '- （DB 中沒有綁定的規格文件——用 get_documents / fetch_svn_specs 先取得規格，或請 orchestrator 提供路徑）';

      const waivedNote = items.length - activeItems.length > 0
        ? `（另有 ${items.length - activeItems.length} 項已豁免，不需驗證）`
        : '';

      // 兩軌共用：orchestrator 派工指示 + 判定標準/寫回/禁令（證據要求、涵蓋要求、寧嚴勿鬆照舊）
      const orchestratorNote = `> **給 orchestrator 的指示：**
> 1. 用 Agent tool 派出**一個獨立的 AI 回對 subagent**，cwd 設為上列 workspace 路徑（both 時擇一，prompt 中附上兩個路徑）
> 2. **絕不可由寫 code 的 implementer 自評**——reviewer 必須是全新 context 的獨立 agent，沒看過 implementer 的任何回報
> 3. 將以下 prompt 原封不動作為 subagent 任務傳入
> 4. subagent 完成後檢查 save_compliance_review 的結果：missing=0 才可繼續結案流程；missing>0 → 把 missing 清單交回 implementer 修正，修正後**重新派 AI 回對**`;

      const commonTail = `4. **判定標準（寧嚴勿鬆）**：每項判 matched 或 missing——
   - matched **必須附 evidence**（file + line，workspace 相對路徑）與一句說明（note）
   - 找不到、不確定、規格與程式碼有出入 → 一律 missing，可用 note 說明疑點
5. **一次寫回**：全部判完後呼叫 save_compliance_review(taskId="${taskId}", results=[{itemId, status, evidence: [{file, line}], note}, ...])，**必須涵蓋所有未豁免項目**。
6. **嚴禁**只看 implementer 的回報、verification report、commit message 或任何摘要就下判定——**必須自己用 Read/Grep 開檔案核對**。

## 絕對禁止
- 不得修改任何程式碼或檔案（只讀）
- 不得呼叫 update_task_status——結案由 orchestrator 決定`;

      const plan = track === 'light'
        ? `**AI 規格回對派工計畫（Compliance Review Plan — LIGHT 軌）**
**Task:** ${task.title}（taskId=${taskId}, label=${task.label}）
**Project:** ${project.name}
**Workspace:**
${workspaces.map(w => `- ${w}`).join('\n')}
**驗證對象（light 軌）：原始 BUG 內容**
- 任務標題：${task.title}
- 任務描述：
${task.description?.trim() || '（無任務描述——BUG 現場以 Asana 留言與附件為準）'}
**檢查表：** ${activeItems.length} 項未豁免項目待逐項驗證${waivedNote}

${orchestratorNote}

---

你是獨立的規格審查員（reviewer）。本任務為 **light 軌**（無 SA/SD 規格文件）——驗證基準是**原始 BUG 內容**。你的任務：**逐項回對規格檢查表（從 BUG 原文抽出的「修復後預期行為」）與實際程式碼，判定每個預期行為是否已確實達成**。你不是來寫 code 的，只讀不改。

## 審查流程（強制，依序執行）

1. **取得完整 BUG 現場**：上列任務標題/描述是起點；呼叫 get_asana_task_comments(taskId="${taskId}") 讀回報討論串、fetch_task_attachments(projectId="${task.project_id}", taskId="${taskId}") 取附件截圖並用 Read tool 看圖。**BUG 原文是你判定的唯一依據，不是任何人的轉述。**
2. **取得檢查表（必須看完全部）**：呼叫 get_spec_checklist(taskId="${taskId}", limit=50, offset=0) 取得項目（含 itemId）。**檢查表可能很大且會分頁**——回應裡 hasMore=true 就用遞增的 offset（0、50、100…）繼續呼叫，直到 hasMore=false，把每一頁的項目都收集齊。**save_compliance_review 必須涵蓋所有非 waived 項目（含 logic 類），漏收任何一頁就會被退回。**
3. **逐項在實際程式碼中驗證**（一項都不可跳過）：
   - **logic（修復後預期行為）→ 讀實際的程式碼修改（diff / 相關檔案），追完整程式碼流程確認該行為真的達成，不可只憑檔名、函式名或 implementer 的說法猜。環境允許時用 Playwright 實測頁面行為更好（非必要）**
   - ui_text → 在程式碼中找到該文字的**渲染處**（不是只出現在註解/測試），確認與 BUG 原文要求逐字一致
   - api / param / response_field / db_field → 同 full 軌標準：確認確實串接/存在，不是只出現字串
${commonTail}`
        : `**AI 規格回對派工計畫（Compliance Review Plan）**
**Task:** ${task.title}（taskId=${taskId}, label=${task.label}）
**Project:** ${project.name}
**Workspace:**
${workspaces.map(w => `- ${w}`).join('\n')}
**規格文件：**
${docLines}
**檢查表：** ${activeItems.length} 項未豁免項目待逐項驗證${waivedNote}

${orchestratorNote}

---

你是獨立的規格審查員（reviewer）。你的任務：**逐項回對規格檢查表與實際程式碼，判定每一項是否已確實實作**。你不是來寫 code 的，只讀不改。

## 審查流程（強制，依序執行）

1. **讀規格原文**：用 Read tool 完整讀取上列規格文件（SA/SD）。這是你判定的唯一依據，不是任何人的轉述。
2. **取得檢查表（必須看完全部）**：呼叫 get_spec_checklist(taskId="${taskId}", limit=50, offset=0) 取得項目（含 itemId）。**檢查表可能很大且會分頁**——回應裡 hasMore=true 就用遞增的 offset（0、50、100…）繼續呼叫，直到 hasMore=false，把每一頁的項目都收集齊。**save_compliance_review 必須涵蓋所有非 waived 項目（含 logic 類），漏收任何一頁就會被退回。**
3. **逐項在實際程式碼中驗證**（一項都不可跳過）：
   - ui_text → 在程式碼中找到該文字的**渲染處**（不是只出現在註解/測試），確認與規格逐字一致
   - api → 確認 path、method、參數確實**串接**（前端有呼叫、後端有 handler），不是只出現字串
   - param / response_field → 確認參數/欄位確實進出該 API 的 request/response
   - db_field → 確認 Entity（@Column name）/ DDL 中確實存在該欄位
   - **logic → 追實際程式碼流程（Controller → Service → SQL / 元件 → handler → API），確認邏輯與規格描述一致。這是 AI 回對的核心價值，不可跳過、不可只憑檔名或函式名猜**
${commonTail}`;

      return { content: [{ type: 'text' as const, text: truncateResponse(plan) }] };
    },
  );

  // ── save_compliance_review ────────────────────────────────
  server.tool(
    'save_compliance_review',
    '寫回「AI 規格回對」結果（由獨立 AI 審查 agent 呼叫，見 get_compliance_review_plan）。results 必須涵蓋該任務**所有未豁免**的檢查表項目（缺項會被拒）；matched 項目必附 evidence（file+line）。寫入後成為完成閘門的依據：最新 ai_review run 的 missing=0 才可標 completed。',
    {
      taskId: z.string().describe('任務 ID'),
      results: z.array(z.object({
        itemId: z.string().describe('檢查表項目 ID（get_spec_checklist 回傳的 id）'),
        status: z.enum(['matched', 'missing']).describe('判定結果：matched=已確實實作（必附 evidence）/ missing=找不到或不確定（寧嚴勿鬆）'),
        evidence: z.array(z.object({
          file: z.string().describe('workspace 相對路徑'),
          line: z.number().int().describe('行號'),
        })).optional().describe('證據（matched 必填至少一筆）'),
        note: z.string().optional().describe('一句說明（matched 建議附；missing 可說明疑點）'),
      })).min(1).max(MAX_REVIEW_RESULTS).describe(`逐項判定結果（一次最多 ${MAX_REVIEW_RESULTS} 項）`),
    },
    { title: 'Save Compliance Review', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, results }) => {
      const db = getMcpDb();
      // zod 已限制上限，這裡再防呆一次（涵蓋不經 zod 的呼叫路徑）
      if (results.length > MAX_REVIEW_RESULTS) {
        return { content: [{ type: 'text' as const, text: `Error: 一次最多 ${MAX_REVIEW_RESULTS} 項（收到 ${results.length}）。` }], isError: true };
      }
      const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const rows = db.prepare('SELECT * FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(taskId) as ChecklistRow[];
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: `Error: 此任務沒有規格檢查表——先用 save_spec_checklist(taskId="${taskId}", items=[...]) 抽取，再做 AI 回對。` }], isError: true };
      }
      const rowById = new Map(rows.map(r => [r.id, r]));

      // 所有 itemId 必須屬於該 task
      const unknownIds = results.filter(r => !rowById.has(r.itemId)).map(r => r.itemId);
      if (unknownIds.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 以下 itemId 不屬於任務 ${taskId} 的檢查表：${unknownIds.slice(0, 20).join(', ')}${unknownIds.length > 20 ? ` …（共 ${unknownIds.length} 個）` : ''}。用 get_spec_checklist(taskId="${taskId}") 取得正確的 itemId。`,
          }],
          isError: true,
        };
      }

      // 同一 itemId 不可重複判定（避免涵蓋檢查被灌水）
      const seen = new Set<string>();
      const dupIds = results.filter(r => (seen.has(r.itemId) ? true : (seen.add(r.itemId), false))).map(r => r.itemId);
      if (dupIds.length > 0) {
        return { content: [{ type: 'text' as const, text: `Error: results 中有重複的 itemId：${[...new Set(dupIds)].slice(0, 20).join(', ')}。每個項目只能判定一次。` }], isError: true };
      }

      // 必須涵蓋所有未豁免項目（防 reviewer 偷懶只驗一部分）
      const resultIds = new Set(results.map(r => r.itemId));
      const uncovered = rows.filter(r => r.waived === 0 && !resultIds.has(r.id));
      if (uncovered.length > 0) {
        const lines = uncovered.slice(0, 20).map(r => `- ${r.id}: [${r.item_type}] ${r.content}`);
        const more = uncovered.length > 20 ? `\n（其餘 ${uncovered.length - 20} 項略）` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Error: AI 回對必須涵蓋所有未豁免的檢查表項目，以下 ${uncovered.length} 項未判定：
${lines.join('\n')}${more}

逐項驗證後重新呼叫 save_compliance_review（一次包含全部項目）。`,
          }],
          isError: true,
        };
      }

      // matched 必附 evidence
      const noEvidence = results.filter(r => r.status === 'matched' && (!r.evidence || r.evidence.length === 0));
      if (noEvidence.length > 0) {
        const lines = noEvidence.slice(0, 20).map(r => `- ${r.itemId}: ${rowById.get(r.itemId)?.content ?? ''}`);
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 以下 ${noEvidence.length} 項判定 matched 但沒有 evidence（file + line）——matched 必須附上程式碼證據：
${lines.join('\n')}${noEvidence.length > 20 ? `\n（其餘 ${noEvidence.length - 20} 項略）` : ''}

補上證據後重新呼叫；找不到證據就判 missing（寧嚴勿鬆）。`,
          }],
          isError: true,
        };
      }

      // 組 results_json（同引擎的 ItemResult 形狀；waived 項目照表補 status='waived'）
      const reviewItems: ItemResult[] = [];
      let matched = 0;
      let missing = 0;
      for (const r of results) {
        const row = rowById.get(r.itemId)!;
        if (row.waived === 1) continue; // 已豁免的判定不計入（照表記 waived）
        if (r.status === 'matched') matched++; else missing++;
        reviewItems.push({
          itemId: r.itemId,
          itemType: row.item_type,
          content: row.content,
          status: r.status,
          ...(r.evidence && r.evidence.length > 0 ? { evidence: r.evidence } : {}),
          ...(r.note ? { note: r.note } : {}),
        });
      }
      const waivedRows = rows.filter(r => r.waived === 1);
      for (const r of waivedRows) {
        reviewItems.push({ itemId: r.id, itemType: r.item_type, content: r.content, status: 'waived' });
      }
      const total = reviewItems.length;
      const autoTotal = matched + missing;

      const runId = randomUUID();
      db.prepare(`
        INSERT INTO spec_compliance_runs (id, task_id, total, matched, missing, manual, waived, results_json, source)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'ai_review')
      `).run(runId, taskId, total, matched, missing, waivedRows.length, JSON.stringify(reviewItems));

      // agent_outputs（同 report_output 通道）
      const { agentId, created, role, title } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: task.project_id, taskId, role, title, model: 'external (MCP)' },
        });
      }
      const outputLine = `[SPEC_REVIEW] ${matched}/${autoTotal} 符合（missing ${missing}）`;
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, taskId, outputLine);

      const notifyOk = await notifyWebServer({
        event: 'task.milestone',
        data: { taskId, projectId: task.project_id, milestone: `AI 規格回對：${matched}/${autoTotal}`, details: outputLine },
      });
      // 讓開著的 SpecCompliance 面板 refetch（best-effort）
      notifyWebServer({
        event: 'task.checklistSaved',
        data: { taskId, projectId: task.project_id, runId, action: 'ai_review' },
      }).catch(() => {});

      const notifyWarning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      if (missing > 0) {
        const missingLines = reviewItems.filter(i => i.status === 'missing').slice(0, 20)
          .map(i => `- [${i.itemType}] ${i.content}${i.note ? ` — ${i.note}` : ''}`);
        const more = missing > 20 ? `\n（其餘 ${missing - 20} 項略）` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `AI 規格回對已記錄（runId=${runId}）：${matched}/${autoTotal} 符合，❌ ${missing} 項 missing${notifyWarning}：
${missingLines.join('\n')}${more}

missing 不為 0 時 update_task_status(completed) 會被拒絕。請 implementer 修正後**重新執行 AI 回對**（get_compliance_review_plan → 獨立 reviewer → save_compliance_review），或對有正當理由的項目用 waive_checklist_item(itemId, reason) 豁免後重新回對。`,
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `✅ AI 規格回對通過（runId=${runId}）：${matched}/${autoTotal} 符合，missing=0${notifyWarning}。完成閘門已解鎖，可繼續驗收流程後標記 completed。`,
        }],
      };
    },
  );
}
