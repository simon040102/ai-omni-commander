import { describe, it, expect } from 'vitest';
import { resolveInitialView } from '../AppShell';

describe('resolveInitialView (localStorage view restore)', () => {
  it('returns home when nothing was persisted', () => {
    expect(resolveInitialView(null)).toBe('home');
    expect(resolveInitialView('')).toBe('home');
  });

  it('restores a normal persisted view unchanged', () => {
    expect(resolveInitialView('tasks')).toBe('tasks');
    expect(resolveInitialView('settings')).toBe('settings');
    expect(resolveInitialView('spec-governance')).toBe('spec-governance');
  });

  it('falls back to the dashboard (tasks) for hidden views persisted by older sessions', () => {
    expect(resolveInitialView('agents')).toBe('tasks');
    expect(resolveInitialView('events')).toBe('tasks');
  });

  it('falls back to home for unknown / corrupted persisted values', () => {
    expect(resolveInitialView('garbage')).toBe('home');
    expect(resolveInitialView('AGENTS')).toBe('home');
  });
});
