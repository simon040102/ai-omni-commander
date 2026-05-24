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
import { registerProgressTools } from '../tools/progress-tools.js';
import { notifyWebServer } from '../notify.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
}

function seedTask(db: Database.Database) {
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
    'task-1', 'proj-1', 'Test Task', 'backend', 'feature',
  );
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler(args, {} as any);
}

describe('progress-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerProgressTools(server);
    vi.clearAllMocks();
  });

  describe('report_output', () => {
    it('stores output and notifies web server', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'report_output', {
        taskId: 'task-1',
        content: 'Building API...',
        outputType: 'text',
      });

      expect(result.content[0].text).toBe('Output reported');

      // Verify agent record was created
      const agent = testDb.prepare('SELECT * FROM agents WHERE id = ?').get('mcp-task-1') as any;
      expect(agent).toBeTruthy();
      expect(agent.role).toBe('backend'); // role matches task label
      expect(agent.current_task_id).toBe('task-1');

      // Verify output stored
      const outputs = testDb.prepare('SELECT * FROM agent_outputs WHERE agent_id = ?').all('mcp-task-1') as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].content).toBe('Building API...');
      expect(outputs[0].stream_type).toBe('text');

      // Verify notification sent
      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'agent.output',
        data: expect.objectContaining({
          agentId: 'mcp-task-1',
          taskId: 'task-1',
          content: 'Building API...',
        }),
      });
    });

    it('reuses existing synthetic agent', async () => {
      seedProject(testDb);
      seedTask(testDb);

      await callTool(server, 'report_output', { taskId: 'task-1', content: 'Step 1' });
      await callTool(server, 'report_output', { taskId: 'task-1', content: 'Step 2' });

      const agents = testDb.prepare('SELECT * FROM agents WHERE id = ?').all('mcp-task-1');
      expect(agents).toHaveLength(1); // Only one agent record

      const outputs = testDb.prepare('SELECT * FROM agent_outputs WHERE agent_id = ?').all('mcp-task-1');
      expect(outputs).toHaveLength(2);
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_output', { taskId: 'nope', content: 'test' });
      expect(result.isError).toBe(true);
    });
  });

  describe('report_milestone', () => {
    it('logs milestone event and output', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'report_milestone', {
        taskId: 'task-1',
        milestone: 'Analyzing documents',
        details: '3 documents found',
      });

      expect(result.content[0].text).toContain('Analyzing documents');

      // Verify event logged
      const events = testDb.prepare("SELECT * FROM events WHERE event_type = 'task.milestone'").all() as any[];
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0].payload_json);
      expect(payload.milestone).toBe('Analyzing documents');

      // Verify system output logged
      const outputs = testDb.prepare("SELECT * FROM agent_outputs WHERE stream_type = 'system'").all() as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].content).toContain('[MILESTONE] Analyzing documents');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_milestone', { taskId: 'nope', milestone: 'Test' });
      expect(result.isError).toBe(true);
    });
  });
});
