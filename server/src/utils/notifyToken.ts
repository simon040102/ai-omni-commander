/**
 * Shared-secret token protecting POST /api/mcp-notify.
 *
 * The Web server creates `data/.notify-token` on startup (reusing an existing
 * file); the MCP process reads the SAME file (via getDataDir(), never cwd) and
 * sends it as the `x-notify-token` header.
 *
 * Backward compatibility keys off file existence on each side:
 * - Web can read the token file → it validates the header (401 on mismatch).
 * - MCP can read the token file → it attaches the header.
 * - Old Web (never creates the file) + new MCP → no file → MCP sends without
 *   header → old Web doesn't validate → still works.
 *
 * Pure functions taking an explicit dataDir — no cwd access (MCP-safe).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const NOTIFY_TOKEN_FILENAME = '.notify-token';

export function notifyTokenPath(dataDir: string): string {
  return path.join(dataDir, NOTIFY_TOKEN_FILENAME);
}

/** Read the token if the file exists and is non-empty; null otherwise. Never throws. */
export function loadNotifyToken(dataDir: string): string | null {
  try {
    const raw = fs.readFileSync(notifyTokenPath(dataDir), 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Return the existing token, or create a new random 32-hex-char one.
 * Returns null when the token file cannot be written (caller should log and
 * skip validation rather than lock out MCP processes that can't read a file
 * that doesn't exist).
 */
export function ensureNotifyToken(dataDir: string): string | null {
  const existing = loadNotifyToken(dataDir);
  if (existing) return existing;
  const token = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(notifyTokenPath(dataDir), token, { encoding: 'utf-8' });
    return token;
  } catch {
    return null;
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Web-side check: when no token is configured (expected null) accept everything
 * (legacy mode); otherwise the provided header must match exactly.
 */
export function verifyNotifyToken(expected: string | null, provided: unknown): boolean {
  if (!expected) return true;
  return typeof provided === 'string' && timingSafeEqualStr(provided, expected);
}
