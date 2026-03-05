import { useEffect } from 'react';
import { WsClient } from '../lib/wsClient';
import { useWsStore } from '../stores/wsStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useToastStore } from '../stores/toastStore';
import { notifyTab } from '../lib/tabNotification';

/**
 * Connect to the server WebSocket and dispatch incoming messages to stores.
 */
export function useWebSocket() {
  const setConnected = useWsStore(s => s.setConnected);
  const setClient = useWsStore(s => s.setClient);
  const setProjects = useProjectStore(s => s.setProjects);
  const setProjectState = useProjectStore(s => s.setProjectState);
  const updateTaskStatus = useProjectStore(s => s.updateTaskStatus);
  const updateAgentStatus = useProjectStore(s => s.updateAgentStatus);
  const addOrUpdateAgent = useProjectStore(s => s.addOrUpdateAgent);
  const addIntervention = useProjectStore(s => s.addIntervention);
  const markProjectActivity = useProjectStore(s => s.markProjectActivity);
  const appendOutput = useAgentStore(s => s.appendOutput);
  const appendStreaming = useAgentStore(s => s.appendStreaming);
  const clearStreamingBuffer = useAgentStore(s => s.clearStreamingBuffer);
  const setOutputsBulk = useAgentStore(s => s.setOutputsBulk);
  const clearOutputs = useAgentStore(s => s.clearOutputs);
  const clearAllOutputs = useAgentStore(s => s.clearAll);
  const addToast = useToastStore(s => s.addToast);

  useEffect(() => {
    const wsUrl = `ws://${window.location.host}/omni-ws`;

    const client = new WsClient(
      wsUrl,
      (msg: Record<string, unknown>) => {
        const type = msg['type'] as string;
        const payload = msg['payload'] as Record<string, unknown>;

        switch (type) {
          case 'projects.list':
            setProjects(payload['projects'] as Parameters<typeof setProjects>[0]);
            break;

          case 'project.state':
            // Clear all cached outputs on reconnect — fresh outputs will be loaded via project.agentOutputs
            clearAllOutputs();
            setProjectState(payload as Parameters<typeof setProjectState>[0]);
            addToast({ type: 'success', title: 'Project loaded', message: `Project state received` });
            break;

          case 'project.agentOutputs': {
            // Bulk load historical outputs for an agent (from DB)
            const bulkAgentId = payload['agentId'] as string;
            const bulkOutputs = payload['outputs'] as Array<{ streamType: string; content: string; timestamp: string }>;
            if (bulkAgentId && bulkOutputs) {
              setOutputsBulk(bulkAgentId, bulkOutputs.map(o => ({
                streamType: o.streamType as 'text',
                content: o.content,
                timestamp: o.timestamp,
              })));
            }
            break;
          }

          case 'agent.output': {
            const agentId = payload['agentId'] as string;
            const isStreaming = payload['isStreaming'] as boolean;
            const streamType = payload['streamType'] as string;
            const content = payload['content'] as string;
            const outputProjectId = payload['projectId'] as string | undefined;

            // Mark activity for non-current projects
            if (outputProjectId) {
              markProjectActivity(outputProjectId);
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
              break;
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
              break;
            }

            // Other non-streaming output (tool_use, tool_result, system, etc.) — add normally
            appendOutput(agentId, {
              streamType: streamType as 'text',
              content: content,
              toolName: payload['toolName'] as string | undefined,
              timestamp: payload['timestamp'] as string,
            });
            break;
          }

          case 'agent.outputsCleared': {
            // Server cleared outputs for an agent (rerun) — clear frontend terminal too
            const clearedAgentId = payload['agentId'] as string;
            if (clearedAgentId) {
              clearOutputs(clearedAgentId);
            }
            break;
          }

          case 'agent.started': {
            const startedProjectId = payload['projectId'] as string;
            // Mark activity for non-current projects
            markProjectActivity(startedProjectId);
            // A new agent was spawned — add it to the store
            addOrUpdateAgent({
              id: payload['agentId'] as string,
              projectId: startedProjectId,
              role: payload['role'] as string,
              status: 'running',
              currentTaskId: null,
              model: '',
              totalCostUsd: 0,
              totalTurns: 0,
            });
            addToast({ type: 'info', title: 'Agent started', message: `${payload['role']} agent is now running` });
            break;
          }

          case 'agent.statusChange': {
            const newStatus = payload['newStatus'] as string;
            updateAgentStatus(
              payload['agentId'] as string,
              newStatus,
            );
            if (newStatus === 'running') {
              addToast({ type: 'info', title: 'Agent started', message: `Agent is now running` });
            } else if (newStatus === 'error') {
              addToast({ type: 'error', title: 'Agent error', message: `Agent encountered an error`, duration: 8000 });
            } else if (newStatus === 'stopped') {
              addToast({ type: 'info', title: 'Agent stopped' });
            }
            break;
          }

          case 'agent.completed': {
            const completedProjectId = payload['projectId'] as string;
            // Mark activity for non-current projects
            markProjectActivity(completedProjectId);
            const inputTokens = (payload['inputTokens'] as number) || 0;
            const outputTokens = (payload['outputTokens'] as number) || 0;
            const totalTokens = inputTokens + outputTokens;
            addOrUpdateAgent({
              id: payload['agentId'] as string,
              projectId: completedProjectId,
              role: '',
              status: 'stopped',
              currentTaskId: null,
              model: '',
              totalCostUsd: (payload['costUsd'] as number) || 0,
              totalTurns: (payload['turns'] as number) || 0,
              totalInputTokens: inputTokens,
              totalOutputTokens: outputTokens,
            });
            addToast({
              type: 'success',
              title: 'Agent completed',
              message: `Cost: $${((payload['costUsd'] as number) || 0).toFixed(4)} | ${(totalTokens / 1000).toFixed(1)}k tokens`,
            });
            break;
          }

          case 'task.statusChange': {
            const taskStatus = payload['newStatus'] as string;
            updateTaskStatus(
              payload['taskId'] as string,
              taskStatus,
              payload['assignedAgentId'] as string | undefined,
            );
            if (taskStatus === 'failed') {
              addToast({ type: 'error', title: 'Task failed', message: `Task ${payload['taskId']}`, duration: 8000 });
            } else if (taskStatus === 'completed') {
              addToast({ type: 'success', title: 'Task completed' });
            }
            break;
          }

          case 'intervention.request':
            addIntervention({
              id: payload['interventionId'] as string,
              agentId: payload['agentId'] as string,
              agentRole: payload['agentRole'] as string,
              taskId: (payload['taskId'] as string) || null,
              reason: payload['reason'] as string,
              context: payload['context'] as string,
              status: 'pending',
            });
            addToast({
              type: 'warning',
              title: 'Intervention needed',
              message: payload['reason'] as string,
              duration: 0, // persistent
            });
            break;

          case 'interview.question':
          case 'interview.specDraft':
            // Handled by specific components
            window.dispatchEvent(new CustomEvent('omni:interview', { detail: msg }));
            break;

          case 'error':
            addToast({
              type: 'error',
              title: `Error: ${payload['code'] || 'unknown'}`,
              message: payload['message'] as string,
              duration: 10000,
            });
            break;

          default:
            // Log unhandled message types for debugging
            console.log('[WS] unhandled message type:', type, payload);
            break;
        }
      },
      (connected) => {
        setConnected(connected);
        if (connected) {
          addToast({ type: 'success', title: 'Connected to server', duration: 2000 });
        } else {
          addToast({ type: 'warning', title: 'Disconnected', message: 'Reconnecting...', duration: 3000 });
        }
      },
    );

    client.connect();
    setClient(client);

    return () => {
      client.disconnect();
    };
  }, []);
}
