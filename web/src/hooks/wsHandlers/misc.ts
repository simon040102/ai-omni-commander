import { useToastStore } from '../../stores/toastStore';
import type { HandlerMap, WsMessageHandler } from './types';

// SVN errors — show toast for auth failures
const svnResultHandler: WsMessageHandler = (payload) => {
  const svnError = payload['error'] as string | undefined;
  if (svnError) {
    const isAuth = /auth|401|403|password|credential/i.test(svnError);
    useToastStore.getState().addToast({
      type: 'error',
      title: isAuth ? 'SVN 認證失敗' : 'SVN 錯誤',
      message: isAuth ? '請檢查 SVN 帳號密碼設定' : svnError,
      duration: 8000,
    });
  }
};

/**
 * svn.* / error WS message handlers.
 */
export const miscHandlers: HandlerMap = {
  'svn.browseResult': svnResultHandler,
  'svn.previewResult': svnResultHandler,

  'error': (payload) => {
    useToastStore.getState().addToast({
      type: 'error',
      title: `錯誤：${payload['code'] || 'unknown'}`,
      message: payload['message'] as string,
      duration: 10000,
    });
  },
};
