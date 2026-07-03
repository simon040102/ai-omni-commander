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
} from '../flow-gate.js';
import type { TaskStatus, TaskLabel, TaskType, TaskSource } from '@omni/shared';

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

/** Safely parse a JSON column; returns fallback on null/invalid. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
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
    },
    async ({ projectId, taskType, label, keyword, section, tag, statuses }) => {
      const db = getMcpDb();
      const statusList = statuses && statuses.length > 0 ? statuses : ['pending', 'queued', 'assigned'];
      const placeholders = statusList.map(() => '?').join(',');

      let sql = `
        SELECT id, title, description, label, status, priority, task_type, preferred_model, parent_name, source_ref,
               section, tags, custom_fields, assignee, assignee_gid
        FROM tasks
        WHERE project_id = ? AND status IN (${placeholders})
      `;
      const params: unknown[] = [projectId, ...statusList];

      if (taskType) {
        sql += ' AND task_type = ?';
        params.push(taskType);
      }
      if (label) {
        sql += ' AND label = ?';
        params.push(label);
      }
      if (keyword) {
        sql += ' AND (title LIKE ? OR description LIKE ?)';
        const like = `%${keyword}%`;
        params.push(like, like);
      }
      if (section) {
        sql += ' AND section = ?';
        params.push(section);
      }
      if (tag) {
        // tags stored as JSON array of names; match if any element equals the tag (exact)
        sql += ' AND EXISTS (SELECT 1 FROM json_each(tasks.tags) WHERE json_each.value = ?)';
        params.push(tag);
      }

      sql += ' ORDER BY priority DESC, created_at ASC';

      const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

      // Parse JSON dimensions for output; back-compat: old tasks → [] / {} / null
      const tasks = rows.map(r => ({
        ...r,
        tags: parseJson<string[]>(r['tags'], []),
        custom_fields: parseJson<Record<string, string>>(r['custom_fields'], {}),
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ projectId, count: tasks.length, tasks }, null, 2),
        }],
      };
    },
  );

  // ── get_execution_plan ────────────────────────────────────
  server.tool(
    'get_execution_plan',
    'Get a complete execution plan for a task. Returns prompt, workspace paths (frontendPath + backendPath), and model. Use role param to get role-specific plan (frontend/backend). Orchestrator should ask user "前端、後端、還是都做？" before calling.',
    {
      taskId: z.string().describe('The task ID to generate an execution plan for'),
      role: z.enum(['frontend', 'backend']).optional().describe('Override role for plan generation. Omit to use task label.'),
    },
    async ({ taskId, role }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const notifyUrl = process.env['NOTIFY_URL'] || 'http://localhost:3457/api/mcp-notify';
      const baseUrl = notifyUrl.replace('/api/mcp-notify', '');
      const roleParam = role ? `?role=${role}` : '';

      try {
        const response = await fetch(`${baseUrl}/api/execution-plan/${taskId}${roleParam}`, {
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          const data = await response.json() as {
            prompt: string; workingDir: string; model: string;
            frontendPath: string | null; backendPath: string | null;
          };

          const effectiveRole = role || task.label;

          // ── Flow-Gated Development: initialize state machine ──
          // flow_required is set only AFTER the plan is successfully fetched (review M6).
          // flow_state is merged, never overwritten (review C2): existing flows/gates/
          // failure counters survive repeated get_execution_plan calls.
          const flowRole = resolveRole(role || (task.label === 'frontend' || task.label === 'backend' ? task.label : undefined));
          const specExpected = detectSpecDocuments(db, task.id, task.project_id);
          db.prepare("UPDATE tasks SET flow_required = 1, updated_at = datetime('now') WHERE id = ?").run(task.id);
          const flowState = mutateFlowState(db, task.id, (s) => {
            // upgrade-only: adding docs later upgrades to three-flow mode; never downgrade (review I-1)
            s.specExpected = s.specExpected || specExpected;
            getRoleState(s, flowRole).required = true;
          });

          const rolePart = role ? `, role="${role}"` : '';
          const flowGateSection = `
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

          const header = `**Task ID:** ${task.id}
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
    'Update the status of a task. Use this to mark tasks as in_progress, completed, or failed. For flow-gated tasks, "completed" is rejected until gate B has passed for every required role — skipFlowGate=true (with skipReason, only with explicit user approval) overrides.',
    {
      taskId: z.string().describe('The task ID'),
      status: z.enum(['in_progress', 'completed', 'failed']).describe('New task status'),
      summary: z.string().optional().describe('Optional result summary (recommended for completed/failed)'),
      skipFlowGate: z.boolean().optional().describe('Skip the flow-gate completion check. ONLY with explicit user approval; requires skipReason and is logged as [SKIP].'),
      skipReason: z.string().optional().describe('Reason for skipping the flow gate (required when skipFlowGate=true)'),
    },
    async ({ taskId, status, summary, skipFlowGate, skipReason }) => {
      const db = getMcpDb();

      const task = db.prepare('SELECT id, project_id, status, flow_required FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; status: string; flow_required: number | null } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // [I2] State transition validation
      const allowedTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'queued': ['in_progress'],
        'assigned': ['in_progress'],
        'in_progress': ['completed', 'failed'],
      };
      const allowed = allowedTransitions[task.status];
      if (!allowed || !allowed.includes(status)) {
        return {
          content: [{ type: 'text' as const, text: `Error: Invalid state transition "${task.status}" → "${status}". Allowed transitions from "${task.status}": ${allowed ? allowed.join(', ') : 'none (terminal state)'}` }],
          isError: true,
        };
      }

      // ── Flow-Gated Development: exit gate ──
      // Only 'completed' on flow_required tasks is gated; in_progress/failed pass through.
      if (status === 'completed' && task.flow_required === 1) {
        const flowState = getFlowState(db, taskId);
        const blockers = getCompletionBlockers(flowState);
        if (blockers.length > 0) {
          if (skipFlowGate) {
            if (!skipReason || !skipReason.trim()) {
              return { content: [{ type: 'text' as const, text: 'Error: skipFlowGate=true 需要 skipReason（使用者同意跳過閘門的原因）。' }], isError: true };
            }
            mutateFlowState(db, taskId, (s) => {
              s.skipped = { reason: skipReason.trim(), at: new Date().toISOString() };
            });
            logTaskOutput(db, taskId, task.project_id, `[SKIP] 使用者跳過 Flow-Gated 閘門檢查：${skipReason.trim()}`);
          } else {
            const lines = blockers.map(b => `- role=${b.role}: ${b.missing}`).join('\n');
            return {
              content: [{
                type: 'text' as const,
                text: `Error: 任務尚未通過 Flow-Gated 閘門，不可標記 completed。缺少的步驟：
${lines}

請依序補完（save_task_flow → report_flow_check），閘門 B 通過並跑完測試後再結案。
若使用者明確同意跳過閘門，改用 skipFlowGate=true + skipReason 重新呼叫。`,
              }],
              isError: true,
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

      // [C1] When task completes/fails, also stop synthetic MCP agents
      let notifyWarning = '';
      if (status === 'completed' || status === 'failed') {
        const agentResult = db.prepare(
          `UPDATE agents SET status = 'stopped', updated_at = datetime('now') WHERE id LIKE 'mcp-%' AND project_id = ? AND status = 'running'`
        ).run(task.project_id);

        if (agentResult.changes > 0) {
          // Notify Web UI about agent completion
          const ok = await notifyWebServer({
            event: 'agent.completed',
            data: { projectId: task.project_id, agentId: `mcp-${taskId}`, status: 'stopped' },
          });
          if (!ok) {
            notifyWarning = ' (warning: agent.completed notification to Web UI failed)';
          }
        }
      }

      // Notify Web Server about task status change
      const taskNotifyOk = await notifyWebServer({
        event: 'task.statusChange',
        data: { taskId, projectId: task.project_id, status, summary: summary || null },
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
    async () => {
      const db = getMcpDb();
      const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

      try {
        // Get Asana PAT
        const patRow = db.prepare("SELECT value FROM global_config WHERE key = 'asana.pat'").get() as { value: string } | undefined;
        const asanaPat = patRow?.value || process.env['ASANA_PAT'];
        if (!asanaPat) {
          return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured. Use set_global_config to set asana.pat.' }], isError: true };
        }

        // Get current user's workspaces
        const userRes = await fetch(`${ASANA_API_BASE}/users/me`, {
          headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
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
    async ({ taskId, taskGid }) => {
      const db = getMcpDb();
      const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

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
        const patRow = db.prepare("SELECT value FROM global_config WHERE key = 'asana.pat'").get() as { value: string } | undefined;
        const asanaPat = patRow?.value || process.env['ASANA_PAT'];
        if (!asanaPat) {
          return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured. Use set_global_config to set asana.pat.' }], isError: true };
        }

        const res = await fetch(`${ASANA_API_BASE}/tasks/${resolvedGid}/stories?opt_fields=type,text,created_by.gid,created_by.name,created_by.email,created_at`, {
          headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
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

  server.tool(
    'sync_asana_tasks',
    'Sync Asana tasks for a project. Fetches tasks from Asana and upserts into local DB. Checks last sync time — if synced within 5 minutes, returns cached. Use force=true to override.',
    {
      projectId: z.string().describe('The project ID'),
      force: z.boolean().optional().describe('Force sync even if recently synced (default: false)'),
    },
    async ({ projectId, force }) => {
      const db = getMcpDb();
      const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

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
        const patRow = db.prepare("SELECT value FROM global_config WHERE key = 'asana.pat'").get() as { value: string } | undefined;
        const asanaPat = patRow?.value || process.env['ASANA_PAT'];
        if (!asanaPat) return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured. Set it in global settings or ASANA_PAT env var.' }], isError: true };

        // Get current user GID
        const userRes = await fetch(`${ASANA_API_BASE}/users/me`, {
          headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
        });
        if (!userRes.ok) return { content: [{ type: 'text' as const, text: `Asana API error: ${userRes.status} ${await userRes.text()}` }], isError: true };
        const userData = await userRes.json() as { data?: { gid?: string } };
        const userGid = userData.data?.gid;

        // Fetch all project tasks with pagination.
        // memberships.section.name → 分區(Section)；memberships.project.gid 用來挑出本專案對應的 membership
        // tags.name → 標籤；custom_fields.* → 自訂欄位（用 display_value 落地最穩，enum 另取 enum_value.name 備援）
        const optFields = 'name,notes,due_on,completed,permalink_url,memberships.section.name,memberships.project.gid,tags.name,assignee.name,assignee.gid,custom_fields.name,custom_fields.display_value,custom_fields.enum_value.name,parent.gid,parent.name,parent.notes';
        let allTasks: Array<Record<string, unknown>> = [];
        let nextUrl: string | null = `${ASANA_API_BASE}/tasks?project=${project.asana_project_gid}&limit=100&completed_since=now&opt_fields=${optFields}`;

        while (nextUrl) {
          const res = await fetch(nextUrl, {
            headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
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

        // Label detection (regex-based)
        const detectLabel = (title: string): string => {
          if (/前端|串接/.test(title)) return 'frontend';
          if (/後端/.test(title)) return 'backend';
          return 'frontend';
        };

        // Task type detection (regex-based)
        const detectTaskType = (title: string, notes: string): string => {
          const text = `${title} ${notes}`.toLowerCase();
          if (/bug|fix|error|crash|broken|fail|issue|problem|wrong|incorrect|失效|錯誤/.test(text)) return 'bug';
          if (/refactor|restructure|reorganize|重構/.test(text)) return 'refactor';
          if (/add|create|implement|build|new|feature|新增|開發/.test(text)) return 'feature';
          return 'other';
        };

        // Upsert: create new tasks, update existing if changed
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
            const newLabel = detectLabel(name);
            const labelChanged = newLabel !== existing.label;
            const sectionChanged = (existing.section || null) !== (section || null);
            const tagsChanged = (existing.tags || '[]') !== tagsJson;
            const cfChanged = (existing.custom_fields || '{}') !== customFieldsJson;

            if (titleChanged || descChanged || parentChanged || labelChanged || sectionChanged || tagsChanged || cfChanged) {
              db.prepare("UPDATE tasks SET title = ?, description = ?, parent_name = ?, label = ?, section = ?, tags = ?, custom_fields = ?, assignee = ?, assignee_gid = ?, updated_at = datetime('now') WHERE id = ?")
                .run(name, description || null, parentName, newLabel, section, tagsJson, customFieldsJson, assigneeName, assigneeGid, existing.id);
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

        const syncTime = new Date().toISOString();
        lastSyncAt.set(projectId, syncTime);

        // Notify Web Server if available (best-effort, non-blocking)
        notifyWebServer({ event: 'asana.syncResult', data: { projectId, newTasks: newCount, updatedTasks: updatedCount, removedTasks: 0, lastSyncAt: syncTime } }).catch(() => {});

        return { content: [{ type: 'text' as const, text: `Asana sync completed: +${newCount} new, ~${updatedCount} updated. Total fetched: ${myTasks.length}. Last sync: ${syncTime}` }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Asana sync error: ${msg}` }], isError: true };
      }
    },
  );
}
