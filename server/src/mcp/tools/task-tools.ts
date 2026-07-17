/**
 * MCP tools for task execution — the core of the MCP Server.
 * get_task, list_pending_tasks, get_execution_plan, update_task_status
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import {
  GATE_B_MAX_FAILURES, FLOW_NODE_LEVEL_SPEC,
  resolveRole, mutateFlowState, getFlowState, getRoleState,
  detectSpecDocuments, getCompletionBlockers, logTaskOutput,
  type ExecutionTrack,
} from '../flow-gate.js';
import { parseJson, getAsanaPat, ASANA_API_BASE, ASANA_FETCH_TIMEOUT_MS } from '../helpers.js';
import { detectLabel, detectTaskType } from '../../utils/taskClassification.js';
import { runSpecChangeCheck, type SpecChangeTarget } from '../spec-change.js';
import { parseTestCommands, getRequiredUnitTestItems, findLatestUnitTestVerification, UNRELATED_TEST_FAILURE_RULE } from './verification-tools.js';
import { getStalledHours, DEFAULT_STALE_THRESHOLD_HOURS } from '../stale-tasks.js';

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  label: string;
  status: string;
  assigned_agent_id: string | null;
  priority: number;
  prompt: string | null;
  result_summary: string | null;
  task_type: string;
  source: string;
  source_ref: string | null;
  branch_name: string | null;
  spec_url: string | null;
  preferred_model: string | null;
  parent_name: string | null;
  section: string | null;
  tags: string | null;
  custom_fields: string | null;
  assignee: string | null;
  assignee_gid: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  working_dir: string;
  frontend_path: string | null;
  backend_path: string | null;
  config_json: string | null;
}

interface DocumentRow {
  id: string;
  filename: string;
  file_path: string;
  file_type: string | null;
  doc_type: string | null;
  parsed_text: string | null;
}

export function registerTaskTools(server: McpServer): void {

  // ── get_task ──────────────────────────────────────────────
  server.tool(
    'get_task',
    'Get detailed information about a specific task including its project context. Documents are excluded by default to reduce payload — use includeDocuments=true or get_documents when needed.',
    {
      taskId: z.string().describe('The task ID'),
      includeDocuments: z.boolean().optional().describe('Include associated documents (default: false). Use get_documents for document listing instead.'),
    },
    { title: 'Get Task', readOnlyHint: true, openWorldHint: false },
    async ({ taskId, includeDocuments }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as ProjectRow | undefined;

      const result: Record<string, unknown> = {
        task: {
          id: task.id,
          projectId: task.project_id,
          title: task.title,
          description: task.description,
          label: task.label,
          status: task.status,
          priority: task.priority,
          prompt: task.prompt,
          taskType: task.task_type,
          source: task.source,
          sourceRef: task.source_ref,
          branchName: task.branch_name,
          specUrl: task.spec_url,
          preferredModel: task.preferred_model,
          parentName: task.parent_name,
          section: task.section ?? null,
          tags: parseJson<string[]>(task.tags, []),
          customFields: parseJson<Record<string, string>>(task.custom_fields, {}),
          assignee: task.assignee ?? null,
          assigneeGid: task.assignee_gid ?? null,
          createdAt: task.created_at,
        },
        project: project ? {
          id: project.id,
          name: project.name,
          workingDir: project.working_dir,
          frontendPath: project.frontend_path,
          backendPath: project.backend_path,
        } : null,
      };

      if (includeDocuments) {
        const docs = db.prepare(`
          SELECT d.id, d.filename, d.file_path, d.file_type, d.doc_type
          FROM task_documents td JOIN documents d ON d.id = td.document_id
          WHERE td.task_id = ?
        `).all(taskId) as DocumentRow[];

        const projectDocs = docs.length === 0
          ? db.prepare('SELECT id, filename, file_path, file_type, doc_type FROM documents WHERE project_id = ?').all(task.project_id) as DocumentRow[]
          : [];

        result.documents = (docs.length > 0 ? docs : projectDocs).map(d => ({
          id: d.id,
          filename: d.filename,
          filePath: d.file_path,
          fileType: d.file_type,
          docType: d.doc_type,
        }));
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── list_pending_tasks ────────────────────────────────────
  server.tool(
    'list_pending_tasks',
    'List tasks for a project. Defaults to pending/queued/assigned. Supports filtering by taskType, label, keyword, section (exact Asana Section name, e.g. "UT"), tag (matches any one of the task\'s Asana tags), and custom status list. Returns sourceRef (Asana GID), plus section/tags/customFields dimensions.',
    {
      projectId: z.string().describe('The project ID'),
      taskType: z.string().optional().describe('Filter by task_type (bug/feature/refactor/other)'),
      label: z.string().optional().describe('Filter by label (frontend/backend/fullstack)'),
      keyword: z.string().optional().describe('Search keyword in title or description'),
      section: z.string().optional().describe('Filter by Asana Section name (exact match, e.g. "UT")'),
      tag: z.string().optional().describe('Filter by Asana tag (matches if the task has this tag, exact tag name)'),
      statuses: z.array(z.string()).optional().describe('Override status filter (default: ["pending","queued","assigned"])'),
      limit: z.number().int().positive().optional().describe('Max tasks to return (default: 100)'),
      offset: z.number().int().min(0).optional().describe('Number of tasks to skip for pagination (default: 0)'),
      staleThresholdHours: z.number().int().positive().optional().describe(`Threshold (hours) for flagging an in_progress task as stalled (default: ${DEFAULT_STALE_THRESHOLD_HOURS}). Each in_progress task in the response carries stalledHours + stalled.`),
    },
    { title: 'List Pending Tasks', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, taskType, label, keyword, section, tag, statuses, limit, offset, staleThresholdHours }) => {
      const db = getMcpDb();
      const statusList = statuses && statuses.length > 0 ? statuses : ['pending', 'queued', 'assigned'];
      const placeholders = statusList.map(() => '?').join(',');

      let where = `WHERE project_id = ? AND status IN (${placeholders})`;
      const params: unknown[] = [projectId, ...statusList];

      if (taskType) {
        where += ' AND task_type = ?';
        params.push(taskType);
      }
      if (label) {
        where += ' AND label = ?';
        params.push(label);
      }
      if (keyword) {
        // Escape LIKE wildcards so %/_ in the keyword match literally
        where += " AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')";
        const like = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
        params.push(like, like);
      }
      if (section) {
        where += ' AND section = ?';
        params.push(section);
      }
      if (tag) {
        // tags stored as JSON array of names; match if any element equals the tag (exact)
        where += ' AND EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE json_each.value = ?)';
        params.push(tag);
      }

      const total = (db.prepare(`SELECT COUNT(*) as count FROM tasks ${where}`).get(...params) as { count: number }).count;

      const effLimit = limit ?? 100;
      const effOffset = offset ?? 0;
      const rows = db.prepare(`
        SELECT id, title, description, label, status, priority, task_type, preferred_model, parent_name, source_ref,
               section, tags, custom_fields, assignee, assignee_gid
        FROM tasks
        ${where}
        ORDER BY priority DESC, created_at ASC
        LIMIT ? OFFSET ?
      `).all(...params, effLimit, effOffset) as Array<Record<string, unknown>>;

      // Parse JSON dimensions for output; back-compat: old tasks → [] / {} / null.
      // in_progress tasks additionally carry stalledHours + stalled (卡死偵測): a
      // task with no report_output that nobody marked completed/failed shows a
      // growing stalledHours so orchestrators can resume_task or mark it failed.
      const threshold = staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS;
      const tasks = rows.map(r => {
        const base = {
          ...r,
          tags: parseJson<string[]>(r['tags'], []),
          custom_fields: parseJson<Record<string, string>>(r['custom_fields'], {}),
        };
        if (r['status'] === 'in_progress') {
          const stalledHours = getStalledHours(db, r['id'] as string);
          return { ...base, stalledHours, stalled: stalledHours >= threshold };
        }
        return base;
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            projectId,
            total,
            count: tasks.length,
            offset: effOffset,
            hasMore: effOffset + tasks.length < total,
            staleThresholdHours: threshold,
            tasks,
          }, null, 2),
        }],
      };
    },
  );

  // ── get_execution_plan ────────────────────────────────────
  server.tool(
    'get_execution_plan',
    'Get a complete execution plan for a task. Returns prompt, workspace paths (frontendPath + backendPath), and model. Use role param to get role-specific plan (frontend/backend). Orchestrator should ask user "前端、後端、還是都做？" before calling. Track: omit for auto — taskType=bug 且無 SA/SD 規格文件 → light（輕量修復流程，跳過流程圖閘門；檢查表改抽 BUG 原文，AI 回對 missing=0 標準不變）; otherwise full. Explicit track overrides auto detection.',
    {
      taskId: z.string().describe('The task ID to generate an execution plan for'),
      role: z.enum(['frontend', 'backend']).optional().describe('Override role for plan generation. Omit to use task label.'),
      track: z.enum(['light', 'full']).optional().describe('Execution track. Omit for auto detection (bug without SA/SD docs → light; otherwise full). Explicit value overrides.'),
    },
    { title: 'Get Execution Plan', readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    async ({ taskId, role, track }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // ── 任務自動判軌（light / full）──
      // light = 小 bug 輕量修復流程：跳過 Flow-Gated 閘門，但 checklist（改抽
      // BUG 原文）+ AI 回對 missing=0 的完成標準不變——輕的是工序，不是標準。
      // 判定粒度是「任務綁定」的 SA/SD（task_documents）：專案層難免有其他功能的
      // SA/SD，用專案層判定會讓 bug 永遠判不到 light。fetch_svn_specs 撈到的規格
      // 會自動綁定到任務，所以「為這個 bug 撈過規格」= full。
      const hasSpecDocs = detectSpecDocuments(db, task.id, task.project_id); // 專案層 fallback，僅供 flow-gate specExpected 用
      const taskBoundSpecDocs = (db.prepare(`
        SELECT COUNT(*) as c FROM task_documents td
        JOIN documents d ON d.id = td.document_id
        WHERE td.task_id = ? AND d.doc_type IN ('SA','SD')
      `).get(task.id) as { c: number }).c > 0;
      const autoTrack: ExecutionTrack = task.task_type === 'bug' && !taskBoundSpecDocs ? 'light' : 'full';
      const effectiveTrack: ExecutionTrack = track ?? autoTrack;
      const trackReason = track
        ? `呼叫端指定 track="${track}"`
        : effectiveTrack === 'light'
          ? '自動判定：taskType=bug 且任務未綁定 SA/SD 規格文件'
          : `自動判定：taskType=${task.task_type}${taskBoundSpecDocs ? '（任務已綁定 SA/SD 規格文件）' : ''}`;

      const notifyUrl = process.env['NOTIFY_URL'] || 'http://127.0.0.1:3457/api/mcp-notify';
      const baseUrl = notifyUrl.replace('/api/mcp-notify', '');
      const query = new URLSearchParams();
      if (role) query.set('role', role);
      query.set('track', effectiveTrack);

      try {
        const response = await fetch(`${baseUrl}/api/execution-plan/${taskId}?${query.toString()}`, {
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          const data = await response.json() as {
            prompt: string; workingDir: string; model: string;
            frontendPath: string | null; backendPath: string | null;
          };

          const effectiveRole = role || task.label;

          // ── 判軌結果持久化（merge 式 flow_state，供 compliance/resume 讀取）──
          // Persisted only AFTER the plan is successfully fetched (same rule as flow_required).
          const prevTrack = getFlowState(db, task.id)?.track;

          let flowGateSection = '';
          if (effectiveTrack === 'full') {
            // ── Flow-Gated Development: initialize state machine（full 軌限定）──
            // flow_required is set only AFTER the plan is successfully fetched (review M6).
            // flow_state is merged, never overwritten (review C2): existing flows/gates/
            // failure counters survive repeated get_execution_plan calls.
            const flowRole = resolveRole(role || (task.label === 'frontend' || task.label === 'backend' ? task.label : undefined));
            db.prepare("UPDATE tasks SET flow_required = 1, updated_at = datetime('now') WHERE id = ?").run(task.id);
            const flowState = mutateFlowState(db, task.id, (s) => {
              s.track = 'full';
              s.trackReason = trackReason;
              // upgrade-only: adding docs later upgrades to three-flow mode; never downgrade (review I-1)
              s.specExpected = s.specExpected || hasSpecDocs;
              getRoleState(s, flowRole).required = true;
            });

            const rolePart = role ? `, role="${role}"` : '';
            flowGateSection = `
## Flow-Gated Development（強制工作流 — 依序執行，不可跳步）

本任務已啟用流程圖閘門。**閘門 B 未通過前，update_task_status(completed) 會被拒絕。**

${FLOW_NODE_LEVEL_SPEC}

**步驟：**
1. **檢查既有圖**：呼叫 get_task_flows(taskId="${task.id}"${rolePart}) 看已有哪些圖（雙角色任務 spec-flow 共用，已存在就沿用不重畫）
${flowState.specExpected ? `2. **spec-flow**：完整讀取 SA/SD 規格文件後，畫出**規格要求的業務流程圖**，呼叫 save_task_flow(taskId="${task.id}", flowType="spec", mermaidContent=..., filename=規格檔名)` : `2. 此任務無 SA/SD 規格文件 → **兩圖模式**（跳過 spec-flow，閘門改為與任務描述自洽比對）`}
3. **plan-flow**：畫出「我打算怎麼實作」的業務步驟流程圖，save_task_flow(taskId="${task.id}", flowType="plan"${rolePart})
4. **閘門 A**：依工具回應的指示做涵蓋比對，report_flow_check(taskId="${task.id}", gate="A", passed=..., diffs=...${rolePart})。**通過前不可寫 code**
5. **實作**：嚴格照 plan-flow 進行（複雜任務建議先產 mindmap 細節覆蓋清單：save_task_flow flowType="mindmap"）
6. **code-flow**：實作完成後，從**實際程式碼**反推業務流程圖，save_task_flow(taskId="${task.id}", flowType="code"${rolePart})
7. **閘門 B**：依工具回應的比對準則做語意比對（建議由主 session 執行，不要由寫 code 的 subagent 自評），report_flow_check(gate="B", ...)。不符 → 修正後重存 code-flow（失敗上限 ${GATE_B_MAX_FAILURES} 次，達上限標 [NEEDS_HUMAN] 回報使用者）
8. **閘門 B 通過後才跑測試**；測試通過才 update_task_status(taskId="${task.id}", status="completed")
`;
          } else {
            // ── light 軌：不設 flow_required、不初始化 role gate ──
            // update_task_status 的 flow 閘門只擋 flow_required=1 的任務，
            // light 軌不啟用即不受擋；規格回對閘門（checklist + AI 回對）照常生效。
            mutateFlowState(db, task.id, (s) => {
              s.track = 'light';
              s.trackReason = trackReason;
            });
          }

          // 留痕：判軌結果寫入 agent_outputs（Web UI 終端可見）。只在首次判軌
          // 或軌道變更時寫，避免重複呼叫 get_execution_plan 灌噪音。
          if (prevTrack !== effectiveTrack) {
            logTaskOutput(db, task.id, task.project_id, `[TRACK] ${effectiveTrack} — ${trackReason}`);
          }

          // full→light 覆寫時 flow_required 不降級（保守），聲明必須如實反映閘門仍生效
          const flowStillRequired = (db.prepare('SELECT flow_required FROM tasks WHERE id = ?').get(task.id) as { flow_required: number | null }).flow_required === 1;
          const lightFlowLine = flowStillRequired
            ? `⚠ 注意：此任務先前已啟用 Flow-Gated 閘門，閘門**不降級**——結案仍需通過閘門 B（或使用者明確同意 skipFlowGate）。規格回對標準不變：`
            : `本任務跳過 Flow-Gated 流程圖閘門，但規格回對標準不變：`;
          const trackSection = effectiveTrack === 'light'
            ? `## 任務軌道：LIGHT（輕量修復流程）
判定依據：${trackReason}
${lightFlowLine}
- 檢查表來源 = 原始 BUG 內容（任務描述 + Asana 留言 + 附件截圖）
- 完成前一樣要 AI 回對（missing=0 才能標 completed）
如需完整流程，重新呼叫 get_execution_plan(taskId="${task.id}", track="full")。

`
            : `## 任務軌道：FULL（規格驅動流程）
判定依據：${trackReason}

`;

          const header = trackSection + `**Task ID:** ${task.id}
**Role:** ${effectiveRole}
**Workspace:** ${data.workingDir}
**Frontend Path:** ${data.frontendPath || 'N/A'}
**Backend Path:** ${data.backendPath || 'N/A'}
**Model:** ${data.model}

## MCP 進度回報（必須執行）

你可以使用 OmniCommander MCP 工具回報執行狀態到 Web UI 監控介面。**請在以下時機呼叫這些工具**：

1. **開始執行時**：呼叫 \`report_milestone\`，taskId 為 \`${task.id}\`，milestone 為「開始執行」
2. **每完成一個重要步驟時**：呼叫 \`report_output\`，taskId 為 \`${task.id}\`，content 為你正在做什麼的簡短描述
3. **關鍵節點**：呼叫 \`report_milestone\`（例如「讀取規格文件完成」「程式碼實作完成」「Build 通過」）
4. **完成時**：呼叫 \`update_task_status\`，taskId 為 \`${task.id}\`，status 為 "completed"，summary 為完成摘要
5. **失敗時**：呼叫 \`update_task_status\`，taskId 為 \`${task.id}\`，status 為 "failed"，summary 為失敗原因

**⚠ 重要：任務結束前必須呼叫 update_task_status，否則任務會一直卡在 in_progress 狀態。不論成功或失敗，都必須回報。**

這些呼叫會讓 Web UI 即時顯示你的 agent 狀態和輸出。
${flowGateSection}
---

`;
          return { content: [{ type: 'text' as const, text: header + data.prompt }] };
        }

        let errorDetail = '';
        try { errorDetail = await response.text(); } catch { /* ignore */ }
        return { content: [{ type: 'text' as const, text: `Error: Web Server returned ${response.status}. ${errorDetail}` }], isError: true };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: Could not connect to Web Server at ${baseUrl}. ${msg}` }], isError: true };
      }
    },
  );

  // ── update_task_status ────────────────────────────────────
  server.tool(
    'update_task_status',
    'Update the status of a task. Use this to mark tasks as in_progress, completed, or failed. For flow-gated tasks, "completed" is rejected until gate B has passed for every required role. Tasks with a spec checklist additionally require the latest run_spec_compliance run to have missing=0. Projects with frontendTestCommand/backendTestCommand configured additionally require a passing "單元測試全數通過" verification report (report_verification_result) for the task\'s side(s). skipFlowGate=true (with skipReason, only with explicit user approval) overrides all these gates.',
    {
      taskId: z.string().describe('The task ID'),
      status: z.enum(['in_progress', 'completed', 'failed']).describe('New task status'),
      summary: z.string().optional().describe('Optional result summary (recommended for completed/failed)'),
      skipFlowGate: z.boolean().optional().describe('Skip the flow-gate completion check. ONLY with explicit user approval; requires skipReason and is logged as [SKIP].'),
      skipReason: z.string().optional().describe('Reason for skipping the flow gate (required when skipFlowGate=true)'),
    },
    { title: 'Update Task Status', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ taskId, status, summary, skipFlowGate, skipReason }) => {
      const db = getMcpDb();

      // Read → validate → write runs inside an IMMEDIATE transaction so a
      // concurrent process cannot interleave (TOCTOU). Notify HTTP calls stay outside.
      type TxnResult =
        | { kind: 'error'; message: string }
        | { kind: 'ok'; projectId: string; stoppedAgent: boolean };

      const txn = db.transaction((): TxnResult => {
        const task = db.prepare('SELECT id, project_id, status, label, flow_required FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; status: string; label: string; flow_required: number | null } | undefined;
        if (!task) {
          return { kind: 'error', message: `Error: Task "${taskId}" not found` };
        }

        // [I2] State transition validation ([A11] failed → in_progress allows retry)
        const allowedTransitions: Record<string, string[]> = {
          'pending': ['in_progress'],
          'queued': ['in_progress'],
          'assigned': ['in_progress'],
          'in_progress': ['completed', 'failed'],
          'failed': ['in_progress'],
        };
        const allowed = allowedTransitions[task.status];
        if (!allowed || !allowed.includes(status)) {
          return { kind: 'error', message: `Error: Invalid state transition "${task.status}" → "${status}". Allowed transitions from "${task.status}": ${allowed ? allowed.join(', ') : 'none (terminal state)'}` };
        }

        // ── Flow-Gated Development: exit gate ──
        // Only 'completed' on flow_required tasks is gated; in_progress/failed pass through.
        if (status === 'completed' && task.flow_required === 1) {
          const flowState = getFlowState(db, taskId);
          const blockers = getCompletionBlockers(flowState);
          if (blockers.length > 0) {
            if (skipFlowGate) {
              if (!skipReason || !skipReason.trim()) {
                return { kind: 'error', message: 'Error: skipFlowGate=true 需要 skipReason（使用者同意跳過閘門的原因）。' };
              }
              mutateFlowState(db, taskId, (s) => {
                s.skipped = { reason: skipReason.trim(), at: new Date().toISOString() };
              });
              logTaskOutput(db, taskId, task.project_id, `[SKIP] 使用者跳過 Flow-Gated 閘門檢查：${skipReason.trim()}`);
            } else {
              const lines = blockers.map(b => `- role=${b.role}: ${b.missing}`).join('\n');
              return {
                kind: 'error',
                message: `Error: 任務尚未通過 Flow-Gated 閘門，不可標記 completed。缺少的步驟：
