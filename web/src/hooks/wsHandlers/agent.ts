import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useToastStore } from '../../stores/toastStore';
import { notifyTab } from '../../lib/tabNotification';
import type { Agent, AgentPlan } from '../../stores/projectStore';
import type { AgentProgress } from '../../stores/agentStore';
import type { HandlerMap } from './types';

/**
 * agent.* WS message handlers.
 */
export const agentHandlers: HandlerMap = {
  'agent.plans': (payload) => {
    const plansProjectId = payload['projectId'] as string;
    const plans = payload['plans'] as AgentPlan[];
    useProjectStore.getState().setPlans(plansProjectId, plans);
  },

  'agent.planReady': (payload) => {
    const plan = payload['plan'] as AgentPlan;
    const agentRole = payload['agentRole'] as string;
    useProjectStore.getState().addPlan(plan);
    useToastStore.getState().addToast({
      type: 'info',
      title: '計劃書已準備完成',
      message: `${agentRole} Agent 已產出實作計劃，等待審核`,
      duration: 0, // persistent
    });
  },

  'agent.initialPrompt': (payload) => {
    // Display initial prompt as the first output in terminal
    const promptAgentId = payload['agentId'] as string;
    const promptContent = payload['prompt'] as string;
    if (promptAgentId && promptContent) {
      useAgentStore.getState().appendOutput(promptAgentId, {
        streamType: 'system',
        content: `[初始 Prompt]\n\n${promptContent}`,
        timestamp: new Date().toISOString(),
      });
    }
  },

  'agent.output': (payload) => {
    const agentId = payload['agentId'] as string;
    const isStreaming = payload['isStreaming'] as boolean;
    const streamType = payload['streamType'] as string;
    const content = payload['content'] as string;
    const outputProjectId = payload['projectId'] as string | undefined;
    const { appendStreaming, appendOutput, clearStreamingBuffer } = useAgentStore.getState();

    // Mark activity for non-current projects
    if (outputProjectId) {
      useProjectStore.getState().markProjectActivity(outputProjectId);
    }

    // Notify browser tab when text output arrives (not tool results/etc)
    if (streamType === 'text' && !isStreaming) {
      notifyTab();
    }

    // Handle streaming content — accumulate in buffer for real-time display
    if (isStreaming) {
      if (streamType === 'text') {
        appendStreaming(agentId, 'text', content);
      } else if (streamType === 'system' && content.startsWith('[thinking]')) {
        appendStreaming(agentId, 'thinking', content.replace('[thinking] ', ''));
      }
      return;
    }

    // Non-streaming text or thinking = server flush after streaming
    // Add the complete content to outputs (for persistence) and clear the streaming buffer
    if (streamType === 'text' || (streamType === 'system' && content.startsWith('[thinking]'))) {
      // Add to outputs so it persists in the UI
      appendOutput(agentId, {
        streamType: streamType as 'text',
        content: content,
        timestamp: payload['timestamp'] as string,
      });
      clearStreamingBuffer(agentId);
      return;
    }

    // Other non-streaming output (tool_use, tool_result, system, etc.) — add normally
    appendOutput(agentId, {
      streamType: streamType as 'text',
      content: content,
      toolName: payload['toolName'] as string | undefined,
      timestamp: payload['timestamp'] as string,
    });
  },

  'agent.outputsCleared': (payload) => {
    // Server cleared outputs for an agent (rerun) — clear frontend terminal too
    const clearedAgentId = payload['agentId'] as string;
    if (clearedAgentId) {
      useAgentStore.getState().clearOutputs(clearedAgentId);
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

  'agent.contextUsage': (payload) => {
    useAgentStore.getState().setContextUsage(
      payload['agentId'] as string,
      {
        totalTokens: payload['totalTokens'] as number,
        maxTokens: payload['maxTokens'] as number,
        percentage: payload['percentage'] as number,
      },
    );
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

  'agent.progress': (payload) => {
    const progressData = payload as unknown as AgentProgress;
    if (progressData.agentId) {
      useAgentStore.getState().setProgress(progressData.agentId, progressData);
    }
  },
};
