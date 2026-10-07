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
    async function seedGap(category = 'api_undefined', description = 'API 未定義'): Promise<string> {
      seed(testDb);
      await callTool(server, 'report_spec_gap', { taskId: 'task-1', category, description });
      const gap = testDb.prepare('SELECT id FROM spec_gaps').get() as { id: string };
      return gap.id;
    }

    it('marks a gap resolved with a concrete resolutionNote and notifies', async () => {
      const gapId = await seedGap();

      const result = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '使用者補了 SD v2：儲存改走 POST /api/wa05/save' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('裁決已落地');

      const row = testDb.prepare('SELECT * FROM spec_gaps WHERE id = ?').get(gapId) as any;
      expect(row.status).toBe('resolved');
      expect(row.resolution_note).toBe('使用者補了 SD v2：儲存改走 POST /api/wa05/save');
      expect(row.resolved_at).toBeTruthy();

      expect(notifyWebServer).toHaveBeenLastCalledWith({
        event: 'task.specGap',
        data: expect.objectContaining({ gapId, action: 'resolved' }),
      });
    });

    it('rejects a missing resolutionNote（必填）and keeps the gap open', async () => {
      const gapId = await seedGap();

      const result = await callTool(server, 'resolve_spec_gap', { gapId });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('必填');
      expect(result.content[0].text).toContain('選 B：刪除前 confirm 彈窗');

      const row = testDb.prepare('SELECT status, resolution_note FROM spec_gaps WHERE id = ?').get(gapId) as any;
      expect(row.status).toBe('open');
      expect(row.resolution_note).toBeNull();
    });

    it('rejects a too-short resolutionNote with guidance', async () => {
      const gapId = await seedGap();

      const result = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選B' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('過短');
      expect(result.content[0].text).toContain('具體的決定內容');

      expect((testDb.prepare('SELECT status FROM spec_gaps WHERE id = ?').get(gapId) as any).status).toBe('open');
    });

    it('rejects vague blacklist notes（「可以」「照舊」「OK」等）', async () => {
      const gapId = await seedGap();

      for (const vague of ['可以', '照舊', 'OK', '沒問題。', 'no problem']) {
        const result = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: vague });
        expect(result.isError, `should reject "${vague}"`).toBe(true);
        expect(result.content[0].text).toContain('空泛');
        expect(result.content[0].text).toContain('選 B：刪除前 confirm 彈窗');
      }
      expect((testDb.prepare('SELECT status FROM spec_gaps WHERE id = ?').get(gapId) as any).status).toBe('open');
    });

    it('is idempotent for already-resolved gaps（不重驗 note）', async () => {
      const gapId = await seedGap('other', 'x');
      await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 A：直接刪除不確認' });

      const again = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '好' });
      expect(again.isError).toBeUndefined();
      expect(again.content[0].text).toContain('already resolved');
      // 原裁決不被空泛的第二次呼叫覆蓋
      expect((testDb.prepare('SELECT resolution_note FROM spec_gaps WHERE id = ?').get(gapId) as any).resolution_note).toBe('選 A：直接刪除不確認');
    });

    it('returns error for unknown gapId', async () => {
      const result = await callTool(server, 'resolve_spec_gap', { gapId: 'nope', resolutionNote: '選 B：刪除前 confirm 彈窗' });
      expect(result.isError).toBe(true);
    });

    // ── revise：更正一則已落地但發現是錯的裁決 ─────────────────────────
    //
    // 起因（2026-09-19 實例）：碼值換中文的裁決當天落地、當天被推翻。撤回時程式、測試、
    // 流程圖、驗證報告都改了，唯獨已落地的裁決改不動——而裁決會自動注入後續派工與 AI 回對，
    // 於是下一輪 reviewer 拿到兩份互相矛盾的「規格條文」。
    // 這一組釘的是兩件事：錯的裁決改得掉，而且**前一版不會憑空消失**。
    describe('revise', () => {
      it('沒帶 revise 時維持原樣拒收，並告訴呼叫者有修訂這條路', async () => {
        const gapId = await seedGap('other', 'x');
        await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 A：直接刪除不確認' });

        const again = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 B：刪除前 confirm 彈窗' });
        expect(again.isError).toBeUndefined();
        expect(again.content[0].text).toContain('already resolved');
        expect(again.content[0].text).toContain('revise');
        expect((testDb.prepare('SELECT resolution_note FROM spec_gaps WHERE id = ?').get(gapId) as any).resolution_note)
          .toBe('選 A：直接刪除不確認');
      });

      it('帶 revise 時換成新裁決，且把前一版以「已被取代」保留在同一則裡', async () => {
        const gapId = await seedGap('other', 'x');
        await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 A：直接刪除不確認' });

        const revised = await callTool(server, 'resolve_spec_gap', {
          gapId, resolutionNote: '改判選 B：刪除前 confirm 彈窗（選 A 與共用基礎的軟刪除規則衝突）', revise: true,
        });
        expect(revised.isError).toBeUndefined();

        const note = (testDb.prepare('SELECT resolution_note FROM spec_gaps WHERE id = ?').get(gapId) as any).resolution_note as string;
        // 新裁決在前，讀的人先看到現行的那一份
        expect(note.indexOf('改判選 B')).toBeLessThan(note.indexOf('選 A：直接刪除不確認'));
        // 舊裁決還在，而且明示不可照辦——悄悄換掉與不能換一樣糟
        expect(note).toContain('已被取代的前一版裁決');
        expect(note).toContain('不可照辦');
      });

      it('revise 的內容與現行版本相同時拒收（沒有東西可修訂）', async () => {
        const gapId = await seedGap('other', 'x');
        await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 A：直接刪除不確認' });

        const same = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 A：直接刪除不確認', revise: true });
        expect(same.isError).toBe(true);
      });

      it('revise 仍然要過裁決品質驗證，空泛詞擋下且不動既有裁決', async () => {
        const gapId = await seedGap('other', 'x');
        await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '選 A：直接刪除不確認' });

        const vague = await callTool(server, 'resolve_spec_gap', { gapId, resolutionNote: '照舊', revise: true });
        expect(vague.isError).toBe(true);
        expect((testDb.prepare('SELECT resolution_note FROM spec_gaps WHERE id = ?').get(gapId) as any).resolution_note)
          .toBe('選 A：直接刪除不確認');
      });

      it('對還沒解決的缺口帶 revise 等同一般落地，不會多出「已被取代」那一段', async () => {
        const gapId = await seedGap('other', 'x');
        const result = await callTool(server, 'resolve_spec_gap', {
          gapId, resolutionNote: '選 B：刪除前 confirm 彈窗', revise: true,
        });
        expect(result.isError).toBeUndefined();
        const note = (testDb.prepare('SELECT resolution_note FROM spec_gaps WHERE id = ?').get(gapId) as any).resolution_note as string;
        expect(note).toBe('選 B：刪除前 confirm 彈窗');
        expect(note).not.toContain('已被取代');
      });
    });
  });
});
