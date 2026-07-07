/**
 * Shared test utilities for MCP tool tests.
 * callTool reaches into the SDK's private tool registry — kept in one place
 * so an SDK upgrade only breaks a single file.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not found`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool.handler(args, {} as any);
}
