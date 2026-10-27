/**
 * 任務 ID 短碼：在工具註冊入口統一把 taskId／dependsOnTaskId／coveredBy 的唯一前綴（≥8 碼）換成完整 ID。
 * 各工具不用個別處理；完整 ID、不存在的 ID 照原樣交給工具（由工具回自己的 not found）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { vi } from 'vitest';

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { installTaskIdPrefixResolution } from '../task-id-prefix.js';
import { registerTaskTools } from '../tools/task-tools.js';
import { registerContextTools } from '../tools/context-tools.js';
import { callTool } from './test-helpers.js';

const A = 'aaaabbbb-1111-4222-8333-444455556666';
const B1 = 'cccc0000-1111-4222-8333-444455556666';
const B2 = 'cccc0000-9999-4222-8333-444455556666'; // 與 B1 前 8 碼相同

describe('任務 ID 短碼（入口統一解析）', () => {
  let server: McpServer;
  let seen: Record<string, unknown> | null;

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p1', 'P', '/tmp')`).run();
    for (const id of [A, B1, B2]) {
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label) VALUES (?, 'p1', ?, 'frontend')`).run(id, `任務 ${id.slice(0, 4)}`);
    }
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    installTaskIdPrefixResolution(server);
    seen = null;
    server.tool('echo', 'echo', { taskId: z.string().optional(), dependsOnTaskId: z.string().optional(), coveredBy: z.string().optional(), taskGid: z.string().optional() },
      async (args) => { seen = args; return { content: [{ type: 'text' as const, text: 'ok' }] }; });
    registerTaskTools(server);
    registerContextTools(server);
  });

  it('唯一的 8 碼前綴 → 換成完整 ID 再交給工具；三種任務參數都適用', async () => {
    await callTool(server, 'echo', { taskId: A.slice(0, 8), dependsOnTaskId: A.slice(0, 10), coveredBy: A.slice(0, 8) });
    expect(seen).toMatchObject({ taskId: A, dependsOnTaskId: A, coveredBy: A });
  });

  it('完整 ID、不存在的 ID、少於 8 碼 → 原樣交給工具（由工具回自己的 not found）', async () => {
    await callTool(server, 'echo', { taskId: A });
    expect(seen!['taskId']).toBe(A);
    await callTool(server, 'echo', { taskId: 'zzzzzzzz' });
    expect(seen!['taskId']).toBe('zzzzzzzz');
    await callTool(server, 'echo', { taskId: 'aaaabbb' });
    expect(seen!['taskId']).toBe('aaaabbb');
  });

  it('前綴對到多筆 → 不呼叫工具，回錯列出候選', async () => {
    const r = await callTool(server, 'echo', { taskId: 'cccc0000' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(B1);
    expect(r.content[0].text).toContain(B2);
    expect(seen).toBeNull();
  });

  it('Asana 的 taskGid 不碰（就算剛好像任務前綴）', async () => {
    await callTool(server, 'echo', { taskGid: A.slice(0, 8) });
    expect(seen!['taskGid']).toBe(A.slice(0, 8));
  });

  it('真實工具：get_task 用 8 碼短 ID 拿得到任務', async () => {
    const r = await callTool(server, 'get_task', { taskId: A.slice(0, 8) });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain(A);
  });

  it('正式入口 createOmniMcpServer 有裝上（不是只有測試手動裝）', async () => {
    const { createOmniMcpServer } = await import('../McpServer.js');
    const omni = createOmniMcpServer();
    const r = await callTool(omni, 'get_task', { taskId: A.slice(0, 8) });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain(A);
  }, 180_000); // 載入全部工具模組在機器忙的時候要幾十秒

  it('真實工具：add_task_dependency 兩個參數都用短 ID，DB 存的是完整 ID', async () => {
    const r = await callTool(server, 'add_task_dependency', { taskId: A.slice(0, 8), dependsOnTaskId: B1.slice(0, 13) });
    expect(r.isError).toBeUndefined();
    const row = testDb.prepare('SELECT * FROM task_dependencies').get() as Record<string, string>;
    expect(Object.values(row)).toEqual(expect.arrayContaining([A, B1]));
  });
});
