import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(true),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerInsightTools } from '../tools/insight-tools.js';
import { notifyWebServer } from '../notify.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
}

function seedTask(db: Database.Database, id: string, opts: { taskType?: string; status?: string; createdAt?: string; label?: string; dueDate?: string | null } = {}) {
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, label, task_type, status, created_at, updated_at, due_date)
    VALUES (?, 'proj-1', ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(id, `Task ${id}`, opts.label || 'backend', opts.taskType || 'feature', opts.status || 'pending', opts.createdAt || '2026-01-01 00:00:00', opts.dueDate ?? null);
}

describe('insight-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerInsightTools(server);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('next_task', () => {
    it('prioritizes bugs and excludes blocked tasks', async () => {
      seedProject(testDb);
      seedTask(testDb, 'old-feature', { createdAt: '2026-01-01 00:00:00' });
      seedTask(testDb, 'newer-bug', { taskType: 'bug', createdAt: '2026-02-01 00:00:00' });
      seedTask(testDb, 'blocked-bug', { taskType: 'bug', createdAt: '2026-01-15 00:00:00' });
      seedTask(testDb, 'dep', { status: 'in_progress' });
      testDb.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('blocked-bug', 'dep');

      const result = await callTool(server, 'next_task', { projectId: 'proj-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.recommended.id).toBe('newer-bug'); // bug beats older feature; blocked bug excluded
      expect(data.recommended.reason).toContain('bug');
      const altIds = data.alternatives.map((a: any) => a.id);
      expect(altIds).toContain('old-feature');
      expect(altIds).not.toContain('blocked-bug');
    });

    it('allows tasks whose dependencies are completed', async () => {
      seedProject(testDb);
      seedTask(testDb, 'dep-done', { status: 'completed' });
      seedTask(testDb, 'ready');
      testDb.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('ready', 'dep-done');

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      expect(data.recommended.id).toBe('ready');
    });

    it('explains when all pending tasks are blocked', async () => {
      seedProject(testDb);
      seedTask(testDb, 'blocked');
      seedTask(testDb, 'dep', { status: 'in_progress' });
      testDb.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run('blocked', 'dep');
      // 'dep' itself is in_progress (not pending) so only 'blocked' is pending — and it is blocked

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      expect(data.recommended).toBeNull();
      expect(data.reason).toContain('blocked');
    });

    it('explains when there are no pending tasks', async () => {
      seedProject(testDb);
      seedTask(testDb, 'done', { status: 'completed' });
      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      expect(data.recommended).toBeNull();
      expect(data.reason).toContain('沒有待處理任務');
    });

    it('returns error for unknown project', async () => {
      const result = await callTool(server, 'next_task', { projectId: 'nope' });
      expect(result.isError).toBe(true);
    });

    it('within the same priority tier, earlier due_date wins and null due_date sorts last', async () => {
      seedProject(testDb);
      // 同為 feature：due 越早越前，無 due 排最後（即使建立時間最早）
      seedTask(testDb, 'no-due-oldest', { createdAt: '2025-01-01 00:00:00' });
      seedTask(testDb, 'due-later', { dueDate: '2999-12-31', createdAt: '2026-03-01 00:00:00' });
      seedTask(testDb, 'due-sooner', { dueDate: '2000-01-01', createdAt: '2026-06-01 00:00:00' });

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      expect(data.recommended.id).toBe('due-sooner');
      expect(data.alternatives.map((a: any) => a.id)).toEqual(['due-later', 'no-due-oldest']);
      expect(data.recommended.dueDate).toBe('2000-01-01');
    });

    it('bug priority is not broken by an overdue feature; due_date orders bugs among themselves', async () => {
      seedProject(testDb);
      seedTask(testDb, 'overdue-feature', { dueDate: '2000-01-01' });
      seedTask(testDb, 'bug-no-due', { taskType: 'bug', createdAt: '2026-01-01 00:00:00' });
      seedTask(testDb, 'bug-due', { taskType: 'bug', dueDate: '2999-01-01', createdAt: '2026-02-01 00:00:00' });

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      // bug 仍然壓過逾期 feature；同為 bug 時有 due 的排前（null 最後）
      expect(data.recommended.id).toBe('bug-due');
      expect(data.alternatives.map((a: any) => a.id)).toEqual(['bug-no-due', 'overdue-feature']);
    });

    it('recommendation reason carries due info（已逾期/N 天後到期）', async () => {
      seedProject(testDb);
      seedTask(testDb, 'overdue-bug', { taskType: 'bug', dueDate: '2000-01-01' });
      seedTask(testDb, 'future-feature', { dueDate: '2999-12-31' });
      seedTask(testDb, 'plain-feature', {});

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      expect(data.recommended.id).toBe('overdue-bug');
      expect(data.recommended.reason).toContain('bug 修復優先');
      expect(data.recommended.reason).toMatch(/已逾期 \d+ 天/);

      const future = data.alternatives.find((a: any) => a.id === 'future-feature');
      expect(future.reason).toMatch(/\d+ 天後到期/);
      expect(future.dueDate).toBe('2999-12-31');

      const plain = data.alternatives.find((a: any) => a.id === 'plain-feature');
      expect(plain.reason).toContain('建立時間較早');
      expect(plain.dueDate).toBeNull();
    });

    it('surfaces stalled in_progress tasks alongside the recommendation, most stalled first', async () => {
      seedProject(testDb);
      seedTask(testDb, 'pick-me', { taskType: 'bug' });
      seedTask(testDb, 'stuck-30h', { status: 'in_progress' });
      seedTask(testDb, 'stuck-50h', { status: 'in_progress' });
      seedTask(testDb, 'active', { status: 'in_progress' });
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-30 hours') WHERE id = 'stuck-30h'`).run();
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-50 hours') WHERE id = 'stuck-50h'`).run();
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-2 hours') WHERE id = 'active'`).run();

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1' })).content[0].text);
      expect(data.recommended.id).toBe('pick-me'); // recommendation logic unchanged
      expect(data.staleThresholdHours).toBe(24);
      expect(data.stalledTasks.map((s: any) => s.taskId)).toEqual(['stuck-50h', 'stuck-30h']);
      expect(data.staleHint).toContain('疑似卡死');
    });

    it('reports stalled tasks even when there are no pending tasks, honoring a custom threshold', async () => {
      seedProject(testDb);
      seedTask(testDb, 'stuck', { status: 'in_progress' });
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-10 hours') WHERE id = 'stuck'`).run();

      const data = JSON.parse((await callTool(server, 'next_task', { projectId: 'proj-1', staleThresholdHours: 5 })).content[0].text);
      expect(data.recommended).toBeNull();
      expect(data.stalledTasks.map((s: any) => s.taskId)).toEqual(['stuck']);
    });
  });

  describe('get_task_outputs', () => {
    it('returns chronological outputs for the mcp-{taskId} agent with pagination', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1');
      testDb.prepare(`INSERT INTO agents (id, project_id, role, status, model) VALUES ('mcp-task-1', 'proj-1', 'backend', 'running', 'external')`).run();
      for (let i = 1; i <= 3; i++) {
        testDb.prepare(`INSERT INTO agent_outputs (agent_id, task_id, stream_type, content) VALUES ('mcp-task-1', 'task-1', 'text', ?)`).run(`step ${i}`);
      }

      const data = JSON.parse((await callTool(server, 'get_task_outputs', { taskId: 'task-1' })).content[0].text);
      expect(data.total).toBe(3);
      expect(data.outputs.map((o: any) => o.content)).toEqual(['step 1', 'step 2', 'step 3']);

      const page = JSON.parse((await callTool(server, 'get_task_outputs', { taskId: 'task-1', limit: 1, offset: 1 })).content[0].text);
      expect(page.outputs).toHaveLength(1);
      expect(page.outputs[0].content).toBe('step 2');
      expect(page.hasMore).toBe(true);
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_task_outputs', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('update_task', () => {
    it('updates whitelisted fields and notifies task.updated with the full task', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', { label: 'frontend' });

      const result = await callTool(server, 'update_task', {
        taskId: 'task-1',
        title: 'New Title',
        label: 'backend',
        taskType: 'bug',
        tags: ['UT', 'urgent'],
        section: 'UT',
      });
      expect(result.isError).toBeUndefined();

      const row = testDb.prepare('SELECT * FROM tasks WHERE id = ?').get('task-1') as any;
      expect(row.title).toBe('New Title');
      expect(row.label).toBe('backend');
      expect(row.task_type).toBe('bug');
      expect(JSON.parse(row.tags)).toEqual(['UT', 'urgent']);
      expect(row.section).toBe('UT');
      expect(row.status).toBe('pending'); // status untouched

      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.updated',
        data: expect.objectContaining({
          taskId: 'task-1',
          projectId: 'proj-1',
          updatedFields: ['title', 'label', 'taskType', 'tags', 'section'],
          task: expect.objectContaining({
            id: 'task-1',
            projectId: 'proj-1',
            title: 'New Title',
            label: 'backend',
            taskType: 'bug',
            status: 'pending',
            retryCount: 0,
            source: 'manual',
          }),
        }),
      });
    });

    it('rejects call with no fields', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1');
      const result = await callTool(server, 'update_task', { taskId: 'task-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('至少提供一個');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'update_task', { taskId: 'nope', title: 'x' });
      expect(result.isError).toBe(true);
    });
  });

  describe('health_check', () => {
    it('returns independent structured statuses (db ok, webServer unreachable, asana not_configured)', async () => {
      // Fail fast for the web-server probe instead of waiting for a real socket
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      // Ensure the Asana check doesn't pick up a developer's real PAT from env
      const savedPat = process.env['ASANA_PAT'];
      delete process.env['ASANA_PAT'];
      try {

      const result = await callTool(server, 'health_check', {});
      const data = JSON.parse(result.content[0].text);

      expect(data.db.ok).toBe(true);
      expect(data.db.path).toBeTruthy();
      expect(data.webServer.ok).toBe(false); // fetch stubbed to fail — one failing check must not break others
      expect(data.asana.status).toBe('not_configured'); // no PAT in fresh DB
      expect(['ok', 'not_found']).toContain(data.svn.status); // depends on local svn install
      } finally {
        if (savedPat !== undefined) process.env['ASANA_PAT'] = savedPat;
      }
    });
  });
});
