/**
 * HTTP notification helper for MCP Server → Web Server communication.
 * Sends POST requests to the Web Server's /api/mcp-notify endpoint
 * so the Web UI can update in real-time.
 */
import { getDataDir } from './helpers.js';
import { loadNotifyToken } from '../utils/notifyToken.js';

const NOTIFY_URL = () => process.env['NOTIFY_URL'] || 'http://127.0.0.1:3457/api/mcp-notify';

// Shared-secret token written by the Web server to data/.notify-token.
// Attach it only when the file exists (backward compatible with an old Web
// server that never created it). Cache once found; re-check while absent —
// the Web server may create the file after this MCP process started.
let cachedNotifyToken: string | null = null;
function getNotifyToken(forceReload = false): string | null {
  if (forceReload) cachedNotifyToken = null;
  if (cachedNotifyToken) return cachedNotifyToken;
  cachedNotifyToken = loadNotifyToken(getDataDir());
  return cachedNotifyToken;
}

export interface McpNotification {
  event: string;
  data: Record<string, unknown>;
}

// [I5] Track notification failures for logging
let notifyFailCount = 0;
let notifySuccessCount = 0;

export function getNotifyStats(): { failures: number; successes: number } {
  return { failures: notifyFailCount, successes: notifySuccessCount };
}

async function postNotification(notification: McpNotification, token: string | null): Promise<Response> {
  return fetch(NOTIFY_URL(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { 'x-notify-token': token }),
    },
    body: JSON.stringify(notification),
    signal: AbortSignal.timeout(3000),
  });
}

/**
 * Send a notification to the Web Server.
 * Returns false if notification failed (caller can add warning to tool response).
 */
export async function notifyWebServer(notification: McpNotification): Promise<boolean> {
  try {
    const token = getNotifyToken();
    let response = await postNotification(notification, token);

    // 401 = our token is stale or missing while the Web server now enforces one
    // (token rotated, or this long-lived MCP session predates the token file).
    // Invalidate the cache, re-read the file, retry once with the fresh token.
    if (response.status === 401) {
      const freshToken = getNotifyToken(true);
      if (freshToken !== token) {
        response = await postNotification(notification, freshToken);
      }
    }

    if (response.ok) {
      notifySuccessCount++;
      return true;
    }
    notifyFailCount++;
    console.error(`[MCP notify] HTTP ${response.status} for event "${notification.event}" (total failures: ${notifyFailCount})`);
    return false;
  } catch (err) {
    notifyFailCount++;
    console.error(`[MCP notify] Failed to send "${notification.event}" (total failures: ${notifyFailCount}):`, err instanceof Error ? err.message : err);
    return false;
  }
}
