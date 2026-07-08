import { useProjectStore } from '../../stores/projectStore';
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
 * svn.* / intervention.* / error WS message handlers.
 */
export const miscHandlers: HandlerMap = {
  'svn.browseResult': svnResultHandler,
  'svn.previewResult': svnResultHandler,

  'intervention.request': (payload) => {
    useProjectStore.getState().addIntervention({
      id: payload['interventionId'] as string,
      agentId: payload['agentId'] as string,
      agentRole: payload['agentRole'] as string,
      taskId: (payload['taskId'] as string) || null,
      reason: payload['reason'] as string,
      context: payload['context'] as string,
      status: 'pending',
    });
    useToastStore.getState().addToast({
      type: 'warning',
      title: '需要人工介入',
      message: payload['reason'] as string,
      duration: 0, // persistent
    });
  },

  'error': (payload) => {
    useToastStore.getState().addToast({
      type: 'error',
      title: `錯誤：${payload['code'] || 'unknown'}`,
      message: payload['message'] as string,
      duration: 10000,
    });
  },
};
