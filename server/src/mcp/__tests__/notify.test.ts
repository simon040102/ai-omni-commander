import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('notify', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env['NOTIFY_URL'] = 'http://localhost:9999/api/mcp-notify';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env['NOTIFY_URL'];
  });

  it('sends POST request with event data', async () => {
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
