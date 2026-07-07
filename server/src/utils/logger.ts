import pino from 'pino';

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
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
