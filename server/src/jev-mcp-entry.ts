#!/usr/bin/env node
/**
 * Jev MCP Server entry point——omni 版（與 OmniCommander MCP 分開註冊）：
 *   claude mcp add --scope user jev -- node "<repo>/server/dist/jev-mcp-entry.js"
 * 金鑰：OmniCommander 全域設定 typesafe.apiKey，或 env TYPESAFE_API_KEY。
 * 給其他人安裝的獨立版見 packages/jev-mcp（只讀 env、打包成單檔）。
 */
import { runJevStdio } from './jev/runStdio.js';
import { readOmniJevApiKey } from './jev/omni-key.js';

runJevStdio(readOmniJevApiKey, 'Jev MCP').catch((e) => {
  process.stderr.write(`Fatal error: ${e}\n`);
  process.exit(1);
});
