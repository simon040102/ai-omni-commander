import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadNotifyToken, ensureNotifyToken, verifyNotifyToken, notifyTokenPath } from '../notifyToken.js';

describe('notifyToken', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-notify-token-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('loadNotifyToken', () => {
    it('returns null when the file does not exist (MCP → no header)', () => {
      expect(loadNotifyToken(dir)).toBeNull();
    });

    it('returns the trimmed token when the file exists', () => {
      fs.writeFileSync(notifyTokenPath(dir), '  abc123  \n');
      expect(loadNotifyToken(dir)).toBe('abc123');
    });

    it('returns null for an empty file', () => {
      fs.writeFileSync(notifyTokenPath(dir), '  \n');
      expect(loadNotifyToken(dir)).toBeNull();
    });
  });

  describe('ensureNotifyToken', () => {
    it('creates a 32-hex token and persists it', () => {
      const token = ensureNotifyToken(dir);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(fs.readFileSync(notifyTokenPath(dir), 'utf-8').trim()).toBe(token);
    });

    it('reuses the existing file instead of rotating', () => {
      fs.writeFileSync(notifyTokenPath(dir), 'existing-token');
      expect(ensureNotifyToken(dir)).toBe('existing-token');
      // second startup keeps the same value
      expect(ensureNotifyToken(dir)).toBe('existing-token');
    });
  });

  describe('verifyNotifyToken — four quadrants (file existence on each side)', () => {
    it('web has no token (old web / unwritable) → accepts anything', () => {
      expect(verifyNotifyToken(null, undefined)).toBe(true);
      expect(verifyNotifyToken(null, 'whatever')).toBe(true);
    });

    it('web has token + MCP sends matching header → accepted', () => {
      expect(verifyNotifyToken('tok', 'tok')).toBe(true);
    });

    it('web has token + old MCP sends no header → 401 path', () => {
      expect(verifyNotifyToken('tok', undefined)).toBe(false);
    });

    it('web has token + wrong header (incl. arrays / different length) → 401 path', () => {
      expect(verifyNotifyToken('tok', 'wrong')).toBe(false);
      expect(verifyNotifyToken('tok', 'tok2')).toBe(false);
      expect(verifyNotifyToken('tok', ['tok'])).toBe(false);
    });
  });
});