${lines}

請依序補完（save_task_flow → report_flow_check），閘門 B 通過並跑完測試後再結案。
若使用者明確同意跳過閘門，改用 skipFlowGate=true + skipReason 重新呼叫。`,
              };
            }
          }
        }

        // ── Spec Compliance: exit gate（AI 規格回對）──
        // 有未 waived 的 checklist 項目（含 logic——AI 看得懂 code，logic 也驗）時，
        // 要求「存在至少一次 AI 回對 run（source='ai_review'）且最新一次的 missing=0」。
        // 程式預檢（source='engine'）僅 advisory，不解鎖此閘門。
        // 無 checklist 的任務完全不受影響（向後相容）。
        // 沿用 skipFlowGate+skipReason 跳過（訊息注明跳過的是規格回對閘門）。
        // 只做同步 DB 查詢（在 immediate transaction 內）。
        if (status === 'completed') {
          const checklistCount = (db.prepare(
            'SELECT COUNT(*) as c FROM spec_checklist_items WHERE task_id = ? AND waived = 0'
          ).get(taskId) as { c: number }).c;

          // Checklist enforcement: a task that obtained an execution plan (flow_state
          // has track) must have a checklist before completion — otherwise the light
          // track would have no structural gate at all when the agent skips
          // save_spec_checklist (輕的是工序，不是標準). Legacy tasks (no track) unaffected.
          const gateTrack = getFlowState(db, taskId)?.track;
          if (checklistCount === 0 && gateTrack) {
            if (skipFlowGate) {
              if (!skipReason || !skipReason.trim()) {
                return { kind: 'error', message: 'Error: skipFlowGate=true 需要 skipReason（使用者同意跳過閘門的原因）。' };
              }
              logTaskOutput(db, taskId, task.project_id, `[SKIP] 使用者跳過規格回對閘門（未建立檢查表）：${skipReason.trim()}`);
            } else {
              return {
                kind: 'error',
                message: `Error: 此任務走 ${gateTrack} 軌但尚未建立規格檢查表，不可標記 completed。
