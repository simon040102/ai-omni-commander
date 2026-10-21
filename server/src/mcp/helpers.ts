/**
 * Shared helpers for MCP tools — JSON parsing, synthetic agent creation,
 * Asana access, config masking, response size governance.
 */
import type Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── JSON ────────────────────────────────────────────────────

/** Safely parse a JSON column; returns fallback on null/invalid. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

// ── repo root / paths ───────────────────────────────────────

// The MCP process may be spawned from ANY project folder (user-scope MCP
// registration), so process.cwd() is unreliable. Relative paths (DB_PATH etc.)
// must resolve against the OmniCommander repo root, derived from this module's
// own location: server/dist/mcp/ (compiled) or server/src/mcp/ (tests) → 3 up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const DEFAULT_DB_PATH = './data/omni.db';

/** Resolve a possibly-relative path against the OmniCommander repo root (never cwd). */
export function resolveFromRepoRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

/** Resolve the configured DB path (env DB_PATH or default), always absolute. */
export function getDbPath(): string {
  return resolveFromRepoRoot(process.env['DB_PATH'] || DEFAULT_DB_PATH);
}

// ── data dir (derived from DB_PATH) ─────────────────────────

/** Resolve the data directory from DB_PATH (single shared convention). */
export function getDataDir(): string {
  return path.dirname(getDbPath());
}

// ── synthetic MCP agent ─────────────────────────────────────

export interface EnsureMcpAgentResult {
  agentId: string;
  created: boolean;
  role: string;
  title: string | null;
}

/** agents.role 的 CHECK 白名單（schema.ts）——task label 不在其中（如 fullstack）時退回 'quick'，
 *  否則 INSERT OR IGNORE 會靜默吞掉 CHECK violation，後續 agent_outputs 寫入直接 FK 爆炸。
 *  與 schema 的同步由測試對 in-memory DB 逐一 INSERT 驗證（helpers-agent-roles）。 */
export const AGENT_ROLES = new Set([
  'master', 'architect', 'backend', 'frontend', 'coordinator',
  'integration-test', 'skill-gen', 'devops', 'testing', 'review', 'quick', 'axure',
]);

/**
 * Ensure the synthetic mcp-{taskId} agent row exists (concurrency-safe via
 * INSERT OR IGNORE). created=true only when this call inserted the row —
 * use it to decide whether to emit agent.started.
 */
export function ensureMcpAgent(db: Database.Database, taskId: string, projectId: string): EnsureMcpAgentResult {
  const agentId = `mcp-${taskId}`;
  const taskInfo = db.prepare('SELECT title, label FROM tasks WHERE id = ?').get(taskId) as { title: string; label: string } | undefined;
  const rawRole = taskInfo?.label || 'quick';
  const role = AGENT_ROLES.has(rawRole) ? rawRole : 'quick';
  const title = taskInfo?.title || null;
  const result = db.prepare(`
    INSERT OR IGNORE INTO agents (id, project_id, role, status, model, current_task_id, title)
    VALUES (?, ?, ?, 'running', 'external', ?, ?)
  `).run(agentId, projectId, role, taskId, title);
  return { agentId, created: result.changes > 0, role, title };
}

// ── Asana ───────────────────────────────────────────────────

export const ASANA_API_BASE = 'https://app.asana.com/api/1.0';
export const ASANA_FETCH_TIMEOUT_MS = 30000;

/** Read the Asana PAT from global_config, falling back to the ASANA_PAT env var. */
export function getAsanaPat(db: Database.Database): string | undefined {
  const patRow = db.prepare("SELECT value FROM global_config WHERE key = 'asana.pat'").get() as { value: string } | undefined;
  return patRow?.value || process.env['ASANA_PAT'] || undefined;
}

// ── config masking ──────────────────────────────────────────

/** Mask password/pwd values inside a connection string. */
export function maskConnectionString(connStr: string): string {
  return connStr.replace(/((?:password|pwd)\s*=\s*)[^;]*/gi, '$1***');
}

/**
 * Mask credentials in a project config object before returning it from a tool:
 * dbConnections[].password → '***'; passwords inside connectionString → ***;
 * legacy svnConfig.password (older config_json rows) → '***'.
 */
