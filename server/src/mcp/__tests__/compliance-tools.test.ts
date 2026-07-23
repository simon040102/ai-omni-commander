import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(true),
}));

// task-tools（真實閘門測試用）在 module top-level import svn-status——mock 掉避免碰真實 svn CLI
vi.mock('../svn-status.js', () => ({
  getSvnCredentials: vi.fn().mockReturnValue({ username: 'user', password: 'pass' }),
  isSvnCliAvailable: vi.fn().mockReturnValue(true),
  fetchRemoteLastModified: vi.fn().mockReturnValue(null),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerComplianceTools } from '../tools/compliance-tools.js';
import { registerTaskTools } from '../tools/task-tools.js';
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
      // 模型政策：reviewer 一律建議 opus（與主 session 脫鉤）
      expect(text).toContain('model: "opus"');
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
      expect(text).toContain('無出處不記');
      // 必要性門檻：回寫非必要、流水帳不記、去時間/任務/commit 後還成立才記
      expect(text).toContain('沒有值得記的就不要記');
      expect(text).toContain('流水帳');
      // 回寫紀律收緊：先對照已注入知識庫、只記新事實、過時 archive
      expect(text).toContain('先對照上方已注入的「元件知識庫」區塊');
      expect(text).toContain('只記「新的、現有筆記沒涵蓋」的事實');
      expect(text).toContain('archive_project_note');
      expect(text).toContain('既有筆記已過時');
      // 合約反向對齊（step 4b，full 軌限定）：枚舉程式欄位 → report_spec_gap(field_undefined)
      expect(text).toContain('合約反向對齊');
      expect(text).toContain('枚舉程式欄位');
      expect(text).toContain('report_spec_gap(taskId="task-1", category="field_undefined"');
      expect(text).toContain('基礎設施雜訊');
      expect(text).toContain('advisory，不進閘門');
      expect(text).toContain('不影響本次 matched/missing 判定與結案');
      expect(text).toContain('規格模糊就略過');
      // 只做欄位維度，絕不 ui_text/logic 反向
      expect(text).toContain('絕不對 ui_text / logic 做反向對齊');
      // 與步驟 4「反向掃描規格原文」是兩個不同方向，都保留
      expect(text).toContain('反向掃描規格原文');
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
      // 合約反向對齊為 full 軌限定——light 軌無 SA/SD 規格文件，不做
      expect(text).not.toContain('合約反向對齊');
      expect(text).not.toContain('category="field_undefined"');
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

    it('合約反向對齊（code→spec 欄位）：full 軌步驟含枚舉程式欄位/field_undefined/雜訊排除/advisory/規格模糊略過；與 spec→checklist 反向掃描措辭區隔', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1',
        items: [{ itemType: 'api', content: 'POST /api/wa05/save', side: 'frontend' }],
      });

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      // 步驟存在且方向明確（code→spec，開缺口）
      expect(text).toContain('合約反向對齊（code→spec 欄位');
      expect(text).toContain('枚舉程式欄位回頭開缺口（code→spec）');
      // 產出走既有 report_spec_gap，category=field_undefined（既有欄位未定義類別，非新字串）
      expect(text).toContain('report_spec_gap(taskId="task-1", category="field_undefined"');
      expect(text).toContain('過度實作（該移除）還是規格待補');
      // 只做欄位維度，絕不 ui_text/logic 反向
      expect(text).toContain('只做欄位維度（param / response_field / db_field）');
      expect(text).toContain('絕不對 ui_text / logic 做反向對齊');
      // 基礎設施雜訊排除（含 MetaData 系統共用欄位）
      expect(text).toContain('基礎設施雜訊一律排除');
      expect(text).toContain('CREATE_DATE/MODIFY_DATE/DATA_REMARK');
      expect(text).toContain('page/size/offset/limit');
      // advisory 不進閘門
      expect(text).toContain('advisory，不進閘門');
      expect(text).toContain('不影響本次 matched/missing 判定與結案');
      // 規格模糊略過（前提限制）
      expect(text).toContain('規格模糊就略過');
      expect(text).toContain('略過反向對齊');
      // 與步驟 4「反向掃描規格原文」（spec→checklist）措辭區隔：兩個方向都在，不混淆
      expect(text).toContain('這步方向與步驟 4 相反');
      expect(text).toContain('反向掃描規格原文');
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

    describe('增量重審段（S1 配套）', () => {
      /** 全量第一輪：rows[0] matched（真實證據）、其餘 missing */
      async function seedFirstReview(extraMissingNote = '排序方向不符') {
        await callTool(server, 'save_spec_checklist', {
          taskId: 'task-1',
          items: [UI_ITEM, { itemType: 'logic', content: '依建立日期倒序' }],
        });
        const rows = itemIds();
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'missing', note: extraMissingNote },
          ],
        });
        return rows;
      }

      it('首輪回對（無 ai_review run，只有 engine 預檢）→ plan 完全無增量段', async () => {
        seedProject(testDb);
        seedTask(testDb);
        await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
        await callTool(server, 'run_spec_compliance', { taskId: 'task-1' });

        const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
        expect(text).not.toContain('增量重審');
        expect(text).not.toContain('carryForward');
      });

      it('上輪 ai_review missing>0 → plan 含增量段：上輪 missing 清單 + staleness 新增項 + carryForward/revalidationFailed 指示', async () => {
        seedProject(testDb);
        seedTask(testDb);
        const rows = await seedFirstReview();
        // 把上輪 run 回溯一小時，再新增檢查項 → staleness 項（created_at 嚴格晚於 run_at）
        testDb.prepare("UPDATE spec_compliance_runs SET run_at = datetime('now', '-1 hour') WHERE task_id = 'task-1'").run();
        await callTool(server, 'save_spec_checklist', {
          taskId: 'task-1',
          items: [{ itemType: 'ui_text', content: '事後新增文字' }],
        });

        const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
        expect(text).toContain('## 增量重審');
        expect(text).toContain('missing=1');
        // 上輪 missing 項清單（itemId + content + note 摘要）
        expect(text).toContain(rows[1].id);
        expect(text).toContain('依建立日期倒序');
        expect(text).toContain('排序方向不符');
        // staleness 新增項
        expect(text).toContain('staleness');
        expect(text).toContain('事後新增文字');
        // 寫回指示：carryForward + revalidationFailed 補判重提
        expect(text).toContain('save_compliance_review(taskId="task-1", carryForward=true');
        expect(text).toContain('只提交你重判的項目');
        expect(text).toContain('revalidationFailed');
        // orchestrator 指示也有增量段
        expect(text).toContain('> 5. 本次為**增量重審**');
        // 標準不放寬
        expect(text).toContain('不是放寬');
      });

      it('上輪 ai_review missing=0 → 無增量段（乾淨前輪不需要重審指示）', async () => {
        seedProject(testDb);
        seedTask(testDb);
        await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
        const rows = itemIds();
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });

        const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
        expect(text).not.toContain('## 增量重審');
      });

      it('上輪 run 之後檢查表被整份取代（[CHECKLIST_REPLACE]）→ 無增量段，走全量（與 save_compliance_review 拒絕條件一致）', async () => {
        seedProject(testDb);
        seedTask(testDb);
        await seedFirstReview();
        await callTool(server, 'save_spec_checklist', {
          taskId: 'task-1',
          items: [{ itemType: 'ui_text', content: '重抽後的新項', side: 'frontend' }],
          replace: true,
        });

        const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
        expect(text).not.toContain('## 增量重審');
        expect(text).not.toContain('carryForward=true');
      });

      it('light 軌 plan 也帶增量段（missing>0 前輪）', async () => {
        seedProject(testDb);
        seedTask(testDb);
        testDb.prepare(`UPDATE tasks SET flow_state = ? WHERE id = 'task-1'`).run(
          JSON.stringify({ roles: {}, track: 'light', trackReason: '自動判定' }),
        );
        await seedFirstReview();

        const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
        expect(text).toContain('LIGHT 軌');
        expect(text).toContain('## 增量重審');
        expect(text).toContain('save_compliance_review(taskId="task-1", carryForward=true');
      });
    });
  });

  describe('get_compliance_review_plan — SA 流程圖回對（R3）', () => {
    let tmpDataDir: string;
    let savedDbPath: string | undefined;

    const SA_CONTENT = '# SA 規格 WA05 代理人設定\n查詢作業流程：輸入條件後查詢，依有無資料決定顯示清單或查無資料訊息。';
    const SA_FLOW_MMD = 'flowchart TD\n  A[輸入查詢條件] --> B{有無資料}\n  B -->|有| C[顯示清單]\n  B -->|無| D[顯示查無資料]';

    beforeEach(() => {
      // SA flow cache 依 DB_PATH 解析 data/sa-flows —— 指向隔離 temp dir
      tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-saflow-'));
      savedDbPath = process.env['DB_PATH'];
      process.env['DB_PATH'] = path.join(tmpDataDir, 'omni.db');
    });

    afterEach(() => {
      if (savedDbPath === undefined) delete process.env['DB_PATH'];
      else process.env['DB_PATH'] = savedDbPath;
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    });

    /** 綁 SA 文件到任務 + 寫入內容 hash 對應的 sa-flows cache 檔（沿用 ExecutionPipeline 命名慣例） */
    function seedSaDocWithFlow(content = SA_CONTENT, mermaid = SA_FLOW_MMD) {
      testDb.prepare(`
        INSERT INTO documents (id, project_id, filename, file_path, doc_type, parsed_text)
        VALUES ('doc-sa', 'proj-1', 'SPEC_WA05.md', '/nonexistent/SPEC_WA05.md', 'SA', ?)
      `).run(content);
      testDb.prepare("INSERT INTO task_documents (task_id, document_id) VALUES ('task-1', 'doc-sa')").run();
      const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
      const flowsDir = path.join(tmpDataDir, 'sa-flows');
      fs.mkdirSync(flowsDir, { recursive: true });
      fs.writeFileSync(path.join(flowsDir, `proj-1-${hash}-flow.mmd`), mermaid, 'utf-8');
    }

    it('full 軌 + 有 SA flow → 注入「流程回對」節：mermaid 內嵌 + logic 補項指示 + 缺路徑判 missing', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      seedSaDocWithFlow();

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('## 流程回對（SA 流程圖 → 程式路徑）');
      expect(text).toContain('輸入查詢條件'); // mermaid 內嵌
      expect(text).toContain('itemType="logic"');
      expect(text).toContain('sourceRef="SA flow SPEC_WA05.md"');
      expect(text).toContain('**append，不可用 replace**');
      expect(text).toContain('找不到對應程式路徑的分支判 missing');
      // 節位在絕對禁止之前（仍是 reviewer prompt 的一部分）
      expect(text.indexOf('## 流程回對')).toBeLessThan(text.indexOf('## 絕對禁止'));
    });

    it('mermaid 超過內嵌上限 → 改附檔案絕對路徑（不內嵌）', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      const hugeMermaid = 'flowchart TD\n' + Array.from({ length: 500 }, (_, i) => `  N${i}[節點編號第${i}步驟] --> N${i + 1}`).join('\n');
      expect(hugeMermaid.length).toBeGreaterThan(6000);
      seedSaDocWithFlow(SA_CONTENT, hugeMermaid);

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('## 流程回對（SA 流程圖 → 程式路徑）');
      expect(text).toContain('未內嵌');
      expect(text).toContain('sa-flows'); // 附檔案路徑
      expect(text).not.toContain('N499'); // mermaid 本體不內嵌
    });

    it('light 軌 → 整節不出現（即使 SA flow 存在）', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare(`UPDATE tasks SET flow_state = ? WHERE id = 'task-1'`).run(
        JSON.stringify({ roles: {}, track: 'light', trackReason: '自動判定' }),
      );
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      seedSaDocWithFlow();

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('LIGHT 軌');
      expect(text).not.toContain('## 流程回對');
    });

    it('無 SA flow cache（SA 文件存在但沒產生過流程圖）→ 整節不出現', async () => {
      seedProject(testDb);
      seedTask(testDb);
      await callTool(server, 'save_spec_checklist', { taskId: 'task-1', items: [UI_ITEM] });
      testDb.prepare(`
        INSERT INTO documents (id, project_id, filename, file_path, doc_type, parsed_text)
        VALUES ('doc-sa', 'proj-1', 'SPEC_WA05.md', '/nonexistent/SPEC_WA05.md', 'SA', ?)
      `).run(SA_CONTENT);
      testDb.prepare("INSERT INTO task_documents (task_id, document_id) VALUES ('task-1', 'doc-sa')").run();

      const text = (await callTool(server, 'get_compliance_review_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).not.toContain('## 流程回對');
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

    describe('carryForward 增量回對 (S1)', () => {
      function aiRuns(taskId = 'task-1') {
        return testDb.prepare(
          "SELECT * FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review' ORDER BY run_at ASC, rowid ASC"
        ).all(taskId) as Array<{ id: string; matched: number; missing: number; results_json: string }>;
      }

      it('上輪 matched + 證據仍有效 → 自動沿用（carriedForward=true 計入涵蓋）；上輪 missing 本次重判 matched → run 反映', async () => {
        const rows = await seedChecklist(); // [UI_ITEM(matched-able), logic 依建立日期倒序]
        // 第一輪（全量）：A matched、B missing
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }], note: '標題渲染於 h1' },
            { itemId: rows[1].id, status: 'missing', note: '排序未實作' },
          ],
        });

        // 第二輪（增量）：只提交上輪 missing 的 B（判 matched）——A 不提交，由程式重驗沿用
        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }], note: '排序已修' }],
        });
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toContain('missing=0');
        expect(result.content[0].text).toContain('沿用上輪判定');
        expect(result.content[0].text).toContain('1 項沿用');

        const runs = aiRuns();
        expect(runs).toHaveLength(2);
        expect(runs[1]).toMatchObject({ matched: 2, missing: 0 });
        // results_json 保持陣列形狀，沿用項與重判項並列，沿用項多 carriedForward 欄位
        const items = JSON.parse(runs[1].results_json) as Array<{ itemId: string; status: string; evidence?: Array<{ file: string; line: number }>; carriedForward?: boolean }>;
        expect(Array.isArray(items)).toBe(true);
        const carried = items.find(i => i.itemId === rows[0].id)!;
        expect(carried.status).toBe('matched');
        expect(carried.carriedForward).toBe(true);
        expect(carried.evidence).toEqual([{ file: 'src/Index.tsx', line: 1 }]); // 沿用原證據
        const rejudged = items.find(i => i.itemId === rows[1].id)!;
        expect(rejudged.status).toBe('matched');
        expect(rejudged.carriedForward).toBeUndefined();
      });

      it('上輪證據已失效（改檔案內容使 ±10 行不再含目標）→ revalidationFailed 整批拒收、不寫 run', async () => {
        const mutPath = path.join(feRoot, 'src', 'Mutable.tsx');
        fs.writeFileSync(mutPath, '<h1>沿用重驗目標文字</h1>\n', 'utf-8');
        try {
          const rows = await seedChecklist([
            { itemType: 'ui_text', content: '沿用重驗目標文字', side: 'frontend' },
            { itemType: 'logic', content: '修復後預期行為' },
          ]);
          // 第一輪：M matched（Mutable.tsx:1）、L missing
          await callTool(server, 'save_compliance_review', {
            taskId: 'task-1',
            results: [
              { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Mutable.tsx', line: 1 }] },
              { itemId: rows[1].id, status: 'missing' },
            ],
          });
          // implementer 改了檔案：目標文字消失（±10 行窗口不再命中）
          fs.writeFileSync(
            mutPath,
            ['// 文字已被移除', ...Array.from({ length: 25 }, (_, i) => `const y_${i} = ${i};`)].join('\n'),
            'utf-8',
          );

          // 第二輪（增量）：只提交 L——M 的沿用重驗必須失敗且整批拒收
          const result = await callTool(server, 'save_compliance_review', {
            taskId: 'task-1',
            carryForward: true,
            results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
          });
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toContain('revalidationFailed');
          expect(result.content[0].text).toContain('不得沿用');
          expect(result.content[0].text).toContain(rows[0].id);
          expect(result.content[0].text).toContain('src/Mutable.tsx:1');
          // 整批拒收——沒有第二筆 run
          expect(aiRuns()).toHaveLength(1);

          // 把失效項納入重判後重新提交（照指示）→ 成功
          const retry = await callTool(server, 'save_compliance_review', {
            taskId: 'task-1',
            carryForward: true,
            results: [
              { itemId: rows[0].id, status: 'missing', note: '文字已從程式碼移除' },
              { itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            ],
          });
          expect(retry.isError).toBeUndefined();
          expect(aiRuns()).toHaveLength(2);
        } finally {
          fs.rmSync(mutPath, { force: true });
        }
      });

      it('無前一輪 ai_review run（只有 engine 預檢）→ 拒絕 carryForward', async () => {
        const rows = await seedChecklist([UI_ITEM]);
        await callTool(server, 'run_spec_compliance', { taskId: 'task-1' }); // engine run 不算前輪

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('前一輪');
        expect(result.content[0].text).toContain('全量');
        expect(aiRuns()).toHaveLength(0);
      });

      it('[CHECKLIST_REPLACE] 晚於上輪 run（檢查表被整份取代）→ 拒絕 carryForward 要求全量', async () => {
        const rows = await seedChecklist([UI_ITEM, MISSING_ITEM]);
        // 第一輪全量
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'missing' },
          ],
        });
        // 上輪 run 之後整份取代檢查表（真實路徑：save_spec_checklist replace 會寫 [CHECKLIST_REPLACE] 稽核）
        await callTool(server, 'save_spec_checklist', {
          taskId: 'task-1',
          items: [{ itemType: 'ui_text', content: '代理人設定作業', side: 'frontend' }],
          replace: true,
        });
        const newRow = testDb.prepare("SELECT id FROM spec_checklist_items WHERE task_id = 'task-1' AND waived = 0").get() as { id: string };

        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [{ itemId: newRow.id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('整份取代');
        expect(result.content[0].text).toContain('CHECKLIST_REPLACE');
        expect(aiRuns()).toHaveLength(1);
      });

      it('沿用 + 提交聯集仍缺項 → 涵蓋驗證照樣拒（上輪 missing 項不會被沿用）', async () => {
        const rows = await seedChecklist([
          UI_ITEM,
          { itemType: 'logic', content: '依建立日期倒序' },
          { itemType: 'logic', content: '刪除需二次確認' },
        ]);
        // 第一輪：A matched、B/C missing
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'missing' },
            { itemId: rows[2].id, status: 'missing' },
          ],
        });
        // 第二輪（增量）：只提交 B——C 既非提交也非沿用（上輪 missing）→ 缺項拒
        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('未判定');
        expect(result.content[0].text).toContain(rows[2].id);
        expect(result.content[0].text).toContain('上輪 missing');
        expect(aiRuns()).toHaveLength(1);
      });

      it('logic 項一律不沿用：上輪 matched 的 logic 未提交 → 缺項拒；重提含 logic → 成功且無沿用標記', async () => {
        const rows = await seedChecklist(); // [UI_ITEM(ui_text), logic 依建立日期倒序]
        // 第一輪：兩項都 matched（logic 也 matched）
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }], note: '排序邏輯已確認' },
          ],
        });
        // 第二輪（增量）：只提交 ui_text——logic 上輪雖 matched 但不得沿用 → 缺項拒
        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [{ itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(rows[1].id);
        expect(aiRuns()).toHaveLength(1);

        // 把 logic 納入重判後重提 → 成功；logic 是重判項不是沿用項
        const retry = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }], note: '重判確認' },
          ],
        });
        expect(retry.isError).toBeUndefined();
        const items = JSON.parse(aiRuns()[1]!.results_json) as Array<{ itemId: string; carriedForward?: boolean }>;
        expect(items.find(i => i.itemId === rows[1].id)?.carriedForward).toBeUndefined();
      });

      it('workspace 未設定（無法程式重驗）→ 拒絕 carryForward', async () => {
        testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-cw', 'P', '/tmp/cw')`).run();
        seedTask(testDb, 'task-cw', 'proj-cw', 'frontend');
        await callTool(server, 'save_spec_checklist', { taskId: 'task-cw', items: [UI_ITEM] });
        const row = testDb.prepare("SELECT id FROM spec_checklist_items WHERE task_id = 'task-cw'").get() as { id: string };
        // 第一輪（無 workspace → 證據未經程式驗證，照舊寫入）
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-cw',
          results: [{ itemId: row.id, status: 'matched', evidence: [{ file: 'src/Whatever.tsx', line: 1 }] }],
        });
        // 第二輪 carryForward：重驗做不到 → 拒
        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-cw',
          carryForward: true,
          results: [{ itemId: row.id, status: 'matched', evidence: [{ file: 'src/Whatever.tsx', line: 1 }] }],
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('無法開檔驗證');
        expect(aiRuns('task-cw')).toHaveLength(1);
      });

      it('鏈式沿用：第三輪沿用「第二輪的沿用項」時仍每輪重驗——證據失效照樣 revalidationFailed', async () => {
        const chainPath = path.join(feRoot, 'src', 'Chain.tsx');
        fs.writeFileSync(chainPath, '<h1>鏈式沿用目標文字</h1>\n', 'utf-8');
        try {
          const rows = await seedChecklist([
            { itemType: 'ui_text', content: '鏈式沿用目標文字', side: 'frontend' },
            { itemType: 'logic', content: '修復後預期行為' },
          ]);
          // 第一輪（全量）：A matched（Chain.tsx:1）、B missing
          await callTool(server, 'save_compliance_review', {
            taskId: 'task-1',
            results: [
              { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Chain.tsx', line: 1 }] },
              { itemId: rows[1].id, status: 'missing' },
            ],
          });
          // 第二輪（增量）：B 重判 matched，A 沿用（重驗通過）
          const r2 = await callTool(server, 'save_compliance_review', {
            taskId: 'task-1',
            carryForward: true,
            results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
          });
          expect(r2.isError).toBeUndefined();
          expect(aiRuns()).toHaveLength(2);

          // implementer 又改壞了 Chain.tsx（目標文字消失）
          fs.writeFileSync(
            chainPath,
            ['// 文字已移除', ...Array.from({ length: 25 }, (_, i) => `const z_${i} = ${i};`)].join('\n'),
            'utf-8',
          );

          // 第三輪（增量）：A 現在是「第二輪的沿用項」——沿用鏈仍必須每輪重驗 → 失效整批拒收
          const r3 = await callTool(server, 'save_compliance_review', {
            taskId: 'task-1',
            carryForward: true,
            results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
          });
          expect(r3.isError).toBe(true);
          expect(r3.content[0].text).toContain('revalidationFailed');
          expect(r3.content[0].text).toContain(rows[0].id);
          expect(aiRuns()).toHaveLength(2); // 第三輪未寫入
        } finally {
          fs.rmSync(chainPath, { force: true });
        }
      });

      it('上輪 run 之後某 matched 項被 waive → carryForward 時既不沿用也不要求涵蓋', async () => {
        const rows = await seedChecklist(); // [UI_ITEM, logic]
        // 第一輪：A matched、B missing
        await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          results: [
            { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
            { itemId: rows[1].id, status: 'missing' },
          ],
        });
        // A 在上輪之後被豁免
        await callTool(server, 'waive_checklist_item', { itemId: rows[0].id, reason: 'Phase 2 才做' });

        // 第二輪（增量）：只提交 B——A 已豁免,不需沿用也不算缺項
        const result = await callTool(server, 'save_compliance_review', {
          taskId: 'task-1',
          carryForward: true,
          results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] }],
        });
        expect(result.isError).toBeUndefined();

        const runs = aiRuns();
        expect(runs).toHaveLength(2);
        const items = JSON.parse(runs[1].results_json) as Array<{ itemId: string; carriedForward?: boolean }>;
        // A 不以沿用身分出現在 run 的 matched/missing 判定中
        expect(items.find(i => i.itemId === rows[0].id && i.carriedForward)).toBeUndefined();
      });
    });
  });

  describe('carryForward × 完成閘門相容（真實閘門測試）', () => {
    it('carryForward 產生的 run missing=0 → update_task_status(completed) 放行；missing>0 照樣擋', async () => {
      registerTaskTools(server); // 同一 server 掛上 update_task_status（同一 mock DB）
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-1'").run();
      // R2 執行計畫/派工記錄閘門：塞 [DISPATCH] 稽核行
      testDb.prepare(`
        INSERT INTO agents (id, project_id, role, status, model, current_task_id)
        VALUES ('mcp-task-1', 'proj-1', 'frontend', 'running', 'external', 'task-1')
      `).run();
      testDb.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES ('mcp-task-1', 'task-1', 'system', '[DISPATCH] {"at":"2026-01-01T00:00:00Z","meta":null,"prompt":"test dispatch"}')
      `).run();

      await callTool(server, 'save_spec_checklist', {
        taskId: 'task-1',
        items: [UI_ITEM, { itemType: 'logic', content: '依建立日期倒序' }],
      });
      const rows = testDb.prepare("SELECT id FROM spec_checklist_items WHERE task_id = 'task-1' ORDER BY created_at ASC, rowid ASC")
        .all() as Array<{ id: string }>;

      // 第一輪：missing=1 → 閘門擋
      await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        results: [
          { itemId: rows[0].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }] },
          { itemId: rows[1].id, status: 'missing', note: '排序未實作' },
        ],
      });
      const blocked = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0].text).toContain('規格回對未通過');

      // 第二輪（增量 carryForward）：missing=0 → 閘門放行
      const review = await callTool(server, 'save_compliance_review', {
        taskId: 'task-1',
        carryForward: true,
        results: [{ itemId: rows[1].id, status: 'matched', evidence: [{ file: 'src/Index.tsx', line: 1 }], note: '排序已修' }],
      });
      expect(review.isError).toBeUndefined();

      const done = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', summary: '完工' });
      expect(done.isError).toBeUndefined();
      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('completed');
    });
  });
});
