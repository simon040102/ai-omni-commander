import { EventTypes } from '@omni/shared';
import { updateAgent, getAgent, getRunningAgents } from '../db/queries/agents.js';
import { updateTask, getTask } from '../db/queries/tasks.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('AgentManager');

/**
 * Agent 狀態的維護者——只改 DB、發事件，不碰任何程序。
 *
 * 本機 spawn 派工（PTY／SDK）已移除：任務一律由外部 Claude Code session 經 MCP 執行，
 * agent 列只剩 MCP 合成的 `mcp-{taskId}`（由 mcp/helpers ensureMcpAgent 建立）與更早期留下的舊列。
 * 這裡只剩兩件事：啟動時清理上次殘留的非 MCP agent、Web UI 的停止鈕。
 */
export class AgentManager {
  constructor(private eventBus: EventBus) {}

  /**
   * Server 啟動時：把上次還標著執行中的非 MCP agent 標成 error，它的進行中任務退回 pending。
   * MCP 合成 agent 不動——外部 session 可能還在跑，退回 pending 會打斷它。
   * 不依 DB 裡的舊 PID kill 程序：不會再有新的本機 agent，而舊 PID 可能已被別的程序重用。
   */
  async recoverRunningAgents(): Promise<void> {
    const runningAgents = getRunningAgents().filter(a => !a.id.startsWith('mcp-'));
    if (runningAgents.length === 0) return;

    logger.info({ count: runningAgents.length }, 'Found agents to recover from previous session');
    for (const agent of runningAgents) {
      logger.warn({ agentId: agent.id }, 'Marking orphaned agent as error');
      updateAgent(agent.id, { status: 'error', pid: null });
      if (agent.currentTaskId) {
        const task = getTask(agent.currentTaskId);
        if (task && (task.status === 'in_progress' || task.status === 'assigned')) {
          updateTask(agent.currentTaskId, { status: 'pending', assignedAgentId: null });
        }
      }
      await this.eventBus.emit({
        type: EventTypes.AGENT_OUTPUT,
        source: agent.id,
        payload: { agentId: agent.id, projectId: agent.projectId, streamType: 'system',
          content: '[RECOVERY] Server 重啟，agent 已標記為 error。請手動重新執行。' },
        timestamp: new Date().toISOString(),
      });
    }
    logger.info('Agent recovery complete');
  }

  /** Web UI 停止鈕：agent 標 stopped；它的任務若還在進行中就退回 pending。 */
  async stopAgent(agentId: string): Promise<void> {
    const agent = getAgent(agentId);
    if (agent?.currentTaskId) {
      const task = getTask(agent.currentTaskId);
      if (task && task.status === 'in_progress') {
        updateTask(agent.currentTaskId, { status: 'pending', assignedAgentId: null });
        logger.info({ agentId, taskId: agent.currentTaskId }, 'Reset task to pending (agent stopped)');
      }
    }

    updateAgent(agentId, { status: 'stopped', pid: null, currentTaskId: null });
    await this.eventBus.emit({
      type: EventTypes.AGENT_STOPPED,
      source: agentId,
      payload: { agentId },
      timestamp: new Date().toISOString(),
    });
  }
}
