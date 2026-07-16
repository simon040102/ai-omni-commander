import { describe, it, expect } from 'vitest';
import { isSafePathParam } from '../pathSafety.js';

describe('isSafePathParam (upload projectId/taskId guard)', () => {
  it('accepts UUID-like ids', () => {
    expect(isSafePathParam('7053457d-7423-4c05-9976-cdeff4260628')).toBe(true);
    expect(isSafePathParam('proj_1')).toBe(true);
  });

  it('rejects .. traversal', () => {
    expect(isSafePathParam('..')).toBe(false);
    expect(isSafePathParam('../etc')).toBe(false);
    expect(isSafePathParam('a..b')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafePathParam('a/b')).toBe(false);
    expect(isSafePathParam('a\\b')).toBe(false);
    expect(isSafePathParam('..\\..\\windows')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isSafePathParam('')).toBe(false);
  });
});
