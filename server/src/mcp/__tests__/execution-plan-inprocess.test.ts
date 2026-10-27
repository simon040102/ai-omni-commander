/**
 * 執行計畫在 MCP process 內組——不 mock 組計畫本身：真的動態載入 ExecutionPipeline、
 * 讓 db/queries/* 改用 MCP 的連線（useDb）、組出計畫。專案沒設 SVN／規格資料夾，所以不碰網路。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

// getConfig() 會快取 dbPath（spec-cache／svn-cache／uploads 都由它推導）——載入任何模組前先指到暫存目錄
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-plan-inproc-'));
process.env['DB_PATH'] = path.join(tmpDir, 'omni.db');

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));

import { buildExecutionPlanInProcess } from '../execution-plan-inprocess.js';
import { logDestinationFd } from '../../utils/logger.js';

describe('buildExecutionPlanInProcess（不經 Web Server）', () => {
  beforeAll(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    runMigrations(testDb);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path, backend_path) VALUES ('p1', 'P', ?, ?, ?)`)
      .run(tmpDir, path.join(tmpDir, 'web'), path.join(tmpDir, 'server'));
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, description, label, task_type) VALUES ('t1', 'p1', 'WA05 查詢作業', '查詢條件要能依日期過濾', 'frontend', 'feature')`).run();
  });
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('真的組出計畫：含任務內容、兩個 workspace 路徑；讀的是 MCP 的連線（測試 DB）', async () => {
    const plan = await buildExecutionPlanInProcess('t1', undefined, 'full');
    expect(plan.prompt).toContain('WA05 查詢作業');
    expect(plan.prompt).toContain('查詢條件要能依日期過濾');
    expect(plan.frontendPath).toBe(path.join(tmpDir, 'web'));
    expect(plan.backendPath).toBe(path.join(tmpDir, 'server'));
    expect(typeof plan.model).toBe('string');
  }, 180_000);

  it('指定 role 走該角色的計畫；light 軌照樣組得出來', async () => {
    const plan = await buildExecutionPlanInProcess('t1', 'backend', 'light');
    expect(plan.prompt).toContain('WA05 查詢作業');
  }, 180_000);

  it('任務不存在 → 丟錯（get_execution_plan 會轉成錯誤回應）', async () => {
    await expect(buildExecutionPlanInProcess('no-such', undefined, 'full')).rejects.toThrow(/not found/);
  }, 180_000);

  it('載入後 log 一律走 stderr（stdout 是 MCP 的 JSON-RPC 通道）', () => {
    expect(process.env['OMNI_LOG_STDERR']).toBe('1');
    expect(logDestinationFd()).toBe(2);
    expect(logDestinationFd({})).toBe(1); // Web Server 沒設旗標 → 照舊 stdout
  });
});
