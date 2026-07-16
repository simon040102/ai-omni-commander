import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('notify', () => {
  let originalFetch: typeof globalThis.fetch;
  let dataDir: string;

  beforeEach(() => {
    vi.resetModules(); // fresh notify.js module (token cache) per test
    originalFetch = globalThis.fetch;
    process.env['NOTIFY_URL'] = 'http://localhost:9999/api/mcp-notify';
    // Isolate the data dir so tests never read the repo's real data/.notify-token
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-notify-'));
    process.env['DB_PATH'] = path.join(dataDir, 'omni.db');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env['NOTIFY_URL'];
    delete process.env['DB_PATH'];
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('sends POST request with event data (no token file → no x-notify-token header)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    // Dynamic import to pick up env change
    const { notifyWebServer } = await import('../notify.js');

    const result = await notifyWebServer({
      event: 'task.statusChange',
      data: { taskId: 'abc', status: 'completed' },
    });

    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9999/api/mcp-notify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'task.statusChange',
          data: { taskId: 'abc', status: 'completed' },
        }),
      }),
    );
  });

  it('attaches x-notify-token header when the token file exists', async () => {
    fs.writeFileSync(path.join(dataDir, '.notify-token'), 'secret-token-123');
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const { notifyWebServer } = await import('../notify.js');
    await notifyWebServer({ event: 'task.milestone', data: {} });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:9999/api/mcp-notify',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'x-notify-token': 'secret-token-123',
        },
      }),
    );
  });

  it('picks up a token file created AFTER the MCP process started (re-check while absent)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = mockFetch;

    const { notifyWebServer } = await import('../notify.js');
    await notifyWebServer({ event: 'task.milestone', data: {} });
    expect((mockFetch.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('x-notify-token');

    // Web server starts later and writes the token file
    fs.writeFileSync(path.join(dataDir, '.notify-token'), 'late-token');
    await notifyWebServer({ event: 'task.milestone', data: {} });
    expect((mockFetch.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ 'x-notify-token': 'late-token' });
  });

  it('returns false when fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    const { notifyWebServer } = await import('../notify.js');
    const result = await notifyWebServer({
      event: 'test',
      data: {},
    });

    expect(result).toBe(false);
  });

  it('returns false when response is not ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const { notifyWebServer } = await import('../notify.js');
    const result = await notifyWebServer({
      event: 'test',
      data: {},
    });

    expect(result).toBe(false);
  });
});
