import { useAsanaStore } from '../../stores/asanaStore';
import { useToastStore } from '../../stores/toastStore';
import type { AsanaTask, AsanaConnectionStatus } from '@omni/shared';
import type { HandlerMap } from './types';

/**
 * asana.* WS message handlers.
 */
export const asanaHandlers: HandlerMap = {
  'asana.tasks': (payload) => {
    useAsanaStore.getState().setTasks(payload['tasks'] as AsanaTask[]);
  },

  'asana.projects': (payload) => {
    useAsanaStore.getState().setProjects(payload['projects'] as Array<{ gid: string; name: string }>);
  },

  'asana.connectionStatus': (payload) => {
    useAsanaStore.getState().setConnectionStatus(payload as unknown as AsanaConnectionStatus);
  },

  'asana.taskStories': (payload) => {
    useAsanaStore.getState().setTaskStories(
      payload['taskGid'] as string,
      payload['stories'] as Array<{ author: string; text: string; createdAt: string }>,
    );
  },

  'asana.syncResult': (payload) => {
    const syncNewTasks = payload['newTasks'] as number;
    const syncAutoExec = payload['autoExecuted'] as number;
    useToastStore.getState().addToast({
      type: 'success',
      title: 'Asana 同步完成',
      message: `新增 ${syncNewTasks} 筆任務，自動執行 ${syncAutoExec} 筆`,
      duration: 5000,
    });
    window.dispatchEvent(new CustomEvent('omni:asana-sync', { detail: payload }));
  },

  'asana.syncConfig': (payload) => {
    window.dispatchEvent(new CustomEvent('omni:asana-sync-config', { detail: payload }));
  },

  'asana.error': (payload) => {
    useAsanaStore.getState().setError(payload['message'] as string);
    useAsanaStore.getState().setLoading(false);
    window.dispatchEvent(new CustomEvent('omni:asana-error'));
    useToastStore.getState().addToast({
      type: 'error',
      title: 'Asana 錯誤',
      message: payload['message'] as string,
      duration: 5000,
    });
  },
};
