#!/usr/bin/env node
/**
 * Jev MCP Server entry point（與 OmniCommander MCP 分開註冊）：
 *   claude mcp add --scope user jev -- node "<repo>/server/dist/jev-mcp-entry.js"
 * 金鑰：OmniCommander 全域設定 typesafe.apiKey，或 env TYPESAFE_API_KEY。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createJevMcpServer } from './jev/JevMcpServer.js';

async function main() {
  const server = createJevMcpServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows 上 Claude Code 以關閉 stdio 結束 MCP——不接這個會留下孤兒程序
  process.stdin.on('end', shutdown);
  // stdout 是 JSON-RPC 通道，診斷一律走 stderr
  process.on('unhandledRejection', (e) => {
    process.stderr.write(`[Jev MCP] Unhandled rejection: ${e instanceof Error ? (e.stack || e.message) : String(e)}\n`);
  });
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[Jev MCP] Uncaught exception: ${e instanceof Error ? (e.stack || e.message) : String(e)}\n`);
  });
  server.server.onclose = shutdown;

  await server.connect(transport);
  process.stderr.write('Jev MCP Server started (stdio)\n');
}

main().catch((e) => {
  process.stderr.write(`Fatal error: ${e}\n`);
  process.exit(1);
});
