import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { logger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Load .env from project root
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

export interface Config {
  port: number;
  /** Host interface to bind the HTTP/WS server to (default 127.0.0.1 — credentials flow in cleartext) */
  host: string;
  dbPath: string;
  defaultModel: string;
  logLevel: string;
  projectRoot: string;
  /** Asana Personal Access Token for MCP integration */
  asanaPat: string | null;
  /** Optional: Filter tasks to specific Asana workspace */
  asanaWorkspace: string | null;
}

function parsePort(raw: string | undefined): number {
  const parsed = parseInt(raw || '3457', 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    logger.warn({ raw }, 'Invalid PORT env value — falling back to 3457');
    return 3457;
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

  cachedConfig = {
    port: parsePort(process.env['PORT']),
    host: process.env['HOST'] || '127.0.0.1',
    dbPath: resolveDbPath(),
    defaultModel: process.env['DEFAULT_MODEL'] || 'sonnet',
    logLevel: process.env['LOG_LEVEL'] || 'info',
    projectRoot: PROJECT_ROOT,
    asanaPat: process.env['ASANA_PAT'] || null,
    asanaWorkspace: process.env['ASANA_WORKSPACE'] || null,
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
