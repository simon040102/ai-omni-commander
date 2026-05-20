import { EventEmitter } from 'node:events';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('PtyController');

// node-pty types (dynamic import since it requires native compilation)
interface IPty {
  pid: number;
  cols: number;
  rows: number;
  onData: (callback: (data: string) => void) => { dispose(): void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/**
 * Low-level wrapper around node-pty.
 * Handles spawn, write, resize, kill, and ANSI stripping.
 *
 * Events:
 *   'data' (string) — raw PTY output (includes ANSI codes)
 *   'clean-data' (string) — ANSI-stripped output
 *   'exit' ({ exitCode: number, signal?: number }) — process exited
 */
export class PtyController extends EventEmitter {
  private pty: IPty | null = null;
  private _pid: number | null = null;
  private _alive = false;
  private stripAnsi: ((s: string) => string) | null = null;

  get pid(): number | null { return this._pid; }
  get isAlive(): boolean { return this._alive; }

  /** Spawn a process in a real PTY */
  async spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
    },
  ): Promise<void> {
    // Dynamic import of node-pty (native module)
    let nodePty: { spawn: (cmd: string, args: string[], opts: Record<string, unknown>) => IPty };
    try {
      nodePty = await import('node-pty');
    } catch (err) {
      throw new Error(`Failed to load node-pty: ${(err as Error).message}. Make sure native build tools are installed.`);
    }

    // Dynamic import of strip-ansi (ESM module)
    try {
      const stripAnsiModule = await import('strip-ansi');
      this.stripAnsi = stripAnsiModule.default || stripAnsiModule;
    } catch {
      // Fallback: basic ANSI stripping regex
      this.stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
    }

    logger.info({ command, args, cwd: options.cwd }, 'Spawning PTY process');

    // On Windows, .cmd scripts need cmd.exe wrapper; on Unix, spawn directly
    const spawnCmd = process.platform === 'win32' ? 'cmd.exe' : command;
    const spawnArgs = process.platform === 'win32' ? ['/c', command, ...args] : args;

    this.pty = nodePty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cols: options.cols || 200,
      rows: options.rows || 50,
      cwd: options.cwd,
      env: options.env || process.env as Record<string, string>,
    });

    this._pid = this.pty.pid;
    this._alive = true;

    // Auto-accept CLI confirmation prompts (trust folder, bypass permissions)
    let initBuffer = '';
    const stripInit = (s: string) => s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
    let promptsHandled = 0;

    const initListener = this.pty.onData((data: string) => {
      initBuffer += data;
      const clean = stripInit(initBuffer);

      // Debug: log every 500 chars of clean buffer to see what's coming
      if (initBuffer.length % 500 < data.length) {
        logger.info({ cleanLen: clean.length, cleanTail: clean.slice(-100) }, 'PTY init buffer');
      }

      if (clean.includes('Entertoconfirm') || clean.includes('Enter to confirm')) {
        // "Trust this folder?" — option 1 (Yes) is default, just Enter
        if (clean.includes('Itrustthisfolder') || clean.includes('I trust this folder')) {
          promptsHandled++;
          logger.info('Auto-accepting: trust folder prompt');
          setTimeout(() => this.pty?.write('\r'), 300);
          initBuffer = '';
        }
        // "Bypass permissions?" — option 2 (Yes), need Down arrow then Enter
        else if (clean.includes('Iaccept') || clean.includes('I accept')) {
          promptsHandled++;
          logger.info('Auto-accepting: bypass permissions prompt');
          setTimeout(() => {
            this.pty?.write('\x1B[B'); // Down arrow to select option 2
            setTimeout(() => this.pty?.write('\r'), 200);
          }, 300);
          initBuffer = '';
        }
      }

      if (promptsHandled >= 3) initListener.dispose();
    });
    setTimeout(() => initListener.dispose(), 20000);

    // Wire up events
    this.pty.onData((data: string) => {
      this.emit('data', data);
      if (this.stripAnsi) {
        const clean = this.stripAnsi(data);
        if (clean.trim()) {
          this.emit('clean-data', clean);
        }
      }
    });

    this.pty.onExit((e) => {
      this._alive = false;
      logger.info({ pid: this._pid, exitCode: e.exitCode, signal: e.signal }, 'PTY process exited');
      this.emit('exit', e);
    });
  }

  /** Write data to the PTY stdin (raw, for control chars like \r, Ctrl+C) */
  write(data: string): void {
    if (!this.pty || !this._alive) {
      logger.warn('Cannot write to PTY: process not alive');
      return;
    }
    this.pty.write(data);
  }

  /**
   * Type text character by character then press Enter.
   * Ink (Claude CLI's terminal UI) doesn't accept bulk paste —
   * it needs individual keystrokes to register in the TextInput component.
   */
  async typeAndSubmit(text: string, charDelayMs = 2): Promise<void> {
    if (!this.pty || !this._alive) {
      logger.warn('Cannot type to PTY: process not alive');
      return;
    }
    // Type each character with a small delay
    for (const char of text) {
      this.pty.write(char);
      if (charDelayMs > 0) {
        await new Promise(r => setTimeout(r, charDelayMs));
      }
    }
    // Press Enter (carriage return)
    await new Promise(r => setTimeout(r, 50));
    this.pty.write('\r');
  }

  /** Send Enter key */
  enter(): void {
    this.write('\r');
  }

  /** Send Ctrl+C (interrupt) */
  interrupt(): void {
    this.write('\x03');
  }

  /** Resize the PTY */
  resize(cols: number, rows: number): void {
    if (this.pty) {
      this.pty.resize(cols, rows);
    }
  }

  /** Kill the PTY process */
  kill(signal?: string): void {
    if (!this.pty) return;
    try {
      this.pty.kill(signal);
    } catch (err) {
      logger.warn({ err }, 'Error killing PTY process');
    }
    this._alive = false;
  }

  /**
   * Wait for Claude CLI to show its input prompt (❯ or >) before typing.
   * Returns true if prompt detected, false if timed out.
   */
  waitForReady(timeoutMs = 15000): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this._alive) { resolve(false); return; }

      let buffer = '';
      let resolved = false;
      const done = (found: boolean) => {
        if (!resolved) {
          resolved = true;
          resolve(found);
        }
      };

      const handler = (data: string) => {
        buffer += data;
        // Strip ANSI codes
        const clean = buffer.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
        if (clean.includes('❯') || clean.includes('\n> ') || clean.match(/\n[?] /)) {
          this.removeListener('data', handler);
          // Small extra delay to ensure CLI is fully ready
          setTimeout(() => done(true), 300);
        }
      };

      this.on('data', handler);

      // Fallback timeout
      setTimeout(() => {
        this.removeListener('data', handler);
        logger.warn({ timeoutMs }, 'waitForReady: CLI prompt not detected within timeout, proceeding');
        done(false);
      }, timeoutMs);
    });
  }

  /** Graceful stop: Ctrl+C → wait → force kill */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    if (!this._alive) return;

    // Send Ctrl+C
    this.interrupt();

    // Wait for exit
    const exited = await Promise.race([
      new Promise<boolean>(resolve => {
        this.once('exit', () => resolve(true));
      }),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), timeoutMs)),
    ]);

    // Force kill if still alive
    if (!exited && this._alive) {
      logger.warn({ pid: this._pid }, 'PTY did not exit gracefully, force killing');
      this.kill();
    }
  }
}
