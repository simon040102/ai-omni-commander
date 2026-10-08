import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

/**
 * AgentManager 只剩兩件事（legacy spawn 引擎已移除，任務一律由外部 Claude Code session + MCP 執行）：
 * 啟動時清理上次殘留的非 MCP agent、Web UI 的停止鈕。兩者都只改 DB 狀態、發事件，不碰任何程序。
 */
let testDb: Database.Database;
vi.mock('../../db/connection.js', () => ({ getDb: () => testDb }));

import { AgentManager } from '../AgentManager.js';
import { EventTypes } from '@omni/shared';

function seed() {
  testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p1', 'P', '/tmp')`).run();
  testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('t-legacy', 'p1', 'T', 'backend', 'feature', 'in_progress')`).run();
  testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('t-mcp', 'p1', 'T2', 'backend', 'feature', 'in_progress')`).run();
  testDb.prepare(`INSERT INTO agents (id, project_id, role, status, model, current_task_id, pid) VALUES ('a-legacy', 'p1', 'backend', 'running', 'sonnet', 't-legacy', 999999)`).run();
  testDb.prepare(`INSERT INTO agents (id, project_id, role, status, model, current_task_id) VALUES ('mcp-t-mcp', 'p1', 'backend', 'running', 'external', 't-mcp')`).run();
}
const agentStatus = (id: string) => (testDb.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;
const taskStatus = (id: string) => (testDb.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status;

describe('AgentManager', () => {
  let emit: ReturnType<typeof vi.fn>;
  let manager: AgentManager;

  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    seed();
    emit = vi.fn().mockResolvedValue(undefined);
    manager = new AgentManager({ emit } as any);
  });

  describe('recoverRunningAgents（啟動時清理上次殘留）', () => {
    it('非 MCP 的 running agent → 標 error、它的進行中任務退回 pending、發 [RECOVERY] 輸出', async () => {
      await manager.recoverRunningAgents();
      expect(agentStatus('a-legacy')).toBe('error');
      expect(taskStatus('t-legacy')).toBe('pending');
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({
        type: EventTypes.AGENT_OUTPUT,
        payload: expect.objectContaining({ agentId: 'a-legacy', content: expect.stringContaining('[RECOVERY]') }),
      }));
    });

    it('MCP 合成 agent（mcp-*）不動——外部 session 可能還在跑，退回 pending 會打斷它', async () => {
      await manager.recoverRunningAgents();
      expect(agentStatus('mcp-t-mcp')).toBe('running');
      expect(taskStatus('t-mcp')).toBe('in_progress');
    });

    it('不再依 DB 裡的舊 PID 去 kill 程序（PID 可能已被別的程序重用）', async () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      await manager.recoverRunningAgents();
      expect(kill).not.toHaveBeenCalled();
      kill.mockRestore();
    });
  });

  describe('stopAgent（Web UI 停止鈕）', () => {
    it('agent 標 stopped、清掉目前任務；進行中任務退回 pending；發 AGENT_STOPPED', async () => {
      await manager.stopAgent('a-legacy');
      const row = testDb.prepare('SELECT status, current_task_id, pid FROM agents WHERE id = ?').get('a-legacy') as Record<string, unknown>;
      expect(row).toMatchObject({ status: 'stopped', current_task_id: null, pid: null });
      expect(taskStatus('t-legacy')).toBe('pending');
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: EventTypes.AGENT_STOPPED, payload: { agentId: 'a-legacy' } }));
    });

    it('任務已不是進行中 → 不改任務狀態', async () => {
      testDb.prepare(`UPDATE tasks SET status = 'completed' WHERE id = 't-legacy'`).run();
      await manager.stopAgent('a-legacy');
      expect(taskStatus('t-legacy')).toBe('completed');
    });

    it('不依 PID kill 程序', async () => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      await manager.stopAgent('a-legacy');
      expect(kill).not.toHaveBeenCalled();
      kill.mockRestore();
    });
  });
});
