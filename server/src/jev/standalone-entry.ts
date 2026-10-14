/**
 * Jev MCP 獨立發佈版入口——由 packages/jev-mcp/build.mjs 打包成單一 jev-mcp.mjs。
 * 金鑰只讀 env TYPESAFE_API_KEY（安裝腳本註冊時以 `claude mcp add -e` 寫入）。
 * 不可 import omni-key.ts 或任何會帶進 better-sqlite3 的模組。
 */
import { runJevStdio } from './runStdio.js';
import { readEnvJevApiKey } from './jev-tools.js';

runJevStdio(readEnvJevApiKey, 'Jev MCP').catch((e) => {
  process.stderr.write(`Fatal error: ${e}\n`);
  process.exit(1);
});
