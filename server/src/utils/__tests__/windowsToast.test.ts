import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSpawn, mockGetGlobalConfig } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockGetGlobalConfig: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('../../db/queries/globalConfig.js', () => ({ getGlobalConfig: mockGetGlobalConfig }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  showToast,
  escapeToastText,
  buildToastScript,
  resetToastThrottle,
  TOAST_CONFIG_KEY,
} from '../windowsToast.js';

const originalPlatform = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function makeFakeChild() {
  return {
    on: vi.fn(),
    once: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  };
}

/** Decode the -EncodedCommand argument of the Nth spawn call back to the script text. */
function decodeSpawnedScript(callIndex = 0): string {
  const args = mockSpawn.mock.calls[callIndex]![1] as string[];
  const encodedIndex = args.indexOf('-EncodedCommand') + 1;
  return Buffer.from(args[encodedIndex]!, 'base64').toString('utf16le');
}

beforeEach(() => {
  vi.useFakeTimers();
  resetToastThrottle();
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => makeFakeChild());
  mockGetGlobalConfig.mockReset();
  mockGetGlobalConfig.mockReturnValue(null); // default: enabled
  setPlatform('win32');
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(originalPlatform);
});

describe('escapeToastText', () => {
  it('escapes XML special characters', () => {
    expect(escapeToastText('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes double and single quotes (no raw quote survives)', () => {
    const out = escapeToastText(`he said "hi" and 'bye'`);
    expect(out).toBe('he said &quot;hi&quot; and &apos;bye&apos;');
    expect(out).not.toContain("'");
    expect(out).not.toContain('"');
  });

  it('keeps newlines and tabs but strips XML-invalid control characters', () => {
    const input = 'line1\nline2\ttab' + String.fromCharCode(0) + String.fromCharCode(7) + String.fromCharCode(127) + 'end';
    expect(escapeToastText(input)).toBe('line1\nline2\ttabend');
  });

  it('passes Chinese text through untouched', () => {
    expect(escapeToastText('任務完成：SM27 共用_查詢工程專案')).toBe('任務完成：SM27 共用_查詢工程專案');
  });

  it('neutralizes PowerShell injection attempts (quote breakout)', () => {
    const out = escapeToastText(`'); Remove-Item -Recurse C:\\ #`);
    expect(out).not.toContain("'");
    expect(out).toContain('&apos;');
  });
});

describe('buildToastScript', () => {
  it('embeds escaped title/body inside the toast XML', () => {
    const script = buildToastScript('T & <x>', `B 'q'`);
    expect(script).toContain('<text id="1">T &amp; &lt;x&gt;</text>');
    expect(script).toContain('<text id="2">B &apos;q&apos;</text>');
  });

  it('uses the AI-OmniCommander AppId and ToastText02 template', () => {
    const script = buildToastScript('t', 'b');
    expect(script).toContain("CreateToastNotifier('AI-OmniCommander')");
    expect(script).toContain('template="ToastText02"');
  });

  it('never leaves a raw single quote from external text inside the PS literal', () => {
    const script = buildToastScript(`evil'); $x=(1`, `body' + (Invoke-Expression 'calc')`);
    // The only single quotes allowed are the fixed ones written by the template itself
    const loadXmlLine = script.split('\n').find(l => l.includes('LoadXml'))!;
    // strip the two delimiter quotes of LoadXml('...') — inner content must have none
    const inner = loadXmlLine.slice(loadXmlLine.indexOf("('") + 2, loadXmlLine.lastIndexOf("')"));
    expect(inner).not.toContain("'");
  });
});

describe('showToast', () => {
  it('spawns powershell.exe with array args and -EncodedCommand (no shell)', () => {
    showToast('標題', '內容 with <xml> & "quotes"');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0]!;
    expect(cmd).toBe('powershell.exe');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-EncodedCommand');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
    // No part of the external text appears raw in the argv — only base64
    const script = decodeSpawnedScript();
    expect(script).toContain('標題');
    expect(script).toContain('&lt;xml&gt; &amp; &quot;quotes&quot;');
  });

  it('is a no-op on non-win32 platforms', () => {
    setPlatform('linux');
    showToast('t', 'b');
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('is a no-op when global config disables it with "0" or "false"', () => {
    mockGetGlobalConfig.mockReturnValue('0');
    showToast('t', 'b');
    mockGetGlobalConfig.mockReturnValue('false');
    showToast('t', 'b');
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockGetGlobalConfig).toHaveBeenCalledWith(TOAST_CONFIG_KEY);
  });

  it('stays enabled when config is unset or config read throws', () => {
    mockGetGlobalConfig.mockReturnValue(null);
    showToast('a', 'b');
    mockGetGlobalConfig.mockImplementation(() => { throw new Error('db closed'); });
    showToast('c', 'd');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('dedupes the same title+body within 30 seconds', () => {
    showToast('t', 'b');
    showToast('t', 'b');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_001);
    showToast('t', 'b');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe different title/body pairs', () => {
    showToast('t', 'b1');
    showToast('t', 'b2');
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('drops toasts beyond 3 per 10 seconds globally', () => {
    showToast('t1', 'b');
    showToast('t2', 'b');
    showToast('t3', 'b');
    showToast('t4', 'b'); // dropped by the global limit
    expect(mockSpawn).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(10_001);
    showToast('t5', 'b');
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it('never throws when spawn fails', () => {
    mockSpawn.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => showToast('t', 'b')).not.toThrow();
  });

  it('kills the child after 5 seconds if it does not exit', () => {
    const child = makeFakeChild();
    mockSpawn.mockReturnValue(child);
    showToast('t', 'b');
    vi.advanceTimersByTime(5_001);
    expect(child.kill).toHaveBeenCalled();
  });
});
