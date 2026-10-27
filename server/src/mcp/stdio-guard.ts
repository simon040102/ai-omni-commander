/**
 * MCP 入口的第一個 import：在任何模組載入前設好「log 走 stderr」。
 * ESM 依 import 順序執行，這個檔必須排在 mcp-entry.ts 所有 import 的最前面——
 * 之後才載入的 utils/logger.ts 讀到旗標就不會把 log 寫進 stdout（JSON-RPC 通道）。
 */
process.env['OMNI_LOG_STDERR'] = '1';

export {};
