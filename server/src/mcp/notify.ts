/**
 * HTTP notification helper for MCP Server → Web Server communication.
 * Sends POST requests to the Web Server's /api/mcp-notify endpoint
 * so the Web UI can update in real-time.
 */

const NOTIFY_URL = () => process.env['NOTIFY_URL'] || 'http://localhost:3457/api/mcp-notify';

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

/**
 * Send a notification to the Web Server.
 * Returns false if notification failed (caller can add warning to tool response).
 */
export async function notifyWebServer(notification: McpNotification): Promise<boolean> {
  try {
    const response = await fetch(NOTIFY_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(3000),
    });
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
