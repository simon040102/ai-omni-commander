#!/usr/bin/env node
/**
 * MCP Server entry point for OmniCommander.
 * Launched by Claude Code via .mcp.json configuration.
 * Communicates via stdio (stdin/stdout) using JSON-RPC.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOmniMcpServer } from './mcp/McpServer.js';
import { getMcpDb, closeMcpDb } from './mcp/db.js';

async function main() {
  // Validate required env vars
  if (!process.env['DB_PATH']) {
    process.stderr.write('ERROR: DB_PATH environment variable is required\n');
    process.exit(1);
  }

  // Initialize DB connection (validates path, runs migrations)
  try {
    getMcpDb();
  } catch (err) {
    process.stderr.write(`ERROR: Failed to connect to database: ${err}\n`);
    process.exit(1);
  }

  // Create MCP server with all tools registered
  const server = createOmniMcpServer();

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('OmniCommander MCP Server started (stdio)\n');

  // Graceful shutdown
  const shutdown = () => {
    closeMcpDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
