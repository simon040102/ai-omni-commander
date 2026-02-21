import { EventEmitter } from 'node:events';
import type { ClaudeStreamMessage } from '@omni/shared';

/**
 * Parses NDJSON lines from Claude CLI's --output-format stream-json
 * Emits typed ClaudeStreamMessage objects.
 */
export class StreamParser extends EventEmitter {
  private buffer = '';

  /** Feed raw stdout data chunks */
  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed) as ClaudeStreamMessage;
        this.emit('message', msg);
      } catch {
        // Non-JSON output: treat as raw text
        this.emit('message', { type: 'raw', content: trimmed } as ClaudeStreamMessage);
      }
    }
  }

  /** Flush any remaining buffer content */
  flush(): void {
    if (this.buffer.trim()) {
      try {
        const msg = JSON.parse(this.buffer.trim()) as ClaudeStreamMessage;
        this.emit('message', msg);
      } catch {
        this.emit('message', { type: 'raw', content: this.buffer.trim() } as ClaudeStreamMessage);
      }
      this.buffer = '';
    }
  }
}
