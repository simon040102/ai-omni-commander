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

/**
 * Send a notification to the Web Server.
 * Failures are silently ignored (Web Server may not be running).
 */
export async function notifyWebServer(notification: McpNotification): Promise<boolean> {
  try {
    const response = await fetch(NOTIFY_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notification),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    // Web Server not running or unreachable — silently ignore
    return false;
  }
}
