#!/usr/bin/env node
/**
 * MCP Server entry point for OmniCommander.
 * Launched by Claude Code via .mcp.json configuration.
 * Communicates via stdio (stdin/stdout) using JSON-RPC.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOmniMcpServer } from './mcp/McpServer.js';
import { getMcpDb, closeMcpDb } from './mcp/db.js';
import { getDbPath } from './mcp/helpers.js';

async function main() {
  // DB_PATH is optional: relative values (and the default ./data/omni.db) are
  // resolved against the OmniCommander repo root, NOT process.cwd() — the MCP
  // server may be spawned from any project folder via user-scope registration.
  try {
    getMcpDb();
    process.stderr.write(`[MCP] Using database: ${getDbPath()}\n`);
  } catch (err) {
    process.stderr.write(`ERROR: Failed to connect to database: ${err}\n`);
    process.exit(1);
  }

  // Create MCP server with all tools registered
  const server = createOmniMcpServer();

  // Connect via stdio transport
  const transport = new StdioServerTransport();

  // Graceful shutdown — idempotent, wired to signals, stdio EOF and transport close
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    closeMcpDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // On Windows, Claude Code terminates the MCP server by closing stdio —
  // without this the process would linger as an orphan.
  process.stdin.on('end', shutdown);
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[MCP] Unhandled rejection: ${err instanceof Error ? (err.stack || err.message) : String(err)}\n`);
  });
  // Same pattern as the Web server (index.ts): log to stderr and keep serving —
  // stdout is the JSON-RPC channel and must never receive diagnostics.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[MCP] Uncaught exception: ${err instanceof Error ? (err.stack || err.message) : String(err)}\n`);
  });
  server.server.onclose = shutdown;

  await server.connect(transport);

  process.stderr.write('OmniCommander MCP Server started (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
