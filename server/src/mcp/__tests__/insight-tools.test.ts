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

function seedTask(db: Database.Database, id: string, opts: { taskType?: string; status?: string; createdAt?: string; label?: string } = {}) {
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, label, task_type, status, created_at, updated_at)
    VALUES (?, 'proj-1', ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, `Task ${id}`, opts.label || 'backend', opts.taskType || 'feature', opts.status || 'pending', opts.createdAt || '2026-01-01 00:00:00');
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
