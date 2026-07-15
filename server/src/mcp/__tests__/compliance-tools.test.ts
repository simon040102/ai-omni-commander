import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
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
import { registerComplianceTools } from '../tools/compliance-tools.js';
import { notifyWebServer } from '../notify.js';
import { callTool } from './test-helpers.js';

let feRoot: string;

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database, id = 'proj-1') {
  db.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path, backend_path) VALUES (?, ?, ?, ?, ?)`).run(
    id, 'Test Project', '/tmp/project', feRoot, null,
  );
}

function seedTask(db: Database.Database, id = 'task-1', projectId = 'proj-1', label = 'frontend') {
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, label, task_type) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, projectId, 'WA05 代理人設定', 'desc', label, 'feature',
  );
}

const UI_ITEM = { itemType: 'ui_text', content: '代理人設定作業', side: 'frontend' };
const MISSING_ITEM = { itemType: 'ui_text', content: '不存在的文字', side: 'frontend' };

beforeAll(() => {
  feRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-comp-tools-'));
  fs.mkdirSync(path.join(feRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(feRoot, 'src', 'Index.tsx'), '<h1>代理人設定作業</h1>\n', 'utf-8');
  // 40 行檔案：目標文字只在第 1 行——證據引用遠處行會超出 ±10 相關性窗口
  fs.writeFileSync(
    path.join(feRoot, 'src', 'Long.tsx'),
    ['// 窗口測試目標文字', ...Array.from({ length: 39 }, (_, i) => `const filler_${i} = ${i};`)].join('\n'),
    'utf-8',
  );
});

afterAll(() => {
  fs.rmSync(feRoot, { recursive: true, force: true });
});

describe('compliance-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerComplianceTools(server);
    vi.mocked(notifyWebServer).mockClear();
  });

  describe('save_spec_checklist', () => {
    it('appends items by default and notifies task.checklistSaved', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const r1 = await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      expect(r1.isError).toBeUndefined();
      const r2 = await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [MISSING_ITEM] });
      expect(r2.content[0].text).toContain('共 2 項');

      const count = (testDb.prepare('SELECT COUNT(*) as c FROM spec_checklist_items WHERE task_id = ?').get('task-1') as { c: number }).c;
      expect(count).toBe(2);
      expect(notifyWebServer).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.checklistSaved',
        data: expect.objectContaining({ taskId: 'task-1', projectId: 'proj-1' }),
      }));
    });

    it('replace=true removes non-waived items but preserves waived ones', async () => {
      seedProject(testDb);
      seedTask(testDb);

      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM, MISSING_ITEM] });
      // waive one item
      const rows = testDb.prepare('SELECT id, content FROM spec_checklist_items WHERE task_id = ?').all('task-1') as Array<{ id: string; content: string }>;
      const waivedRow = rows.find(r => r.content === '不存在的文字')!;
      await callTool(server, 'waive_checklist_item', { itemId: waivedRow.id, reason: 'Phase 2 不做' });

      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [{ itemType: 'api', content: 'POST /api/wa05/save' }], replace: true });

      const after = testDb.prepare('SELECT content, waived FROM spec_checklist_items WHERE task_id = ? ORDER BY waived DESC').all('task-1') as Array<{ content: string; waived: number }>;
      expect(after).toHaveLength(2);
      expect(after.find(r => r.waived === 1)?.content).toBe('不存在的文字'); // waived survived replace
      expect(after.find(r => r.waived === 0)?.content).toBe('POST /api/wa05/save');
    });

    it('rejects more than 200 items in one call', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const items = Array.from({ length: 201 }, (_, i) => ({ itemType: 'param', content: `field_${i}` }));
      const result = await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('200');
    });

    it('replace=true after an ai_review run exists → [CHECKLIST_REPLACE] audit trail + response warning', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM, MISSING_ITEM] });
      // 手造一筆 ai_review run（模擬已完成過 AI 回對）
      testDb.prepare(`
        INSERT INTO spec_compliance_runs (id, task_id, total, matched, missing, manual, waived, results_json, source)
        VALUES ('run-air', 'task-1', 2, 2, 0, 0, 0, '[]', 'ai_review')
      `).run();

      const result = await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1', items: [{ itemType: 'ui_text', content: '縮水後的唯一項' }], replace: true,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('[CHECKLIST_REPLACE]');
      const audit = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[CHECKLIST_REPLACE]%'").all() as Array<{ content: string }>;
      expect(audit).toHaveLength(1);
      expect(audit[0].content).toContain('移除 2 筆');
    });

    it('replace=true without any ai_review run → no audit line', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });

      const result = await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1', items: [{ itemType: 'ui_text', content: '重抽的項' }], replace: true,
      });

      expect(result.content[0].text).not.toContain('[CHECKLIST_REPLACE]');
      const audit = testDb.prepare("SELECT COUNT(*) as c FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[CHECKLIST_REPLACE]%'").get() as { c: number };
      expect(audit.c).toBe(0);
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'save_spec_checklist', { taskId: 'nope', items: [UI_ITEM] });
      expect(result.isError).toBe(true);
    });

    it('P4: returns the created item ids as a parseable JSON block matching the DB', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1',
        items: [UI_ITEM, { itemType: 'logic', content: '依建立日期倒序' }],
      });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      // 引導文字保留
      expect(text).toContain('Spec checklist saved');
      expect(text).toContain('run_spec_compliance');
      // created JSON 區塊
      const created = JSON.parse(text.slice(text.indexOf('created:') + 'created:'.length)) as Array<{ id: string; itemType: string; content: string }>;
      expect(created).toHaveLength(2);
      expect(created[0]).toMatchObject({ itemType: 'ui_text', content: '代理人設定作業' });
      expect(created[1]).toMatchObject({ itemType: 'logic', content: '依建立日期倒序' });
      // id 與 DB 一致
      const dbIds = (testDb.prepare('SELECT id FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC').all('task-1') as Array<{ id: string }>).map(r => r.id);
      expect(created.map(c => c.id)).toEqual(dbIds);
    });

    it('P2: tool description forbids storing behaviour sentences as ui_text (存 logic)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = (server as any)._registeredTools['save_spec_checklist'];
      expect(tool.description).toContain('禁止存 ui_text——存 logic');
      expect(tool.description).toContain('字面文字');
    });
  });

  describe('get_spec_checklist', () => {
    it('returns items (incl. waived) and null latestRun when no run exists', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM, MISSING_ITEM] });
      const row = testDb.prepare("SELECT id FROM spec_checklist_items WHERE content = '不存在的文字'").get() as { id: string };
      await callTool(server, 'waive_checklist_item', { itemId: row.id, reason: '不做' });

      const data = JSON.parse((await callTool(server, 'get_spec_checklist', { taskId: 'task-1' })).content[0].text);
      expect(data.count).toBe(2);
      expect(data.items.filter((i: { waived: boolean }) => i.waived)).toHaveLength(1);
      expect(data.latestRun).toBeNull();
    });

    it('includes the latest run summary after run_spec_compliance', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      await callTool(server, 'run_spec_compliance', { taskId: 'task-1' });

      const data = JSON.parse((await callTool(server, 'get_spec_checklist', { taskId: 'task-1' })).content[0].text);
      expect(data.latestRun).toMatchObject({ total: 1, matched: 1, missing: 0 });
    });

    it('paginates a large checklist (total/hasMore/offset) so the reviewer can see every item', async () => {
      seedProject(testDb);
      seedTask(testDb);
      const items = Array.from({ length: 120 }, (_, i) => ({
        itemType: i % 5 === 0 ? 'logic' : 'ui_text',
        content: `項目-${i}`,
      }));
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items });

      // page 1
      const p1 = JSON.parse((await callTool(server, 'get_spec_checklist', { taskId: 'task-1', limit: 50, offset: 0 })).content[0].text);
      expect(p1.total).toBe(120);
      expect(p1.count).toBe(50);
      expect(p1.hasMore).toBe(true);
      // page 3 (last)
      const p3 = JSON.parse((await callTool(server, 'get_spec_checklist', { taskId: 'task-1', limit: 50, offset: 100 })).content[0].text);
      expect(p3.count).toBe(20);
      expect(p3.hasMore).toBe(false);

      // collect all ids across pages → covers all 120 incl. logic items
      const allIds = new Set<string>();
      for (let offset = 0; ; offset += 50) {
        const page = JSON.parse((await callTool(server, 'get_spec_checklist', { taskId: 'task-1', limit: 50, offset })).content[0].text);
        for (const it of page.items) allIds.add(it.id);
        if (!page.hasMore) break;
      }
      expect(allIds.size).toBe(120);
    });

    it('P3: auto-shrinks an oversized page so the JSON stays parseable, hasMore is trustworthy, and all ids are reachable across pages', async () => {
      seedProject(testDb);
      seedTask(testDb);
      // 30 項 × ~1500 字 content → 單頁（limit=50）JSON 遠超 CHARACTER_LIMIT(25000)
      const big = 'X規格文字'.repeat(300);
      const items = Array.from({ length: 30 }, (_, i) => ({ itemType: 'ui_text', content: `項${i}-${big}` }));
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items });

      const raw = (await callTool(server, 'get_spec_checklist', { taskId: 'task-1', limit: 50, offset: 0 })).content[0].text;
      const p1 = JSON.parse(raw); // 不會 throw——回應是完整 JSON，不是硬截斷
      expect(p1.total).toBe(30);
      expect(p1.count).toBeLessThan(30);          // 本頁自動縮小
      expect(p1.count).toBe(p1.items.length);     // count 以實際回傳筆數計
      expect(p1.hasMore).toBe(true);              // hasMore 可信
      expect(p1.note).toContain('自動縮至');
      expect(p1.note).toContain(`offset=${p1.count}`);

      // 跨頁（以實際回傳的 count 推進 offset）仍可收齊全部 30 個 id
      const allIds = new Set<string>();
      for (let offset = 0; ;) {
        const page = JSON.parse((await callTool(server, 'get_spec_checklist', { taskId: 'task-1', limit: 50, offset })).content[0].text);
        expect(page.count).toBe(page.items.length);
        for (const it of page.items) allIds.add(it.id);
        if (!page.hasMore) break;
        offset += page.count;
      }
      expect(allIds.size).toBe(30);
    });
  });

  describe('waive_checklist_item', () => {
    it('rejects blank-only reason', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [MISSING_ITEM] });
      const row = testDb.prepare('SELECT id FROM spec_checklist_items').get() as { id: string };

      const result = await callTool(server, 'waive_checklist_item', { itemId: row.id, reason: '   ' });

      expect(result.isError).toBe(true);
      const waived = (testDb.prepare('SELECT waived FROM spec_checklist_items WHERE id = ?').get(row.id) as { waived: number }).waived;
      expect(waived).toBe(0);
    });

    it('sets waived + reason and writes a [WAIVE] output line', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [MISSING_ITEM] });
      const row = testDb.prepare('SELECT id FROM spec_checklist_items').get() as { id: string };

      const result = await callTool(server, 'waive_checklist_item', { itemId: row.id, reason: '使用者確認 Phase 2 再做' });
      expect(result.isError).toBeUndefined();

      const item = testDb.prepare('SELECT waived, waive_reason FROM spec_checklist_items WHERE id = ?').get(row.id) as { waived: number; waive_reason: string };
      expect(item.waived).toBe(1);
      expect(item.waive_reason).toBe('使用者確認 Phase 2 再做');

      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content.startsWith('[WAIVE] 不存在的文字: 使用者確認 Phase 2 再做'))).toBe(true);
    });

    it('is idempotent — second waive returns already-waived without a second [WAIVE] line', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [MISSING_ITEM] });
      const row = testDb.prepare('SELECT id FROM spec_checklist_items').get() as { id: string };

      await callTool(server, 'waive_checklist_item', { itemId: row.id, reason: 'r1' });
      const second = await callTool(server, 'waive_checklist_item', { itemId: row.id, reason: 'r2' });
      expect(second.isError).toBeUndefined();
      expect(second.content[0].text).toContain('already waived');

      const waiveLines = (testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>)
        .filter(o => o.content.startsWith('[WAIVE]'));
      expect(waiveLines).toHaveLength(1);
      // reason unchanged
      const item = testDb.prepare('SELECT waive_reason FROM spec_checklist_items WHERE id = ?').get(row.id) as { waive_reason: string };
      expect(item.waive_reason).toBe('r1');
    });

    it('returns error for unknown itemId', async () => {
      const result = await callTool(server, 'waive_checklist_item', { itemId: 'nope', reason: 'r' });
      expect(result.isError).toBe(true);
    });
  });

  describe('run_spec_compliance', () => {
    it('writes a run row, [SPEC_COMPLIANCE] output and milestone notify', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM, MISSING_ITEM] });

      const result = await callTool(server, 'run_spec_compliance', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.summary).toMatchObject({ total: 2, matched: 1, missing: 1, autoTotal: 2 });
      // missing items sorted first
      expect(data.items[0].status).toBe('missing');

      const run = testDb.prepare('SELECT * FROM spec_compliance_runs WHERE task_id = ?').get('task-1') as Record<string, unknown>;
      expect(run).toMatchObject({ total: 2, matched: 1, missing: 1, source: 'engine' });
      expect(JSON.parse(run['results_json'] as string)).toHaveLength(2);

      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content === '[SPEC_COMPLIANCE] 1/2 符合（missing 1）')).toBe(true);

      expect(notifyWebServer).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.milestone',
        data: expect.objectContaining({ milestone: '規格回對：1/2' }),
      }));
    });

    it('includes runtimeCheckPlan for matched ui_text items', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });

      const data = JSON.parse((await callTool(server, 'run_spec_compliance', { taskId: 'task-1' })).content[0].text);
      expect(data.runtimeCheckPlan).not.toBeNull();
      expect(data.runtimeCheckPlan.instruction).toContain('Playwright');
      expect(data.runtimeCheckPlan.instruction).toContain('report_verification_evidence');
      expect(data.runtimeCheckPlan.uiTexts).toEqual(['代理人設定作業']);
    });

    it('returns guidance (not error) when the task has no checklist', async () => {
      seedProject(testDb);
      seedTask(testDb);
      const result = await callTool(server, 'run_spec_compliance', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('save_spec_checklist');
    });

    it('errors when the workspace path does not exist', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path) VALUES ('proj-x', 'P', '/tmp/x', ?)`)
        .run(path.join(feRoot, 'does-not-exist'));
      seedTask(testDb, 'task-x', 'proj-x', 'frontend');
      await callTool(server, 'save_spec_checklist', { taskId: 'task-x', items: [UI_ITEM] });

      const result = await callTool(server, 'run_spec_compliance', { taskId: 'task-x' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('路徑不存在');
    });

    it('errors when the project has no scannable workspace path for the label', async () => {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-n', 'P', '/tmp/n')`).run();
      seedTask(testDb, 'task-n', 'proj-n', 'backend');
      await callTool(server, 'save_spec_checklist', { taskId: 'task-n', items: [{ itemType: 'db_field', content: 'A_COL', side: 'backend' }] });

      const result = await callTool(server, 'run_spec_compliance', { taskId: 'task-n' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('workspace');
    });

    it('marks the response as advisory 預檢 and points to get_compliance_review_plan', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });

      const text = (await callTool(server, 'run_spec_compliance', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('程式預檢');
      expect(text).toContain('不解鎖完成閘門');
      // 回應是 JSON.stringify 過的，引號會被跳脫
      expect(text).toContain('get_compliance_review_plan(taskId=\\"task-1\\")');
    });
  });

  describe('get_compliance_review_plan', () => {
    function itemIds(taskId = 'task-1'): Array<{ id: string; content: string }> {
      return testDb.prepare('SELECT id, content FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(taskId) as Array<{ id: string; content: string }>;
    }

    it('returns guidance (not error) when the task has no non-waived checklist items', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('save_spec_checklist');

      // All-waived is the same: nothing to review
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      await callTool(server, 'waive_checklist_item', { itemId: itemIds()[0].id, reason: 'Phase 2' });
      const result2 = await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' });
      expect(result2.isError).toBeUndefined();
      expect(result2.content[0].text).toContain('save_spec_checklist');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_compliance_review_plan', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });

    it('returns a full dispatch plan: independent reviewer, per-item evidence, logic verification, spec doc paths', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare(`INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES ('doc-1', 'proj-1', 'SPEC_WA05.md', '/specs/SPEC_WA05.md', 'SA')`).run();
      await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1',
        items: [UI_ITEM, { itemType: 'logic', content: '查詢結果依建立日期倒序' }],
      });

      const result = await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      // 給 orchestrator：獨立 reviewer，不可 implementer 自評
      expect(text).toContain('獨立的 AI 回對 subagent');
      expect(text).toContain('絕不可由寫 code 的 implementer 自評');
      // workspace + 規格文件路徑
      expect(text).toContain(feRoot);
      expect(text).toContain('/specs/SPEC_WA05.md');
      // reviewer prompt：讀規格 → get_spec_checklist（分頁看完全部）→ 逐項驗證（logic 必驗）→ 證據 → save_compliance_review
      expect(text).toContain(`get_spec_checklist(taskId="task-1", limit=50, offset=0)`);
      expect(text).toContain('hasMore=false');
      expect(text).toContain('logic');
      expect(text).toContain('不可跳過');
      expect(text).toContain('evidence');
      expect(text).toContain(`save_compliance_review(taskId="task-1"`);
      // 寧嚴勿鬆 + 嚴禁只看回報
      expect(text).toContain('寧嚴勿鬆');
      expect(text).toContain('必須自己用 Read/Grep 開檔案核對');
      // N2：反向完整性掃描（full 掃 SA/SD 規格原文）+ 證據會被程式驗證的警告
      expect(text).toContain('反向掃描規格原文');
      expect(text).toContain('反向掃描無遺漏');
      expect(text).toContain('每筆 evidence 會被程式驗證');
      expect(text).toContain('整批退回');
      // P2：反向掃描補項同守 ui_text 抽取規範
      expect(text).toContain('禁止存 ui_text——存 logic');
      // P1：回寫閉環（save_compliance_review 之後記錄可重用元件級事實）
      expect(text).toContain('save_project_note(projectId="proj-1", category="component"');
      expect(text).toContain('無出處的觀察不記');
      // full 軌（無 track 記錄）不得出現 light 內容
      expect(text).not.toContain('LIGHT 軌');
      expect(text).not.toContain('原始 BUG 內容');
    });

    it('light 軌任務：驗證對象為原始 BUG 內容（含 title/description 與 BUG 現場工具指示），標準照舊', async () => {
      seedProject(testDb);
      seedTask(testDb);
      // get_execution_plan 判軌後寫入 flow_state.track（此處直接模擬）
      testDb.prepare(`UPDATE tasks SET flow_state = ? WHERE id = 'task-1'`).run(
        JSON.stringify({ roles: {}, track: 'light', trackReason: '自動判定：taskType=bug 且無 SA/SD 規格文件' }),
      );
      await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1',
        items: [{ itemType: 'logic', content: '計劃部門查詢欄位輸入值後查詢，結果正確過濾' }],
      });

      const result = await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      // light 軌標示 + 驗證對象 = 原始 BUG 內容（plan 直接附任務 title/description）
      expect(text).toContain('LIGHT 軌');
      expect(text).toContain('驗證對象（light 軌）：原始 BUG 內容');
      expect(text).toContain('WA05 代理人設定'); // task title
      expect(text).toContain('desc');            // task description
      // reviewer 取得完整 bug 現場的工具指示
      expect(text).toContain('get_asana_task_comments(taskId="task-1")');
      expect(text).toContain('fetch_task_attachments(projectId="proj-1", taskId="task-1")');
      // 逐項驗證「程式碼修改是否真的達成每個預期行為」+ Playwright 實測建議
      expect(text).toContain('修復後預期行為');
      expect(text).toContain('Playwright');
      // 不再要求讀 SA/SD 規格原文
      expect(text).not.toContain('讀規格原文');
      // N2：反向完整性掃描改掃 BUG 原文 + 證據會被程式驗證的警告
      expect(text).toContain('反向掃描 BUG 原文');
      expect(text).toContain('反向掃描無遺漏');
      expect(text).toContain('每筆 evidence 會被程式驗證');
      expect(text).not.toContain('反向掃描規格原文');
      // P2：補項同守 ui_text 抽取規範；P1：回寫閉環（兩軌共用 commonTail）
      expect(text).toContain('禁止存 ui_text——存 logic');
      expect(text).toContain('save_project_note(projectId="proj-1", category="component"');
      // 證據要求、涵蓋要求、寧嚴勿鬆、獨立 reviewer 全部照舊
      expect(text).toContain('evidence');
      expect(text).toContain('必須涵蓋所有未豁免項目');
      expect(text).toContain('寧嚴勿鬆');
      expect(text).toContain('絕不可由寫 code 的 implementer 自評');
      expect(text).toContain('必須自己用 Read/Grep 開檔案核對');
      expect(text).toContain(`save_compliance_review(taskId="task-1"`);
    });

    it('P1: injects active category=component notes only (no other categories, no archived); absent when none', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });

      // 無 component notes → 整節不出現（回寫步驟照樣存在）
      const before = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(before).not.toContain('## 元件知識庫');
      expect(before).toContain('save_project_note(projectId="proj-1", category="component"');

      testDb.prepare(`INSERT INTO project_notes (id, project_id, category, content) VALUES ('n-comp', 'proj-1', 'component', '共用表頭元件 PageHeader.tsx 會自動加「作業」字尾')`).run();
      testDb.prepare(`INSERT INTO project_notes (id, project_id, category, content) VALUES ('n-pit', 'proj-1', 'pitfall', '大表禁 findAll')`).run();
      testDb.prepare(`INSERT INTO project_notes (id, project_id, category, content, active) VALUES ('n-arch', 'proj-1', 'component', '已封存的元件事實', 0)`).run();

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('## 元件知識庫');
      expect(text).toContain('PageHeader.tsx');
      // 框架文字：降低追查成本 + 不是免驗證通行證
      expect(text).toContain('證據在哪個元件檔');
      expect(text).toContain('這不是免驗證通行證');
      expect(text).toContain('重查並更新筆記');
      // 只注入 component 分類；封存的不注入
      expect(text).not.toContain('大表禁 findAll');
      expect(text).not.toContain('已封存的元件事實');
    });

    it('P1: component notes are budget-capped — 超量筆記截斷並附提示，防線文字不被擠出', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      // 塞爆預算（4000 字元）：10 筆各 ~600 字元
      for (let i = 0; i < 10; i++) {
        testDb.prepare(`INSERT INTO project_notes (id, project_id, category, content) VALUES (?, 'proj-1', 'component', ?)`)
          .run(`n-big-${i}`, `元件事實 ${i}：${'很長的說明'.repeat(120)}`);
      }

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('## 元件知識庫');
      expect(text).toContain('元件事實 0'); // 最早的筆記有進
      expect(text).toContain('筆記已達大小上限截斷');
      expect(text).not.toContain('元件事實 9'); // 超出預算的沒進
      // 預算生效 → plan 尾端的防線文字沒被 truncateResponse 擠掉
      expect(text).toContain('不得呼叫 update_task_status');
    });

    it('分頁指示與縮頁行為一致：以本頁 count 遞增 offset，不假設固定 50 筆', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('offset += 本頁回傳的 count');
      expect(text).toContain('不可假設每頁固定 50 筆');
      expect(text).not.toContain('0、50、100');
    });

    it('P1: latest engine run seeds matched evidence (file:line) into the plan; absent without a run', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM, MISSING_ITEM] });

      const before = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(before).not.toContain('引擎預檢種子');

      await callTool(server, 'run_spec_compliance', { taskId: 'task-1' }); // UI_ITEM matched at src/Index.tsx:1
      const after = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(after).toContain('## 引擎預檢種子');
      expect(after).toContain('src/Index.tsx:1');
      expect(after).toContain('[ui_text] 代理人設定作業');
      // 種子只是起點：仍須自己開檔確認、時間集中在 missing/manual/logic
      expect(after).toContain('引擎 missing / manual / logic');
      expect(after).not.toContain('不存在的文字 →'); // engine missing 的項目不進種子
    });

    it('P1: light 軌 plan 也注入元件知識庫與引擎種子', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare(`UPDATE tasks SET flow_state = ? WHERE id = 'task-1'`).run(
        JSON.stringify({ roles: {}, track: 'light', trackReason: '自動判定' }),
      );
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      testDb.prepare(`INSERT INTO project_notes (id, project_id, category, content) VALUES ('n-comp', 'proj-1', 'component', '共用查詢列元件 SearchBar.tsx 一列兩欄')`).run();
      await callTool(server, 'run_spec_compliance', { taskId: 'task-1' });

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('LIGHT 軌');
      expect(text).toContain('## 元件知識庫');
      expect(text).toContain('SearchBar.tsx');
      expect(text).toContain('## 引擎預檢種子');
      expect(text).toContain('src/Index.tsx:1');
    });
  });

  describe('save_compliance_review', () => {
    async function seedChecklist(items = [UI_ITEM, { itemType: 'logic', content: '依建立日期倒序' }]) {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items });
      return testDb.prepare('SELECT id, content, item_type, waived FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all('task-1') as Array<{ id: string; content: string; item_type: string; waived: number }>;
    }

    it('writes an ai_review run with counts, [SPEC_REVIEW] output and milestone notify', async () => {
      const rows = await seedChecklist();

      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [
          { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }], note: '標題渲染於 h1' },
          { itemId: rows[1].id, status: 'missing', note: 'Service 排序用 ASC，與規格倒序不符' },
        ],
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('missing');
      expect(result.content[0].text).toContain('重新執行 AI 回對');
      expect(result.content[0].text).toContain('依建立日期倒序');

      const run = testDb.prepare('SELECT * FROM spec_compliance_runs WHERE task_id = ?').get('task-1') as Record<string, unknown>;
      expect(run).toMatchObject({ total: 2, matched: 1, missing: 1, manual: 0, waived: 0, source: 'ai_review' });
      const results = JSON.parse(run['results_json'] as string) as Array<{ itemId: string; status: string; evidence?: unknown }>;
      expect(results).toHaveLength(2);
      expect(results.find(r => r.itemId === rows[0].id)?.status).toBe('matched');

      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content === '[SPEC_REVIEW] 1/2 符合（missing 1）')).toBe(true);

      expect(notifyWebServer).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.milestone',
        data: expect.objectContaining({ milestone: 'AI 規格回對：1/2' }),
      }));
      expect(notifyWebServer).toHaveBeenCalledWith(expect.objectContaining({
        event: 'task.checklistSaved',
        data: expect.objectContaining({ taskId: 'task-1', action: 'ai_review' }),
      }));
    });

    it('missing=0 unlocks: success message says the gate is open; waived items recorded from the table', async () => {
      const rows = await seedChecklist([UI_ITEM, MISSING_ITEM]);
      await callTool(server, 'waive_checklist_item', { itemId: rows[1].id, reason: 'Phase 2' });

      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('missing=0');
      expect(result.content[0].text).toContain('完成閘門已解鎖');

      const run = testDb.prepare('SELECT * FROM spec_compliance_runs WHERE task_id = ?').get('task-1') as Record<string, unknown>;
      expect(run).toMatchObject({ total: 2, matched: 1, missing: 0, manual: 0, waived: 1, source: 'ai_review' });
      const results = JSON.parse(run['results_json'] as string) as Array<{ status: string }>;
      expect(results.filter(r => r.status === 'waived')).toHaveLength(1);
    });

    it('rejects when non-waived items are not covered, listing the missed ids/contents', async () => {
      const rows = await seedChecklist();

      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('未判定');
      expect(result.content[0].text).toContain(rows[1].id);
      expect(result.content[0].text).toContain('依建立日期倒序');
      // 不寫 run
      const count = (testDb.prepare('SELECT COUNT(*) as c FROM spec_compliance_runs WHERE task_id = ?').get('task-1') as { c: number }).c;
      expect(count).toBe(0);
    });

    it('rejects matched without evidence', async () => {
      const rows = await seedChecklist([UI_ITEM]);

      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [{ itemId: rows[0].id, status: 'matched' }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('evidence');
      expect(result.content[0].text).toContain('寧嚴勿鬆');
    });

    it('rejects itemIds that do not belong to the task', async () => {
      const rows = await seedChecklist([UI_ITEM]);
      seedTask(testDb, 'task-2');
      await callTool(server, 'save_spec_checklist', { taskId: 'task-2', items: [MISSING_ITEM] });
      const otherId = (testDb.prepare("SELECT id FROM spec_checklist_items WHERE task_id = 'task-2'").get() as { id: string }).id;

      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [
          { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
          { itemId: otherId, status: 'missing' },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('不屬於');
      expect(result.content[0].text).toContain(otherId);
    });

    it('rejects duplicate itemIds in results', async () => {
      const rows = await seedChecklist([UI_ITEM]);

      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [
          { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
          { itemId: rows[0].id, status: 'missing' },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('重複');
    });

    it('rejects more than 500 results in one call', async () => {
      const results = Array.from({ length: 501 }, () => ({ itemId: crypto.randomUUID(), status: 'missing' }));
      const result = await callTool(server, 'save_compliance_review', { taskId: 'task-1', results });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('500');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'save_compliance_review', {
        taskId: 'nope',
        results: [{ itemId: 'x', status: 'missing' }],
      });
      expect(result.isError).toBe(true);
    });

    describe('evidence program validation (N1)', () => {
      it('rejects the whole batch when an evidence file does not exist — no run written', async () => {
        const rows = await seedChecklist([UI_ITEM]);

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Nope.tsx', line: 1 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('未通過程式驗證');
        expect(result.content[0].text).toContain('整批拒收');
        expect(result.content[0].text).toContain('檔案不存在');
        expect(result.content[0].text).toContain('src/Nope.tsx:1');
        expect(result.content[0].text).toContain('i18n'); // 引用指引
        const count = (testDb.prepare('SELECT COUNT(*) as c FROM spec_compliance_runs WHERE task_id = ?').get('task-1') as { c: number }).c;
        expect(count).toBe(0);
      });

      it('rejects out-of-range line numbers', async () => {
        const rows = await seedChecklist([UI_ITEM]);

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 999 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('行號超界');
      });

      it('rejects evidence whose ±10-line window does not contain the content', async () => {
        const rows = await seedChecklist([{ itemType: 'ui_text', content: '窗口測試目標文字', side: 'frontend' }]);

        // 文字在 Long.tsx 第 1 行，證據引第 30 行 → 窗口 20~40 找不到
        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Long.tsx', line: 30 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('找不到文字');
        // 引對行就通過
        const ok = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Long.tsx', line: 1 }] }],
        });
        expect(ok.isError).toBeUndefined();
      });

      it('logic items skip the relevance check (file + line validity only)', async () => {
        const rows = await seedChecklist([{ itemType: 'logic', content: '查詢結果依建立日期倒序', side: 'frontend' }]);

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Long.tsx', line: 30 }], note: '排序邏輯確認' }],
        });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('missing=0');
      });

      it('skips validation with a note when the project has no workspace paths', async () => {
        testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-w', 'P', '/tmp/w')`).run();
        seedTask(testDb, 'task-w', 'proj-w', 'frontend');
        await callTool(server, 'save_spec_checklist', { taskId: 'task-w', items: [UI_ITEM] });
        const row = testDb.prepare("SELECT id FROM spec_checklist_items WHERE task_id = 'task-w'").get() as { id: string };

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-w',
          results: [{ itemId: row.id, status: 'matched', evidence: [{ file: 'src/Whatever.tsx', line: 1 }] }],
        });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('證據未經程式驗證');
        const count = (testDb.prepare('SELECT COUNT(*) as c FROM spec_compliance_runs WHERE task_id = ?').get('task-w') as { c: number }).c;
        expect(count).toBe(1);
      });
    });

    describe('engine × AI discrepancy detection (N3)', () => {
      it('marks engineStatus on discrepant items and lists them in the response (both directions)', async () => {
        const rows = await seedChecklist([UI_ITEM, MISSING_ITEM]);
        // 造 engine run：UI_ITEM=missing（AI 將判 matched → 分歧）、MISSING_ITEM=matched（AI 將判 missing → 分歧）
        testDb.prepare(`
          INSERT INTO spec_compliance_runs (id, task_id, total, matched, missing, manual, waived, results_json, source)
          VALUES ('run-engine', 'task-1', 2, 1, 1, 0, 0, ?, 'engine')
        `).run(JSON.stringify([
          { itemId: rows[0].id, itemType: 'ui_text', content: rows[0].content, status: 'missing' },
          { itemId: rows[1].id, itemType: 'ui_text', content: rows[1].content, status: 'matched' },
        ]));

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'missing', note: '找不到' },
          ],
        });
        expect(result.isError).toBeUndefined();
        const text = result.content[0].text;
        expect(text).toContain('分歧 2 項');
        expect(text).toContain('抽查的優先靶點');
        expect(text).toContain('程式預檢=missing / AI=matched');
        expect(text).toContain('程式預檢=matched / AI=missing');

        // results_json 保持陣列形狀，分歧項帶 engineStatus
        const run = testDb.prepare("SELECT results_json FROM spec_compliance_runs WHERE task_id = 'task-1' AND source = 'ai_review'").get() as { results_json: string };
        const items = JSON.parse(run.results_json) as Array<{ itemId: string; status: string; engineStatus?: string }>;
        expect(Array.isArray(items)).toBe(true);
        expect(items.find(i => i.itemId === rows[0].id)?.engineStatus).toBe('missing');
        expect(items.find(i => i.itemId === rows[1].id)?.engineStatus).toBe('matched');
      });

      it('agreeing items get no engineStatus; latest engine run wins', async () => {
        const rows = await seedChecklist([UI_ITEM]);
        // 真實 engine run（UI_ITEM=matched）——與 AI 一致，不算分歧
        await callTool(server, 'run_spec_compliance', { taskId: 'task-1' });

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).not.toContain('分歧');

        const run = testDb.prepare("SELECT results_json FROM spec_compliance_runs WHERE task_id = 'task-1' AND source = 'ai_review'").get() as { results_json: string };
        const items = JSON.parse(run.results_json) as Array<Record<string, unknown>>;
        expect(items.every(i => !('engineStatus' in i))).toBe(true);
      });

      it('no engine run → no crash, no engineStatus, no discrepancy section', async () => {
        const rows = await seedChecklist([UI_ITEM]);

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('missing=0');
        expect(result.content[0].text).not.toContain('分歧');

        const run = testDb.prepare("SELECT results_json FROM spec_compliance_runs WHERE task_id = 'task-1' AND source = 'ai_review'").get() as { results_json: string };
        const items = JSON.parse(run.results_json) as Array<Record<string, unknown>>;
        expect(items.every(i => !('engineStatus' in i))).toBe(true);
      });
    });
  });
});
