/**
 * MCP tools for progress & output reporting.
 * report_output, report_milestone
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { ensureMcpAgent } from '../helpers.js';

/**
 * `agent_outputs.stream_type` 的 CHECK 允許值——**參數 enum 與執行期檢查的唯一來源**。
 *
 * 2026-09-21 實例：enum 宣告支援 `'milestone'`，而 DB 的 CHECK 不收。參數驗證放行、
 * 寫入時才被資料庫擋下，呼叫端拿到一句看不懂的 SQLite 約束錯誤。
 * **宣告支援卻存不進去，比不支援更糟**——它讓人以為自己用錯了，而其實是契約自己對不上。
 *
 * 這一份要與 `db/schema.ts` 的 `CHECK(stream_type IN (...))` 一字不差。
 * 里程碑走 `report_milestone`，不在這裡。
 */
export const OUTPUT_STREAM_TYPES = ['text', 'tool_use', 'tool_result', 'system', 'error'] as const;
export type OutputStreamType = typeof OUTPUT_STREAM_TYPES[number];

export function registerProgressTools(server: McpServer): void {

  // ── report_output ─────────────────────────────────────────
  server.tool(
    'report_output',
    'Send execution output to the Web UI for real-time monitoring. Call this periodically during task execution to keep the UI updated.',
    {
      taskId: z.string().describe('The task ID this output belongs to'),
      content: z.string().describe('The output content to display'),
      // 'milestone' 曾列在這個 enum 裡，但 agent_outputs.stream_type 的 CHECK 不收它——
      // 通過參數驗證、寫入時才被資料庫擋下，呼叫端拿到的是一句看不懂的 SQLite 約束錯誤。
      // **宣告支援卻存不進去，比不支援更糟**：它讓人以為自己用錯了，而其實是契約自己對不上。
      // 里程碑有獨立的 report_milestone，這裡移除；'error' 則是資料庫本來就收、只是沒開放。
      outputType: z.enum(OUTPUT_STREAM_TYPES).optional().describe(
        'Output type for display styling (default: text)。'
        + '**里程碑請用 report_milestone**，不是這裡——本 enum 的值必須與 agent_outputs.stream_type 的 CHECK 一致。',
      ),
    },
    { title: 'Report Output', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, content, outputType }) => {
      const db = getMcpDb();
      const streamType = outputType || 'text';
      // 防禦：呼叫端若繞過參數驗證（測試 harness、舊版客戶端），要在這裡給看得懂的錯，
      // 不要讓它撞到 DB 的 CHECK 變成一句 SQLite 約束訊息。
      if (!(OUTPUT_STREAM_TYPES as readonly string[]).includes(streamType)) {
        return { content: [{ type: 'text' as const, text: `Error: outputType "${streamType}" 不在允許值內（${OUTPUT_STREAM_TYPES.join(' / ')}）。里程碑請用 report_milestone。` }], isError: true };
      }

      // Get task to find project
      const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // Ensure synthetic agent record exists — send agent.started on first creation
      const { agentId: mcpAgentId, created, role: agentRole, title: agentTitle } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        // Notify Web Server to show agent in Agents view
        await notifyWebServer({
          event: 'agent.started',
          data: {
            agentId: mcpAgentId,
            projectId: task.project_id,
            taskId,
            role: agentRole,
            title: agentTitle,
            model: 'external (MCP)',
          },
        });
      }

      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, ?, ?)
      `).run(mcpAgentId, taskId, streamType, content);

      // Notify Web Server
      await notifyWebServer({
        event: 'agent.output',
        data: {
          agentId: mcpAgentId,
          projectId: task.project_id,
          taskId,
          streamType,
          content,
        },
      });

      return { content: [{ type: 'text' as const, text: `Output reported. ⚠ 提醒：任務全部完成時，請務必呼叫 update_task_status(taskId="${taskId}", status="completed", summary="...") 回報完成狀態。` }] };
    },
  );

  // ── report_milestone ──────────────────────────────────────
  server.tool(
    'report_milestone',
    'Report a high-level progress milestone to the Web UI (e.g., "Analyzing documents", "Writing code", "Running tests")',
    {
      taskId: z.string().describe('The task ID'),
      milestone: z.string().describe('Milestone description (e.g., "Analyzing documents")'),
      details: z.string().optional().describe('Optional additional details'),
    },
    { title: 'Report Milestone', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, milestone, details }) => {
      const db = getMcpDb();

      const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // Log as event
      const eventId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO events (id, project_id, event_type, source, target, payload_json)
        VALUES (?, ?, 'task.milestone', ?, ?, ?)
      `).run(eventId, task.project_id, `task:${taskId}`, null,
        JSON.stringify({ milestone, details: details || null }));

      // Also store as a system output for the terminal view
      const { agentId: mcpAgentId, created, role: agentRole, title: agentTitle } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId: mcpAgentId, projectId: task.project_id, taskId, role: agentRole, title: agentTitle, model: 'external (MCP)' },
        });
      }

      const milestoneText = details ? `[MILESTONE] ${milestone}: ${details}` : `[MILESTONE] ${milestone}`;
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(mcpAgentId, taskId, milestoneText);

      // Notify Web Server
      await notifyWebServer({
        event: 'task.milestone',
        data: { taskId, projectId: task.project_id, milestone, details: details || null },
      });

      return { content: [{ type: 'text' as const, text: `Milestone reported: ${milestone}. ⚠ 提醒：任務全部完成時，請務必呼叫 update_task_status(taskId="${taskId}", status="completed", summary="...") 回報完成狀態。` }] };
    },
  );
}
