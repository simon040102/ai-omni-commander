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

vi.mock('../svn-status.js', () => ({
  getSvnCredentials: vi.fn().mockReturnValue({ username: 'user', password: 'pass' }),
  isSvnCliAvailable: vi.fn().mockReturnValue(true),
  fetchRemoteLastModified: vi.fn().mockReturnValue(null),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerContextTools } from '../tools/context-tools.js';
import { notifyWebServer } from '../notify.js';
import { isSvnCliAvailable, fetchRemoteLastModified } from '../svn-status.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path, backend_path) VALUES (?, ?, ?, ?, ?)`).run(
    'proj-1', 'Test Project', '/tmp', '/tmp/fe', '/tmp/be',
  );
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'task-1', 'proj-1', 'WA05 查詢作業', 'frontend', 'feature', 'in_progress', 'WA05',
  );
}

function addOutput(db: Database.Database, taskId: string, content: string) {
  db.prepare(`INSERT OR IGNORE INTO agents (id, project_id, role, status, model) VALUES (?, 'proj-1', 'quick', 'running', 'external')`).run(`mcp-${taskId}`);
  db.prepare(`INSERT INTO agent_outputs (agent_id, task_id, stream_type, content) VALUES (?, ?, 'system', ?)`).run(`mcp-${taskId}`, taskId, content);
}

