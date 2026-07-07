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

vi.mock('../svn-status.js', () => ({
  getSvnCredentials: vi.fn().mockReturnValue({ username: 'user', password: 'pass' }),
  isSvnCliAvailable: vi.fn().mockReturnValue(true),
  fetchRemoteLastModified: vi.fn().mockReturnValue(null),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from '../tools/task-tools.js';
import { isSvnCliAvailable, fetchRemoteLastModified } from '../svn-status.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database, id = 'proj-1') {
  db.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path, backend_path) VALUES (?, ?, ?, ?, ?)`).run(
    id, 'Test Project', '/tmp/project', '/tmp/project/web', '/tmp/project/server',
  );
}

function seedTask(db: Database.Database, id = 'task-1', projectId = 'proj-1', label = 'backend') {
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, label, task_type, prompt) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, projectId, 'Test Task', 'A test task description', label, 'feature', 'Build the API endpoint',
  );
}

describe('task-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerTaskTools(server);
  });

  describe('get_task', () => {
    it('returns task details with project info', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'get_task', { taskId: 'task-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.task.id).toBe('task-1');
      expect(data.task.title).toBe('Test Task');
      expect(data.task.label).toBe('backend');
      expect(data.project.id).toBe('proj-1');
      expect(data.project.workingDir).toBe('/tmp/project');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_task', { taskId: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('list_pending_tasks', () => {
    it('lists pending tasks for a project', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', 'proj-1');
      seedTask(testDb, 'task-2', 'proj-1', 'frontend');

      const result = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.count).toBe(2);
      expect(data.tasks).toHaveLength(2);
    });

    it('returns empty list for project with no tasks', async () => {
      seedProject(testDb);
      const result = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
    });

    it('escapes LIKE wildcards in keyword (A10)', async () => {
      seedProject(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
        'task-a', 'proj-1', 'SM27_共用查詢', 'backend', 'feature',
      );
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
        'task-b', 'proj-1', 'SM27x共用查詢', 'backend', 'feature',
      );

      // '_' must match literally, not as a single-char wildcard
      const result = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', keyword: 'SM27_' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.tasks[0].id).toBe('task-a');

      // '%' must match literally
      const pct = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', keyword: '100%' });
      expect(JSON.parse(pct.content[0].text).count).toBe(0);
    });

    it('supports limit/offset pagination with total and hasMore (A15)', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1');
      seedTask(testDb, 'task-2');
      seedTask(testDb, 'task-3');

      const page1 = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', limit: 2 })).content[0].text);
      expect(page1.total).toBe(3);
      expect(page1.count).toBe(2);
      expect(page1.hasMore).toBe(true);

      const page2 = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', limit: 2, offset: 2 })).content[0].text);
      expect(page2.total).toBe(3);
      expect(page2.count).toBe(1);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('get_execution_plan', () => {
    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_execution_plan', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });

    it('returns error when task not in web server DB', async () => {
      seedProject(testDb);
      seedTask(testDb);

      // task-1 exists in test in-memory DB but not in the web server's DB
      // So either we get a 404 (server running) or connection error (server not running)
      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('update_task_status', () => {
    it('updates task status to in_progress', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(result.content[0].text).toContain('in_progress');

      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('in_progress');
    });

    it('updates task status with summary', async () => {
      seedProject(testDb);
      seedTask(testDb);

      // pending → completed is not a valid transition; go through in_progress first
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', summary: 'All done' });

      const row = testDb.prepare('SELECT status, result_summary FROM tasks WHERE id = ?').get('task-1') as { status: string; result_summary: string };
      expect(row.status).toBe('completed');
      expect(row.result_summary).toBe('All done');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'update_task_status', { taskId: 'nope', status: 'completed' });
      expect(result.isError).toBe(true);
    });

    it('allows failed → in_progress retry (A11)', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run('task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(result.isError).toBeUndefined();
      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('in_progress');
    });

    it('rejects completed → in_progress (terminal state)', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run('task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(result.isError).toBe(true);
    });

    it('stops only this task\'s synthetic agent, not other agents in the project (A2)', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1');
      seedTask(testDb, 'task-2');
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id IN ('task-1', 'task-2')").run();
      const insertAgent = testDb.prepare(`
        INSERT INTO agents (id, project_id, role, status, model, current_task_id)
        VALUES (?, 'proj-1', 'backend', 'running', 'external', ?)
      `);
      insertAgent.run('mcp-task-1', 'task-1');
      insertAgent.run('mcp-task-2', 'task-2');

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      const a1 = testDb.prepare('SELECT status FROM agents WHERE id = ?').get('mcp-task-1') as { status: string };
      const a2 = testDb.prepare('SELECT status FROM agents WHERE id = ?').get('mcp-task-2') as { status: string };
      expect(a1.status).toBe('stopped');
      expect(a2.status).toBe('running');
    });
  });

  describe('sync_asana_tasks — auto spec change check', () => {
    function seedAsanaProject() {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES (?, ?, ?, ?)`).run(
        'proj-1', 'Test Project', '/tmp/project', 'pg-1',
      );
      testDb.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'test-pat')`).run();
    }

    function seedInProgressTaskWithSpecVersion(taskId = 'task-1') {
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES (?, 'proj-1', 'WA05 查詢作業', 'frontend', 'feature', 'in_progress')`).run(taskId);
      testDb.prepare(`INSERT INTO task_spec_versions (task_id, file_ref, last_modified) VALUES (?, 'https://svn/specs/SPEC_WA05_v1.docx', '2026-06-01 10:00:00')`).run(taskId);
    }

    function stubAsanaFetch() {
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('/users/me')) {
          return { ok: true, json: async () => ({ data: { gid: 'u1' } }) };
        }
        if (u.includes('/tasks?project=')) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        throw new Error(`unexpected fetch: ${u}`);
      }));
    }

    beforeEach(() => {
      vi.mocked(isSvnCliAvailable).mockReturnValue(true);
      vi.mocked(fetchRemoteLastModified).mockReturnValue(null);
      vi.mocked(fetchRemoteLastModified).mockClear();
      vi.mocked(isSvnCliAvailable).mockClear();
      stubAsanaFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('runs the spec change check after sync and reports changes in specChangeCheck', async () => {
      seedAsanaProject();
      seedInProgressTaskWithSpecVersion();
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-07-01 09:00:00');

      const result = await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);

      expect(data.specChangeCheck).toMatchObject({ checked: 1, changed: 1 });
      expect(data.specChangeCheck.warning).toContain('spec gap');

      // spec_changed gap created + recorded version bumped
      const gaps = testDb.prepare('SELECT * FROM spec_gaps').all() as any[];
      expect(gaps).toHaveLength(1);
      expect(gaps[0].category).toBe('spec_changed');
      const version = testDb.prepare('SELECT last_modified FROM task_spec_versions WHERE task_id = ?').get('task-1') as any;
      expect(version.last_modified).toBe('2026-07-01 09:00:00');
    });

    it('applies a per-project cooldown: the second sync within 10 minutes skips the check', async () => {
      seedAsanaProject();
      seedInProgressTaskWithSpecVersion();
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-06-01 10:00:00'); // unchanged

      const first = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);
      expect(first.specChangeCheck).toMatchObject({ checked: 1, changed: 0 });
      expect(fetchRemoteLastModified).toHaveBeenCalledTimes(1);

      const second = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1', force: true })).content[0].text);
      expect(second.specChangeCheck).toMatchObject({ checked: 0, changed: 0, skipped: 'cooldown' });
      expect(fetchRemoteLastModified).toHaveBeenCalledTimes(1); // not called again
    });

    it('skips at zero cost when no in_progress task has spec version records', async () => {
      seedAsanaProject();
      // in_progress task WITHOUT task_spec_versions rows
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('task-1', 'proj-1', 'T', 'frontend', 'feature', 'in_progress')`).run();

      const data = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);
      expect(data.specChangeCheck).toMatchObject({ checked: 0, changed: 0, skipped: 'no_tasks_with_spec_versions' });
      expect(isSvnCliAvailable).not.toHaveBeenCalled();
      expect(fetchRemoteLastModified).not.toHaveBeenCalled();
    });

    it('sync still succeeds when SVN is unavailable — error is only annotated', async () => {
      seedAsanaProject();
      seedInProgressTaskWithSpecVersion();
      vi.mocked(isSvnCliAvailable).mockReturnValue(false);

      const result = await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined(); // sync itself succeeds
      const data = JSON.parse(result.content[0].text);
      expect(data.message).toContain('Asana sync completed');
      expect(data.specChangeCheck.error).toContain('svn CLI');
      expect(testDb.prepare('SELECT COUNT(*) as c FROM spec_gaps').get()).toEqual({ c: 0 });

      // no cooldown recorded on failure — the next sync retries the check
      vi.mocked(isSvnCliAvailable).mockReturnValue(true);
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-06-01 10:00:00');
      const retry = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1', force: true })).content[0].text);
      expect(retry.specChangeCheck).toMatchObject({ checked: 1, changed: 0 });
    });
  });
});
