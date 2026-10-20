import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerClassificationTools } from '../tools/classification-tools.js';
import { callTool } from './test-helpers.js';

function seed() {
  testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p1', 'P', '/tmp')`).run();
  const add = (id: string, title: string, label: string, type: string, status = 'pending') =>
    testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES (?, 'p1', ?, ?, ?, ?)`).run(id, title, label, type, status);
  add('t-bug', 'WA02 點選複製後發文無法發出', 'frontend', 'feature');   // 類型標錯
  add('t-be', 'RPT41 報表 SQL 與匯出 API', 'frontend', 'feature');      // 角色標錯（預設 frontend）
  add('t-ok', 'DF01 收文單 新增畫面', 'frontend', 'feature');           // 一致
  add('t-low', '描述很模糊的一張', 'frontend', 'other');                // Jev 沒把握
  add('t-done', '已結案的', 'frontend', 'feature', 'completed');        // 預設不看
  add('t-ops', 'CI 部署設定', 'devops', 'other');                       // 非開發 label 不比角色
}

/** 依任務標題回假答案：kind=任務類型、side=角色 */
function fakeJev(seen: string[]) {
  return vi.fn(async (_u: string, init: RequestInit) => {
    const item = JSON.parse(init.body as string).state.item as string;
    seen.push(item);
    const ans = (kind: string, kc: number, side: string, sc: number) => ({
      answers: { kind: { type: 'choice', choice: kind, confidence: kc }, side: { type: 'choice', choice: side, confidence: sc } },
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    const body = item.includes('無法發出') ? ans('bug', 0.95, 'frontend', 0.9)
      : item.includes('SQL') ? ans('feature', 0.9, 'backend', 0.92)
      : item.includes('模糊') ? ans('bug', 0.4, 'backend', 0.3)
      : item.includes('部署') ? ans('other', 0.9, 'other', 0.9)
      : ans('feature', 0.95, 'frontend', 0.95);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('review_task_classification', () => {
  let server: McpServer;
  let seen: string[];

  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    seed();
    seen = [];
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerClassificationTools(server, { getApiKey: () => 'k', fetchImpl: fakeJev(seen) });
  });

  it('只列 Jev 有把握且與現況不同的任務；不改任何資料', async () => {
    const before = testDb.prepare('SELECT id, label, task_type FROM tasks ORDER BY id').all();
    const r = await callTool(server, 'review_task_classification', { projectId: 'p1' });
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text);
    const ids = out.suggestions.map((s: { taskId: string }) => s.taskId).sort();
    expect(ids).toEqual(['t-be', 't-bug']);
    const bug = out.suggestions.find((s: { taskId: string }) => s.taskId === 't-bug');
    expect(bug.taskType).toEqual({ current: 'feature', suggested: 'bug', confidence: 0.95 });
    expect(bug.label).toBeUndefined();
    const be = out.suggestions.find((s: { taskId: string }) => s.taskId === 't-be');
    expect(be.label).toEqual({ current: 'frontend', suggested: 'backend', confidence: 0.92 });
    expect(out.checked).toBe(5);         // 預設只看 pending／in_progress
    expect(out.note).toContain('update_task');
    expect(testDb.prepare('SELECT id, label, task_type FROM tasks ORDER BY id').all()).toEqual(before);
  });

  it('非開發 label（devops 等）不比角色；Jev 判 other 不當成建議', async () => {
    const out = JSON.parse((await callTool(server, 'review_task_classification', { projectId: 'p1' })).content[0].text);
    expect(out.suggestions.find((s: { taskId: string }) => s.taskId === 't-ops')).toBeUndefined();
  });

  it('沒有金鑰 → 錯誤說明去哪設定', async () => {
    const s2 = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerClassificationTools(s2, { getApiKey: () => '', fetchImpl: fakeJev([]) });
    const r = await callTool(s2, 'review_task_classification', { projectId: 'p1' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Global Settings');
  });
});