describe('context-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerContextTools(server);
    vi.clearAllMocks();
  });

  describe('resume_task', () => {
    it('returns task core fields, project, outputs, gaps, verification, deps, notes, nextSteps', async () => {
      seed(testDb);

      // history outputs + verification line
      addOutput(testDb, 'task-1', '開始執行');
      addOutput(testDb, 'task-1', '[VERIFICATION] 驗收：1/2 通過\n- [FAIL] fe-tsc');
      addOutput(testDb, 'task-1', '完成頁面結構');

      // open spec gap
      testDb.prepare(`INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('gap-1', 'task-1', 'proj-1', 'field_undefined', '狀態欄位未定義')`).run();

      // dependency: task-1 depends on task-0 (pending)
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('task-0', 'proj-1', '共用元件', 'frontend', 'feature', 'pending')`).run();
      testDb.prepare(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('task-1', 'task-0')`).run();

      // project note
      testDb.prepare(`INSERT INTO project_notes (id, project_id, category, content) VALUES ('note-1', 'proj-1', 'build', 'build 必須用 JDK 17')`).run();

      const result = await callTool(server, 'resume_task', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);

      expect(data.task).toMatchObject({ id: 'task-1', title: 'WA05 查詢作業', status: 'in_progress', label: 'frontend', taskType: 'feature', parentName: 'WA05' });
      expect(data.project).toMatchObject({ id: 'proj-1', name: 'Test Project', frontendPath: '/tmp/fe', backendPath: '/tmp/be' });
      expect(data.flowGate.enabled).toBe(false);
      expect(data.recentOutputs.total).toBe(3);
      expect(data.recentOutputs.outputs[2].content).toBe('完成頁面結構');
      expect(data.openSpecGaps).toHaveLength(1);
      expect(data.lastVerification.content).toContain('[VERIFICATION] 驗收：1/2 通過');
      expect(data.dependencies).toEqual([{ taskId: 'task-0', title: '共用元件', status: 'pending' }]);
      expect(data.projectNotes).toEqual([{ id: 'note-1', category: 'build', content: 'build 必須用 JDK 17' }]);

      // nextSteps mentions unresolved deps + gaps
      expect(data.nextSteps).toContain('前置任務未完成');
      expect(data.nextSteps).toContain('規格缺口 1 筆未解決');
    });

    it('summarizes flow-gate state and points at the missing gate step', async () => {
      seed(testDb);
      const flowState = {
        specExpected: true,
        spec: { hash: 'abc', savedAt: '2026-01-01T00:00:00Z' },
        roles: {
          frontend: { required: true, plan: { hash: 'p1', savedAt: '2026-01-01T00:00:00Z' }, gateBFailures: 0 },
        },
      };
      testDb.prepare(`UPDATE tasks SET flow_required = 1, flow_state = ? WHERE id = 'task-1'`).run(JSON.stringify(flowState));

      const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.flowGate.enabled).toBe(true);
      expect(data.flowGate.specFlowSaved).toBe(true);
      expect(data.flowGate.roles[0]).toMatchObject({ role: 'frontend', required: true, planFlowSaved: true, gateA: null });
      // gate A not passed → nextSteps says report_flow_check gate A（R1 直白命名）
      expect(data.nextSteps).toContain('開工閘（規格理解確認）未通過');
    });

    it('returns resolvedGaps（resolved 且 note 非空）並在 nextSteps 註明效力', async () => {
      seed(testDb);
      // resolved + 具體裁決 → 進 resolvedGaps
      testDb.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description, status, resolution_note, resolved_at)
        VALUES ('gap-r1', 'task-1', 'proj-1', 'logic_unclear', '刪除是否需要確認？', 'resolved', '選 B：刪除前 confirm 彈窗', '2026-01-01 00:00:00')
      `).run();
      // resolved 但 note 為空（舊資料）→ 不進 resolvedGaps
      testDb.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description, status, resolution_note, resolved_at)
        VALUES ('gap-r2', 'task-1', 'proj-1', 'other', '舊缺口', 'resolved', '', '2026-01-02 00:00:00')
      `).run();
      // open → 不進 resolvedGaps
      testDb.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES ('gap-o', 'task-1', 'proj-1', 'other', '未解決')
      `).run();

      const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.resolvedGaps).toEqual([{
        id: 'gap-r1',
        category: 'logic_unclear',
        description: '刪除是否需要確認？',
        resolutionNote: '選 B：刪除前 confirm 彈窗',
        resolvedAt: '2026-01-01 00:00:00',
      }]);
      expect(data.openSpecGaps).toHaveLength(1);
      expect(data.nextSteps).toContain('規格裁決');
      expect(data.nextSteps).toContain('效力等同規格');
    });

    it('resolvedGaps is empty when the task has no resolved-with-note gaps', async () => {
      seed(testDb);
      const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.resolvedGaps).toEqual([]);
      expect(data.nextSteps).not.toContain('規格裁決');
    });

    it('respects outputLimit and returns the most recent entries', async () => {
      seed(testDb);
      addOutput(testDb, 'task-1', 'line 1');
      addOutput(testDb, 'task-1', 'line 2');
      addOutput(testDb, 'task-1', 'line 3');

      const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1', outputLimit: 2 })).content[0].text);
      expect(data.recentOutputs.total).toBe(3);
      expect(data.recentOutputs.outputs.map((o: any) => o.content)).toEqual(['line 2', 'line 3']);
      expect(data.lastVerification).toBeNull();
    });

    it('returns error for unknown task', async () => {
      const result = await callTool(server, 'resume_task', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });

    it('includes track / trackReason from flow_state（無記錄 → full / 未判定）', async () => {
      seed(testDb);

      // 未判軌：預設 full + 未判定說明
      let data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.track).toBe('full');
      expect(data.trackReason).toContain('未判定');

      // get_execution_plan 判軌後寫入 flow_state（light 軌不設 flow_required 也要能讀到）
      testDb.prepare(`UPDATE tasks SET flow_state = ? WHERE id = 'task-1'`).run(
        JSON.stringify({ roles: {}, track: 'light', trackReason: '自動判定：taskType=bug 且無 SA/SD 規格文件' }),
      );
      data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.track).toBe('light');
      expect(data.trackReason).toBe('自動判定：taskType=bug 且無 SA/SD 規格文件');
      expect(data.flowGate.enabled).toBe(false); // light 軌不啟用 flow-gate
    });
  });

  describe('save_task_dispatch + resume_task lastDispatch', () => {
    it('stores a [DISPATCH] snapshot and resume_task returns the most recent one parsed', async () => {
      seed(testDb);

      const r1 = await callTool(server, 'save_task_dispatch', {
        taskId: 'task-1', prompt: '第一版 prompt', meta: { role: 'frontend' },
      });
      expect(r1.isError).toBeUndefined();

      // stored in agent_outputs as a [DISPATCH]-prefixed system line
      const rows = testDb.prepare(`SELECT content FROM agent_outputs WHERE agent_id = 'mcp-task-1' AND content LIKE '[DISPATCH]%'`).all() as any[];
      expect(rows).toHaveLength(1);

      // a second dispatch — resume_task must return the LATEST
      await callTool(server, 'save_task_dispatch', {
        taskId: 'task-1', prompt: '第二版 prompt', meta: { role: 'backend', model: 'opus' },
      });

      const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.lastDispatch).toBeDefined();
      expect(data.lastDispatch.prompt).toBe('第二版 prompt');
      expect(data.lastDispatch.meta).toEqual({ role: 'backend', model: 'opus' });
      expect(data.lastDispatch.dispatchedAt).toBeTruthy();
      expect(data.lastDispatch.savedAt).toBeTruthy();
    });

    it('resume_task omits lastDispatch when no snapshot exists (back-compat)', async () => {
      seed(testDb);
      const data = JSON.parse((await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text);
      expect(data.lastDispatch).toBeUndefined();
    });

    it('save_task_dispatch returns error for unknown task', async () => {
      const result = await callTool(server, 'save_task_dispatch', { taskId: 'nope', prompt: 'x' });
      expect(result.isError).toBe(true);
    });

    it('[DISPATCH] 快照排除在 recentOutputs 之外，且 lastDispatch 排在 recentOutputs 前面（防截斷）', async () => {
      seed(testDb);
      await callTool(server, 'save_task_dispatch', { taskId: 'task-1', prompt: '很長的派工 prompt'.repeat(10) });
      // save_task_dispatch 已建 mcp-task-1 合成 agent——直接插一筆一般進度回報
      testDb.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES ('mcp-task-1', 'task-1', 'text', '一般進度回報')
      `).run();

      const text = (await callTool(server, 'resume_task', { taskId: 'task-1' })).content[0].text;
      const data = JSON.parse(text);
      // recentOutputs 不含 [DISPATCH] 行（計數與內容都排除）
      expect(data.recentOutputs.outputs.every((o: { content: string }) => !o.content.startsWith('[DISPATCH]'))).toBe(true);
      expect(data.recentOutputs.total).toBe(1);
      // 序列化順序：lastDispatch 在 recentOutputs 之前（截斷時尾端先被切）
      expect(text.indexOf('"lastDispatch"')).toBeGreaterThan(-1);
      expect(text.indexOf('"lastDispatch"')).toBeLessThan(text.indexOf('"recentOutputs"'));
    });

    it('壞 JSON 的 [DISPATCH] 行不會讓 resume_task 炸掉——落到 raw fallback', async () => {
      seed(testDb);
      testDb.prepare(`
        INSERT INTO agents (id, project_id, role, status, model) VALUES ('mcp-task-1', 'proj-1', 'quick', 'running', 'external')
      `).run();
      testDb.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES ('mcp-task-1', 'task-1', 'system', '[DISPATCH] {壞掉的 json')
      `).run();

      const result = await callTool(server, 'resume_task', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.lastDispatch.raw).toBe('{壞掉的 json');
      expect(data.lastDispatch.savedAt).toBeTruthy();
    });
  });

  describe('project notes', () => {
    it('save_project_note inserts and notifies project.noteSaved', async () => {
      seed(testDb);
      const result = await callTool(server, 'save_project_note', {
        projectId: 'proj-1', content: '查詢表單一列兩欄', category: 'ui',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Project note saved');

      const rows = testDb.prepare('SELECT * FROM project_notes').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ project_id: 'proj-1', category: 'ui', content: '查詢表單一列兩欄', active: 1 });

      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'project.noteSaved',
        data: expect.objectContaining({ projectId: 'proj-1', category: 'ui' }),
      });
    });

    it('save_project_note description 有必要性測試（只記可重用規則、流水帳不記）', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = (server as any)._registeredTools['save_project_note'];
      // 必要性門檻：目的是防重犯錯、不是流水帳
      expect(tool.description).toContain('必要性測試');
      expect(tool.description).toContain('下一個_不同_任務');
      // 明確反例：一次性事件/進度/commit 日期 = 垃圾不記
      expect(tool.description).toContain('流水帳');
      // 判準：去時間/任務名/commit 後還成立才記
      expect(tool.description).toContain('把時間、任務名、commit 拿掉後還成立');
    });

    it('save_project_note description 收緊寫入紀律（精簡/附出處/不重複/過時 archive）', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = (server as any)._registeredTools['save_project_note'];
      // 1. 一則一個重點、精簡可操作
      expect(tool.description).toContain('一則一個重點、精簡可操作');
      // 2. 附出處，無出處不記
      expect(tool.description).toContain('附出處');
      expect(tool.description).toContain('無出處不記');
      // 3. 不要重複——先 list_project_notes 看有沒有涵蓋
      expect(tool.description).toContain('不要重複');
      expect(tool.description).toContain('list_project_notes');
      // 4. 過時就 archive
      expect(tool.description).toContain('過時就 archive');
      expect(tool.description).toContain('archive_project_note');
    });

    it('save_project_note returns error for unknown project', async () => {
      const result = await callTool(server, 'save_project_note', { projectId: 'nope', content: 'x' });
      expect(result.isError).toBe(true);
    });

    it('list_project_notes returns active only by default; includeArchived shows all', async () => {
      seed(testDb);
      await callTool(server, 'save_project_note', { projectId: 'proj-1', content: 'note A', category: 'db' });
      await callTool(server, 'save_project_note', { projectId: 'proj-1', content: 'note B' });
      const noteB = testDb.prepare("SELECT id FROM project_notes WHERE content = 'note B'").get() as { id: string };

      const archived = await callTool(server, 'archive_project_note', { noteId: noteB.id });
      expect(archived.isError).toBeUndefined();
      expect((testDb.prepare('SELECT active FROM project_notes WHERE id = ?').get(noteB.id) as any).active).toBe(0);

      const activeOnly = JSON.parse((await callTool(server, 'list_project_notes', { projectId: 'proj-1' })).content[0].text);
      expect(activeOnly.count).toBe(1);
      expect(activeOnly.notes[0].content).toBe('note A');

      const all = JSON.parse((await callTool(server, 'list_project_notes', { projectId: 'proj-1', includeArchived: true })).content[0].text);
      expect(all.count).toBe(2);

      // archiving again is idempotent
      const again = await callTool(server, 'archive_project_note', { noteId: noteB.id });
      expect(again.isError).toBeUndefined();
      expect(again.content[0].text).toContain('already archived');
    });

    it('archive_project_note returns error for unknown note', async () => {
      const result = await callTool(server, 'archive_project_note', { noteId: 'nope' });
      expect(result.isError).toBe(true);
    });
  });

  describe('check_spec_changes', () => {
    function seedVersion(taskId: string, fileRef: string, lastModified: string) {
      testDb.prepare(`INSERT OR REPLACE INTO task_spec_versions (task_id, file_ref, last_modified) VALUES (?, ?, ?)`)
        .run(taskId, fileRef, lastModified);
    }

    it('requires projectId or taskId', async () => {
      const result = await callTool(server, 'check_spec_changes', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('至少提供');
    });

    it('reports zero files when no versions recorded (no SVN call)', async () => {
      seed(testDb);
      const data = JSON.parse((await callTool(server, 'check_spec_changes', { taskId: 'task-1' })).content[0].text);
      expect(data.filesChecked).toBe(0);
      expect(fetchRemoteLastModified).not.toHaveBeenCalled();
    });

    it('creates a spec_changed gap, notifies, and updates the recorded version on change', async () => {
      seed(testDb);
      seedVersion('task-1', 'https://svn/specs/SPEC_WA05_v1.docx', '2026-06-01 10:00:00');
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-07-01 09:00:00');

      const result = await callTool(server, 'check_spec_changes', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.tasksChecked).toBe(1); // only in_progress tasks
      expect(data.changedTotal).toBe(1);
      expect(data.tasks[0].changed[0]).toMatchObject({
        filename: 'SPEC_WA05_v1.docx',
        recorded: '2026-06-01 10:00:00',
        current: '2026-07-01 09:00:00',
      });

      const gaps = testDb.prepare('SELECT * FROM spec_gaps').all() as any[];
      expect(gaps).toHaveLength(1);
      expect(gaps[0].category).toBe('spec_changed');
      expect(gaps[0].task_id).toBe('task-1');

      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.specGap',
        data: expect.objectContaining({ taskId: 'task-1', category: 'spec_changed', action: 'reported' }),
      });

      // recorded version bumped so repeated checks don't re-report
      const version = testDb.prepare('SELECT last_modified FROM task_spec_versions WHERE task_id = ?').get('task-1') as any;
      expect(version.last_modified).toBe('2026-07-01 09:00:00');

      // agent_outputs system line for terminal visibility
      const outputs = testDb.prepare("SELECT * FROM agent_outputs WHERE agent_id = 'mcp-task-1'").all() as any[];
      expect(outputs[0].content).toContain('[SPEC_GAP][spec_changed]');
    });

    it('reports no change when SVN date matches', async () => {
      seed(testDb);
      seedVersion('task-1', 'https://svn/specs/SPEC_WA05_v1.docx', '2026-06-01 10:00:00');
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-06-01 10:00:00');

      const data = JSON.parse((await callTool(server, 'check_spec_changes', { taskId: 'task-1' })).content[0].text);
      expect(data.changedTotal).toBe(0);
      expect(testDb.prepare('SELECT COUNT(*) as c FROM spec_gaps').get()).toEqual({ c: 0 });
    });

    it('marks files as unknown when SVN info cannot be fetched', async () => {
      seed(testDb);
      seedVersion('task-1', 'https://svn/specs/SPEC_WA05_v1.docx', '2026-06-01 10:00:00');
      vi.mocked(fetchRemoteLastModified).mockReturnValue(null);

      const data = JSON.parse((await callTool(server, 'check_spec_changes', { taskId: 'task-1' })).content[0].text);
      expect(data.changedTotal).toBe(0);
      expect(data.tasks[0].unknown).toEqual(['SPEC_WA05_v1.docx']);
    });

    it('fails loudly when svn CLI is unavailable', async () => {
      seed(testDb);
      seedVersion('task-1', 'https://svn/specs/SPEC_WA05_v1.docx', '2026-06-01 10:00:00');
      vi.mocked(isSvnCliAvailable).mockReturnValue(false);

      const result = await callTool(server, 'check_spec_changes', { taskId: 'task-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('svn CLI');
      vi.mocked(isSvnCliAvailable).mockReturnValue(true);
    });
  });

  describe('task dependencies', () => {
    function seedTwoTasks() {
      seed(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('task-2', 'proj-1', '後端 API', 'backend', 'feature', 'pending')`).run();
    }

    it('add_task_dependency inserts a row', async () => {
      seedTwoTasks();
      const result = await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });
      expect(result.isError).toBeUndefined();
      const rows = testDb.prepare('SELECT * FROM task_dependencies').all() as any[];
      expect(rows).toEqual([{ task_id: 'task-1', depends_on_id: 'task-2' }]);
    });

    it('rejects self-dependency', async () => {
      seedTwoTasks();
      const result = await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('自己');
    });

    it('rejects cross-project dependency', async () => {
      seedTwoTasks();
      testDb.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('proj-2', 'Other', '/tmp')`).run();
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-x', 'proj-2', 'X', 'frontend', 'other')`).run();
      const result = await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-x' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('同一個專案');
    });

    it('rejects duplicate dependency', async () => {
      seedTwoTasks();
      await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });
      const again = await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });
      expect(again.isError).toBe(true);
      expect(again.content[0].text).toContain('已存在');
    });

    it('rejects a dependency that would create a cycle (direct and transitive)', async () => {
      seedTwoTasks();
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-3', 'proj-1', 'C', 'frontend', 'other')`).run();

      await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });
      // direct cycle: task-2 → task-1
      const direct = await callTool(server, 'add_task_dependency', { taskId: 'task-2', dependsOnTaskId: 'task-1' });
      expect(direct.isError).toBe(true);
      expect(direct.content[0].text).toContain('循環');

      // transitive: task-2 → task-3 then task-3 → task-1 would close the loop 1→2→3→1
      await callTool(server, 'add_task_dependency', { taskId: 'task-2', dependsOnTaskId: 'task-3' });
      const transitive = await callTool(server, 'add_task_dependency', { taskId: 'task-3', dependsOnTaskId: 'task-1' });
      expect(transitive.isError).toBe(true);
      expect(transitive.content[0].text).toContain('循環');
    });

    it('remove_task_dependency deletes the row and errors when absent', async () => {
      seedTwoTasks();
      await callTool(server, 'add_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });

      const removed = await callTool(server, 'remove_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });
      expect(removed.isError).toBeUndefined();
      expect(testDb.prepare('SELECT COUNT(*) as c FROM task_dependencies').get()).toEqual({ c: 0 });

      const missing = await callTool(server, 'remove_task_dependency', { taskId: 'task-1', dependsOnTaskId: 'task-2' });
      expect(missing.isError).toBe(true);
    });
  });
});
