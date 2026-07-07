/**
 * MCP tools for progress & output reporting.
 * report_output, report_milestone
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { ensureMcpAgent } from '../helpers.js';

export function registerProgressTools(server: McpServer): void {

  // ── report_output ─────────────────────────────────────────
  server.tool(
    'report_output',
    'Send execution output to the Web UI for real-time monitoring. Call this periodically during task execution to keep the UI updated.',
    {
      taskId: z.string().describe('The task ID this output belongs to'),
      content: z.string().describe('The output content to display'),
      outputType: z.enum(['text', 'tool_use', 'tool_result', 'system', 'milestone']).optional().describe('Output type for display styling (default: text)'),
    },
    { title: 'Report Output', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, content, outputType }) => {
      const db = getMcpDb();
      const streamType = outputType || 'text';

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
