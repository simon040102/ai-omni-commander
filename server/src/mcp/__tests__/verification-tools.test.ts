import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(true),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerVerificationTools } from '../tools/verification-tools.js';
import { notifyWebServer } from '../notify.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedTask(db: Database.Database, label: string, id = 'task-1') {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
    id, 'proj-1', 'Test Task', label, 'feature',
  );
}

describe('verification-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerVerificationTools(server);
    vi.clearAllMocks();
  });

  describe('get_verification_plan', () => {
    it('returns backend checklist for backend tasks', async () => {
      seedTask(testDb, 'backend');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.label).toBe('backend');
      const ids = plan.items.map((i: any) => i.id);
      expect(ids).toEqual(['be-no-findall', 'be-ddl-match', 'be-api-smoke', 'be-seed-sql']);
      expect(plan.items.every((i: any) => i.item && i.how)).toBe(true);
    });

    it('returns frontend checklist for frontend tasks', async () => {
      seedTask(testDb, 'frontend');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.items.map((i: any) => i.id)).toEqual(['fe-tsc', 'fe-browser']);
    });

    it('returns both checklists for fullstack tasks', async () => {
      seedTask(testDb, 'fullstack');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.items).toHaveLength(6);
    });

    it('returns full list with note for other labels', async () => {
      seedTask(testDb, 'devops');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.items).toHaveLength(6);
      expect(plan.note).toContain('devops');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_verification_plan', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('report_verification_result', () => {
    it('stores results in agent_outputs and notifies milestone 驗收：X/Y 通過', async () => {
      seedTask(testDb, 'backend');

      const result = await callTool(server, 'report_verification_result', {
        taskId: 'task-1',
        results: [
          { item: 'be-no-findall', passed: true },
          { item: 'be-api-smoke', passed: false, note: 'GET /api/x 回 500' },
        ],
      });

      expect(result.content[0].text).toContain('驗收：1/2 通過');
      expect(result.content[0].text).toContain('未通過');

      const outputs = testDb.prepare("SELECT * FROM agent_outputs WHERE agent_id = 'mcp-task-1'").all() as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].stream_type).toBe('system');
      expect(outputs[0].content).toContain('[VERIFICATION] 驗收：1/2 通過');
      expect(outputs[0].content).toContain('[FAIL] be-api-smoke — GET /api/x 回 500');

      const events = testDb.prepare("SELECT * FROM events WHERE event_type = 'task.milestone'").all() as any[];
      expect(events).toHaveLength(1);

      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.milestone',
        data: expect.objectContaining({ taskId: 'task-1', milestone: '驗收：1/2 通過' }),
      });
    });

    it('suggests completion when all pass', async () => {
      seedTask(testDb, 'frontend');
      const result = await callTool(server, 'report_verification_result', {
        taskId: 'task-1',
        results: [{ item: 'fe-tsc', passed: true }],
      });
      expect(result.content[0].text).toContain('全部通過');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_verification_result', {
        taskId: 'nope', results: [{ item: 'x', passed: true }],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('report_verification_evidence', () => {
    let tmpDir: string;
    let prevDbPath: string | undefined;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-evidence-'));
      prevDbPath = process.env['DB_PATH'];
      // getDataDir() derives the data dir from DB_PATH
      process.env['DB_PATH'] = path.join(tmpDir, 'omni.db');
    });

    afterEach(() => {
      if (prevDbPath === undefined) delete process.env['DB_PATH'];
      else process.env['DB_PATH'] = prevDbPath;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('copies the file, writes documents (doc_type=verification) + binding + [EVIDENCE] output + milestone', async () => {
      seedTask(testDb, 'frontend');
      const srcPath = path.join(tmpDir, 'screenshot 1.png');
      fs.writeFileSync(srcPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await callTool(server, 'report_verification_evidence', {
        taskId: 'task-1', filePath: srcPath, description: 'WA05 查詢結果截圖',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Verification evidence saved');

      // copied into {dataDir}/uploads/{projectId}/verification/{taskId}/
      const destDir = path.join(tmpDir, 'uploads', 'proj-1', 'verification', 'task-1');
      const copied = fs.readdirSync(destDir);
      expect(copied).toEqual(['screenshot 1.png']);

      // documents row + task binding
      const doc = testDb.prepare("SELECT * FROM documents WHERE doc_type = 'verification'").get() as any;
      expect(doc).toBeTruthy();
      expect(doc.project_id).toBe('proj-1');
      expect(doc.filename).toBe('screenshot 1.png');
      expect(doc.file_type).toBe('image/png');
      const binding = testDb.prepare('SELECT * FROM task_documents WHERE document_id = ?').get(doc.id) as any;
      expect(binding.task_id).toBe('task-1');

      // [EVIDENCE] output line
      const outputs = testDb.prepare("SELECT * FROM agent_outputs WHERE agent_id = 'mcp-task-1'").all() as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].content).toBe('[EVIDENCE] WA05 查詢結果截圖');

      // milestone event + notify
      const events = testDb.prepare("SELECT * FROM events WHERE event_type = 'task.milestone'").all() as any[];
      expect(events).toHaveLength(1);
      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.milestone',
        data: expect.objectContaining({ taskId: 'task-1', milestone: '驗收證據：screenshot 1.png' }),
      });
    });

    it('de-duplicates filenames with a numeric suffix', async () => {
      seedTask(testDb, 'frontend');
      const srcPath = path.join(tmpDir, 'shot.png');
      fs.writeFileSync(srcPath, 'a');

      await callTool(server, 'report_verification_evidence', { taskId: 'task-1', filePath: srcPath });
      await callTool(server, 'report_verification_evidence', { taskId: 'task-1', filePath: srcPath });

      const destDir = path.join(tmpDir, 'uploads', 'proj-1', 'verification', 'task-1');
      expect(fs.readdirSync(destDir).sort()).toEqual(['shot-1.png', 'shot.png']);
    });

    it('returns a clear error for a non-existent file path', async () => {
      seedTask(testDb, 'frontend');
      const result = await callTool(server, 'report_verification_evidence', {
        taskId: 'task-1', filePath: path.join(tmpDir, 'missing.png'),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('檔案不存在');
      expect(testDb.prepare('SELECT COUNT(*) as c FROM documents').get()).toEqual({ c: 0 });
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_verification_evidence', { taskId: 'nope', filePath: 'x' });
      expect(result.isError).toBe(true);
    });
  });
});
