import { useEffect } from 'react';
import { WsClient } from '../lib/wsClient';
import { useWsStore } from '../stores/wsStore';
import { useProjectStore } from '../stores/projectStore';
import { useAgentStore } from '../stores/agentStore';
import { useToastStore } from '../stores/toastStore';
import { useAsanaStore } from '../stores/asanaStore';
import { notifyTab } from '../lib/tabNotification';
import type { AsanaTask, AsanaConnectionStatus } from '@omni/shared';

/**
 * Connect to the server WebSocket and dispatch incoming messages to stores.
 */
export function useWebSocket() {
  const setConnected = useWsStore(s => s.setConnected);
  const setClient = useWsStore(s => s.setClient);
  const setProjects = useProjectStore(s => s.setProjects);
  const setProjectState = useProjectStore(s => s.setProjectState);
  const setDocuments = useProjectStore(s => s.setDocuments);
  const setPlans = useProjectStore(s => s.setPlans);
  const addPlan = useProjectStore(s => s.addPlan);
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
  const setProgress = useAgentStore(s => s.setProgress);
  const addTask = useProjectStore(s => s.addTask);
  const setTasks = useProjectStore(s => s.setTasks);
  const setReviewResult = useProjectStore(s => s.setReviewResult);
  const addToast = useToastStore(s => s.addToast);

  // Asana store actions
  const setAsanaTasks = useAsanaStore(s => s.setTasks);
  const setAsanaProjects = useAsanaStore(s => s.setProjects);
  const setAsanaLoading = useAsanaStore(s => s.setLoading);
  const setAsanaError = useAsanaStore(s => s.setError);
  const setAsanaConnectionStatus = useAsanaStore(s => s.setConnectionStatus);
  const setAsanaTaskStories = useAsanaStore(s => s.setTaskStories);

  useEffect(() => {
    const wsUrl = `ws://${window.location.host}/omni-ws`;

    const client = new WsClient(
      wsUrl,
      (msg: Record<string, unknown>) => {
        const type = msg['type'] as string;
        const payload = msg['payload'] as Record<string, unknown>;

        switch (type) {
          case 'projects.list': {
            const incomingProjects = payload['projects'] as Parameters<typeof setProjects>[0];
            setProjects(incomingProjects);
            // Restore previously selected project after page refresh
            const savedId = useProjectStore.getState().currentProjectId;
            if (savedId && incomingProjects.some(p => p.id === savedId)) {
              client.send({ type: 'project.getState', payload: { projectId: savedId } });
            }
            break;
          }

          case 'project.state':
            // Clear all cached outputs on reconnect — fresh outputs will be loaded via project.agentOutputs
            clearAllOutputs();
            setProjectState(payload as Parameters<typeof setProjectState>[0]);
            addToast({ type: 'success', title: 'Project loaded', message: `Project state received` });
            break;

          case 'project.documents': {
            const docProjectId = payload['projectId'] as string;
            const documents = payload['documents'] as Array<{
              id: string;
              filename: string;
              docType: 'SA' | 'SD';
            }>;
            setDocuments(docProjectId, documents);
            break;
          }

          case 'agent.plans': {
            const plansProjectId = payload['projectId'] as string;
            const plans = payload['plans'] as Array<{
              id: string;
              agentId: string;
              projectId: string;
              content: string;
              status: 'pending' | 'approved' | 'rejected';
              createdAt: string;
              approvedAt?: string;
            }>;
            setPlans(plansProjectId, plans);
            break;
          }

          case 'agent.planReady': {
            const plan = payload['plan'] as {
              id: string;
              agentId: string;
              projectId: string;
              content: string;
              status: 'pending' | 'approved' | 'rejected';
              createdAt: string;
            };
            const agentRole = payload['agentRole'] as string;
            addPlan(plan);
            addToast({
              type: 'info',
              title: '計劃書已準備完成',
              message: `${agentRole} Agent 已產出實作計劃，等待審核`,
              duration: 0, // persistent
            });
            break;
          }

          case 'agent.initialPrompt': {
            // Display initial prompt as the first output in terminal
            const promptAgentId = payload['agentId'] as string;
            const promptContent = payload['prompt'] as string;
            const promptRole = payload['role'] as string;
            if (promptAgentId && promptContent) {
              appendOutput(promptAgentId, {
                streamType: 'system',
                content: `[初始 Prompt]\n\n${promptContent}`,
                timestamp: new Date().toISOString(),
              });
            }
            break;
          }

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
              title: (payload['title'] as string) || null,
              role: payload['role'] as string,
              status: 'running',
              currentTaskId: (payload['taskId'] as string) || null,
              model: (payload['model'] as string) || '',
              sessionId: (payload['sessionId'] as string) || null,
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
              status: 'stopped',
              currentTaskId: null,
              totalCostUsd: (payload['costUsd'] as number) || 0,
              totalTurns: (payload['turns'] as number) || 0,
              totalInputTokens: inputTokens,
              totalOutputTokens: outputTokens,
            } as import('../stores/projectStore').Agent);
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

          // v2: Task management
          case 'task.created': {
            const newTask = payload['task'] as import('../stores/projectStore').Task;
            if (newTask) {
              addTask(newTask);
              addToast({ type: 'info', title: 'Task created', message: newTask.title });
            }
            break;
          }

          case 'task.list': {
            const taskListProjectId = payload['projectId'] as string;
            const taskList = payload['tasks'] as import('../stores/projectStore').Task[];
            if (taskListProjectId && taskList) {
              setTasks(taskListProjectId, taskList);
            }
            break;
          }

          // v2: Workspace scan results (dispatched to listening components)
          case 'workspace.scanResult':
            window.dispatchEvent(new CustomEvent('omni:workspace-scan', { detail: payload }));
            break;

          // SVN errors — show toast for auth failures
          case 'svn.browseResult':
          case 'svn.previewResult': {
            const svnError = payload['error'] as string | undefined;
            if (svnError) {
              const isAuth = /auth|401|403|password|credential/i.test(svnError);
              addToast({
                type: 'error',
                title: isAuth ? 'SVN 認證失敗' : 'SVN 錯誤',
                message: isAuth ? '請檢查 SVN 帳號密碼設定' : svnError,
                duration: 8000,
              });
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

          // Asana MCP messages
          case 'asana.tasks':
            setAsanaTasks(payload['tasks'] as AsanaTask[]);
            break;

          case 'asana.projects':
            setAsanaProjects(payload['projects'] as Array<{ gid: string; name: string }>);
            break;

          case 'asana.connectionStatus':
            setAsanaConnectionStatus(payload as unknown as AsanaConnectionStatus);
            break;

          case 'asana.taskStories':
            setAsanaTaskStories(
              payload['taskGid'] as string,
              payload['stories'] as Array<{ author: string; text: string; createdAt: string }>,
            );
            break;

          case 'asana.syncResult': {
            const syncNewTasks = payload['newTasks'] as number;
            const syncAutoExec = payload['autoExecuted'] as number;
            addToast({
              type: 'success',
              title: 'Asana Sync Complete',
              message: `${syncNewTasks} new task${syncNewTasks !== 1 ? 's' : ''}, ${syncAutoExec} auto-executed`,
              duration: 5000,
            });
            window.dispatchEvent(new CustomEvent('omni:asana-sync', { detail: payload }));
            break;
          }

          case 'asana.syncConfig':
            window.dispatchEvent(new CustomEvent('omni:asana-sync-config', { detail: payload }));
            break;

          case 'agent.progress': {
            const progressData = payload as unknown as import('../stores/agentStore').AgentProgress;
            if (progressData.agentId) {
              setProgress(progressData.agentId, progressData);
            }
            break;
          }

          case 'review.completed': {
            const reviewTaskId = payload['taskId'] as string;
            const reviewResult = payload['result'] as import('../stores/projectStore').ReviewResult;
            if (reviewTaskId && reviewResult) {
              setReviewResult(reviewTaskId, reviewResult);
              const icon = reviewResult.verdict === 'pass' ? '✅' : '❌';
              addToast({
                type: reviewResult.verdict === 'pass' ? 'success' : 'warning',
                title: `Review: ${icon} ${reviewResult.verdict.toUpperCase()}`,
                message: `Score: ${reviewResult.score}/100 — ${reviewResult.issues.length} issue(s)`,
                duration: reviewResult.verdict === 'pass' ? 5000 : 0,
              });
            }
            break;
          }

          case 'task.retrying': {
            const retryTaskId = payload['taskId'] as string;
            const retryCount = payload['retryCount'] as number;
            const maxRetries = payload['maxRetries'] as number;
            addToast({
              type: 'info',
              title: 'Task auto-retrying',
              message: `Task ${retryTaskId} retry ${retryCount}/${maxRetries} after review failure`,
              duration: 5000,
            });
            break;
          }

          case 'asana.error':
            setAsanaError(payload['message'] as string);
            setAsanaLoading(false);
            window.dispatchEvent(new CustomEvent('omni:asana-error'));
            addToast({
              type: 'error',
              title: 'Asana Error',
              message: payload['message'] as string,
              duration: 5000,
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
