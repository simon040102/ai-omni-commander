import pino from 'pino';

/**
 * 輸出目的地：預設 stdout（Web Server 照舊）；OMNI_LOG_STDERR=1 時改 stderr——
 * MCP 是 stdio 協定，stdout 是 JSON-RPC 通道，任何一行 log 寫進去就會弄壞連線。
 * MCP 入口在載入任何模組前就設好這個旗標（見 mcp/stdio-guard.ts）。
 */
export function logDestinationFd(env: NodeJS.ProcessEnv = process.env): 1 | 2 {
  return env['OMNI_LOG_STDERR'] === '1' ? 2 : 1;
}

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
      destination: logDestinationFd(),
    },
  },
  level: process.env['LOG_LEVEL'] || 'info',
  redact: {
    paths: ['err.spawnargs', '*.password', '*.pat', '*.token', '*.connectionString'],
    censor: '[REDACTED]',
  },
});

export function createChildLogger(name: string, meta?: Record<string, unknown>) {
  return logger.child({ module: name, ...meta });
}
