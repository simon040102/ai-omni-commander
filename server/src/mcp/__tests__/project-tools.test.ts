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
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
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

  describe('update_project specFolders overlap guard', () => {
    it('rejects configJson whose specFolders overlap a workspace', async () => {
      testDb.prepare('INSERT INTO projects (id, name, working_dir, frontend_path) VALUES (?, ?, ?, ?)')
        .run('p1', 'P', 'D:\\fork\\app', 'D:\\fork\\app');

      const result = await callTool(server, 'update_project', {
        projectId: 'p1',
        configJson: JSON.stringify({ specFolders: [{ path: 'D:\\fork\\app\\docs', gitPull: true }] }),
      });

      expect(result.isError).toBe(true);
    });

    it('rejects single-side workspace update that would overlap existing specFolders (A4 bypass)', async () => {
      testDb.prepare('INSERT INTO projects (id, name, working_dir, frontend_path, config_json) VALUES (?, ?, ?, ?, ?)')
        .run('p1', 'P', 'D:\\fork\\app', 'D:\\fork\\app', JSON.stringify({ specFolders: [{ path: 'D:\\specs\\docs', gitPull: true }] }));

      // 不帶 configJson、只改 frontendPath 指向規格資料夾 → 必須被擋
      const result = await callTool(server, 'update_project', {
        projectId: 'p1',
        frontendPath: 'D:\\specs\\docs',
      });

      expect(result.isError).toBe(true);
      // 專案路徑未被改動
      const row = testDb.prepare("SELECT frontend_path FROM projects WHERE id = 'p1'").get() as { frontend_path: string };
      expect(row.frontend_path).toBe('D:\\fork\\app');
    });
  });

  describe('update_project testCommand fields', () => {
    it('persists frontendTestCommand/backendTestCommand in configJson and get_project reads them back unmasked', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('p1', 'Test', '/tmp');

      const result = await callTool(server, 'update_project', {
        projectId: 'p1',
        configJson: JSON.stringify({
          frontendTestCommand: 'pnpm vitest run',
          backendTestCommand: 'mvn test',
        }),
      });
      expect(result.isError).toBeUndefined();

      const row = testDb.prepare("SELECT config_json FROM projects WHERE id = 'p1'").get() as { config_json: string };
      const saved = JSON.parse(row.config_json);
      expect(saved.frontendTestCommand).toBe('pnpm vitest run');
      expect(saved.backendTestCommand).toBe('mvn test');

      // 讀回：get_project 的 configJson 遮罩只處理 DB 憑證，testCommand 原樣可見
      const getResult = await callTool(server, 'get_project', { projectId: 'p1' });
      const data = JSON.parse(getResult.content[0].text);
      expect(data.configJson.frontendTestCommand).toBe('pnpm vitest run');
      expect(data.configJson.backendTestCommand).toBe('mvn test');
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

    it('masks DB credentials in configJson (A6)', async () => {
      const config = JSON.stringify({
        dbConnections: [
          { label: 'TYL_DOC', server: 'db1', user: 'sa', password: 'super-secret' },
          { label: 'NaNa', connectionString: 'Server=db2;Database=x;User Id=sa;Password=hunter2;' },
        ],
      });
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES (?, ?, ?, ?)`).run('p1', 'Test', '/tmp', config);

      const result = await callTool(server, 'get_project', { projectId: 'p1' });
      const text = result.content[0].text;
      expect(text).not.toContain('super-secret');
      expect(text).not.toContain('hunter2');
      const data = JSON.parse(text);
      expect(data.configJson.dbConnections[0].password).toBe('***');
      expect(data.configJson.dbConnections[1].connectionString).toContain('Password=***');
    });

    it('returns a clear error for corrupted config_json instead of throwing (A6)', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES (?, ?, ?, ?)`).run('p1', 'Test', '/tmp', '{broken json');
      const result = await callTool(server, 'get_project', { projectId: 'p1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('config_json');
    });
  });

  describe('set_extra_prompt', () => {
    it('recovers from corrupted config_json by starting from {} (A6)', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES (?, ?, ?, ?)`).run('p1', 'Test', '/tmp', '{broken json');

      const result = await callTool(server, 'set_extra_prompt', { projectId: 'p1', label: 'frontend', prompt: '請遵守表單規範' });
      expect(result.isError).toBeUndefined();

      const row = testDb.prepare('SELECT config_json FROM projects WHERE id = ?').get('p1') as { config_json: string };
      const config = JSON.parse(row.config_json);
      expect(config.frontendExtraPrompt).toBe('請遵守表單規範');
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
