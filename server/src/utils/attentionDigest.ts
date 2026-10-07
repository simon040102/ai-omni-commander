/**
 * 每日「該注意什麼」推送（Web Server 專用——MCP process 每個 session 都 spawn，不掛排程）。
 *
 * 只推新的變化：比對上次快照，有新東西才寫 data/attention/YYYY-MM-DD.md 並跳 Windows 通知；
 * 沒有新東西就安靜（不推「一切正常」——那只會讓人學會忽略通知）。
 *
 * 鐵律（同 DB 備份）：best-effort——任何失敗只 log，絕不 throw、絕不擋 server。
 * 只讀 DB；不改任務狀態、不 resolve 缺口、不回寫 Asana。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { collectAttention } from '../mcp/attention-query.js';
import {
  diffAttention, snapshotOf, shouldRunDigest, localYmd,
  type AttentionDiff, type AttentionSnapshot, type AttentionSummary, type GapGroup,
} from '../mcp/attention.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger('AttentionDigest');

/** 每區最多列幾筆（檔案是給人看的，不是資料匯出） */
const MAX_PER_SECTION = 30;

interface DigestState {
  lastRunYmd: string | null;
  snapshot: AttentionSnapshot | null;
}

const flat = (t: string, n = 80) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function gapLines(groups: Array<GapGroup & { newGapCount?: number }>): string[] {
  const L = groups.slice(0, MAX_PER_SECTION).map(g => {
    const extra = g.newGapCount != null && g.newGapCount !== g.gapCount ? `（新增 ${g.newGapCount}）` : '';
    return `- **${g.taskTitle ?? '(任務已刪除)'}**（${g.projectName}）— ${g.gapCount} 條${extra}，最久 ${g.oldestDays} 天\n  - 例：${flat(g.sample)}${g.taskId ? `　\`${g.taskId}\`` : ''}`;
  });
  if (groups.length > MAX_PER_SECTION) L.push(`- （其餘 ${groups.length - MAX_PER_SECTION} 項略）`);
  return L;
}

function taskLines(ts: Array<{ taskId: string; title: string; projectName: string | null }>, tail: (t: any) => string): string[] {
  const L = ts.slice(0, MAX_PER_SECTION).map(t => `- **${t.title}**（${t.projectName}）— ${tail(t)}　\`${t.taskId}\``);
  if (ts.length > MAX_PER_SECTION) L.push(`- （其餘 ${ts.length - MAX_PER_SECTION} 項略）`);
  return L;
}

const stalledTail = (t: { stalledHours: number }) => `${t.stalledHours} 小時沒動靜`;
const overdueTail = (t: { dueText: string; alsoStalled?: boolean }) => `${t.dueText}${t.alsoStalled ? '，且停滯中' : ''}`;

/** 純函式：產出推送檔內容與通知文字。 */
export function renderDigest(diff: AttentionDiff, cur: AttentionSummary, ymd: string): { markdown: string; title: string; body: string } {
  const c = cur.counts;
  const totals = `目前總數：卡住的缺口 ${c.blocking}・結案仍有缺口 ${c.closedWithOpenGaps}・失敗任務的缺口 ${c.failedWithOpenGaps}・停滯 ${c.stalled}・逾期 ${c.overdue}`;
  const L: string[] = [`# 該注意什麼｜${ymd}`, ''];

  if (diff.baseline) {
    L.push('**第一次執行：建立基線。** 以下是目前全部的待注意事項；之後每天只會列「比上次多出來的」。', '', totals, '');
    const sec = (title: string, lines: string[]) => { if (lines.length) L.push(`## ${title}`, '', ...lines, ''); };
    sec('卡著工作的缺口', gapLines(cur.blocking));
    sec('帶著未裁決缺口結案', gapLines(cur.closedWithOpenGaps));
    sec('失敗任務上的缺口', gapLines(cur.failedWithOpenGaps));
    sec('疑似停滯的進行中任務', taskLines(cur.stalled, stalledTail));
    sec('已逾期', taskLines(cur.overdue, overdueTail));
  } else {
    L.push(totals, '');
    const sec = (title: string, hint: string, lines: string[]) => { if (lines.length) L.push(`## ${title}`, '', hint, '', ...lines, ''); };
    sec('新卡住的缺口', '進行中任務上的缺口剛擱置滿門檻。要找能裁決規格的人。', gapLines(diff.newBlocking));
    sec('新的「帶著缺口結案」', '任務標完成了，缺口沒裁決。沒影響就 resolve 並寫理由；有影響就是結案太早。', gapLines(diff.newClosedWithOpenGaps));
    sec('失敗任務上的新缺口', '重試前先裁決。', gapLines(diff.newFailedWithOpenGaps));
    sec('新停滯的任務', '用 resume_task 接手，或標 failed。', taskLines(diff.newStalled, stalledTail));
    sec('新逾期的任務', '', taskLines(diff.newOverdue, overdueTail));
    const cl = diff.cleared;
    const clearedParts = [
      cl.blocking && `卡住的缺口 ${cl.blocking}`, cl.closedWithOpenGaps && `結案缺口 ${cl.closedWithOpenGaps}`,
      cl.failedWithOpenGaps && `失敗任務缺口 ${cl.failedWithOpenGaps}`, cl.stalled && `停滯 ${cl.stalled}`, cl.overdue && `逾期 ${cl.overdue}`,
    ].filter(Boolean);
    if (clearedParts.length) L.push('## 比上次少了', '', clearedParts.join('・'), '');
  }
  L.push('---', '', '完整清單：在 Claude Code 呼叫 `get_attention_summary`。這份只是通知，omni 不會自動改任何東西。');

  const title = diff.baseline ? 'omni：已建立每日提醒基線' : 'omni：該注意什麼';
  const nNew = diff.newBlocking.length + diff.newClosedWithOpenGaps.length + diff.newFailedWithOpenGaps.length + diff.newStalled.length + diff.newOverdue.length;
  const body = diff.baseline
    ? `卡住缺口 ${c.blocking}、停滯 ${c.stalled}、逾期 ${c.overdue}`
    : nNew ? `${nNew} 項新狀況（停滯 +${diff.newStalled.length}、逾期 +${diff.newOverdue.length}、缺口 +${diff.newBlocking.length + diff.newClosedWithOpenGaps.length + diff.newFailedWithOpenGaps.length}）`
      : '沒有新狀況，有些事被處理掉了';
  return { markdown: L.join('\n'), title, body };
}

