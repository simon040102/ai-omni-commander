/**
 * AsanaSyncService.syncOnce — due_on 截止日期落地測試（Web-server 同步路徑）。
 * 與 MCP sync_asana_tasks 各自實作，行為必須一致：
 * create 落地 dueDate、只有 due 改變也觸發 UPDATE、無變更不觸發、清除 → null。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import type { AsanaTask } from '@omni/shared';

let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

import { AsanaSyncService } from '../AsanaSyncService.js';
import type { AsanaMcpClient } from '../AsanaMcpClient.js';
import type { TaskClassifier } from '../../orchestrator/TaskClassifier.js';
import type { OmniWebSocketServer } from '../../websocket/WebSocketServer.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function asanaTask(gid: string, name: string, dueOn: string | null): AsanaTask {
  return {
    gid,
    name,
    notes: '',
    projectName: 'P',
    projectGid: 'pg-1',
    dueOn,
    completed: false,
    permalink_url: '',
    tags: [],
    section: null,
    assignee: null,
    customFields: {},
  };
}

function buildService(remoteTasks: AsanaTask[]) {
  const asanaClient = {
    getMyTasksForProjectDetailed: vi.fn().mockResolvedValue({
      tasks: remoteTasks,
      subtaskCount: 0,
      subtaskFetchIncomplete: false,
      subtaskWarnings: [],
    }),
  } as unknown as AsanaMcpClient;

  const classifier = {
    detectLabelFromTitle: vi.fn().mockReturnValue(null),
    classify: vi.fn().mockResolvedValue({ taskType: 'feature', label: 'frontend' }),
    fallbackClassify: vi.fn().mockReturnValue({ taskType: 'feature', label: 'frontend' }),
  } as unknown as TaskClassifier;

  const wsServer = { broadcast: vi.fn() } as unknown as OmniWebSocketServer;

  return new AsanaSyncService(asanaClient, classifier, wsServer);
}

describe('AsanaSyncService — due_on 落地', () => {
  beforeEach(() => {
    testDb = freshDb();
    testDb.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES ('proj-1', 'Test', '/tmp/p', 'pg-1')`).run();
  });

  it('create 落地 dueDate；無 due → null', async () => {
    const svc = buildService([
      asanaTask('g1', '前端', '2026-07-25'),
      asanaTask('g2', '後端', null),
    ]);
    const result = await svc.syncOnce('proj-1');
    expect(result.newTasks).toBe(2);

    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g1'`).get() as any).due_date).toBe('2026-07-25');
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g2'`).get() as any).due_date).toBeNull();
  });

  it('只有 due date 改變也觸發 UPDATE；無變更不觸發；清除 → null', async () => {
    await buildService([asanaTask('g1', '前端', '2026-07-25')]).syncOnce('proj-1');

    // 同資料 → 不更新
    const unchanged = await buildService([asanaTask('g1', '前端', '2026-07-25')]).syncOnce('proj-1');
    expect(unchanged.updatedTasks).toBe(0);

    // 只改 due_on → 更新
    const changed = await buildService([asanaTask('g1', '前端', '2026-08-01')]).syncOnce('proj-1');
    expect(changed.updatedTasks).toBe(1);
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g1'`).get() as any).due_date).toBe('2026-08-01');

    // 清除 due date → null
    const cleared = await buildService([asanaTask('g1', '前端', null)]).syncOnce('proj-1');
    expect(cleared.updatedTasks).toBe(1);
    expect((testDb.prepare(`SELECT due_date FROM tasks WHERE source_ref = 'g1'`).get() as any).due_date).toBeNull();
  });
});
