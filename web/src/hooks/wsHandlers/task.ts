import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';
import type { Task, ReviewResult } from '../../stores/projectStore';
import type { HandlerMap } from './types';

/**
 * task.* / review.* WS message handlers.
 */
export const taskHandlers: HandlerMap = {
  'task.statusChange': (payload) => {
    const taskStatus = payload['newStatus'] as string;
    const changedTaskId = payload['taskId'] as string;
    const prevStatus = useProjectStore.getState().tasks.find(t => t.id === changedTaskId)?.status;
    useProjectStore.getState().updateTaskStatus(
      changedTaskId,
      taskStatus,
      payload['assignedAgentId'] as string | undefined,
    );
    if (taskStatus !== prevStatus) {
      if (taskStatus === 'failed') {
        useToastStore.getState().addToast({ type: 'error', title: '任務失敗', message: `任務 ${changedTaskId}`, duration: 8000 });
      } else if (taskStatus === 'completed') {
        useToastStore.getState().addToast({ type: 'success', title: '任務完成' });
      }
    }
  },

  // Task fields updated via MCP update_task — merge into store, no toast
  'task.updated': (payload) => {
    const updatedTask = payload['task'] as (Partial<Task> & { id: string }) | undefined;
    if (updatedTask?.id) {
      useProjectStore.getState().updateTask(updatedTask);
    }
  },

  // v2: Task management
  'task.created': (payload) => {
    const newTask = payload['task'] as Task;
    if (newTask) {
      useProjectStore.getState().addTask(newTask);
      useToastStore.getState().addToast({ type: 'info', title: '已建立任務', message: newTask.title });
    }
  },

  'task.list': (payload) => {
    const taskListProjectId = payload['projectId'] as string;
    const taskList = payload['tasks'] as Task[];
    if (taskListProjectId && taskList) {
      useProjectStore.getState().setTasks(taskListProjectId, taskList);
    }
  },

  // Spec gap reported/resolved via MCP — notify listening panels (SpecGapsPanel)
  'task.specGap': (payload) => {
    window.dispatchEvent(new CustomEvent('omni:spec-gap', { detail: payload }));
    if (payload['action'] === 'reported') {
      useToastStore.getState().addToast({
        type: 'warning',
        title: '規格缺口',
        message: (payload['description'] as string) || '任務回報了規格缺少/待補項目',
        duration: 8000,
      });
    }
  },

  // Spec checklist saved/waived via MCP or REST — notify listening panels (SpecCompliancePanel)
  'task.checklistSaved': (payload) => {
    window.dispatchEvent(new CustomEvent('omni:spec-compliance', { detail: payload }));
  },

  'task.retrying': (payload) => {
    const retryTaskId = payload['taskId'] as string;
    const retryCount = payload['retryCount'] as number;
    const maxRetries = payload['maxRetries'] as number;
    useToastStore.getState().addToast({
      type: 'info',
      title: '任務自動重試',
      message: `任務 ${retryTaskId} 因審查未通過，重試 ${retryCount}/${maxRetries}`,
      duration: 5000,
    });
  },

  'review.completed': (payload) => {
    const reviewTaskId = payload['taskId'] as string;
    const reviewResult = payload['result'] as ReviewResult;
    if (reviewTaskId && reviewResult) {
      useProjectStore.getState().setReviewResult(reviewTaskId, reviewResult);
      const icon = reviewResult.verdict === 'pass' ? '✅' : '❌';
      useToastStore.getState().addToast({
        type: reviewResult.verdict === 'pass' ? 'success' : 'warning',
        title: `審查：${icon} ${reviewResult.verdict.toUpperCase()}`,
        message: `評分：${reviewResult.score}/100 — ${reviewResult.issues.length} 個問題`,
        duration: reviewResult.verdict === 'pass' ? 5000 : 0,
      });
    }
  },
};
