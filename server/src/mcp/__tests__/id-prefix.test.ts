/**
 * 短 ID（前 8 碼）：agent 回報常只寫前 8 碼，但裁決落地、豁免、回對都要完整 36 碼，
 * 實測得自己去讀 DB 查。規則：完整 ID 照舊；至少 8 碼且只對得到一筆才接受；
 * 對到多筆回錯誤並列候選（不猜）；少於 8 碼不收。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;
vi.mock('../db.js', () => ({ getMcpDb: () => testDb }));
vi.mock('../notify.js', () => ({ notifyWebServer: vi.fn().mockResolvedValue(true) }));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSpecGapTools } from '../tools/spec-gap-tools.js';
import { registerComplianceTools } from '../tools/compliance-tools.js';
import { resolveIdPrefix } from '../helpers.js';
import { callTool } from './test-helpers.js';

const GAP_A = 'abcd1234-0000-4000-8000-000000000001';
const GAP_B = 'abcd1234-0000-4000-8000-000000000002'; // 前 8 碼與 A 相同 → 8 碼有歧義
const GAP_C = 'ffff9999-0000-4000-8000-000000000003';

function seed() {
  testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p1', 'P', '/tmp')`).run();
  testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t1', 'p1', 'T', 'frontend', 'feature')`).run();
  for (const id of [GAP_A, GAP_B, GAP_C]) {
    testDb.prepare(`INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES (?, 't1', 'p1', 'other', '缺口')`).run(id);
  }
  testDb.prepare(`INSERT INTO spec_checklist_items (id, task_id, project_id, item_type, content) VALUES ('11112222-aaaa-4bbb-8ccc-000000000001', 't1', 'p1', 'logic', '查詢依日期排序')`).run();
}

describe('resolveIdPrefix', () => {
  beforeEach(() => { testDb = new Database(':memory:'); runMigrations(testDb); seed(); });

  it('完整 ID 照舊；唯一的 8 碼前綴接受；歧義列候選；少於 8 碼不收', () => {
    expect(resolveIdPrefix(testDb, 'spec_gaps', GAP_C)).toEqual({ id: GAP_C });
    expect(resolveIdPrefix(testDb, 'spec_gaps', 'ffff9999')).toEqual({ id: GAP_C });
    const amb = resolveIdPrefix(testDb, 'spec_gaps', 'abcd1234');
    expect(amb).toEqual({ ambiguous: [GAP_A, GAP_B] });
    expect(resolveIdPrefix(testDb, 'spec_gaps', 'abcd1234-0000-4000-8000-000000000002')).toEqual({ id: GAP_B });
    expect(resolveIdPrefix(testDb, 'spec_gaps', 'ffff99')).toBeNull();
    expect(resolveIdPrefix(testDb, 'spec_gaps', 'nope0000')).toBeNull();
  });

  it('前綴裡的 SQL 萬用字元不會被當成萬用字元', () => {
    expect(resolveIdPrefix(testDb, 'spec_gaps', 'ffff%%%%')).toBeNull();
    expect(resolveIdPrefix(testDb, 'spec_gaps', '________')).toBeNull();
  });
});

describe('工具接受短 ID', () => {
  let server: McpServer;
  beforeEach(() => {
    testDb = new Database(':memory:'); runMigrations(testDb); seed();
    server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    registerSpecGapTools(server);
    registerComplianceTools(server);
  });

  it('resolve_spec_gap：8 碼前綴落地到正確的缺口；歧義時列候選、不改任何缺口', async () => {
    const ok = await callTool(server, 'resolve_spec_gap', { gapId: 'ffff9999', resolutionNote: '選 B：刪除前跳出確認視窗', scope: 'task' });
    expect(ok.isError).toBeUndefined();
    expect((testDb.prepare('SELECT status, resolution_note FROM spec_gaps WHERE id = ?').get(GAP_C) as { status: string; resolution_note: string }))
      .toEqual({ status: 'resolved', resolution_note: '選 B：刪除前跳出確認視窗' });

    const amb = await callTool(server, 'resolve_spec_gap', { gapId: 'abcd1234', resolutionNote: '選 A：保留原本的排序方式', scope: 'task' });
    expect(amb.isError).toBe(true);
    expect(amb.content[0].text).toContain(GAP_A);
    expect(amb.content[0].text).toContain(GAP_B);
    expect((testDb.prepare("SELECT COUNT(*) c FROM spec_gaps WHERE status = 'resolved'").get() as { c: number }).c).toBe(1);
  });

  it('save_compliance_review：results 的 itemId 可用 8 碼前綴（只在本任務的檢查項裡比對），寫入的是完整 ID', async () => {
    const r = await callTool(server, 'save_compliance_review', { taskId: 't1', results: [{ itemId: '11112222', status: 'missing', note: '還沒做' }] });
    expect(r.isError).toBeUndefined();
    const run = testDb.prepare("SELECT results_json FROM spec_compliance_runs WHERE task_id = 't1' AND source = 'ai_review'").get() as { results_json: string };
    expect(JSON.parse(run.results_json)[0].itemId).toBe('11112222-aaaa-4bbb-8ccc-000000000001');
  });

  it('waive_checklist_item：8 碼前綴豁免到正確的項目', async () => {
    const r = await callTool(server, 'waive_checklist_item', { itemId: '11112222', reason: '使用者確認 Phase 2 再做，本輪不實作' });
    expect(r.isError).toBeUndefined();
    expect((testDb.prepare('SELECT waived FROM spec_checklist_items WHERE id = ?').get('11112222-aaaa-4bbb-8ccc-000000000001') as { waived: number }).waived).toBe(1);
  });
});
