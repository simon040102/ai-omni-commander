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
    'Get detailed information about a specific task including its project context',
    { taskId: z.string().describe('The task ID') },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.project_id) as ProjectRow | undefined;

      // Get bound documents
      const docs = db.prepare(`
        SELECT d.id, d.filename, d.file_path, d.file_type, d.doc_type, d.parsed_text
        FROM task_documents td JOIN documents d ON d.id = td.document_id
        WHERE td.task_id = ?
      `).all(taskId) as DocumentRow[];

      // Get project-level documents if no task-specific ones
      const projectDocs = docs.length === 0
        ? db.prepare('SELECT id, filename, file_path, file_type, doc_type, parsed_text FROM documents WHERE project_id = ?').all(task.project_id) as DocumentRow[]
        : [];

      const result = {
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
        documents: (docs.length > 0 ? docs : projectDocs).map(d => ({
          id: d.id,
          filename: d.filename,
          filePath: d.file_path,
          fileType: d.file_type,
          docType: d.doc_type,
        })),
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── list_pending_tasks ────────────────────────────────────
  server.tool(
    'list_pending_tasks',
    'List all tasks with pending/queued status for a project, ordered by priority',
    { projectId: z.string().describe('The project ID') },
    async ({ projectId }) => {
      const db = getMcpDb();
      const tasks = db.prepare(`
        SELECT id, title, description, label, status, priority, task_type, preferred_model, parent_name
        FROM tasks
        WHERE project_id = ? AND status IN ('pending', 'queued', 'assigned')
        ORDER BY priority DESC, created_at ASC
      `).all(projectId) as Array<Record<string, unknown>>;

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
}
