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
import { registerSpecGapTools } from '../tools/spec-gap-tools.js';
import { notifyWebServer } from '../notify.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
    'task-1', 'proj-1', 'WA05 查詢作業', 'frontend', 'feature',
  );
}

describe('spec-gap-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerSpecGapTools(server);
    vi.clearAllMocks();
  });

  describe('report_spec_gap', () => {
    it('inserts a gap, logs an agent output, and notifies task.specGap', async () => {
      seed(testDb);

      const result = await callTool(server, 'report_spec_gap', {
        taskId: 'task-1',
        category: 'field_undefined',
        description: 'SA 未定義「狀態」欄位的下拉選項',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Spec gap recorded');

      const gaps = testDb.prepare('SELECT * FROM spec_gaps').all() as any[];
      expect(gaps).toHaveLength(1);
      expect(gaps[0].task_id).toBe('task-1');
      expect(gaps[0].project_id).toBe('proj-1');
      expect(gaps[0].category).toBe('field_undefined');
      expect(gaps[0].status).toBe('open');

      // agent_outputs system line for terminal visibility
      const outputs = testDb.prepare('SELECT * FROM agent_outputs WHERE agent_id = ?').all('mcp-task-1') as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].content).toContain('[SPEC_GAP][field_undefined]');

      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.specGap',
        data: expect.objectContaining({ taskId: 'task-1', category: 'field_undefined', action: 'reported' }),
      });
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_spec_gap', {
        taskId: 'nope', category: 'other', description: 'x',
      });
      expect(result.isError).toBe(true);
    });

    it('accepts the ambiguous_spec category (規格模糊點預檢 產出)', async () => {
      seed(testDb);

      const result = await callTool(server, 'report_spec_gap', {
        taskId: 'task-1',
        category: 'ambiguous_spec',
        description: '刪除是否需要二次確認——SA WA05.md §3.2 只寫「可刪除」，未寫確認流程（A: 直接刪除 / B: confirm 彈窗後刪除）',
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Spec gap recorded');

      const gap = testDb.prepare("SELECT * FROM spec_gaps WHERE category = 'ambiguous_spec'").get() as any;
      expect(gap).toBeTruthy();
      expect(gap.status).toBe('open');

      const outputs = testDb.prepare('SELECT * FROM agent_outputs WHERE agent_id = ?').all('mcp-task-1') as any[];
      expect(outputs[0].content).toContain('[SPEC_GAP][ambiguous_spec]');
    });
  });

  describe('list_spec_gaps', () => {
    it('requires at least one filter', async () => {
      const result = await callTool(server, 'list_spec_gaps', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('至少提供');
    });

    it('filters by projectId/taskId/status and returns total', async () => {
      seed(testDb);
      await callTool(server, 'report_spec_gap', { taskId: 'task-1', category: 'sa_missing', description: 'gap A' });
      await callTool(server, 'report_spec_gap', { taskId: 'task-1', category: 'other', description: 'gap B' });

      const byProject = JSON.parse((await callTool(server, 'list_spec_gaps', { projectId: 'proj-1' })).content[0].text);
      expect(byProject.total).toBe(2);
      expect(byProject.gaps[0].taskTitle).toBe('WA05 查詢作業');

      const openOnly = JSON.parse((await callTool(server, 'list_spec_gaps', { taskId: 'task-1', status: 'open' })).content[0].text);
      expect(openOnly.total).toBe(2);

      const resolvedOnly = JSON.parse((await callTool(server, 'list_spec_gaps', { taskId: 'task-1', status: 'resolved' })).content[0].text);
      expect(resolvedOnly.total).toBe(0);
    });
  });

  describe('resolve_spec_gap', () => {
    it('marks a gap resolved with note and notifies', async () => {
      seed(testDb);
      await callTool(server, 'report_spec_gap', { taskId: 'task-1', category: 'api_undefined', description: 'API 未定義' });
      const gap = testDb.prepare('SELECT id FROM spec_gaps').get() as { id: string };

      const result = await callTool(server, 'resolve_spec_gap', { gapId: gap.id, note: '使用者補了 SD v2' });
      expect(result.isError).toBeUndefined();

      const row = testDb.prepare('SELECT * FROM spec_gaps WHERE id = ?').get(gap.id) as any;
      expect(row.status).toBe('resolved');
      expect(row.resolution_note).toBe('使用者補了 SD v2');
      expect(row.resolved_at).toBeTruthy();

      expect(notifyWebServer).toHaveBeenLastCalledWith({
        event: 'task.specGap',
        data: expect.objectContaining({ gapId: gap.id, action: 'resolved' }),
      });
    });

    it('is idempotent for already-resolved gaps', async () => {
      seed(testDb);
      await callTool(server, 'report_spec_gap', { taskId: 'task-1', category: 'other', description: 'x' });
      const gap = testDb.prepare('SELECT id FROM spec_gaps').get() as { id: string };
      await callTool(server, 'resolve_spec_gap', { gapId: gap.id });

      const again = await callTool(server, 'resolve_spec_gap', { gapId: gap.id });
      expect(again.isError).toBeUndefined();
      expect(again.content[0].text).toContain('already resolved');
    });

    it('returns error for unknown gapId', async () => {
      const result = await callTool(server, 'resolve_spec_gap', { gapId: 'nope' });
      expect(result.isError).toBe(true);
    });
  });
});