請先呼叫 save_spec_checklist(taskId="${taskId}", items=[...])（${gateTrack === 'light' ? 'light 軌：從原始 BUG 內容抽「修復後預期行為」' : '從 SA/SD 規格逐字抽取'}），
再執行 AI 規格回對（get_compliance_review_plan → save_compliance_review），missing=0 後結案。
若使用者明確同意跳過，改用 skipFlowGate=true + skipReason 重新呼叫（會記錄 [SKIP]）。`,
              };
            }
          }

          if (checklistCount > 0) {
            const run = db.prepare(
              "SELECT id, run_at, missing, results_json FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review' ORDER BY run_at DESC, rowid DESC LIMIT 1"
            ).get(taskId) as { id: string; run_at: string; missing: number; results_json: string } | undefined;

            // Staleness guard: checklist items added after the latest AI review were
            // never verified — a clean-but-stale review must not unlock completion.
            const staleCount = run ? (db.prepare(
              'SELECT COUNT(*) as c FROM spec_checklist_items WHERE task_id = ? AND waived = 0 AND created_at > ?'
            ).get(taskId, run.run_at) as { c: number }).c : 0;

            const complianceBlocked = !run || run.missing > 0 || staleCount > 0;
            if (complianceBlocked) {
              if (skipFlowGate) {
                if (!skipReason || !skipReason.trim()) {
                  return { kind: 'error', message: 'Error: skipFlowGate=true 需要 skipReason（使用者同意跳過閘門的原因）。' };
                }
                logTaskOutput(db, taskId, task.project_id, `[SKIP] 使用者跳過規格回對閘門（AI 回對）：${skipReason.trim()}`);
              } else if (run && run.missing === 0 && staleCount > 0) {
                return {
                  kind: 'error',
                  message: `Error: 規格檢查表在最後一次 AI 規格回對之後新增了 ${staleCount} 項（尚未驗證），不可標記 completed。
