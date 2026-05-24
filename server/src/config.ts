import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Load .env from project root
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

export interface Config {
  claudePath: string;
  port: number;
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

  // Fallback: use npx
  return 'npx';
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
    port: parseInt(process.env['PORT'] || '3457', 10),
    dbPath: resolveDbPath(),
    defaultModel: process.env['DEFAULT_MODEL'] || 'sonnet',
    logLevel: process.env['LOG_LEVEL'] || 'info',
    projectRoot: PROJECT_ROOT,
    aiContextDir: path.join(PROJECT_ROOT, '.ai_context'),
    asanaPat: process.env['ASANA_PAT'] || null,
    asanaWorkspace: process.env['ASANA_WORKSPACE'] || null,
    agentBackend: (process.env['AGENT_BACKEND'] as 'pty' | 'sdk') || 'pty',
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
