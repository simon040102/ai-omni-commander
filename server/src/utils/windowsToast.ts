/**
 * Windows toast notifications (server-side, WinRT via PowerShell).
 *
 * Security model (highest priority — title/body often contain external text
 * such as Asana task titles):
 * - The notification text NEVER touches shell parsing. The whole PowerShell
 *   script is passed via `-EncodedCommand` (UTF-16LE base64), and spawn() is
 *   called with an args ARRAY (no shell), so there is zero injection surface
 *   at the process-spawn layer.
 * - Inside the script the text lands in an XML text node loaded with
 *   LoadXml(); `escapeToastText` XML-escapes it first (& < > " ') and strips
 *   XML-invalid control characters. After XML escaping no single quote can
 *   remain, so the surrounding PowerShell single-quoted literal cannot be
 *   broken out of either (a defensive single-quote doubling is applied anyway).
 *
 * Reliability model: toasts are best-effort and must never affect the main
 * flow — every path is wrapped in try/catch and failures only logger.debug.
 */
import { spawn } from 'node:child_process';
import { getGlobalConfig } from '../db/queries/globalConfig.js';
import { logger } from './logger.js';

/** global_config key — set to '0' or 'false' to disable (default: enabled). */
export const TOAST_CONFIG_KEY = 'notify.windowsToast';

const APP_ID = 'AI-OmniCommander';
/** Same (title+body) shown at most once per this window. */
const DEDUPE_WINDOW_MS = 30_000;
/** At most GLOBAL_MAX toasts per GLOBAL_WINDOW_MS overall (event-storm guard). */
const GLOBAL_WINDOW_MS = 10_000;
const GLOBAL_MAX = 3;
/** Kill the PowerShell child if it hangs longer than this. */
const KILL_TIMEOUT_MS = 5_000;
/** Cap per text field — toast UI shows ~2 lines anyway, and an unbounded
 *  title would blow the Windows 32K argv limit via -EncodedCommand. */
const MAX_TEXT_LENGTH = 200;

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const DEL = 127;

/**
 * Strip characters invalid in XML 1.0 (control chars below 0x20 except
 * tab/LF/CR, plus DEL) — they would make PowerShell's LoadXml() throw.
 * Implemented char-by-char (no regex) to keep control characters out of
 * the source file entirely.
 */
function stripXmlInvalidChars(input: string): string {
  // for...of iterates by code point: a VALID surrogate pair arrives as one
  // char with codePointAt >= 0x10000, so any code still inside the surrogate
  // range (0xD800-0xDFFF) here is a LONE half (e.g. from a slice that cut an
  // emoji pair) — lone surrogates and U+FFFE/U+FFFF make LoadXml() throw.
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) as number;
    const invalid = (code < SPACE && code !== TAB && code !== LF && code !== CR)
      || code === DEL
      || (code >= 0xD800 && code <= 0xDFFF)
      || code === 0xFFFE || code === 0xFFFF;
    if (!invalid) out += ch;
  }
  return out;
}

const recentByKey = new Map<string, number>();
let globalTimestamps: number[] = [];

/** Test hook: clear throttle state between test cases. */
export function resetToastThrottle(): void {
  recentByKey.clear();
  globalTimestamps = [];
}

/**
 * Escape external text for embedding in the toast payload.
 * 1. Strip characters invalid in XML 1.0 (control chars except tab/LF/CR).
 * 2. XML-escape & < > " ' — the text sits in an XML text node.
 * 3. Double any remaining single quote (defense-in-depth for the PowerShell
 *    single-quoted string literal; a no-op after step 2).
 */
export function escapeToastText(input: string): string {
  // Cap BEFORE stripping: a slice can cut a surrogate pair — the resulting
  // lone half is then repaired by toWellFormed() inside the strip.
  const cleaned = stripXmlInvalidChars(input.slice(0, MAX_TEXT_LENGTH));
  const xmlEscaped = cleaned
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  return xmlEscaped.replace(/'/g, "''");
}

/**
 * Build the PowerShell script that shows a ToastText02 notification.
 * Exported for testing — the escaped title/body are embedded in a
 * single-quoted PS string, then the whole script goes out base64-encoded.
 */
export function buildToastScript(title: string, body: string): string {
  const t = escapeToastText(title);
  const b = escapeToastText(body);
  const toastXml =
    `<toast><visual><binding template="ToastText02">` +
    `<text id="1">${t}</text><text id="2">${b}</text>` +
    `</binding></visual></toast>`;
  return [
    `$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`,
    `$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('${toastXml}')`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show($toast)`,
  ].join('\n');
}

/** Cheap pre-check for callers that do work (e.g. a DB lookup) just to build
 *  toast text — lets them skip that work when no toast could ever show. */
export function toastsMightShow(): boolean {
  return process.platform === 'win32' && isToastEnabled();
}

function isToastEnabled(): boolean {
  try {
    const value = getGlobalConfig(TOAST_CONFIG_KEY);
    return !(value === '0' || value === 'false');
  } catch (err) {
    // Config read failure must not silence notifications entirely — default on.
    logger.debug({ err }, 'windowsToast: global config read failed, defaulting to enabled');
    return true;
  }
}

function spawnToast(script: string): void {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.on('error', (err) => {
    logger.debug({ err }, 'windowsToast: powershell spawn error');
  });
  const timer = setTimeout(() => {
    try { child.kill(); } catch { /* already exited */ }
  }, KILL_TIMEOUT_MS);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
  child.unref();
}

/**
 * Show a Windows toast notification. Fire-and-forget:
 * - no-op on non-Windows platforms
 * - no-op when global_config `notify.windowsToast` is '0'/'false'
 * - throttled: same (title+body) at most once / 30s; max 3 toasts / 10s overall
 * - never throws; failures are logger.debug only
 */
export function showToast(title: string, body: string): void {
  try {
    if (process.platform !== 'win32') return;
    if (!isToastEnabled()) return;

    const now = Date.now();

    // Per-key dedupe (30s). JSON key avoids title/body boundary collisions.
    const key = JSON.stringify([title, body]);
    const last = recentByKey.get(key);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    for (const [k, ts] of recentByKey) {
      if (now - ts >= DEDUPE_WINDOW_MS) recentByKey.delete(k);
    }

    // Global rate limit (3 per 10s) — excess toasts are dropped, not queued
    globalTimestamps = globalTimestamps.filter(ts => now - ts < GLOBAL_WINDOW_MS);
    if (globalTimestamps.length >= GLOBAL_MAX) return;

    recentByKey.set(key, now);
    globalTimestamps.push(now);

    spawnToast(buildToastScript(title, body));
  } catch (err) {
    logger.debug({ err }, 'windowsToast: showToast failed');
  }
}
