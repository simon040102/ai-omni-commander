// jev MCP 的 stdio 啟動流程——omni 版（jev-mcp-entry.ts）與獨立發佈版（standalone-entry.ts）共用，
// 兩邊只差金鑰從哪裡讀。
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createJevMcpServer } from './JevMcpServer.js';
import { checkTypesafeKey } from '../utils/typesafe.js';

export async function runJevStdio(getApiKey: () => string, label: string): Promise<void> {
  // `--check`：只驗證金鑰（GET /v1/models，不送資料）就結束——安裝腳本用
  if (process.argv.includes('--check')) {
    const r = await checkTypesafeKey(getApiKey());
    process.stdout.write(`${r.success ? 'OK' : 'FAIL'}: ${r.message}\n`);
    process.exit(r.success ? 0 : 1);
  }

  const server = createJevMcpServer({ getApiKey });
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
    process.stderr.write(`[${label}] Unhandled rejection: ${e instanceof Error ? (e.stack || e.message) : String(e)}\n`);
  });
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[${label}] Uncaught exception: ${e instanceof Error ? (e.stack || e.message) : String(e)}\n`);
  });
  server.server.onclose = shutdown;

  if (!getApiKey()) {
    process.stderr.write(`[${label}] 警告：沒有 TypeSafe API key（env TYPESAFE_API_KEY），jev_classify 會回錯誤直到設定為止\n`);
  }
  await server.connect(transport);
  process.stderr.write(`${label} started (stdio)\n`);
}
