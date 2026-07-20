import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isDesktopNotifyEnabled,
  setDesktopNotifyEnabled,
  getNotifyPermission,
  requestNotifyPermission,
  showDesktopNotification,
} from '../notify';

/** Minimal Notification mock (jsdom does not implement the API). */
class MockNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(async () => MockNotification.permission);
  static instances: MockNotification[] = [];

  title: string;
  body: string | undefined;
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: { body?: string }) {
    this.title = title;
    this.body = options?.body;
    MockNotification.instances.push(this);
  }
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  MockNotification.instances = [];
  MockNotification.permission = 'granted';
  MockNotification.requestPermission.mockClear();
  vi.stubGlobal('Notification', MockNotification);
  setHidden(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('enabled switch (localStorage)', () => {
  it('defaults to disabled', () => {
    expect(isDesktopNotifyEnabled()).toBe(false);
  });

  it('persists enable/disable', () => {
    setDesktopNotifyEnabled(true);
    expect(isDesktopNotifyEnabled()).toBe(true);
    setDesktopNotifyEnabled(false);
    expect(isDesktopNotifyEnabled()).toBe(false);
  });
});

describe('getNotifyPermission / requestNotifyPermission', () => {
  it('reports unsupported when the API is missing', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(getNotifyPermission()).toBe('unsupported');
    expect(await requestNotifyPermission()).toBe('unsupported');
  });

  it('returns the current permission without prompting when already decided', async () => {
    MockNotification.permission = 'denied';
    expect(await requestNotifyPermission()).toBe('denied');
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('prompts when permission is default', async () => {
    MockNotification.permission = 'default';
    MockNotification.requestPermission.mockResolvedValue('granted');
    expect(await requestNotifyPermission()).toBe('granted');
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });
});

describe('showDesktopNotification — triple gate', () => {
  it('fires when enabled + granted + tab hidden', () => {
    setDesktopNotifyEnabled(true);
    showDesktopNotification('✅ 任務完成', 'SM27 專案成員維護');
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]!.title).toBe('✅ 任務完成');
    expect(MockNotification.instances[0]!.body).toBe('SM27 專案成員維護');
  });

  it('does not fire when the switch is off', () => {
    showDesktopNotification('t', 'b');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not fire without granted permission', () => {
    setDesktopNotifyEnabled(true);
    MockNotification.permission = 'denied';
    showDesktopNotification('t', 'b');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not fire when the tab is visible (foreground)', () => {
    setDesktopNotifyEnabled(true);
    setHidden(false);
    showDesktopNotification('t', 'b');
    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not throw when the API is missing', () => {
    setDesktopNotifyEnabled(true);
    vi.stubGlobal('Notification', undefined);
    expect(() => showDesktopNotification('t', 'b')).not.toThrow();
  });

  it('click focuses the window and closes the notification', () => {
    setDesktopNotifyEnabled(true);
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
    showDesktopNotification('t', 'b');
    const n = MockNotification.instances[0]!;
    expect(n.onclick).toBeTypeOf('function');
    n.onclick!();
    expect(focusSpy).toHaveBeenCalled();
    expect(n.close).toHaveBeenCalled();
    focusSpy.mockRestore();
  });
});
