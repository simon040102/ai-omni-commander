/**
 * MCP tools for task execution — the core of the MCP Server.
 * get_task, list_pending_tasks, get_execution_plan, update_task_status
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
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
    'List tasks for a project. Defaults to pending/queued/assigned. Supports filtering by taskType, label, keyword, and custom status list. Returns sourceRef (Asana GID) for direct use with get_asana_task_comments.',
    {
      projectId: z.string().describe('The project ID'),
      taskType: z.string().optional().describe('Filter by task_type (bug/feature/refactor/other)'),
      label: z.string().optional().describe('Filter by label (frontend/backend/fullstack)'),
      keyword: z.string().optional().describe('Search keyword in title or description'),
      statuses: z.array(z.string()).optional().describe('Override status filter (default: ["pending","queued","assigned"])'),
    },
    async ({ projectId, taskType, label, keyword, statuses }) => {
      const db = getMcpDb();
      const statusList = statuses && statuses.length > 0 ? statuses : ['pending', 'queued', 'assigned'];
      const placeholders = statusList.map(() => '?').join(',');

      let sql = `
        SELECT id, title, description, label, status, priority, task_type, preferred_model, parent_name, source_ref
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

      sql += ' ORDER BY priority DESC, created_at ASC';

      const tasks = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

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
    'Get a complete execution plan for a task — includes superpowers methodology, documents, workspace paths, role instructions, completion criteria, and verification requirements. This is the main tool to call before starting task execution.',
    { taskId: z.string().describe('The task ID to generate an execution plan for') },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // Call the Web Server's execution plan API (uses the full ExecutionPipeline.assembleContext)
      const notifyUrl = process.env['NOTIFY_URL'] || 'http://localhost:3457/api/mcp-notify';
      const baseUrl = notifyUrl.replace('/api/mcp-notify', '');

      try {
        const response = await fetch(`${baseUrl}/api/execution-plan/${taskId}`, {
          signal: AbortSignal.timeout(30000),
        });

        if (response.ok) {
          const data = await response.json() as { prompt: string; workingDir: string; model: string };

          // Check if prompt contains SA documents (frontend tasks)
          const hasSaDoc = task.label === 'frontend' && data.prompt.includes('[SA]');
          const saFlowSection = hasSaDoc ? `
## SA 操作流程圖產生

本任務有 SA 規格文件。讀完 SA 文件後，請產生前端操作流程的 Mermaid flowchart（flowchart TD 格式），涵蓋所有主要操作路徑（查詢、新增、編輯、刪除等）和條件分支。
產生後呼叫 \`save_sa_flow\`，傳入 projectId 為 \`${task.project_id}\`、taskId 為 \`${task.id}\`、filename 為 SA 文件檔名、mermaidContent 為流程圖內容。
這會讓 Web UI 的 SA Flow 面板可以顯示流程圖。
` : '';

          // Prepend workspace and MCP progress instructions
          const header = `**Task ID:** ${task.id}
**Workspace:** ${data.workingDir}
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
${saFlowSection}
---

`;
          return { content: [{ type: 'text' as const, text: header + data.prompt }] };
        }

        // Web Server not available — fall back to basic plan from DB
        return { content: [{ type: 'text' as const, text: `Error: Web Server returned ${response.status}. Make sure the OmniCommander web server is running.` }], isError: true };
      } catch {
        return { content: [{ type: 'text' as const, text: `Error: Could not connect to Web Server at ${baseUrl}. Make sure it is running (pnpm dev).` }], isError: true };
      }
    },
  );

  // ── update_task_status ────────────────────────────────────
  server.tool(
    'update_task_status',
    'Update the status of a task. Use this to mark tasks as in_progress, completed, or failed.',
    {
      taskId: z.string().describe('The task ID'),
      status: z.enum(['in_progress', 'completed', 'failed']).describe('New task status'),
      summary: z.string().optional().describe('Optional result summary (recommended for completed/failed)'),
    },
    async ({ taskId, status, summary }) => {
      const db = getMcpDb();

      const task = db.prepare('SELECT id, project_id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; status: string } | undefined;
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

        // Fetch all project tasks with pagination
        const optFields = 'name,notes,due_on,completed,permalink_url,tags.name,parent.gid,parent.name,parent.notes,assignee.gid';
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
        const existingTasks = db.prepare('SELECT id, title, description, label, status, source_ref, parent_name FROM tasks WHERE project_id = ? AND source = ?').all(projectId, 'asana') as Array<{
          id: string; title: string; description: string | null; label: string; status: string; source_ref: string | null; parent_name: string | null;
        }>;
        const existingByGid = new Map(existingTasks.filter(t => t.source_ref).map(t => [t.source_ref!, t]));

        let newCount = 0, updatedCount = 0;

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

          const existing = existingByGid.get(gid);

          if (existing) {
            const titleChanged = existing.title !== name;
            const descChanged = (existing.description || '') !== description;
            const parentChanged = (existing.parent_name || '') !== (parentName || '');
            const newLabel = detectLabel(name);
            const labelChanged = newLabel !== existing.label;

            if (titleChanged || descChanged || parentChanged || labelChanged) {
              db.prepare("UPDATE tasks SET title = ?, description = ?, parent_name = ?, label = ?, updated_at = datetime('now') WHERE id = ?")
                .run(name, description || null, parentName, newLabel, existing.id);
              updatedCount++;
            }
          } else {
            const taskId = crypto.randomUUID();
            db.prepare(`INSERT INTO tasks (id, project_id, title, description, label, status, priority, task_type, source, source_ref, parent_name, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, 'asana', ?, ?, datetime('now'), datetime('now'))`)
              .run(taskId, projectId, name, description || null, detectLabel(name), detectTaskType(name, notes), gid, parentName);
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