export function maskProjectConfig<T>(config: T): T {
  if (!config || typeof config !== 'object') return config;
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const conns = clone['dbConnections'];
  if (Array.isArray(conns)) {
    for (const conn of conns) {
      if (conn && typeof conn === 'object') {
        const c = conn as Record<string, unknown>;
        if (typeof c['password'] === 'string' && c['password'] !== '') c['password'] = '***';
        if (typeof c['connectionString'] === 'string') c['connectionString'] = maskConnectionString(c['connectionString']);
      }
    }
  }
  // SvnConfig no longer carries credentials (they live in global_config), but
  // older config_json rows may still contain svnConfig.password — mask it too.
  const svn = clone['svnConfig'];
  if (svn && typeof svn === 'object') {
    const s = svn as Record<string, unknown>;
    if (typeof s['password'] === 'string' && s['password'] !== '') s['password'] = '***';
  }
  return clone as T;
}

// ── response size governance ────────────────────────────────

export const CHARACTER_LIMIT = 25000;

/** 短 ID 最少幾碼（UUID 前 8 碼即第一段） */
export const MIN_ID_PREFIX = 8;
const ID_PREFIX_TABLES = new Set(['tasks', 'spec_gaps', 'spec_checklist_items']);

/**
 * 完整 ID 或「至少 8 碼且唯一」的前綴 → 完整 ID。agent 回報常只寫前 8 碼，實測得自己讀 DB 查。
 * 多筆符合回 ambiguous（列候選，不猜）；找不到或少於 8 碼回 null。
 * 用 substr 比對而不是 LIKE——前綴裡的 % 或 _ 不會被當成萬用字元。
 */
export function resolveIdPrefix(
  db: Database.Database,
  table: 'tasks' | 'spec_gaps' | 'spec_checklist_items',
  id: string,
): { id: string } | { ambiguous: string[] } | null {
  if (!ID_PREFIX_TABLES.has(table)) throw new Error(`resolveIdPrefix: table not allowed: ${table}`);
  const exact = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) as { id: string } | undefined;
  if (exact) return { id: exact.id };
  const prefix = id.trim();
  if (prefix.length < MIN_ID_PREFIX) return null;
  const rows = db.prepare(`SELECT id FROM ${table} WHERE substr(id, 1, ?) = ? ORDER BY id LIMIT 6`).all(prefix.length, prefix) as Array<{ id: string }>;
  if (rows.length === 0) return null;
  if (rows.length === 1) return { id: rows[0]!.id };
  return { ambiguous: rows.map(r => r.id) };
}

/** resolveIdPrefix 的歧義訊息 */
export function ambiguousIdMessage(kind: string, given: string, candidates: string[]): string {
  return `Error: ${kind}「${given}」對到多筆，請給完整 ID 或更長的前綴：\n${candidates.map(c => `- ${c}`).join('\n')}${candidates.length >= 6 ? '\n…（可能還有更多）' : ''}`;
}

/** Truncate an oversized tool response, appending a truncation notice. */
export function truncateResponse(text: string, note?: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const suffix = `\n\n[已截斷] 完整內容共 ${text.length} 字元，僅顯示前 ${CHARACTER_LIMIT} 字元。${note ? `\n${note}` : ''}`;
  return text.slice(0, CHARACTER_LIMIT) + suffix;
}

/** JSON 序列化時略過 null／undefined 欄位（不帶資訊、只佔回應上限）。不縮排。 */
export function compactJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v === null ? undefined : v));
}

/**
 * 清單型工具的「放得下多少就帶多少」：從整頁開始，超過回應上限就從尾端少帶幾筆，
 * 直到整份 JSON 放得下為止——寧可少帶並告訴呼叫端下一頁從哪裡取，也不要從中間截斷 JSON
 * （截斷後連前面的欄位都解析不了）。至少保留 1 筆。
 */
export function fitListToLimit<T>(items: T[], render: (shown: T[]) => string, limit = CHARACTER_LIMIT): { text: string; shown: number } {
  let shown = items.length;
  let text = render(items);
  while (text.length > limit && shown > 1) {
    // 依超出比例估算要砍多少，至少砍 1 筆，避免一筆一筆試
    const ratio = limit / text.length;
    shown = Math.max(1, Math.min(shown - 1, Math.floor(shown * ratio * 0.95)));
    text = render(items.slice(0, shown));
  }
  return { text, shown };
}