請重新執行 AI 規格回對（get_compliance_review_plan(taskId="${taskId}") 派獨立 reviewer → save_compliance_review）讓所有項目都經過驗證。`,
                };
              } else if (!run) {
                return {
                  kind: 'error',
                  message: `Error: 此任務有 ${checklistCount} 項規格檢查表項目，但尚未執行 AI 規格回對，不可標記 completed。
請先執行 AI 規格回對：呼叫 get_compliance_review_plan(taskId="${taskId}") 取得派工計畫，由 orchestrator 派**獨立 reviewer** 逐項驗證後 save_compliance_review，missing 為 0 後再結案。
（run_spec_compliance 只是程式預檢，不解鎖此閘門。）
若使用者明確同意跳過，改用 skipFlowGate=true + skipReason 重新呼叫（會記錄 [SKIP]）。`,
                };
              } else {
                const missingItems = parseJson<Array<{ content?: string; itemType?: string; note?: string; status?: string }>>(run.results_json, [])
                  .filter(r => r.status === 'missing');
                const lines = missingItems.slice(0, 10)
                  .map(r => `- [${r.itemType || '?'}] ${r.content || '(unknown)'}${r.note ? ` — ${r.note}` : ''}`);
                const more = missingItems.length > 10 ? `\n（其餘 ${missingItems.length - 10} 項略——get_spec_checklist 有完整清單）` : '';
                return {
                  kind: 'error',
                  message: `Error: AI 規格回對未通過（missing ${run.missing} 項），不可標記 completed。缺少的實作：
