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
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { ensureMcpAgent, parseJson, truncateResponse, CHARACTER_LIMIT } from '../helpers.js';
import { getFlowState, getFlowsDir } from '../flow-gate.js';
import {
  runComplianceEngine,
  type EngineItem, type ChecklistItemType, type ChecklistSide, type ItemResult, type WorkspaceRoots,
} from '../compliance-engine.js';
import { validateReviewEvidence, RELEVANCE_WINDOW, type EvidenceCheckInput } from '../evidence-validator.js';
import { listResolvedSpecGaps, buildResolutionLines } from '../../utils/specGapResolution.js';

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

/**
 * P2：ui_text 抽取規範——行為敘述句存成 ui_text 永遠驗不過（程式中不存在該字面文字），
 * 只能事後豁免。三處文案（tool description、ExecutionPipeline 兩軌、review plan 反向掃描）共用同一規則。
 */
export const UI_TEXT_EXTRACTION_RULE =
  '**行為敘述句（「點擊X後…」「當…時…」）與元件動態組字的完整 label 禁止存 ui_text——存 logic**；ui_text 只放程式中應存在的字面文字（按鈕字、標題、訊息、i18n 值）';

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

/** SA 流程圖內嵌上限——超過改附檔案絕對路徑讓 reviewer 用 Read 讀（防 plan 膨脹）。 */
export const SA_FLOW_INLINE_LIMIT = 6000;

/**
 * 讀取文件內容——與 ExecutionPipeline.readDocContent 同構（web/MCP 邊界不互相 import）：
 * parsed_text 為 "[Document saved at: X]" 指標 → 讀 X；為內文 → 直接用；否則讀 file_path。
 */
function readDocContentForFlow(parsedText: string | null, filePath: string): string | null {
  if (parsedText) {
    const mdMatch = parsedText.match(/^\[Document saved at: (.+)\]/);
    if (mdMatch) {
      try { return fs.readFileSync(mdMatch[1]!.trim(), 'utf-8'); } catch { return null; }
    }
    if (!parsedText.startsWith('[') && parsedText.length > 50) return parsedText;
  }
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf-8');
  } catch { /* ignore */ }
  return null;
}

/**
 * 找此任務可用的 SA 操作流程圖（R3 流程回對）——沿用 ExecutionPipeline 的 SA flow
 * cache 查找模式：任務綁定的 SA 文件內容 sha256 前 16 碼 → data/sa-flows/
 * {projectId}-{hash}-flow.mmd。找不到（無 SA 文件 / 未產生過流程圖）→ null。
 */
