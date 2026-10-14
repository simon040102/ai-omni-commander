import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerJevTools, type JevToolDeps } from './jev-tools.js';

export function createJevMcpServer(deps: JevToolDeps = {}): McpServer {
  const server = new McpServer(
    { name: 'jev', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // 刻意簡短：每個掛了這個 MCP 的 session 都會帶著這段
      instructions: 'Jev：極快、極便宜的封閉式判斷（分類／打分）。遇到「資料量大、每筆都問同一個封閉問題」的工作（分類、篩選、打分、挑選項）先考慮 jev_classify，而不是自己逐筆判斷。結果僅供參考，不可當成任務完成閘門或規格回對的判定依據；資料會送到第三方 TypeSafe。',
    },
  );
  registerJevTools(server, deps);
  return server;
}
