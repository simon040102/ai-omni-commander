import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';
import { notifyTab } from '../../lib/tabNotification';
import type { Agent } from '../../stores/projectStore';
import type { HandlerMap } from './types';

/**
 * agent.* WS message handlers.
 */
export const agentHandlers: HandlerMap = {
  // MCP agent 回報進度（report_output）時會廣播：標記專案有活動、文字輸出時通知瀏覽器分頁。
  // 輸出內容本身的顯示（TerminalOutput）已隨 legacy spawn 移除。
  'agent.output': (payload) => {
    const outputProjectId = payload['projectId'] as string | undefined;
    if (outputProjectId) {
      useProjectStore.getState().markProjectActivity(outputProjectId);
    }
    if (payload['streamType'] === 'text' && !payload['isStreaming']) {
      notifyTab();
    }
  },

  'agent.started': (payload) => {
    const startedProjectId = payload['projectId'] as string;
    // Mark activity for non-current projects
    useProjectStore.getState().markProjectActivity(startedProjectId);
    // A new agent was spawned — add it to the store
    useProjectStore.getState().addOrUpdateAgent({
      id: payload['agentId'] as string,
      projectId: startedProjectId,
      title: (payload['title'] as string) || null,
      role: payload['role'] as string,
      status: 'running',
      currentTaskId: (payload['taskId'] as string) || null,
      model: (payload['model'] as string) || '',
      sessionId: (payload['sessionId'] as string) || null,
      totalCostUsd: 0,
      totalTurns: 0,
      createdAt: new Date().toISOString(),
    });
    useToastStore.getState().addToast({
      type: 'info',
      title: 'Agent 啟動',
      message: `${payload['role']} Agent 開始執行`,
    });
  },

  'agent.statusChange': (payload) => {
    const newStatus = payload['newStatus'] as string;
    useProjectStore.getState().updateAgentStatus(
      payload['agentId'] as string,
      newStatus,
    );
    // Note: no toast for 'running' — agent.started already announces the launch
    if (newStatus === 'error') {
      useToastStore.getState().addToast({ type: 'error', title: 'Agent 錯誤', message: 'Agent 發生錯誤', duration: 8000 });
    } else if (newStatus === 'stopped') {
      useToastStore.getState().addToast({ type: 'info', title: 'Agent 已停止' });
    }
  },

  'agent.completed': (payload) => {
    const completedProjectId = payload['projectId'] as string;
    const completedAgentId = payload['agentId'] as string;
    // Mark activity for non-current projects
    useProjectStore.getState().markProjectActivity(completedProjectId);
    const inputTokens = (payload['inputTokens'] as number) || 0;
    const outputTokens = (payload['outputTokens'] as number) || 0;
    const totalTokens = inputTokens + outputTokens;
    // Keep currentTaskId so fullstack grid view and agent cards still show task info
    useProjectStore.getState().addOrUpdateAgent({
      id: completedAgentId,
      projectId: completedProjectId,
      status: 'stopped',
      totalCostUsd: (payload['costUsd'] as number) || 0,
      totalTurns: (payload['turns'] as number) || 0,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
    } as Agent);
    useToastStore.getState().addToast({
      type: 'success',
      title: 'Agent 完成',
      message: `費用：$${((payload['costUsd'] as number) || 0).toFixed(4)} | ${(totalTokens / 1000).toFixed(1)}k tokens`,
    });
    // Keep outputs visible — user expects to see terminal content after completion.
    // Outputs are also persisted in DB and reloaded on project switch.
  },

};
