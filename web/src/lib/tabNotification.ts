const ORIGINAL_TITLE = 'AI-OmniCommander';
const NOTIFICATION_PREFIX = '● ';

let hasNotification = false;

/**
 * Initialize tab notification listeners.
 * Call this once when the app starts.
 */
export function initTabNotification(): void {
  const handleFocus = () => {
    if (hasNotification) {
      hasNotification = false;
      document.title = ORIGINAL_TITLE;
    }
  };

  window.addEventListener('focus', handleFocus);

  // Also handle visibility change for better mobile support
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleFocus();
    }
  });
}

/**
 * Show a notification indicator in the browser tab title.
 * Only shows if the tab is not focused.
 */
export function notifyTab(): void {
  if (!document.hasFocus() && !hasNotification) {
    hasNotification = true;
    document.title = NOTIFICATION_PREFIX + ORIGINAL_TITLE;
  }
}

/**
 * Clear the notification indicator.
 */
export function clearTabNotification(): void {
  if (hasNotification) {
    hasNotification = false;
    document.title = ORIGINAL_TITLE;
  }
}
