import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createChildLogger } from '../utils/logger.js';
import type { JsonlMessage } from '@omni/shared';

const logger = createChildLogger('JsonlWatcher');

/**
 * Watches a Claude Code JSONL session file for new messages.
 * Uses byte-offset based incremental reading — never re-reads the entire file.
 *
 * Events:
 *   'message' (JsonlMessage) — a new parsed message
 *   'error' (Error) — parse or read error
 */
export class JsonlWatcher extends EventEmitter {
  private filePath: string;
  private fileOffset = 0;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private buffer = '';
  private stopped = false;

  constructor(filePath: string, initialOffset?: number) {
    super();
    this.filePath = filePath;
    if (initialOffset !== undefined) {
      this.fileOffset = initialOffset;
    }
  }

  /** Get the current file size (useful for setting offset on resume) */
  static getFileSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  /** Start watching the JSONL file for new content */
  start(): void {
    this.stopped = false;

    // Initial read of existing content
    this.readNewContent();

    // Use fs.watch for real-time notifications
    try {
      this.watcher = fs.watch(this.filePath, () => {
        if (!this.stopped) this.readNewContent();
      });
      this.watcher.on('error', () => {
        // fs.watch can fail on some systems; fall back to polling
        this.startPolling();
      });
    } catch {
      // fs.watch not available; use polling
      this.startPolling();
    }

    // Also poll periodically as backup (fs.watch can miss events on Windows)
    this.startPolling();
  }

  /** Force-read any remaining content (call before stop for accurate stats) */
  flush(): void {
    this.readNewContent();
  }

  /** Stop watching */
  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Read all messages from the file (for loading history on resume) */
  readAll(): JsonlMessage[] {
    const messages: JsonlMessage[] = [];
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonlMessage;
          messages.push(msg);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File might not exist yet
    }
    return messages;
  }

  /** Read only new messages starting from a byte offset */
  static readFrom(filePath: string, offset: number): { messages: JsonlMessage[]; newOffset: number } {
    const messages: JsonlMessage[] = [];
    try {
      let fd: number;
      try { fd = fs.openSync(filePath, 'r'); } catch { return { messages, newOffset: offset }; }
      const stat = fs.fstatSync(fd);
      if (stat.size <= offset) { fs.closeSync(fd); return { messages, newOffset: offset }; }

      const newBytes = stat.size - offset;
      const buf = Buffer.alloc(newBytes);
      fs.readSync(fd, buf, 0, newBytes, offset);
      fs.closeSync(fd);

      const text = buf.toString('utf-8');
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { messages.push(JSON.parse(trimmed) as JsonlMessage); } catch { /* skip */ }
      }
      return { messages, newOffset: stat.size };
    } catch {
      return { messages, newOffset: offset };
    }
  }

  /** Read new content from the file since last read */
  private readNewContent(): void {
    try {
      // Use fstat on open fd instead of statSync to bypass Windows metadata cache.
      // Windows can cache file size in directory metadata, causing statSync to return
      // stale values when another process (Claude CLI) appends to the file.
      let fd: number;
      try {
        fd = fs.openSync(this.filePath, 'r');
      } catch {
        return; // File doesn't exist yet
      }
      const stat = fs.fstatSync(fd);
      if (stat.size <= this.fileOffset) {
        fs.closeSync(fd);
        return; // No new content
      }

      // Read only new bytes
      const newBytes = stat.size - this.fileOffset;
      const buf = Buffer.alloc(newBytes);
      fs.readSync(fd, buf, 0, newBytes, this.fileOffset);
      fs.closeSync(fd);

      this.fileOffset = stat.size;

      // Append to buffer and process complete lines
      this.buffer += buf.toString('utf-8');
      const lines = this.buffer.split('\n');

      // Keep the last incomplete line in buffer
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonlMessage;
          this.emit('message', msg);
        } catch (err) {
          logger.warn({ err, line: trimmed.slice(0, 100) }, 'Failed to parse JSONL line');
        }
      }
    } catch (err) {
      // File might not exist yet or be locked
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.emit('error', err);
      }
    }
  }

  /** Start polling as backup for fs.watch unreliability */
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.stopped) this.readNewContent();
    }, 200); // Poll every 200ms (Windows fs.watch unreliable)
  }
}
