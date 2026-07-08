import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { registerTaskTools } from '../tools/task-tools.js';
import { isSvnCliAvailable, fetchRemoteLastModified } from '../svn-status.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database, id = 'proj-1') {
  db.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path, backend_path) VALUES (?, ?, ?, ?, ?)`).run(
    id, 'Test Project', '/tmp/project', '/tmp/project/web', '/tmp/project/server',
  );
}

function seedTask(db: Database.Database, id = 'task-1', projectId = 'proj-1', label = 'backend') {
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, label, task_type, prompt) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, projectId, 'Test Task', 'A test task description', label, 'feature', 'Build the API endpoint',
  );
}

describe('task-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerTaskTools(server);
  });

  describe('get_task', () => {
    it('returns task details with project info', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'get_task', { taskId: 'task-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.task.id).toBe('task-1');
      expect(data.task.title).toBe('Test Task');
      expect(data.task.label).toBe('backend');
      expect(data.project.id).toBe('proj-1');
      expect(data.project.workingDir).toBe('/tmp/project');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_task', { taskId: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });
  });

  describe('list_pending_tasks', () => {
    it('lists pending tasks for a project', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', 'proj-1');
      seedTask(testDb, 'task-2', 'proj-1', 'frontend');

      const result = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.count).toBe(2);
      expect(data.tasks).toHaveLength(2);
    });

    it('returns empty list for project with no tasks', async () => {
      seedProject(testDb);
      const result = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
    });

    it('escapes LIKE wildcards in keyword (A10)', async () => {
      seedProject(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
        'task-a', 'proj-1', 'SM27_共用查詢', 'backend', 'feature',
      );
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
        'task-b', 'proj-1', 'SM27x共用查詢', 'backend', 'feature',
      );

      // '_' must match literally, not as a single-char wildcard
      const result = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', keyword: 'SM27_' });
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.tasks[0].id).toBe('task-a');

      // '%' must match literally
      const pct = await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', keyword: '100%' });
      expect(JSON.parse(pct.content[0].text).count).toBe(0);
    });

    it('supports limit/offset pagination with total and hasMore (A15)', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1');
      seedTask(testDb, 'task-2');
      seedTask(testDb, 'task-3');

      const page1 = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', limit: 2 })).content[0].text);
      expect(page1.total).toBe(3);
      expect(page1.count).toBe(2);
      expect(page1.hasMore).toBe(true);

      const page2 = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', limit: 2, offset: 2 })).content[0].text);
      expect(page2.total).toBe(3);
      expect(page2.count).toBe(1);
      expect(page2.hasMore).toBe(false);
    });
  });

  describe('get_execution_plan', () => {
    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_execution_plan', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });

    it('returns error when task not in web server DB', async () => {
      seedProject(testDb);
      seedTask(testDb);

      // task-1 exists in test in-memory DB but not in the web server's DB
      // So either we get a 404 (server running) or connection error (server not running)
      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(result.isError).toBe(true);
    });
  });

  describe('get_execution_plan — 任務判軌（light / full）', () => {
    let fetchedUrls: string[];

    function stubPlanFetch() {
      fetchedUrls = [];
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        fetchedUrls.push(String(url));
        return {
          ok: true,
          json: async () => ({
            prompt: 'PLAN BODY',
            workingDir: '/tmp/project',
            model: 'sonnet',
            frontendPath: '/tmp/project/web',
            backendPath: '/tmp/project/server',
          }),
        };
      }));
    }

    function seedTypedTask(id: string, taskType: string, label = 'frontend') {
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, description, label, task_type) VALUES (?, 'proj-1', ?, ?, ?, ?)`).run(
        id, 'SM27 共用_查詢工程專案', '計劃部門查詢欄位失效', label, taskType,
      );
    }

    function seedSaDocument() {
      testDb.prepare(`INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES ('doc-1', 'proj-1', 'SPEC_SM27.md', '/specs/SPEC_SM27.md', 'SA')`).run();
    }

    function flowStateOf(taskId: string): { flowRequired: number; state: Record<string, any> | null } {
      const row = testDb.prepare('SELECT flow_required, flow_state FROM tasks WHERE id = ?').get(taskId) as { flow_required: number | null; flow_state: string | null };
      return { flowRequired: row.flow_required ?? 0, state: row.flow_state ? JSON.parse(row.flow_state) : null };
    }

    beforeEach(() => {
      seedProject(testDb);
      stubPlanFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('bug 且無 SA/SD → 自動 light：LIGHT 聲明、無 flow-gate、flow_required=0、track 持久化、[TRACK] 留痕', async () => {
      seedTypedTask('task-1', 'bug');

      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      // plan 開頭的判軌聲明
      expect(text.startsWith('## 任務軌道：LIGHT（輕量修復流程）')).toBe(true);
      expect(text).toContain('自動判定：taskType=bug 且任務未綁定 SA/SD 規格文件');
      expect(text).toContain('原始 BUG 內容');
      expect(text).toContain('missing=0 才能標 completed');
      expect(text).toContain('track="full"'); // 重新取 full 軌的指引
      expect(text).toContain('PLAN BODY');
      // 不注入 flow-gate 工作流
      expect(text).not.toContain('Flow-Gated Development（強制工作流');
      // track 透傳給 Web API
      expect(fetchedUrls[0]).toContain('track=light');

      // flow_required 不設、無 role gate 初始化，但 track/trackReason 持久化
      const { flowRequired, state } = flowStateOf('task-1');
      expect(flowRequired).toBe(0);
      expect(state!.track).toBe('light');
      expect(state!.trackReason).toContain('自動判定');
      expect(state!.roles).toEqual({});

      // [TRACK] 留痕寫入 agent_outputs
      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content === '[TRACK] light — 自動判定：taskType=bug 且任務未綁定 SA/SD 規格文件')).toBe(true);
    });

    it('bug 且 SA 文件已綁定任務 → full：FULL 聲明 + flow-gate 初始化照舊', async () => {
      seedTypedTask('task-1', 'bug');
      seedSaDocument();
      testDb.prepare("INSERT INTO task_documents (task_id, document_id) VALUES ('task-1', 'doc-1')").run();

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1' })).content[0].text;
      expect(text.startsWith('## 任務軌道：FULL（規格驅動流程）')).toBe(true);
      expect(text).toContain('Flow-Gated Development（強制工作流');
      expect(fetchedUrls[0]).toContain('track=full');

      const { flowRequired, state } = flowStateOf('task-1');
      expect(flowRequired).toBe(1);
      expect(state!.track).toBe('full');
      expect(state!.specExpected).toBe(true);
      expect(state!.roles.frontend).toMatchObject({ required: true });
    });

    it('feature（無文件）→ full', async () => {
      seedTypedTask('task-1', 'feature');

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1' })).content[0].text;
      expect(text).toContain('## 任務軌道：FULL（規格驅動流程）');
      expect(text).toContain('自動判定：taskType=feature');
      expect(text).toContain('Flow-Gated Development（強制工作流');
      expect(flowStateOf('task-1').flowRequired).toBe(1);
    });

    it('track="full" 覆寫 light 自動判定（bug 無文件仍走 full）', async () => {
      seedTypedTask('task-1', 'bug');

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1', track: 'full' })).content[0].text;
      expect(text.startsWith('## 任務軌道：FULL（規格驅動流程）')).toBe(true);
      expect(text).toContain('呼叫端指定 track="full"');
      expect(text).toContain('Flow-Gated Development（強制工作流');
      expect(fetchedUrls[0]).toContain('track=full');

      const { flowRequired, state } = flowStateOf('task-1');
      expect(flowRequired).toBe(1);
      expect(state!.track).toBe('full');
    });

    it('track="light" 強制輕量（即使 feature + 有 SA 文件）', async () => {
      seedTypedTask('task-1', 'feature');
      seedSaDocument();

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1', track: 'light' })).content[0].text;
      expect(text.startsWith('## 任務軌道：LIGHT（輕量修復流程）')).toBe(true);
      expect(text).toContain('呼叫端指定 track="light"');
      expect(text).not.toContain('Flow-Gated Development（強制工作流');
      expect(fetchedUrls[0]).toContain('track=light');

      const { flowRequired, state } = flowStateOf('task-1');
      expect(flowRequired).toBe(0);
      expect(state!.track).toBe('light');
      expect(state!.trackReason).toContain('呼叫端指定');
    });

    it('bug + 專案層有 SA 但未綁定任務 → 仍判 light（判定粒度=任務綁定文件）', async () => {
      seedTypedTask('task-1', 'bug');
      seedSaDocument(); // 專案層文件，無 task_documents 綁定

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1' })).content[0].text;
      expect(text.startsWith('## 任務軌道：LIGHT（輕量修復流程）')).toBe(true);
      expect(text).toContain('任務未綁定 SA/SD 規格文件');
    });

    it('full→light 覆寫：flow_required 不降級，LIGHT 聲明如實警告閘門仍生效', async () => {
      seedTypedTask('task-1', 'bug');

      await callTool(server, 'get_execution_plan', { taskId: 'task-1', track: 'full' });
      expect(flowStateOf('task-1').flowRequired).toBe(1);

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1', track: 'light' })).content[0].text;
      expect(text.startsWith('## 任務軌道：LIGHT（輕量修復流程）')).toBe(true);
      expect(text).toContain('閘門**不降級**');
      expect(text).not.toContain('本任務跳過 Flow-Gated 流程圖閘門');
      // flow_required 保守不降級
      expect(flowStateOf('task-1').flowRequired).toBe(1);
    });

    it('重複呼叫同軌不重複寫 [TRACK]；換軌會再寫一筆', async () => {
      seedTypedTask('task-1', 'bug');

      await callTool(server, 'get_execution_plan', { taskId: 'task-1' }); // light
      await callTool(server, 'get_execution_plan', { taskId: 'task-1' }); // light（重複）
      let tracks = (testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = ? AND content LIKE '[TRACK]%'").all('task-1') as Array<{ content: string }>);
      expect(tracks).toHaveLength(1);

      await callTool(server, 'get_execution_plan', { taskId: 'task-1', track: 'full' }); // 換軌
      tracks = (testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = ? AND content LIKE '[TRACK]%'").all('task-1') as Array<{ content: string }>);
      expect(tracks).toHaveLength(2);
      expect(tracks[1].content).toContain('[TRACK] full');
    });
  });

  describe('update_task_status', () => {
    it('updates task status to in_progress', async () => {
      seedProject(testDb);
      seedTask(testDb);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(result.content[0].text).toContain('in_progress');

      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('in_progress');
    });

    it('updates task status with summary', async () => {
      seedProject(testDb);
      seedTask(testDb);

      // pending → completed is not a valid transition; go through in_progress first
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', summary: 'All done' });

      const row = testDb.prepare('SELECT status, result_summary FROM tasks WHERE id = ?').get('task-1') as { status: string; result_summary: string };
      expect(row.status).toBe('completed');
      expect(row.result_summary).toBe('All done');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'update_task_status', { taskId: 'nope', status: 'completed' });
      expect(result.isError).toBe(true);
    });

    it('allows failed → in_progress retry (A11)', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run('task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(result.isError).toBeUndefined();
      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('in_progress');
    });

    it('rejects completed → in_progress (terminal state)', async () => {
      seedProject(testDb);
      seedTask(testDb);
      testDb.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run('task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(result.isError).toBe(true);
    });

    it('stops only this task\'s synthetic agent, not other agents in the project (A2)', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1');
      seedTask(testDb, 'task-2');
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id IN ('task-1', 'task-2')").run();
      const insertAgent = testDb.prepare(`
        INSERT INTO agents (id, project_id, role, status, model, current_task_id)
        VALUES (?, 'proj-1', 'backend', 'running', 'external', ?)
      `);
      insertAgent.run('mcp-task-1', 'task-1');
      insertAgent.run('mcp-task-2', 'task-2');

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      const a1 = testDb.prepare('SELECT status FROM agents WHERE id = ?').get('mcp-task-1') as { status: string };
      const a2 = testDb.prepare('SELECT status FROM agents WHERE id = ?').get('mcp-task-2') as { status: string };
      expect(a1.status).toBe('stopped');
      expect(a2.status).toBe('running');
    });
  });

  describe('update_task_status spec compliance gate', () => {
    function seedChecklistItem(taskId: string, opts: { itemType?: string; content?: string; waived?: number } = {}) {
      testDb.prepare(`
        INSERT INTO spec_checklist_items (id, task_id, project_id, item_type, content, side, waived)
        VALUES (?, ?, 'proj-1', ?, ?, 'both', ?)
      `).run(crypto.randomUUID(), taskId, opts.itemType ?? 'ui_text', opts.content ?? '代理人設定作業', opts.waived ?? 0);
    }

    function seedRun(taskId: string, missing: number, missingContents: string[] = [], source: 'ai_review' | 'engine' = 'ai_review') {
      const results = [
        ...missingContents.map(c => ({ itemId: crypto.randomUUID(), itemType: 'ui_text', content: c, status: 'missing', note: '找不到' })),
        { itemId: crypto.randomUUID(), itemType: 'ui_text', content: 'ok-item', status: 'matched' },
      ];
      testDb.prepare(`
        INSERT INTO spec_compliance_runs (id, task_id, total, matched, missing, manual, waived, results_json, source)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
      `).run(crypto.randomUUID(), taskId, results.length, results.length - missing, missing, JSON.stringify(results), source);
    }

    function startTask(taskId = 'task-1') {
      seedProject(testDb);
      seedTask(testDb, taskId);
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    }

    it('blocks completed when task has a track (execution plan issued) but no checklist at all', async () => {
      startTask();
      testDb.prepare("UPDATE tasks SET flow_state = ? WHERE id = 'task-1'")
        .run(JSON.stringify({ track: 'light', trackReason: '自動判定：taskType=bug 且任務未綁定 SA/SD 規格文件' }));

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('尚未建立規格檢查表');
      expect(result.content[0].text).toContain('save_spec_checklist');
      expect(result.content[0].text).toContain('BUG 內容'); // light 軌指引
      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('in_progress');
    });

    it('checklist enforcement can be skipped with skipFlowGate + skipReason ([SKIP] logged)', async () => {
      startTask();
      testDb.prepare("UPDATE tasks SET flow_state = ? WHERE id = 'task-1'")
        .run(JSON.stringify({ track: 'light' }));

      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意：緊急 hotfix',
      });

      expect(result.isError).toBeUndefined();
      const skip = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[SKIP]%'").all() as Array<{ content: string }>;
      expect(skip.some(s => s.content.includes('未建立檢查表'))).toBe(true);
    });

    it('blocks completed when checklist items were added after the latest clean AI review (stale run)', async () => {
      startTask();
      // Clean AI review one hour ago...
      testDb.prepare(`
        INSERT INTO spec_compliance_runs (id, task_id, run_at, total, matched, missing, manual, waived, results_json, source)
        VALUES (?, 'task-1', datetime('now', '-1 hour'), 1, 1, 0, 0, 0, '[]', 'ai_review')
      `).run(crypto.randomUUID());
      // ...then a new checklist item added now (never verified)
      seedChecklistItem('task-1', { content: '事後新增的欄位' });

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('之後新增');
      expect(result.content[0].text).toContain('get_compliance_review_plan');
      const status = (testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string }).status;
      expect(status).toBe('in_progress');
    });

    it('blocks completed when checklist exists but no AI review run', async () => {
      startTask();
      seedChecklistItem('task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('AI 規格回對');
      expect(result.content[0].text).toContain('get_compliance_review_plan');
      expect(result.content[0].text).toContain('尚未執行');

      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('in_progress');
    });

    it('blocks completed when only an engine run (missing=0) exists — message points to AI review', async () => {
      startTask();
      seedChecklistItem('task-1');
      seedRun('task-1', 0, [], 'engine'); // clean 程式預檢 — advisory only

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('AI 規格回對');
      expect(result.content[0].text).toContain('get_compliance_review_plan');
      expect(result.content[0].text).toContain('程式預檢');

      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('in_progress');
    });

    it('blocks completed when latest run has missing > 0 and lists missing items', async () => {
      startTask();
      seedChecklistItem('task-1');
      seedRun('task-1', 1, ['主部門點選儲存']);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('規格回對未通過');
      expect(result.content[0].text).toContain('主部門點選儲存');
      expect(result.content[0].text).toContain('waive_checklist_item');
    });

    it('uses the LATEST ai_review run — an old failing review superseded by a clean review passes', async () => {
      startTask();
      seedChecklistItem('task-1');
      seedRun('task-1', 2, ['a', 'b']);
      // Newer clean AI review (same-second run_at — rowid tiebreak must pick this one)
      seedRun('task-1', 0);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('completed');
    });

    it('ignores a newer engine run — the latest ai_review run is what gates', async () => {
      startTask();
      seedChecklistItem('task-1');
      seedRun('task-1', 0); // clean AI review
      seedRun('task-1', 3, ['x', 'y', 'z'], 'engine'); // later failing 程式預檢 must NOT re-block

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('completed');
    });

    it('is not affected when the task has no checklist (backward compat)', async () => {
      startTask();

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('completed');
    });

    it('is not gated when all checklist items are waived', async () => {
      startTask();
      seedChecklistItem('task-1', { content: '已豁免的項目', waived: 1 });

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('logic-type items now count toward the gate (AI review can verify logic)', async () => {
      startTask();
      seedChecklistItem('task-1', { itemType: 'logic', content: '依日期倒序' });

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('AI 規格回對');
    });

    it('skipFlowGate=true with skipReason bypasses the compliance gate and logs [SKIP]', async () => {
      startTask();
      seedChecklistItem('task-1');
      seedRun('task-1', 1, ['缺的東西']);

      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意先結案',
      });
      expect(result.isError).toBeUndefined();
      const row = testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as { status: string };
      expect(row.status).toBe('completed');

      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('[SKIP] 使用者跳過規格回對閘門') && o.content.includes('使用者同意先結案'))).toBe(true);
    });

    it('skipFlowGate=true without skipReason is rejected', async () => {
      startTask();
      seedChecklistItem('task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', skipFlowGate: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skipReason');
    });
  });

  describe('sync_asana_tasks — auto spec change check', () => {
    function seedAsanaProject() {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, asana_project_gid) VALUES (?, ?, ?, ?)`).run(
        'proj-1', 'Test Project', '/tmp/project', 'pg-1',
      );
      testDb.prepare(`INSERT INTO global_config (key, value) VALUES ('asana.pat', 'test-pat')`).run();
    }

    function seedInProgressTaskWithSpecVersion(taskId = 'task-1') {
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES (?, 'proj-1', 'WA05 查詢作業', 'frontend', 'feature', 'in_progress')`).run(taskId);
      testDb.prepare(`INSERT INTO task_spec_versions (task_id, file_ref, last_modified) VALUES (?, 'https://svn/specs/SPEC_WA05_v1.docx', '2026-06-01 10:00:00')`).run(taskId);
    }

    function stubAsanaFetch() {
      vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('/users/me')) {
          return { ok: true, json: async () => ({ data: { gid: 'u1' } }) };
        }
        if (u.includes('/tasks?project=')) {
          return { ok: true, json: async () => ({ data: [] }) };
        }
        throw new Error(`unexpected fetch: ${u}`);
      }));
    }

    beforeEach(() => {
      vi.mocked(isSvnCliAvailable).mockReturnValue(true);
      vi.mocked(fetchRemoteLastModified).mockReturnValue(null);
      vi.mocked(fetchRemoteLastModified).mockClear();
      vi.mocked(isSvnCliAvailable).mockClear();
      stubAsanaFetch();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('runs the spec change check after sync and reports changes in specChangeCheck', async () => {
      seedAsanaProject();
      seedInProgressTaskWithSpecVersion();
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-07-01 09:00:00');

      const result = await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);

      expect(data.specChangeCheck).toMatchObject({ checked: 1, changed: 1 });
      expect(data.specChangeCheck.warning).toContain('spec gap');

      // spec_changed gap created + recorded version bumped
      const gaps = testDb.prepare('SELECT * FROM spec_gaps').all() as any[];
      expect(gaps).toHaveLength(1);
      expect(gaps[0].category).toBe('spec_changed');
      const version = testDb.prepare('SELECT last_modified FROM task_spec_versions WHERE task_id = ?').get('task-1') as any;
      expect(version.last_modified).toBe('2026-07-01 09:00:00');
    });

    it('applies a per-project cooldown: the second sync within 10 minutes skips the check', async () => {
      seedAsanaProject();
      seedInProgressTaskWithSpecVersion();
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-06-01 10:00:00'); // unchanged

      const first = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);
      expect(first.specChangeCheck).toMatchObject({ checked: 1, changed: 0 });
      expect(fetchRemoteLastModified).toHaveBeenCalledTimes(1);

      const second = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1', force: true })).content[0].text);
      expect(second.specChangeCheck).toMatchObject({ checked: 0, changed: 0, skipped: 'cooldown' });
      expect(fetchRemoteLastModified).toHaveBeenCalledTimes(1); // not called again
    });

    it('skips at zero cost when no in_progress task has spec version records', async () => {
      seedAsanaProject();
      // in_progress task WITHOUT task_spec_versions rows
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('task-1', 'proj-1', 'T', 'frontend', 'feature', 'in_progress')`).run();

      const data = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' })).content[0].text);
      expect(data.specChangeCheck).toMatchObject({ checked: 0, changed: 0, skipped: 'no_tasks_with_spec_versions' });
      expect(isSvnCliAvailable).not.toHaveBeenCalled();
      expect(fetchRemoteLastModified).not.toHaveBeenCalled();
    });

    it('sync still succeeds when SVN is unavailable — error is only annotated', async () => {
      seedAsanaProject();
      seedInProgressTaskWithSpecVersion();
      vi.mocked(isSvnCliAvailable).mockReturnValue(false);

      const result = await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined(); // sync itself succeeds
      const data = JSON.parse(result.content[0].text);
      expect(data.message).toContain('Asana sync completed');
      expect(data.specChangeCheck.error).toContain('svn CLI');
      expect(testDb.prepare('SELECT COUNT(*) as c FROM spec_gaps').get()).toEqual({ c: 0 });

      // no cooldown recorded on failure — the next sync retries the check
      vi.mocked(isSvnCliAvailable).mockReturnValue(true);
      vi.mocked(fetchRemoteLastModified).mockReturnValue('2026-06-01 10:00:00');
      const retry = JSON.parse((await callTool(server, 'sync_asana_tasks', { projectId: 'proj-1', force: true })).content[0].text);
      expect(retry.specChangeCheck).toMatchObject({ checked: 1, changed: 0 });
    });
  });
});
