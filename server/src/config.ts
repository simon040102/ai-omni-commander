import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Load .env from project root
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

export interface Config {
  claudePath: string;
  port: number;
  /** Host interface to bind the HTTP/WS server to (default 127.0.0.1 — credentials flow in cleartext) */
  host: string;
  dbPath: string;
  defaultModel: string;
  logLevel: string;
  projectRoot: string;
  aiContextDir: string;
  /** Asana Personal Access Token for MCP integration */
  asanaPat: string | null;
  /** Optional: Filter tasks to specific Asana workspace */
  asanaWorkspace: string | null;
  /** Agent backend: 'pty' (interactive, subscription billing) or 'sdk' (programmatic, SDK credit) */
  agentBackend: 'pty' | 'sdk';
  /** Max runtime for a single agent process before the watchdog stops it (ms) */
  agentMaxRuntimeMs: number;
}

function detectClaudePath(): string {
  const envPath = process.env['CLAUDE_PATH'];
  if (envPath && envPath !== 'auto') {
    return envPath;
  }

  // Try to find claude in PATH
  try {
    const result = execSync(
      process.platform === 'win32' ? 'where claude' : 'which claude',
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    if (result) return result.split('\n')[0]!;
  } catch {
    // Not found in PATH
  }

  logger.error('Claude CLI not found in PATH and CLAUDE_PATH is not set — agent spawning will fail. Install Claude Code or set CLAUDE_PATH.');
  return 'claude';
}

function parsePort(raw: string | undefined): number {
  const parsed = parseInt(raw || '3457', 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    logger.warn({ raw }, 'Invalid PORT env value — falling back to 3457');
    return 3457;
  }
  return parsed;
}

function parseAgentBackend(raw: string | undefined): 'pty' | 'sdk' {
  if (!raw) return 'pty';
  if (raw === 'pty' || raw === 'sdk') return raw;
  logger.warn({ raw }, 'Invalid AGENT_BACKEND env value (allowed: pty, sdk) — falling back to pty');
  return 'pty';
}

function parseAgentMaxRuntimeMs(raw: string | undefined): number {
  const DEFAULT = 2 * 60 * 60 * 1000; // 2 hours
  if (!raw) return DEFAULT;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn({ raw }, 'Invalid AGENT_MAX_RUNTIME_MS env value — falling back to 2 hours');
    return DEFAULT;
  }
  return parsed;
}

function resolveDbPath(): string {
  const envDb = process.env['DB_PATH'] || './data/omni.db';
  if (path.isAbsolute(envDb)) return envDb;
  return path.resolve(PROJECT_ROOT, envDb);
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const claudePath = detectClaudePath();

  cachedConfig = {
    claudePath,
    port: parsePort(process.env['PORT']),
    host: process.env['HOST'] || '127.0.0.1',
    dbPath: resolveDbPath(),
    defaultModel: process.env['DEFAULT_MODEL'] || 'sonnet',
    logLevel: process.env['LOG_LEVEL'] || 'info',
    projectRoot: PROJECT_ROOT,
    aiContextDir: path.join(PROJECT_ROOT, '.ai_context'),
    asanaPat: process.env['ASANA_PAT'] || null,
    asanaWorkspace: process.env['ASANA_WORKSPACE'] || null,
    agentBackend: parseAgentBackend(process.env['AGENT_BACKEND']),
    agentMaxRuntimeMs: parseAgentMaxRuntimeMs(process.env['AGENT_MAX_RUNTIME_MS']),
  };

  return cachedConfig;
}

/**
 * Reload Asana PAT from DB (called after user updates it via Settings).
 * DB value takes precedence over env var.
 */
export function reloadAsanaPat(dbPat: string | null): void {
  if (cachedConfig) {
    cachedConfig.asanaPat = dbPat || process.env['ASANA_PAT'] || null;
  }
}