${lines.join('\n')}${more}

修正後**重新執行 AI 規格回對**（get_compliance_review_plan(taskId="${taskId}") → 獨立 reviewer → save_compliance_review），或對有正當理由的項目用 waive_checklist_item(itemId, reason) 豁免後重新回對。
若使用者明確同意跳過閘門，改用 skipFlowGate=true + skipReason 重新呼叫（會記錄 [SKIP]）。`,
                };
              }
            }
          }
        }

        // ── Unit Test: exit gate（單元測試驗收閘門）──
        // 專案設定 testCommand（frontendTestCommand / backendTestCommand）時，該任務
        // 對應 side 的「單元測試全數通過」驗收項必須有**最新一筆 passed=true** 的
        // report_verification_result 回報才可標 completed。哪些 side 需要與
        // get_verification_plan 共用 getRequiredUnitTestItems（單一真相，避免規則漂移）。
        // 沒設 testCommand 的專案此閘門不存在（行為與既有完全一致）。
        // 沿用 skipFlowGate+skipReason 跳過（記 [SKIP] 供稽核）。只做同步 DB 查詢。
        if (status === 'completed') {
          const projRow = db.prepare('SELECT config_json FROM projects WHERE id = ?').get(task.project_id) as { config_json: string | null } | undefined;
          const requiredUnitItems = getRequiredUnitTestItems(task.label, parseTestCommands(projRow?.config_json));
          const unitFailures: string[] = [];
          for (const item of requiredUnitItems) {
            const latest = findLatestUnitTestVerification(db, taskId, item);
            if (!latest) {
              unitFailures.push(`- 單元測試閘門：此專案設定了 ${item.side}TestCommand（${item.command}），但「單元測試全數通過」尚無通過的驗收回報。請在 ${item.side} workspace 執行測試並用 report_verification_result(taskId="${taskId}", results=[{item:"${item.id}", passed:true, note:"..."}]) 回報後再標 completed。`);
            } else if (!latest.passed) {
              unitFailures.push(`- 單元測試閘門：此專案設定了 ${item.side}TestCommand（${item.command}），但「單元測試全數通過」最新一筆驗收回報為未通過（FAIL）。請修復後重跑測試，並用 report_verification_result(taskId="${taskId}", results=[{item:"${item.id}", passed:true, note:"..."}]) 重新回報後再標 completed。`);
            }
          }
          if (unitFailures.length > 0) {
            if (skipFlowGate) {
              if (!skipReason || !skipReason.trim()) {
                return { kind: 'error', message: 'Error: skipFlowGate=true 需要 skipReason（使用者同意跳過閘門的原因）。' };
              }
              logTaskOutput(db, taskId, task.project_id, `[SKIP] 使用者跳過單元測試閘門：${skipReason.trim()}`);
            } else {
              return {
                kind: 'error',
                message: `Error: 單元測試閘門未通過，不可標記 completed。