export type Notifier = (title: string, body: string, filePath: string) => void;

/** Windows 右下角氣泡通知。非 Windows 不做事。失敗只 log。 */
export const notifyWindows: Notifier = (title, body, filePath) => {
  if (process.platform !== 'win32') return;
  const q = (s: string) => s.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    `$n.BalloonTipTitle = '${q(title)}'`,
    `$n.BalloonTipText = '${q(body + '\n' + filePath)}'`,
    '$n.Visible = $true',
    '$n.ShowBalloonTip(15000)',
    'Start-Sleep -Seconds 16',
    '$n.Dispose()',
  ].join('; ');
  try {
    // EncodedCommand = UTF-16LE base64 → 中文不會被 PS5.1 的 ANSI 碼頁弄壞
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.on('error', err => logger.warn({ err }, 'Windows 通知失敗'));
    child.unref();
  } catch (err) {
    logger.warn({ err }, 'Windows 通知失敗');
  }
};

export interface RunDigestOptions {
  db: Database.Database;
  dataDir: string;
  now?: Date;
  /** 幾點之後才跑（本地時間，預設 9） */
  hour?: number;
  notify?: Notifier;
}

export interface RunDigestResult {
  ran: boolean;
  wrote?: string;
  notified?: boolean;
  error?: string;
}

function readState(file: string): DigestState {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DigestState>;
    return { lastRunYmd: s.lastRunYmd ?? null, snapshot: s.snapshot ?? null };
  } catch {
    return { lastRunYmd: null, snapshot: null };
  }
}

export function runAttentionDigest(opts: RunDigestOptions): RunDigestResult {
  const now = opts.now ?? new Date();
  const dir = path.join(opts.dataDir, 'attention');
  const stateFile = path.join(dir, 'state.json');
  try {
    const state = readState(stateFile);
    if (!shouldRunDigest(state.lastRunYmd, now, opts.hour ?? 9)) return { ran: false };

    const collected = collectAttention(opts.db, { now });
    if (!collected) return { ran: false, error: 'collect failed' };
    const cur = collected.summary;
    const diff = diffAttention(state.snapshot, cur);
    const ymd = localYmd(now);

    fs.mkdirSync(dir, { recursive: true });
    let wrote: string | undefined;
    let notified = false;
    if (diff.hasNews) {
      const { markdown, title, body } = renderDigest(diff, cur, ymd);
      wrote = path.join(dir, `${ymd}.md`);
      fs.writeFileSync(wrote, markdown, 'utf8');
      (opts.notify ?? notifyWindows)(title, body, wrote);
      notified = true;
    }
    // 沒新消息也要記「今天跑過了」，並更新快照（被處理掉的項目才不會明天又被當成「少了」）
    fs.writeFileSync(stateFile, JSON.stringify({ lastRunYmd: ymd, snapshot: snapshotOf(cur) }, null, 2), 'utf8');
    logger.info({ ymd, hasNews: diff.hasNews, baseline: diff.baseline, wrote }, 'Attention digest done');
    return { ran: true, wrote, notified };
  } catch (err) {
    logger.warn({ err }, 'Attention digest failed — skipped');
    return { ran: false, error: String(err) };
  }
}
