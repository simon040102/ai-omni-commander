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
import { registerProjectTools } from '../tools/project-tools.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler(args, {} as any);
}

describe('project-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerProjectTools(server);
  });

  describe('list_projects', () => {
    it('returns empty list when no projects', async () => {
      const result = await callTool(server, 'list_projects', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.projects).toEqual([]);
    });

    it('returns all projects', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('p1', 'Alpha', '/a');
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('p2', 'Beta', '/b');

      const result = await callTool(server, 'list_projects', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
    });
  });

  describe('get_project', () => {
    it('returns project with task stats', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('p1', 'Test', '/tmp');
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run('t1', 'p1', 'T1', 'backend', 'feature');
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES (?, ?, ?, ?, ?, ?)`).run('t2', 'p1', 'T2', 'frontend', 'bug', 'completed');

      const result = await callTool(server, 'get_project', { projectId: 'p1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.name).toBe('Test');
      expect(data.taskStats.pending).toBe(1);
      expect(data.taskStats.completed).toBe(1);
    });

    it('returns error for non-existent project', async () => {
      const result = await callTool(server, 'get_project', { projectId: 'nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('create_project', () => {
    it('creates a new project', async () => {
      const result = await callTool(server, 'create_project', {
        name: 'New Project',
        workingDir: '/tmp/new',
        frontendPath: '/tmp/new/web',
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.name).toBe('New Project');
      expect(data.workingDir).toBe('/tmp/new');
      expect(data.frontendPath).toBe('/tmp/new/web');
      expect(data.id).toBeTruthy();

      // Verify in DB
      const row = testDb.prepare('SELECT * FROM projects WHERE name = ?').get('New Project') as any;
      expect(row).toBeTruthy();
      expect(row.working_dir).toBe('/tmp/new');
    });
  });

  describe('create_task', () => {
    it('creates a new task in a project', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('p1', 'Test', '/tmp');

      const result = await callTool(server, 'create_task', {
        projectId: 'p1',
        title: 'Build feature',
        label: 'backend',
        taskType: 'feature',
        priority: 5,
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.title).toBe('Build feature');
      expect(data.label).toBe('backend');
      expect(data.taskType).toBe('feature');
      expect(data.status).toBe('pending');
    });

    it('returns error for non-existent project', async () => {
      const result = await callTool(server, 'create_task', {
        projectId: 'nope',
        title: 'Test',
        label: 'backend',
      });
      expect(result.isError).toBe(true);
    });
  });
});
