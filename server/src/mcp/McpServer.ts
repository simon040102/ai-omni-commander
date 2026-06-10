/**
 * OmniCommander MCP Server.
 * Registers all tools and connects via stdio transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerDocumentTools } from './tools/document-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerProgressTools } from './tools/progress-tools.js';
import { registerWorkspaceTools } from './tools/workspace-tools.js';
import { registerDbTools } from './tools/db-tools.js';

export function createOmniMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'omni-commander',
      version: '5.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: `OmniCommander MCP Server — a task management and context provider for AI-driven software development.

Use these tools to:
- Fetch tasks and execution plans for development work
- Read project documents (SA/SD specs)
- Report progress, output, and milestones back to the monitoring Web UI
- Manage projects and tasks

Typical workflow:
1. Call get_execution_plan(taskId) to get the full execution context
2. Call update_task_status(taskId, "in_progress") to mark the task as started
3. Execute the work as described in the plan
4. Call report_output() periodically to send key output to the Web UI
5. Call report_milestone() at major checkpoints
6. Call update_task_status(taskId, "completed", summary) when done`,
    },
  );

  // Register all tool groups
  registerTaskTools(server);
  registerDocumentTools(server);
  registerProjectTools(server);
  registerProgressTools(server);
  registerWorkspaceTools(server);
  registerDbTools(server);

  return server;
}
