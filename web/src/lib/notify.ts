/**
 * Browser desktop notifications (Web Notification API).
 *
 * Central triple-gate for every desktop notification:
 * 1. user switch (localStorage) enabled
 * 2. Notification permission granted
 * 3. tab is hidden (document.hidden) — a foreground tab already shows the UI
 *
 * Never throws — notification failures must not break WS handling.
 */

const STORAGE_KEY = 'omni.desktopNotify';

/** Whether the user turned the desktop-notification switch on. */
export function isDesktopNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDesktopNotifyEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* storage unavailable — switch simply won't persist */
  }
}

/** Current permission state, or 'unsupported' when the API is missing. */
export function getNotifyPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Ask the browser for notification permission (no-op when already decided).
 * Returns the resulting permission, or 'unsupported'.
 */
export async function requestNotifyPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Show a desktop notification when all three gates pass
 * (enabled + permission granted + tab hidden). Clicking focuses the tab.
 */
export function showDesktopNotification(title: string, body: string): void {
  try {
    if (!isDesktopNotifyEnabled()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (!document.hidden) return;
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      try {
        window.focus();
        notification.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* notifications must never break the WS handler flow */
  }
}