export function findSaFlowForTask(
  db: ReturnType<typeof getMcpDb>,
  taskId: string,
  projectId: string,
): { mermaid: string; flowPath: string; filename: string } | null {
  const saDocs = db.prepare(`
    SELECT d.filename, d.file_path, d.parsed_text
    FROM task_documents td JOIN documents d ON d.id = td.document_id
    WHERE td.task_id = ? AND d.doc_type = 'SA'
  `).all(taskId) as Array<{ filename: string; file_path: string; parsed_text: string | null }>;
  for (const doc of saDocs) {
    const content = readDocContentForFlow(doc.parsed_text, doc.file_path);
    if (!content) continue;
    const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const flowPath = path.join(getFlowsDir(), `${projectId}-${hash}-flow.mmd`);
    try {
      if (fs.existsSync(flowPath)) {
        return { mermaid: fs.readFileSync(flowPath, 'utf-8'), flowPath, filename: doc.filename };
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function registerComplianceTools(server: McpServer): void {

  // ── save_spec_checklist ───────────────────────────────────
  server.tool(
    'save_spec_checklist',
    `儲存規格檢查表（規格回對的輸入）。**讀完 SA/SD 規格後立即抽取：每一個欄位名/按鈕文字/訊息文字/API/DB 欄位都是一項，content 必須從規格逐字抄**（不可翻譯或改寫）。任務完成時先用 run_spec_compliance 做程式預檢，再由獨立 AI 回對 agent（get_compliance_review_plan → save_compliance_review）逐項驗證，最新 AI 回對的 missing 不為 0 無法標 completed。itemType 對應：ui_text=規格逐字文字（按鈕/標題/訊息）；api=路徑（如 "POST /api/wa05/save"）；param/response_field/db_field=識別字；logic=規則描述（程式預檢不比對，由 AI 回對驗證）。${UI_TEXT_EXTRACTION_RULE}。`,
    {
      taskId: z.string().describe('任務 ID'),
      items: z.array(z.object({
        itemType: z.enum(CHECKLIST_ITEM_TYPES).describe(`項目類型：ui_text=規格逐字文字 / api=API 路徑（如 "POST /api/wa05/save"）/ param=請求參數識別字 / response_field=回應欄位識別字 / db_field=DB 欄位識別字 / logic=邏輯規則描述。${UI_TEXT_EXTRACTION_RULE}`),
        content: z.string().min(1).describe(`比對內容：ui_text 從規格逐字抄；api 為 "METHOD /path" 或 "/path"；param/response_field/db_field 為識別字；logic 為規則描述。${UI_TEXT_EXTRACTION_RULE}`),
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
      // P4：回傳本次新增項目的 id，reviewer 補項後不用再查一次 get_spec_checklist
      const created: Array<{ id: string; itemType: ChecklistItemType; content: string }> = [];
      db.transaction(() => {
        if (replace) {
          removed = db.prepare('DELETE FROM spec_checklist_items WHERE task_id = ? AND waived = 0').run(taskId).changes;
        }
        for (const item of items) {
          const id = randomUUID();
          insert.run(
            id, taskId, task.project_id,
            item.itemType, item.content, item.side ?? 'both',
            item.detail ? JSON.stringify(item.detail) : null,
            item.sourceRef ?? null,
          );
          created.push({ id, itemType: item.itemType, content: item.content });
        }
      })();

      const total = (db.prepare('SELECT COUNT(*) as c FROM spec_checklist_items WHERE task_id = ?').get(taskId) as { c: number }).c;

      // 稽核：已有 AI 回對紀錄後還 replace 整份檢查表 = 高風險操作（可能縮小驗證範圍
      // 再自評）——留 [CHECKLIST_REPLACE] 軌跡供人工檢視。reviewer plan 明文禁止 replace。
      let replaceAudit = '';
      if (replace && removed > 0) {
        const hadAiReview = (db.prepare(
          "SELECT COUNT(*) as c FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review'"
        ).get(taskId) as { c: number }).c > 0;
        if (hadAiReview) {
          const { agentId } = ensureMcpAgent(db, taskId, task.project_id);
          db.prepare(`
            INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
            VALUES (?, ?, 'system', ?)
          `).run(agentId, taskId, `[CHECKLIST_REPLACE] 已有 AI 回對紀錄後整份取代檢查表（移除 ${removed} 筆、新增 ${items.length} 筆）——請人工確認取代的正當性`);
          replaceAudit = '\n⚠ 此任務已有 AI 回對紀錄，整份取代檢查表已記入稽核軌跡（[CHECKLIST_REPLACE]）；新檢查表必須重新完整回對。';
        }
      }

      const notifyOk = await notifyWebServer({
        event: 'task.checklistSaved',
        data: { taskId, projectId: task.project_id, count: items.length, total, action: 'saved' },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      const replaceNote = replace ? `（replace：移除 ${removed} 筆未豁免舊項目，waived 項目保留）` : '';
      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(`Spec checklist saved：+${items.length} 項${replaceNote}，此任務目前共 ${total} 項${warning}。實作完成後先呼叫 run_spec_compliance(taskId="${taskId}") 做程式預檢，再由 orchestrator 派獨立 AI 回對 agent（get_compliance_review_plan → save_compliance_review）。${replaceAudit}

本次新增項目（後續判定/豁免可直接引用這些 id，不需再查 get_spec_checklist）
created:
${JSON.stringify(created, null, 2)}`, '（created 清單被截斷——用 get_spec_checklist(taskId) 取得項目 id）'),
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

      // P3：截斷安全分頁——單頁 JSON 超過 CHARACTER_LIMIT 時逐步對半縮小本頁筆數重組，
      // 保證回應永遠是可解析的完整 JSON；count/hasMore 以實際回傳筆數計算。
      // truncateResponse 保留為最終保險（單一項目本身就超限時才會觸發）。
      const buildPayload = (pageRows: ChecklistRow[], shrunk: boolean): string => {
        const hasMore = effOffset + pageRows.length < total;
        return JSON.stringify({
          taskId,
          total,
          count: pageRows.length,
          offset: effOffset,
          hasMore,
          ...(shrunk ? { note: `本頁因大小自動縮至 ${pageRows.length} 筆（原 limit=${effLimit}），續用 offset=${effOffset + pageRows.length} 取後續` } : {}),
          items: pageRows.map(rowToItem),
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
      };

      let pageRows = rows;
      let shrunk = false;
      let text = buildPayload(pageRows, shrunk);
      while (text.length > CHARACTER_LIMIT && pageRows.length > 1) {
        pageRows = pageRows.slice(0, Math.ceil(pageRows.length / 2));
        shrunk = true;
        text = buildPayload(pageRows, shrunk);
      }

      const finalHasMore = effOffset + pageRows.length < total;
      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(text, `檢查表共 ${total} 項，本頁 offset=${effOffset}、count=${pageRows.length}${finalHasMore ? '、hasMore=true → 用 offset 續取下一頁' : ''}。單一項目過大導致截斷——此頁 JSON 已損毀，勿依 hasMore 判斷，改逐項處理。`),
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
    '取得「AI 規格回對」的派工計畫（給 orchestrator）。回傳一份完整 prompt：由 orchestrator 派**獨立的 AI 審查 subagent**（絕不可由寫 code 的 implementer 自評）讀 SA/SD 規格原文 + get_spec_checklist 檢查表 + 實際程式碼，逐項判定 matched/missing（必附 file+line 證據），最後用 save_compliance_review 一次寫回。完成閘門只認此 AI 回對結果（最新 ai_review run 的 missing=0）。full 軌計畫另含「合約反向對齊」步驟（code→spec，advisory）：枚舉程式實際帶的 request/response/db 欄位，程式有而規格沒定義的業務欄位用 report_spec_gap(category="field_undefined") 開缺口交使用者裁決——只做欄位維度、排除基礎設施雜訊、規格模糊則略過，**不影響 missing 判定與完成閘門**（light 軌無 SA/SD 規格文件，不做）。full 軌任務若有 SA 操作流程圖（sa-flows cache），計畫會加「流程回對」步驟：流程圖每個判斷分支/節點補為 logic 檢查項並在程式碼中找到對應路徑。light 軌任務（get_execution_plan 判軌）驗證對象改為原始 BUG 內容（任務描述 + Asana 留言 + 附件），標準不變。已有 AI 回對且最新一輪 missing>0 時，計畫自動加「增量重審」段：reviewer 只重判上輪 missing / 新增 / 有疑慮項，其餘上輪 matched 項由 save_compliance_review(carryForward=true) 程式重驗證據自動沿用——重審成本 O(改動)，閘門標準不變。任務有已裁決的規格缺口（resolve_spec_gap 落地）時，計畫自動注入「規格裁決」段——reviewer 驗證時裁決視同規格條文。',
    {
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Get Compliance Review Plan', readOnlyHint: true, openWorldHint: false },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, project_id, title, description, label, preferred_model FROM tasks WHERE id = ?').get(taskId) as
        { id: string; project_id: string; title: string; description: string | null; label: string; preferred_model: string | null } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }
      // 模型政策：reviewer 是全系統唯一「程式驗不了推理品質」的位置（logic 項判定），
      // 一律建議 opus——與主 session 用什麼模型脫鉤；任務 preferredModel 有設則優先。
      const reviewerModel = task.preferred_model?.trim() || 'opus';

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

      // ── P1a：元件知識庫（category='component' 的 active 專案筆記；只此分類，防 prompt 膨脹）──
      const componentNotes = db.prepare(`
        SELECT content FROM project_notes
        WHERE project_id = ? AND active = 1 AND category = 'component'
        ORDER BY created_at ASC
      `).all(task.project_id) as Array<{ content: string }>;
      // 字元預算：筆記會隨使用累積，無上限注入會把 plan 尾端的防線文字擠出 truncateResponse
      const COMPONENT_NOTES_CHAR_BUDGET = 4000;
      let componentNotesSection = '';
      if (componentNotes.length > 0) {
        const noteLines: string[] = [];
        let notesBudget = COMPONENT_NOTES_CHAR_BUDGET;
        let notesTruncated = false;
        for (const n of componentNotes) {
          const line = `- ${n.content}`;
          if (line.length + 1 > notesBudget) { notesTruncated = true; break; }
          notesBudget -= line.length + 1;
          noteLines.push(line);
        }
        if (noteLines.length > 0) {
          componentNotesSection = `

## 元件知識庫（已確認的元件級事實，降低重複追查成本）
${noteLines.join('\n')}${notesTruncated ? '\n（筆記已達大小上限截斷，其餘用 list_project_notes 查看）' : ''}

用法：這些事實告訴你**證據在哪個元件檔**——直接開該檔引用對應行號當證據，不需重讀整個元件追邏輯。
**這不是免驗證通行證**：對應項目仍須附 file+line 證據、仍會被程式開檔驗證；若引用行驗證失敗代表元件已變更，重查並更新筆記。`;
        }
      }

      // ── 規格裁決（resolve_spec_gap 落地的使用者拍板）——驗證依據之一 ──
      // 只從 DB 讀（結構性強制：不落地的裁決 reviewer 看不到）。字元預算比照元件知識庫防肥。
      const RESOLVED_GAPS_CHAR_BUDGET = 4000;
      const resolvedGapsForReview = listResolvedSpecGaps(db, taskId);
      let resolvedGapsSection = '';
      if (resolvedGapsForReview.length > 0) {
        const { lines: gapLines, truncated: gapsTruncated } = buildResolutionLines(resolvedGapsForReview, RESOLVED_GAPS_CHAR_BUDGET);
        if (gapLines.length > 0) {
          resolvedGapsSection = `

## 規格裁決（驗證依據之一——使用者已拍板，效力等同規格條文）
${gapLines.join('\n')}${gapsTruncated ? `\n（裁決清單已達大小上限截斷，其餘用 list_spec_gaps(taskId="${taskId}", status="resolved") 查看）` : ''}

用法：驗證 logic／實作時，這些裁決**視同規格條文**——規格模糊或沒寫、但裁決有定的，以裁決為準（例如裁決「選 B：刪除前 confirm 彈窗」→ 程式必須是 confirm 彈窗才 matched）；實作與裁決矛盾一律判 missing，並在 note 註明違反哪條裁決。`;
        }
      }

      // ── P1b：引擎預檢種子——最新 engine run 的 matched 證據（前 50 項，每項一行 file:line）──
      const ENGINE_SEED_CHAR_BUDGET = 8000;
      const engineRunRow = db.prepare(
        "SELECT results_json FROM spec_compliance_runs WHERE task_id = ? AND source = 'engine' ORDER BY run_at DESC, rowid DESC LIMIT 1"
      ).get(taskId) as { results_json: string } | undefined;
      let engineSeedSection = '';
      if (engineRunRow) {
        const allMatchedSeeds = parseJson<ItemResult[]>(engineRunRow.results_json, [])
          .filter(i => i.status === 'matched' && i.evidence && i.evidence.length > 0);
        const seeds = allMatchedSeeds.slice(0, 50);
        if (seeds.length > 0) {
          const seedLines: string[] = [];
          let budget = ENGINE_SEED_CHAR_BUDGET;
          let seedTruncated = allMatchedSeeds.length > seeds.length;
          for (const s of seeds) {
            const ev = s.evidence![0];
            const line = `- ${s.itemId}: [${s.itemType}] ${s.content} → ${ev.file}:${ev.line}`;
            if (line.length + 1 > budget) { seedTruncated = true; break; }
            budget -= line.length + 1;
            seedLines.push(line);
          }
          if (seedLines.length > 0) {
            engineSeedSection = `

## 引擎預檢種子（最新程式預檢 source='engine' 已 matched 的項目與其證據）
${seedLines.join('\n')}${seedTruncated ? '\n（種子清單已達大小上限截斷，其餘項自行比對）' : ''}

用法：以上項目引擎已在程式碼中命中——可先開其引用的 file:line 確認，屬實即沿用該證據（仍須你自己開檔看過，引擎可能誤中註解/測試檔，不屬實照樣判 missing），把時間集中在引擎 missing / manual / logic 項。`;
          }
        }
      }

      // ── S1 配套：增量重審段——已有 ai_review run 且最新一輪 missing>0 時，
      // orchestrator 指示與 reviewer prompt 加「增量重審」段（carryForward 模式）。
      // 首輪回對（無 ai_review run）plan 完全不變；上輪 run 之後檢查表被整份取代
      // （[CHECKLIST_REPLACE] 稽核晚於上輪 run，同秒視為之後——與 save_compliance_review
      // 的拒絕條件一致）→ 不出增量段，走全量重審。
      const DELTA_LIST_CHAR_BUDGET = 6000;
      const prevAiRun = db.prepare(
        "SELECT id, run_at, missing, results_json FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review' ORDER BY run_at DESC, rowid DESC LIMIT 1"
      ).get(taskId) as { id: string; run_at: string; missing: number; results_json: string } | undefined;
      let deltaSection = '';
      let deltaOrchestratorLine = '';
      if (prevAiRun && prevAiRun.missing > 0) {
        const replacedAfter = (db.prepare(
          "SELECT COUNT(*) as c FROM agent_outputs WHERE task_id = ? AND stream_type = 'system' AND content LIKE '[CHECKLIST_REPLACE]%' AND timestamp >= ?"
        ).get(taskId, prevAiRun.run_at) as { c: number }).c > 0;
        if (!replacedAfter) {
          const short = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max)}…` : s);
          const prevMissingItems = parseJson<ItemResult[]>(prevAiRun.results_json, [])
            .filter(i => i.status === 'missing');
          const staleItems = activeItems.filter(i => i.created_at > prevAiRun.run_at);

          let deltaBudget = DELTA_LIST_CHAR_BUDGET;
          let deltaTruncated = false;
          const takeLines = (lines: string[]): string[] => {
            const kept: string[] = [];
            for (const line of lines) {
              if (line.length + 1 > deltaBudget) { deltaTruncated = true; break; }
              deltaBudget -= line.length + 1;
              kept.push(line);
            }
            return kept;
          };
          const missingLines = takeLines(prevMissingItems.map(i =>
            `- ${i.itemId}: [${i.itemType}] ${short(i.content)}${i.note ? ` — ${short(i.note, 60)}` : ''}`));
          const staleLines = takeLines(staleItems.map(i => `- ${i.id}: [${i.item_type}] ${short(i.content)}`));
          // 以 staleLines（實際印得出的行）判斷，避免預算耗盡時出現空標題殘段
          const staleBlock = staleLines.length > 0
            ? `\n\n上輪回對後新增的檢查項（staleness——同樣必須本次判定）：\n${staleLines.join('\n')}`
            : '';
          if (staleItems.length > staleLines.length) deltaTruncated = true;

          deltaSection = `

## 增量重審（delta re-review — 上輪 AI 回對 missing=${prevAiRun.missing}）

此任務已有 AI 回對紀錄且最新一輪未通過。**本次為增量重審——你的 AI 重判範圍 = 下列上輪 missing 項 + staleness 新增項 + 所有 logic 項（不分上輪判定——logic 驗的是行為，程式重驗證明不了行為未變，每輪都必須 AI 重判）+ 你重看後有疑慮的項；其餘上輪 matched 的字面項（ui_text/api/param/db_field）由程式重驗證據自動沿用，不需重判。**判定標準、matched 必附 file+line 證據、寧嚴勿鬆——全部照舊，增量只是省掉重複勞動，不是放寬。

上輪 missing 項（必須本次重判）：
${missingLines.join('\n')}${staleBlock}${deltaTruncated ? '\n（清單已達大小上限截斷——不用自行重建完整清單：漏判的項目會由 save_compliance_review 的拒絕訊息逐項列出 itemId，據此補判重提即可）' : ''}

寫回方式：save_compliance_review(taskId="${taskId}", carryForward=true, results=[...]) **只提交你重判的項目**——工具會對「上輪 matched 且本次未提交」的項目程式重驗原證據後自動沿用（結果標 carriedForward），涵蓋驗證照舊（提交 + 沿用的聯集必須涵蓋所有未豁免項目）。**若工具回 revalidationFailed 清單，代表那些上輪證據已失效，把那些項目納入重判後重新提交。**`;
          deltaOrchestratorLine = `
> 5. 本次為**增量重審**（上輪 AI 回對 missing=${prevAiRun.missing}）——reviewer prompt 已含增量重審指示：只重判上輪 missing / 新增 / 有疑慮項，其餘上輪 matched 項由工具程式重驗證據自動沿用（save_compliance_review carryForward=true），重審成本從 O(全部) 降到 O(改動)，閘門標準不變`;
        }
      }

      // 兩軌共用：orchestrator 派工指示 + 判定標準/寫回/禁令（證據要求、涵蓋要求、寧嚴勿鬆照舊）
      const orchestratorNote = `> **給 orchestrator 的指示：**
> 1. 用 Agent tool 派出**一個獨立的 AI 回對 subagent**，cwd 設為上列 workspace 路徑（both 時擇一，prompt 中附上兩個路徑），**派工帶 model: "${reviewerModel}"**（reviewer 的 logic 判定沒有程式兜底，不可因主 session 用較小模型而降級${task.preferred_model ? '；此為任務 preferredModel 指定值' : ''}）
> 2. **絕不可由寫 code 的 implementer 自評**——reviewer 必須是全新 context 的獨立 agent，沒看過 implementer 的任何回報
> 3. 將以下 prompt 原封不動作為 subagent 任務傳入
> 4. subagent 完成後檢查 save_compliance_review 的結果：missing=0 才可繼續結案流程；missing>0 → 把 missing 清單交回 implementer 修正，修正後**重新派 AI 回對**（重審自動走增量模式）${deltaOrchestratorLine}`;

      // 反向完整性掃描（步驟 4）：full 掃 SA/SD 規格原文，light 掃 BUG 原文
      const reverseScanStep = track === 'light'
        ? `4. **反向掃描 BUG 原文（完整性檢查）**：重讀 BUG 原文（任務描述、Asana 留言、附件截圖裡的預期行為），找出有明確預期但 checklist 沒有對應項目的行為。找到遺漏 → 呼叫 save_spec_checklist(taskId="${taskId}", items=[...]) 補上（**append，不可用 replace**；補項同守抽取規範：${UI_TEXT_EXTRACTION_RULE}），把補上的項目一併納入本次逐項驗證與 save_compliance_review（新項目通常判 missing，交由 implementer 補做），並在總結列出補了哪些；staleness 閘門會自動要求後續回對涵蓋它們。沒有遺漏也要明確說「反向掃描無遺漏」。`
        : `4. **反向掃描規格原文（完整性檢查）**：逐節掃 SA/SD 規格，找出規格有明確要求但 checklist 沒有對應項目的內容（欄位/文字/API/邏輯）。找到遺漏 → 呼叫 save_spec_checklist(taskId="${taskId}", items=[...]) 補上（**append，不可用 replace**；補項同守抽取規範：${UI_TEXT_EXTRACTION_RULE}），把補上的項目一併納入本次逐項驗證與 save_compliance_review（新項目通常判 missing，交由 implementer 補做），並在總結列出補了哪些；staleness 閘門會自動要求後續回對涵蓋它們。沒有遺漏也要明確說「反向掃描無遺漏」。`;

      // 合約反向對齊（步驟 4b，**full 軌限定**）：與步驟 4 方向相反——
      // 步驟 4 是「掃規格補檢查表」（spec→checklist，補漏做的項目）；
      // 這一步是「掃程式開缺口」（code→spec，抓程式多帶、規格沒定義的欄位）。
      // 只限欄位維度（param/response_field/db_field），絕不對 ui_text/logic 反向；
      // 只產 report_spec_gap(advisory)，不影響 matched/missing 與完成閘門。
      // light 軌無 SA/SD 規格文件，無「規格定義欄位」可比對 → 整步不出現。
      const contractReverseStep = track === 'full'
        ? `
4b. **合約反向對齊（code→spec 欄位，advisory，不進閘門）**：這步方向與步驟 4 相反——步驟 4 掃規格原文回頭補檢查表（spec→checklist），這步**枚舉程式欄位回頭開缺口（code→spec）**，抓「程式實際有、規格卻沒定義」的多餘欄位交使用者裁決。作法：對檢查表中出現的**每個 api**，在程式碼裡枚舉該 API 實際的 request 參數（param）、response 欄位（response_field）、對應 db_field，與規格（SA/SD）對該 API 定義的欄位逐一比對——
   - **程式有、規格沒有，且看起來是業務語意欄位** → 呼叫 report_spec_gap(taskId="${taskId}", category="field_undefined", description="合約反向對齊：程式實際帶了「{欄位名}」（{api}）但規格未定義——請確認是過度實作（該移除）還是規格待補") 記錄。**這是 advisory：不影響本次 matched/missing 判定與結案，不進完成閘門**，只開缺口供使用者裁決
   - **只做欄位維度（param / response_field / db_field）**，**絕不對 ui_text / logic 做反向對齊**（畫面文字/邏輯反掃誤報過多）
   - **基礎設施雜訊一律排除，不報**：分頁（page/size/offset/limit）、排序（sort/order）、認證（token/authorization）、時間戳（createdAt/updatedAt/timestamp），以及專案共用系統欄位（如 MetaData 的 CREATE_DATE/MODIFY_DATE/DATA_REMARK，及 backendExtraPrompt / 元件知識庫提到的系統欄位）——只報看起來是**業務語意**的多餘欄位
   - **規格模糊就略過**：規格對某 API 的欄位定義不清楚/不完整時，不要硬 diff 逼報（否則全是 extra 誤報），該 API 直接略過反向對齊並在總結註明「{api}：規格欄位定義不足，略過反向對齊」
   - 沒有發現多餘業務欄位也要明確說「合約反向對齊：無多餘欄位」`
        : '';

      const commonSteps = `${reverseScanStep}${contractReverseStep}
5. **判定標準（寧嚴勿鬆）**：每項判 matched 或 missing——
   - matched **必須附 evidence**（file + line，workspace 相對路徑）與一句說明（note）
   - **每筆 evidence 會被程式驗證**（檔案存在、行號有效、該行 ±${RELEVANCE_WINDOW} 行內確實含該文字/路徑/識別字）——引用不精確會整批退回，請引用實際包含該文字/路徑/識別字的行（如文字在 i18n 檔就引 i18n 檔）
   - 找不到、不確定、規格與程式碼有出入 → 一律 missing，可用 note 說明疑點
6. **一次寫回**：全部判完後呼叫 save_compliance_review(taskId="${taskId}", results=[{itemId, status, evidence: [{file, line}], note}, ...])，**必須涵蓋所有未豁免項目**。
7. **嚴禁**只看 implementer 的回報、verification report、commit message 或任何摘要就下判定——**必須自己用 Read/Grep 開檔案核對**。
8. **回寫元件知識庫（save_compliance_review 之後，非必要步驟——沒有值得記的就不要記）**：只在發現**可重用的元件級事實**（共用元件產生什麼文字/行為、慣例差異，下一個_不同_任務不知道就會做錯的）時，才用 save_project_note(projectId="${task.project_id}", category="component", content=...) 記錄。**先過必要性測試**：把時間/任務名/commit 拿掉後還成立的可重用規則才記；「這次審了什麼、發現這個任務哪裡 missing」是流水帳，**不要記**（那是 save_compliance_review 的 note 該放的）。**寫入紀律：**
   - **先對照上方已注入的「元件知識庫」區塊**（若有）——只記「新的、現有筆記沒涵蓋」的事實；能對應到既有筆記的更新/延伸就不要新增重複則。
   - **精簡**：一則一個重點、附元件檔+行號、無出處不記，不要長篇。
   - **既有筆記已過時**（引用行對不上/元件已改）→ 用 archive_project_note(noteId=...) 標掉，不要留著誤導。`;

      const forbiddenSection = `## 絕對禁止
- 不得修改任何程式碼或檔案（只讀；MCP 回寫僅限 save_project_note / save_spec_checklist / save_compliance_review 三個工具）
- 不得呼叫 update_task_status——結案由 orchestrator 決定`;

      const commonTail = `${commonSteps}

${forbiddenSection}`;

      // ── R3：SA 流程圖回對（full 軌限定）──
      // 沿用 ExecutionPipeline 的 SA flow cache（data/sa-flows/{projectId}-{contentHash}-flow.mmd）。
      // 找不到 SA flow 或 light 軌 → 整節不出現。
      let saFlowSection = '';
      if (track === 'full') {
        const saFlow = findSaFlowForTask(db, taskId, task.project_id);
        if (saFlow) {
          const flowBody = saFlow.mermaid.length <= SA_FLOW_INLINE_LIMIT
            ? `### SA 流程圖（${saFlow.filename}）
\`\`\`mermaid
${saFlow.mermaid}
\`\`\``
            : `### SA 流程圖（${saFlow.filename}）
流程圖過大（${saFlow.mermaid.length} 字元）未內嵌——用 Read tool 讀取：
\`${saFlow.flowPath.replace(/\\/g, '/')}\``;
          saFlowSection = `

## 流程回對（SA 流程圖 → 程式路徑）

此任務有 SA 操作流程圖（依 SA 文件內容產生的 Mermaid flowchart）。除上述逐項驗證外，執行流程回對：
1. 逐一檢視 SA 流程圖的每個**判斷分支/流程節點**
2. checklist 尚未涵蓋的分支/節點 → 呼叫 save_spec_checklist(taskId="${taskId}", items=[...])（**append，不可用 replace**）補為檢查項：itemType="logic"、content=該節點/分支的行為描述、sourceRef="SA flow ${saFlow.filename}"
3. 補上的項目一併納入本次逐項驗證與 save_compliance_review——逐項在程式碼中找到對應路徑，matched 必附 file+line 證據（照樣過程式驗證）；**找不到對應程式路徑的分支判 missing**

${flowBody}`;
        }
      }

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

你是獨立的規格審查員（reviewer）。本任務為 **light 軌**（無 SA/SD 規格文件）——驗證基準是**原始 BUG 內容**。你的任務：**逐項回對規格檢查表（從 BUG 原文抽出的「修復後預期行為」）與實際程式碼，判定每個預期行為是否已確實達成**。你不是來寫 code 的，只讀不改。${resolvedGapsSection}${componentNotesSection}${engineSeedSection}${deltaSection}

## 審查流程（強制，依序執行）

1. **取得完整 BUG 現場**：上列任務標題/描述是起點；呼叫 get_asana_task_comments(taskId="${taskId}") 讀回報討論串、fetch_task_attachments(projectId="${task.project_id}", taskId="${taskId}") 取附件截圖並用 Read tool 看圖。**BUG 原文是你判定的唯一依據，不是任何人的轉述。**
2. **取得檢查表（必須看完全部）**：呼叫 get_spec_checklist(taskId="${taskId}", limit=50, offset=0) 取得項目（含 itemId）。**檢查表可能很大且會分頁**——回應裡 hasMore=true 就以「offset += 本頁回傳的 count」繼續呼叫（頁面過大時會自動縮頁，實際回傳筆數可能小於 limit，note 會給正確的續取 offset——**不可假設每頁固定 50 筆**），直到 hasMore=false，把每一頁的項目都收集齊。**save_compliance_review 必須涵蓋所有非 waived 項目（含 logic 類），漏收任何一頁就會被退回。**
3. **逐項在實際程式碼中驗證**（一項都不可跳過）：
   - **logic（修復後預期行為）→ 讀實際的程式碼修改（diff / 相關檔案），追完整程式碼流程確認該行為真的達成，不可只憑檔名、函式名或 implementer 的說法猜。環境允許時用 Playwright 實測頁面行為更好（非必要）。若 implementer 已為該邏輯撰寫單元測試，測試檔中對應案例的 file+line 可作為 evidence（仍會被程式開檔驗證）**
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

你是獨立的規格審查員（reviewer）。你的任務：**逐項回對規格檢查表與實際程式碼，判定每一項是否已確實實作**。你不是來寫 code 的，只讀不改。${resolvedGapsSection}${componentNotesSection}${engineSeedSection}${deltaSection}

## 審查流程（強制，依序執行）

1. **讀規格原文**：用 Read tool 完整讀取上列規格文件（SA/SD）。這是你判定的唯一依據，不是任何人的轉述。
2. **取得檢查表（必須看完全部）**：呼叫 get_spec_checklist(taskId="${taskId}", limit=50, offset=0) 取得項目（含 itemId）。**檢查表可能很大且會分頁**——回應裡 hasMore=true 就以「offset += 本頁回傳的 count」繼續呼叫（頁面過大時會自動縮頁，實際回傳筆數可能小於 limit，note 會給正確的續取 offset——**不可假設每頁固定 50 筆**），直到 hasMore=false，把每一頁的項目都收集齊。**save_compliance_review 必須涵蓋所有非 waived 項目（含 logic 類），漏收任何一頁就會被退回。**
3. **逐項在實際程式碼中驗證**（一項都不可跳過）：
   - ui_text → 在程式碼中找到該文字的**渲染處**（不是只出現在註解/測試），確認與規格逐字一致
   - api → 確認 path、method、參數確實**串接**（前端有呼叫、後端有 handler），不是只出現字串
   - param / response_field → 確認參數/欄位確實進出該 API 的 request/response
   - db_field → 確認 Entity（@Column name）/ DDL 中確實存在該欄位
   - **logic → 追實際程式碼流程（Controller → Service → SQL / 元件 → handler → API），確認邏輯與規格描述一致。這是 AI 回對的核心價值，不可跳過、不可只憑檔名或函式名猜。若 implementer 已為該邏輯撰寫單元測試，測試檔中對應案例的 file+line 可作為 evidence（仍會被程式開檔驗證）**
${commonSteps}${saFlowSection}

${forbiddenSection}`;

      return { content: [{ type: 'text' as const, text: truncateResponse(plan) }] };
    },
  );

  // ── save_compliance_review ────────────────────────────────
  server.tool(
    'save_compliance_review',
    '寫回「AI 規格回對」結果（由獨立 AI 審查 agent 呼叫，見 get_compliance_review_plan）。results 必須涵蓋該任務**所有未豁免**的檢查表項目（缺項會被拒）；matched 項目必附 evidence（file+line）。**每筆 evidence 會被程式驗證**（檔案存在、行號有效、該行附近確實含該文字/路徑/識別字；logic 只驗檔案+行號）——引用不精確會整批退回。**增量重審**：重審時可帶 carryForward=true 只提交本次 AI 實際重判的項目——上輪 ai_review run 中 matched 且本次未提交的項目，工具會程式重驗其原證據，通過即自動沿用（結果標 carriedForward）；重驗失敗會回 revalidationFailed 清單整批拒收，把那些項目納入重判後重新提交。涵蓋驗證不變：「本次提交 + 沿用通過」聯集仍必須涵蓋所有未豁免項目。寫入後成為完成閘門的依據：最新 ai_review run 的 missing=0 才可標 completed；與最新程式預檢（engine run）判定相反的項目會標 engineStatus 並在回應列出（抽查優先靶點）。',
    {
      taskId: z.string().describe('任務 ID'),
      carryForward: z.boolean().optional().describe('true=增量重審模式：只提交本次 AI 重判的項目（上輪 missing、上輪回對後新增、**所有 logic 項——logic 不沿用每輪必重判**、以及重看後有疑慮的項），其餘上輪 matched 的字面項（ui_text/api/param/response_field/db_field）由工具程式重驗原證據後自動沿用。需要已存在前一輪 ai_review run；上輪 run 之後檢查表被整份取代（[CHECKLIST_REPLACE]）則拒絕。預設 false=全量提交'),
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
    async ({ taskId, results, carryForward }) => {
      const db = getMcpDb();
      // zod 已限制上限，這裡再防呆一次（涵蓋不經 zod 的呼叫路徑）
      if (results.length > MAX_REVIEW_RESULTS) {
        return { content: [{ type: 'text' as const, text: `Error: 一次最多 ${MAX_REVIEW_RESULTS} 項（收到 ${results.length}）。` }], isError: true };
      }
      const task = db.prepare('SELECT id, project_id, label FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; label: string } | undefined;
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

      // workspace roots 依 task.label 解析（同 run_spec_compliance 的規則）——
      // 提早解析：carryForward 的證據重驗與 N1 的提交證據驗證共用。
      // root 未設定或路徑不存在 → 無法驗證（carryForward 直接拒；全量提交維持現行為並註記）。
      const project = db.prepare('SELECT frontend_path, backend_path FROM projects WHERE id = ?').get(task.project_id) as
        { frontend_path: string | null; backend_path: string | null } | undefined;
      const roots: WorkspaceRoots = {};
      if (task.label === 'frontend') {
        if (project?.frontend_path) roots.frontend = project.frontend_path;
      } else if (task.label === 'backend') {
        if (project?.backend_path) roots.backend = project.backend_path;
      } else {
        if (project?.frontend_path) roots.frontend = project.frontend_path;
        if (project?.backend_path) roots.backend = project.backend_path;
      }
      if (roots.frontend && !fs.existsSync(roots.frontend)) delete roots.frontend;
      if (roots.backend && !fs.existsSync(roots.backend)) delete roots.backend;
      const hasRoots = Boolean(roots.frontend || roots.backend);

      // ── S1：增量回對（carryForward）——「上輪 matched 且本次未提交」的項目
      // 由程式重驗上輪證據（validateReviewEvidence 開檔確認仍有效）後自動沿用。
      // 重驗失敗 → revalidationFailed 整批拒收（不得沿用失效證據）。
      // 閘門語意不變：沿用項照樣計入涵蓋與 matched，缺項照樣拒。
      const resultIds = new Set(results.map(r => r.itemId));
      const carriedItems: ItemResult[] = [];
      if (carryForward) {
        const prevRun = db.prepare(
          "SELECT id, run_at, results_json FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review' ORDER BY run_at DESC, rowid DESC LIMIT 1"
        ).get(taskId) as { id: string; run_at: string; results_json: string } | undefined;
        if (!prevRun) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: carryForward=true 需要已存在的前一輪 AI 回對 run（source='ai_review'），此任務沒有——首輪回對請不帶 carryForward，全量提交所有未豁免項目。`,
            }],
            isError: true,
          };
        }
        // 上輪 run 之後檢查表被整份取代（[CHECKLIST_REPLACE] 稽核晚於上輪 run）→
        // 上輪判定對象已不是現行檢查表，拒絕沿用要求全量。時間同秒視為「之後」
        // （datetime 秒級精度無法分辨先後，保守拒絕只多花一次全量重審，不會放寬閘門）。
        const replaceAudit = db.prepare(
          "SELECT timestamp FROM agent_outputs WHERE task_id = ? AND stream_type = 'system' AND content LIKE '[CHECKLIST_REPLACE]%' ORDER BY timestamp DESC, id DESC LIMIT 1"
        ).get(taskId) as { timestamp: string } | undefined;
        if (replaceAudit && replaceAudit.timestamp >= prevRun.run_at) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: 檢查表在上輪 AI 回對之後被整份取代（[CHECKLIST_REPLACE]），上輪判定不可沿用——請不帶 carryForward 對現行檢查表全量重新回對。`,
            }],
            isError: true,
          };
        }
        if (!hasRoots) {
          return {
            content: [{
              type: 'text' as const,
              text: `Error: carryForward 需要程式重驗上輪證據，但 workspace 未設定或路徑不存在（無法開檔驗證）——請不帶 carryForward 全量提交，或先用 update_project 修正 workspace 路徑。`,
            }],
            isError: true,
          };
        }

        // 沿用候選：上輪 matched、有證據、本次未提交、且仍是現行未豁免檢查項。
        // logic 項一律排除——logic 的「符合」是行為等於規格，證據行只是錨點，
        // 程式重驗證明不了行為未變（改壞行為但證據行沒動的縫隙），每輪都要 AI 重判。
        // 字面項（ui_text/api/param/db_field）的符合定義就是「該文字存在於正確位置」，
        // 程式重驗即完整驗證，沿用零妥協。
        const prevResults = parseJson<ItemResult[]>(prevRun.results_json, []);
        const candidates = prevResults.filter(p =>
          p.status === 'matched' && p.itemType !== 'logic' && p.evidence && p.evidence.length > 0 &&
          !resultIds.has(p.itemId) && rowById.get(p.itemId)?.waived === 0
        );
        const carryCheckInputs: EvidenceCheckInput[] = candidates.map(p => {
          const row = rowById.get(p.itemId)!;
          return {
            itemId: p.itemId,
            itemType: row.item_type,
            content: row.content,
            side: row.side ?? 'both',
            detail: parseJson<Record<string, unknown> | null>(row.detail_json, null),
            evidence: p.evidence!,
          };
        });
        const carryFailures = validateReviewEvidence(carryCheckInputs, roots);
        if (carryFailures.length > 0) {
          const failedIds = [...new Set(carryFailures.map(f => f.itemId))];
          const lines = carryFailures.slice(0, 20).map(f => {
            const row = rowById.get(f.itemId);
            return `- ${f.itemId}（[${row?.item_type ?? '?'}] ${row?.content ?? ''}）: ${f.file}:${f.line} — ${f.reason}`;
          });
          const more = carryFailures.length > 20 ? `\n（其餘 ${carryFailures.length - 20} 筆略）` : '';
          return {
            content: [{
              type: 'text' as const,
              text: `Error: carryForward 證據重驗失敗，整批拒收（未寫入 run）。revalidationFailed ${failedIds.length} 項——上輪證據已失效（程式碼變更/行號位移），**不得沿用**：
${lines.join('\n')}${more}

請把以上項目納入本次 AI 重判（自己開檔重新驗證，matched 附新證據、找不到判 missing），連同原提交項一併重新呼叫 save_compliance_review(carryForward=true)。`,
            }],
            isError: true,
          };
        }
        for (const p of candidates) {
          const row = rowById.get(p.itemId)!;
          carriedItems.push({
            itemId: p.itemId,
            itemType: row.item_type,
            content: row.content,
            status: 'matched',
            evidence: p.evidence,
            ...(p.note ? { note: p.note } : {}),
            carriedForward: true,
          });
        }
      }
      const carriedIds = new Set(carriedItems.map(c => c.itemId));

      // 必須涵蓋所有未豁免項目（防 reviewer 偷懶只驗一部分）——
      // carryForward 時涵蓋 = 本次提交 + 沿用通過的聯集，缺項照樣拒。
      const uncovered = rows.filter(r => r.waived === 0 && !resultIds.has(r.id) && !carriedIds.has(r.id));
      if (uncovered.length > 0) {
        const lines = uncovered.slice(0, 20).map(r => `- ${r.id}: [${r.item_type}] ${r.content}`);
        const more = uncovered.length > 20 ? `\n（其餘 ${uncovered.length - 20} 項略）` : '';
        const carryHint = carryForward
          ? '\n（carryForward 只沿用「上輪 matched 且證據仍有效」的項目——上輪 missing、上輪回對後新增的項目必須本次提交判定。）'
          : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Error: AI 回對必須涵蓋所有未豁免的檢查表項目，以下 ${uncovered.length} 項未判定：
${lines.join('\n')}${more}

逐項驗證後重新呼叫 save_compliance_review（涵蓋全部未判定項目）。${carryHint}`,
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

      // ── N1：程式驗證 matched 證據（AI 判定、程式驗證判定依據）──
      // roots 已於上方提早解析；未設定/不存在 → 無法驗證，維持現行為並註記
      // （carryForward 已在上方拒絕此情境）。
      let evidenceNote = '';
      if (!hasRoots) {
        evidenceNote = '\n（注意：證據未經程式驗證——workspace 未設定或路徑不存在）';
      } else {
        const checkInputs: EvidenceCheckInput[] = results
          .filter(r => r.status === 'matched' && rowById.get(r.itemId)!.waived === 0)
          .map(r => {
            const row = rowById.get(r.itemId)!;
            return {
              itemId: r.itemId,
              itemType: row.item_type,
              content: row.content,
              side: row.side ?? 'both',
              detail: parseJson<Record<string, unknown> | null>(row.detail_json, null),
              evidence: r.evidence!,
            };
          });
        const failures = validateReviewEvidence(checkInputs, roots);
        if (failures.length > 0) {
          const lines = failures.slice(0, 20).map(f => {
            const row = rowById.get(f.itemId);
            return `- ${f.itemId}（[${row?.item_type ?? '?'}] ${row?.content ?? ''}）: ${f.file}:${f.line} — ${f.reason}`;
          });
          const more = failures.length > 20 ? `\n（其餘 ${failures.length - 20} 筆略）` : '';
          return {
            content: [{
              type: 'text' as const,
              text: `Error: ${failures.length} 筆 matched 證據未通過程式驗證，整批拒收（未寫入 run）：
${lines.join('\n')}${more}

請引用實際包含該文字/路徑/識別字的行（如文字在 i18n 檔就引 i18n 檔、API path 引呼叫處或 handler 定義行附近）；確實找不到證據就判 missing（寧嚴勿鬆）。修正證據後重新呼叫 save_compliance_review。`,
            }],
            isError: true,
          };
        }
      }

      // ── N3：引擎 × AI 分歧偵測（對照最新 source='engine' 的 run；無 engine run 則跳過）──
      const engineRun = db.prepare(
        "SELECT results_json FROM spec_compliance_runs WHERE task_id = ? AND source = 'engine' ORDER BY run_at DESC, rowid DESC LIMIT 1"
      ).get(taskId) as { results_json: string } | undefined;
      const engineStatusById = new Map<string, 'matched' | 'missing'>();
      if (engineRun) {
        for (const it of parseJson<ItemResult[]>(engineRun.results_json, [])) {
          if (it.itemId && (it.status === 'matched' || it.status === 'missing')) {
            engineStatusById.set(it.itemId, it.status);
          }
        }
      }

      // 組 results_json（同引擎的 ItemResult 形狀；waived 項目照表補 status='waived'）
      const reviewItems: ItemResult[] = [];
      const discrepancies: Array<{ itemId: string; itemType: ChecklistItemType; content: string; engineStatus: 'matched' | 'missing'; aiStatus: 'matched' | 'missing' }> = [];
      let matched = 0;
      let missing = 0;
      for (const r of results) {
        const row = rowById.get(r.itemId)!;
        if (row.waived === 1) continue; // 已豁免的判定不計入（照表記 waived）
        if (r.status === 'matched') matched++; else missing++;
        const engineStatus = engineStatusById.get(r.itemId);
        const discrepant = engineStatus !== undefined && engineStatus !== r.status;
        if (discrepant) {
          discrepancies.push({ itemId: r.itemId, itemType: row.item_type, content: row.content, engineStatus, aiStatus: r.status });
        }
        reviewItems.push({
          itemId: r.itemId,
          itemType: row.item_type,
          content: row.content,
          status: r.status,
          ...(r.evidence && r.evidence.length > 0 ? { evidence: r.evidence } : {}),
          ...(r.note ? { note: r.note } : {}),
          ...(discrepant ? { engineStatus } : {}), // 只在分歧時加，results_json 保持陣列形狀
        });
      }
      // 沿用項（carryForward）：與重判項並列於同一陣列，僅多 carriedForward 欄位；
      // 照樣計入 matched 與引擎分歧偵測。
      for (const c of carriedItems) {
        matched++;
        const engineStatus = engineStatusById.get(c.itemId);
        const discrepant = engineStatus !== undefined && engineStatus !== 'matched';
        if (discrepant) {
          discrepancies.push({ itemId: c.itemId, itemType: c.itemType, content: c.content, engineStatus, aiStatus: 'matched' });
        }
        reviewItems.push({ ...c, ...(discrepant ? { engineStatus } : {}) });
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

      // 分歧區段（N3）：引擎與 AI 判定相反的項目——抽查優先靶點
      const discrepancySection = discrepancies.length > 0
        ? `\n\n⚡ discrepancies — 引擎 × AI 分歧 ${discrepancies.length} 項（分歧項是抽查的優先靶點：引擎誤中註解或 AI 看漏都可能）：
${discrepancies.slice(0, 20).map(d => `- ${d.itemId}: [${d.itemType}] ${d.content} — 程式預檢=${d.engineStatus} / AI=${d.aiStatus}`).join('\n')}${discrepancies.length > 20 ? `\n（其餘 ${discrepancies.length - 20} 項略）` : ''}`
        : '';

      const notifyWarning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      const carriedNote = carriedItems.length > 0
        ? `（其中 ${carriedItems.length} 項沿用上輪判定 carriedForward，原證據已程式重驗通過）`
        : '';
      if (missing > 0) {
        const missingLines = reviewItems.filter(i => i.status === 'missing').slice(0, 20)
          .map(i => `- [${i.itemType}] ${i.content}${i.note ? ` — ${i.note}` : ''}`);
        const more = missing > 20 ? `\n（其餘 ${missing - 20} 項略）` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `AI 規格回對已記錄（runId=${runId}）：${matched}/${autoTotal} 符合${carriedNote}，❌ ${missing} 項 missing${notifyWarning}：
${missingLines.join('\n')}${more}${discrepancySection}${evidenceNote}

missing 不為 0 時 update_task_status(completed) 會被拒絕。請 implementer 修正後**重新執行 AI 回對**（get_compliance_review_plan → 獨立 reviewer → save_compliance_review，重審會自動走增量模式），或對有正當理由的項目用 waive_checklist_item(itemId, reason) 豁免後重新回對。`,
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: `✅ AI 規格回對通過（runId=${runId}）：${matched}/${autoTotal} 符合${carriedNote}，missing=0${notifyWarning}。完成閘門已解鎖，可繼續驗收流程後標記 completed。${discrepancySection}${evidenceNote}`,
        }],
      };
    },
  );
}