${unitFailures.join('\n')}

（提醒：既有的**無關失敗**不卡你——${UNRELATED_TEST_FAILURE_RULE}，並建議使用者執行 get_test_baseline_plan 做基線修復。）
若使用者明確同意跳過閘門，改用 skipFlowGate=true + skipReason 重新呼叫（會記錄 [SKIP]）。`,
              };
            }
          }
        }

        const sets = [`status = ?`, `updated_at = datetime('now')`];
        const values: unknown[] = [status];

        if (summary) {
          sets.push('result_summary = ?');
          values.push(summary);
        }

        values.push(taskId);
        db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

        // [C1] When task completes/fails, also stop THIS task's synthetic MCP agent only
        let stoppedAgent = false;
        if (status === 'completed' || status === 'failed') {
          const agentResult = db.prepare(
            `UPDATE agents SET status = 'stopped', updated_at = datetime('now') WHERE id = ? AND status = 'running'`
          ).run(`mcp-${taskId}`);
          stoppedAgent = agentResult.changes > 0;
        }

        return { kind: 'ok', projectId: task.project_id, stoppedAgent };
      });

      const result = txn.immediate();
      if (result.kind === 'error') {
        return { content: [{ type: 'text' as const, text: result.message }], isError: true };
      }

      let notifyWarning = '';
      if (result.stoppedAgent) {
        // Notify Web UI about agent completion
        const ok = await notifyWebServer({
          event: 'agent.completed',
          data: { projectId: result.projectId, agentId: `mcp-${taskId}`, status: 'stopped' },
        });
        if (!ok) {
          notifyWarning = ' (warning: agent.completed notification to Web UI failed)';
        }
      }

      // Notify Web Server about task status change
      const taskNotifyOk = await notifyWebServer({
        event: 'task.statusChange',
        data: { taskId, projectId: result.projectId, status, newStatus: status, summary: summary || null },
      });
      if (!taskNotifyOk) {
        notifyWarning += ' (warning: task.statusChange notification to Web UI failed)';
      }

      return { content: [{ type: 'text' as const, text: `Task ${taskId} status updated to "${status}"${notifyWarning}` }] };
    },
  );

  // ── list_asana_projects ────────────────────────────────────
  server.tool(
    'list_asana_projects',
    '列出 Asana workspace 的所有專案。用於找到 project GID 來綁定本地專案。',
    {},
    { title: 'List Asana Projects', readOnlyHint: true, openWorldHint: true },
    async () => {
      const db = getMcpDb();

      try {
        // Get Asana PAT
        const asanaPat = getAsanaPat(db);
        if (!asanaPat) {
          return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured. Use set_global_config to set asana.pat.' }], isError: true };
        }

        // Get current user's workspaces
        const userRes = await fetch(`${ASANA_API_BASE}/users/me`, {
          headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
        });
        if (!userRes.ok) {
          return { content: [{ type: 'text' as const, text: `Asana API error: ${userRes.status} ${await userRes.text()}` }], isError: true };
        }
        const userData = await userRes.json() as { data?: { workspaces?: Array<{ gid: string; name: string }> } };
        const workspaces = userData.data?.workspaces || [];

        if (workspaces.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No workspaces found for this Asana user.' }] };
        }

        // Fetch projects from all workspaces
        const allProjects: Array<{ gid: string; name: string; workspace: string }> = [];
        for (const ws of workspaces) {
          const res = await fetch(`${ASANA_API_BASE}/projects?workspace=${ws.gid}&limit=100&opt_fields=name,archived`, {
            headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
          });
          if (!res.ok) continue;
          const data = await res.json() as { data?: Array<{ gid: string; name: string; archived: boolean }> };
          const projects = (data.data || []).filter(p => !p.archived);
          allProjects.push(...projects.map(p => ({ gid: p.gid, name: p.name, workspace: ws.name })));
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ count: allProjects.length, projects: allProjects }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error fetching Asana projects: ${msg}` }], isError: true };
      }
    },
  );

  // ── get_asana_task_comments ───────────────────────────────
  server.tool(
    'get_asana_task_comments',
    '取得 Asana 任務的評論/故事。可傳 taskId（omni UUID，自動查 sourceRef）或 taskGid（Asana GID）。回傳包含 authorGid 供精確比對。',
    {
      taskId: z.string().optional().describe('Omni task UUID — 會自動從 DB 查 sourceRef (Asana GID)'),
      taskGid: z.string().optional().describe('Asana 任務 GID（直接傳，跳過 DB 查詢）'),
    },
    { title: 'Get Asana Task Comments', readOnlyHint: true, openWorldHint: true },
    async ({ taskId, taskGid }) => {
      const db = getMcpDb();

      // Resolve GID
      let resolvedGid = taskGid;
      if (!resolvedGid && taskId) {
        const row = db.prepare('SELECT source_ref FROM tasks WHERE id = ?').get(taskId) as { source_ref: string | null } | undefined;
        if (!row) return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
        if (!row.source_ref) return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" has no Asana sourceRef (not synced from Asana)` }], isError: true };
        resolvedGid = row.source_ref;
      }
      if (!resolvedGid) {
        return { content: [{ type: 'text' as const, text: 'Error: Must provide either taskId or taskGid' }], isError: true };
      }

      try {
        const asanaPat = getAsanaPat(db);
        if (!asanaPat) {
          return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured. Use set_global_config to set asana.pat.' }], isError: true };
        }

        const res = await fetch(`${ASANA_API_BASE}/tasks/${resolvedGid}/stories?opt_fields=type,text,created_by.gid,created_by.name,created_by.email,created_at`, {
          headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) {
          return { content: [{ type: 'text' as const, text: `Asana API error: ${res.status} ${await res.text()}` }], isError: true };
        }

        const data = await res.json() as { data?: Array<{ type: string; text: string; created_by?: { gid: string; name: string; email?: string }; created_at: string }> };
        const comments = (data.data || [])
          .filter(s => s.type === 'comment')
          .map(s => ({
            authorGid: s.created_by?.gid || null,
            author: s.created_by?.name || 'Unknown',
            authorEmail: s.created_by?.email || null,
            text: s.text,
            createdAt: s.created_at,
          }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ taskGid: resolvedGid, count: comments.length, comments }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error fetching Asana comments: ${msg}` }], isError: true };
      }
    },
  );

  // ── sync_asana_tasks ──────────────────────────────────────
  // Track last sync per project (in-memory, resets on MCP server restart)
  const lastSyncAt = new Map<string, string>();
  // In-process cooldown for the post-sync spec change check (per project)
  const lastSpecCheckAt = new Map<string, number>();
  const SPEC_CHECK_COOLDOWN_MS = 10 * 60 * 1000;

  server.tool(
    'sync_asana_tasks',
    'Sync Asana tasks for a project. Fetches tasks from Asana and upserts into local DB. Checks last sync time — if synced within 5 minutes, returns cached. Use force=true to override.',
    {
      projectId: z.string().describe('The project ID'),
      force: z.boolean().optional().describe('Force sync even if recently synced (default: false)'),
    },
    { title: 'Sync Asana Tasks', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ projectId, force }) => {
      const db = getMcpDb();

      try {
        // Check last sync time
        if (!force) {
          const prev = lastSyncAt.get(projectId);
          if (prev) {
            const diffMinutes = (Date.now() - new Date(prev).getTime()) / 60000;
            if (diffMinutes < 5) {
              return { content: [{ type: 'text' as const, text: `Asana tasks already synced ${Math.round(diffMinutes)} minutes ago (${prev}). Use force=true to sync again.` }] };
            }
          }
        }

        // Get project info
        const project = db.prepare('SELECT id, asana_project_gid FROM projects WHERE id = ?').get(projectId) as { id: string; asana_project_gid: string | null } | undefined;
        if (!project) return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
        if (!project.asana_project_gid) return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" has no Asana project GID. Set it in project settings.` }], isError: true };

        // Get Asana PAT from global_config or env
        const asanaPat = getAsanaPat(db);
        if (!asanaPat) return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured. Set it in global settings or ASANA_PAT env var.' }], isError: true };

        // Get current user GID
        const userRes = await fetch(`${ASANA_API_BASE}/users/me`, {
          headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
          signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
        });
        if (!userRes.ok) return { content: [{ type: 'text' as const, text: `Asana API error: ${userRes.status} ${await userRes.text()}` }], isError: true };
        const userData = await userRes.json() as { data?: { gid?: string } };
        const userGid = userData.data?.gid;

        // Fetch all project tasks with pagination.
        // memberships.section.name → 分區(Section)；memberships.project.gid 用來挑出本專案對應的 membership
        // tags.name → 標籤；custom_fields.* → 自訂欄位（用 display_value 落地最穩，enum 另取 enum_value.name 備援）
        const optFields = 'name,notes,due_on,completed,permalink_url,memberships.section.name,memberships.project.gid,tags.name,assignee.name,assignee.gid,custom_fields.name,custom_fields.display_value,custom_fields.enum_value.name,parent.gid,parent.name,parent.notes';
        const allTasks: Array<Record<string, unknown>> = [];
        let nextUrl: string | null = `${ASANA_API_BASE}/tasks?project=${project.asana_project_gid}&limit=100&completed_since=now&opt_fields=${optFields}`;

        while (nextUrl) {
          const res = await fetch(nextUrl, {
            headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
          });
          if (!res.ok) return { content: [{ type: 'text' as const, text: `Asana API error fetching tasks: ${res.status}` }], isError: true };
          const data = await res.json() as { data?: Record<string, unknown>[]; next_page?: { uri?: string } };
          allTasks.push(...(data.data || []));
          nextUrl = data.next_page?.uri || null;
        }

        // Filter to tasks assigned to me
        const myTasks = userGid ? allTasks.filter(t => (t['assignee'] as Record<string, unknown> | null)?.['gid'] === userGid) : allTasks;

        // Get existing Asana tasks in local DB
        const existingTasks = db.prepare('SELECT id, title, description, label, status, source_ref, parent_name, section, tags, custom_fields FROM tasks WHERE project_id = ? AND source = ?').all(projectId, 'asana') as Array<{
          id: string; title: string; description: string | null; label: string; status: string; source_ref: string | null; parent_name: string | null;
          section: string | null; tags: string | null; custom_fields: string | null;
        }>;
        const existingByGid = new Map(existingTasks.filter(t => t.source_ref).map(t => [t.source_ref!, t]));

        let newCount = 0, updatedCount = 0;

        // --- Asana 分類維度抽取 ---
        // Section：一張 task 在不同 project 會有多筆 membership，挑出本專案 (asana_project_gid) 對應的那筆
        const extractSection = (task: Record<string, unknown>): string | null => {
          const memberships = task['memberships'] as Array<{ project?: { gid?: string }; section?: { name?: string } }> | undefined;
          if (!memberships || memberships.length === 0) return null;
          const match = memberships.find(m => m.project?.gid === project.asana_project_gid) || memberships[0];
          return match?.section?.name || null;
        };
        // Tags：字串陣列
        const extractTags = (task: Record<string, unknown>): string[] => {
          const tags = task['tags'] as Array<{ name?: string }> | undefined;
          return (tags || []).map(t => t.name).filter((n): n is string => !!n);
        };
        // 自訂欄位：name -> display_value（enum/text/number 都能拿到字串；display_value 缺則退回 enum_value.name）
        const extractCustomFields = (task: Record<string, unknown>): Record<string, string> => {
          const cfs = task['custom_fields'] as Array<{ name?: string; display_value?: string | null; enum_value?: { name?: string } | null }> | undefined;
          const obj: Record<string, string> = {};
          for (const cf of cfs || []) {
            if (!cf.name) continue;
            const v = cf.display_value ?? cf.enum_value?.name ?? null;
            if (v !== null && v !== undefined && String(v) !== '') obj[cf.name] = String(v);
          }
          return obj;
        };

        // Label / task type detection: shared pure module (utils/taskClassification)
        // — same logic as TaskClassifier on the Web-server sync path.

        // Upsert: create new tasks, update existing if changed.
        // Runs in a single transaction — no half-synced state on failure, and much faster.
        // Label is decided only at INSERT time; updates never overwrite it (preserves manual corrections).
        db.transaction(() => {
          for (const asanaTask of myTasks) {
            const gid = String(asanaTask['gid'] || '');
            const name = String(asanaTask['name'] || '');
            const notes = String(asanaTask['notes'] || '');
            const description = notes.length > 2000 ? notes.substring(0, 2000) + '...' : notes;
            const parentRaw = asanaTask['parent'] as { name?: string } | null | undefined;
            const parentName = parentRaw?.name || null;

            // Asana 分類維度
            const section = extractSection(asanaTask);
            const tagsJson = JSON.stringify(extractTags(asanaTask));
            const customFieldsJson = JSON.stringify(extractCustomFields(asanaTask));
            const assigneeRaw = asanaTask['assignee'] as { name?: string; gid?: string } | null | undefined;
            const assigneeName = assigneeRaw?.name || null;
            const assigneeGid = assigneeRaw?.gid || null;

            const existing = existingByGid.get(gid);

            if (existing) {
              const titleChanged = existing.title !== name;
              const descChanged = (existing.description || '') !== description;
              const parentChanged = (existing.parent_name || '') !== (parentName || '');
              const sectionChanged = (existing.section || null) !== (section || null);
              const tagsChanged = (existing.tags || '[]') !== tagsJson;
              const cfChanged = (existing.custom_fields || '{}') !== customFieldsJson;

              if (titleChanged || descChanged || parentChanged || sectionChanged || tagsChanged || cfChanged) {
                db.prepare("UPDATE tasks SET title = ?, description = ?, parent_name = ?, section = ?, tags = ?, custom_fields = ?, assignee = ?, assignee_gid = ?, updated_at = datetime('now') WHERE id = ?")
                  .run(name, description || null, parentName, section, tagsJson, customFieldsJson, assigneeName, assigneeGid, existing.id);
                updatedCount++;
              }
            } else {
              const taskId = crypto.randomUUID();
              db.prepare(`INSERT INTO tasks (id, project_id, title, description, label, status, priority, task_type, source, source_ref, parent_name, section, tags, custom_fields, assignee, assignee_gid, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'asana', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
                .run(taskId, projectId, name, description || null, detectLabel(name), detectTaskType(name, notes), gid, parentName, section, tagsJson, customFieldsJson, assigneeName, assigneeGid);
              newCount++;
            }
          }
        })();

        const syncTime = new Date().toISOString();
        lastSyncAt.set(projectId, syncTime);

        // Notify Web Server if available (best-effort, non-blocking)
        notifyWebServer({ event: 'asana.syncResult', data: { projectId, newTasks: newCount, updatedTasks: updatedCount, removedTasks: 0, lastSyncAt: syncTime } }).catch(() => {});

        // ── Auto spec change check (best-effort — never fails the sync) ──
        // Only in_progress tasks that have recorded spec versions; zero cost
        // (no SVN touched) when there are none. Per-project 10-min cooldown.
        let specChangeCheck: Record<string, unknown>;
        const specTargets = db.prepare(`
          SELECT t.id, t.project_id, t.title FROM tasks t
          WHERE t.project_id = ? AND t.status = 'in_progress'
            AND EXISTS (SELECT 1 FROM task_spec_versions v WHERE v.task_id = t.id)
        `).all(projectId) as SpecChangeTarget[];

        if (specTargets.length === 0) {
          specChangeCheck = { checked: 0, changed: 0, skipped: 'no_tasks_with_spec_versions' };
        } else {
          const prevCheck = lastSpecCheckAt.get(projectId);
          if (prevCheck !== undefined && Date.now() - prevCheck < SPEC_CHECK_COOLDOWN_MS) {
            specChangeCheck = { checked: 0, changed: 0, skipped: 'cooldown' };
          } else {
            try {
              const check = await runSpecChangeCheck(db, specTargets);
              lastSpecCheckAt.set(projectId, Date.now());
              specChangeCheck = { checked: check.tasksChecked, changed: check.changedTotal };
              if (check.changedTotal > 0) {
                specChangeCheck['warning'] = `發現 ${check.changedTotal} 個規格檔案有新版，已建立 spec gap（category=spec_changed）。請重新 fetch_svn_specs 並確認實作影響。`;
              }
            } catch (specErr: unknown) {
              // best-effort: SVN failure must not fail the sync
              const specMsg = specErr instanceof Error ? specErr.message : String(specErr);
              specChangeCheck = { checked: 0, changed: 0, error: `規格異動檢查失敗（不影響同步結果）：${specMsg}` };
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Asana sync completed: +${newCount} new, ~${updatedCount} updated. Total fetched: ${myTasks.length}. Last sync: ${syncTime}`,
              newTasks: newCount,
              updatedTasks: updatedCount,
              totalFetched: myTasks.length,
              lastSyncAt: syncTime,
              specChangeCheck,
            }, null, 2),
          }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Asana sync error: ${msg}` }], isError: true };
      }
    },
  );
}
