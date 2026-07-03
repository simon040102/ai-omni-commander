import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { registerTaskTools } from '../tools/task-tools.js';

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

// Helper: call a registered tool by name
async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // Access internal tool registry
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler(args, {} as any);
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
  });
});
