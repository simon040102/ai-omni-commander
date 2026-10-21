import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { registerVerificationTools, UNRELATED_TEST_FAILURE_RULE, TEST_SCOPE_NOTE_RULE } from '../tools/verification-tools.js';
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

/**
 * 塞一筆 [DISPATCH] 派工快照——讓開發任務通過「執行計畫/派工記錄」完成閘門（R2），
 * 且不影響其他閘門（不寫 flow_state track，檢查表閘門行為不變）。
 */
function seedDispatch(db: Database.Database, taskId = 'task-1', projectId = 'proj-1') {
  db.prepare(`
    INSERT OR IGNORE INTO agents (id, project_id, role, status, model, current_task_id)
    VALUES (?, ?, 'backend', 'running', 'external', ?)
  `).run(`mcp-${taskId}`, projectId, taskId);
  db.prepare(`
    INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
    VALUES (?, ?, 'system', '[DISPATCH] {"at":"2026-01-01T00:00:00Z","meta":null,"prompt":"test dispatch"}')
  `).run(`mcp-${taskId}`, taskId);
}

describe('task-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerTaskTools(server);
  });

  describe('get_asana_task_comments — 非 Asana 任務', () => {
    // 派工 prompt（bug／light 軌）一律叫 agent 先抓 Asana 留言，並寫明「非 Asana 任務會回空，屬正常」。
    // 回錯誤會讓 agent 以為環境壞了去排查（實測 48 次無效呼叫）——照 prompt 的約定回空。
    it('任務沒有 Asana 來源 → 回空留言（不是錯誤），而且不打 Asana API', async () => {
      seedProject(testDb);
      seedTask(testDb);   // source_ref = null
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await callTool(server, 'get_asana_task_comments', { taskId: 'task-1' });
      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
      expect(data.comments).toEqual([]);
      expect(data.note).toContain('不是從 Asana 同步');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('任務不存在 → 仍然是錯誤（那是呼叫端給錯 id，不是「沒有留言」）', async () => {
      const result = await callTool(server, 'get_asana_task_comments', { taskId: 'no-such' });
      expect(result.isError).toBe(true);
    });
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

    // 實測 25 次超過輸出上限：預設回 100 筆、每筆完整描述、縮排 JSON。清單是拿來挑任務的，
    // 詳情本來就該 get_task——描述預設只帶摘錄，要全文另外開。
    describe('大小', () => {
      function seedLong(n: number, descLen: number) {
        seedProject(testDb);
        const ins = testDb.prepare(`INSERT INTO tasks (id, project_id, title, description, label, task_type) VALUES (?, 'proj-1', ?, ?, 'backend', 'feature')`);
        for (let i = 0; i < n; i++) ins.run(`t-${i}`, `任務 ${i}`, `描述 ${i}：${'說'.repeat(descLen)}`);
      }

      it('描述預設只帶前 200 字，並告訴你原本多長、全文去哪看', async () => {
        seedLong(1, 1000);
        const data = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1' })).content[0].text);
        const t = data.tasks[0];
        expect(t.description.length).toBeLessThanOrEqual(201);
        expect(t.descriptionLength).toBe(`描述 0：${'說'.repeat(1000)}`.length);
        expect(data.note ?? '').toContain('get_task');
      });

      it('fullDescription=true → 回完整描述', async () => {
        seedLong(1, 1000);
        const data = JSON.parse((await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', fullDescription: true })).content[0].text);
        expect(data.tasks[0].description).toBe(`描述 0：${'說'.repeat(1000)}`);
        expect(data.tasks[0]).not.toHaveProperty('descriptionLength');
      });

      it('整頁仍太大 → 少帶幾筆並給 nextOffset，回應是完整 JSON（不從中間截斷）', async () => {
        seedLong(100, 3000);
        const text = (await callTool(server, 'list_pending_tasks', { projectId: 'proj-1', fullDescription: true })).content[0].text;
        expect(text).not.toContain('[已截斷]');
        const data = JSON.parse(text);
        expect(data.count).toBeLessThan(100);
        expect(data.hasMore).toBe(true);
        expect(data.nextOffset).toBe(data.count);
      });
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

    it('attaches stalledHours + stalled to in_progress tasks (卡死偵測), not to other statuses', async () => {
      seedProject(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('ip-stale', 'proj-1', 'Stuck', 'backend', 'feature', 'in_progress')`).run();
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('ip-fresh', 'proj-1', 'Active', 'backend', 'feature', 'in_progress')`).run();
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-30 hours') WHERE id = 'ip-stale'`).run();
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-1 hours') WHERE id = 'ip-fresh'`).run();
      seedTask(testDb, 'pending-1'); // status default pending

      const data = JSON.parse((await callTool(server, 'list_pending_tasks', {
        projectId: 'proj-1', statuses: ['pending', 'in_progress'],
      })).content[0].text);
      expect(data.staleThresholdHours).toBe(24);

      const byId = Object.fromEntries(data.tasks.map((t: any) => [t.id, t]));
      expect(byId['ip-stale'].stalledHours).toBeGreaterThanOrEqual(29);
      expect(byId['ip-stale'].stalled).toBe(true);
      expect(byId['ip-fresh'].stalled).toBe(false);
      // pending task carries neither field
      expect(byId['pending-1'].stalledHours).toBeUndefined();
      expect(byId['pending-1'].stalled).toBeUndefined();
    });

    it('honors a custom staleThresholdHours', async () => {
      seedProject(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status) VALUES ('ip', 'proj-1', 'Stuck', 'backend', 'feature', 'in_progress')`).run();
      testDb.prepare(`UPDATE tasks SET updated_at = datetime('now','-10 hours') WHERE id = 'ip'`).run();

      const data = JSON.parse((await callTool(server, 'list_pending_tasks', {
        projectId: 'proj-1', statuses: ['in_progress'], staleThresholdHours: 5,
      })).content[0].text);
      expect(data.tasks[0].stalled).toBe(true);
      expect(data.staleThresholdHours).toBe(5);
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

  describe('get_execution_plan — 大計畫改寫檔交付（內容逐字不變）', () => {
    // 實測 10 月 260 次有 164 次超過回應上限（中位數 7.7 萬字）：orchestrator 要分段讀、
    // 派工時再整段抄進 subagent prompt（輸出 token、也可能抄漏）。內容一個字都不改，只改交付方式。
    let tmpDir: string;
    let prevDbPath: string | undefined;
    const BIG = Array.from({ length: 1500 }, (_, i) => `第 ${i + 1} 行：規格與規範內容，必須逐字保留。`).join('\n');

    function stubPlan(prompt: string) {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ prompt, workingDir: '/tmp/project', model: 'sonnet', frontendPath: '/tmp/project/web', backendPath: '/tmp/project/server' }),
      })));
    }

    beforeEach(() => {
      seedProject(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('task-1', 'proj-1', 'WA05 大計畫', 'frontend', 'feature')`).run();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-plan-'));
      prevDbPath = process.env['DB_PATH'];
      process.env['DB_PATH'] = path.join(tmpDir, 'omni.db');
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      if (prevDbPath === undefined) delete process.env['DB_PATH']; else process.env['DB_PATH'] = prevDbPath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('超過上限 → 全文寫進 data/plans，回應只給摘要＋檔案路徑＋行數＋派工方式；檔案內容就是原本的回應全文', async () => {
      stubPlan(BIG);
      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text as string;
      expect(text.length).toBeLessThan(5000);
      const planFile = path.join(tmpDir, 'plans', 'task-1-frontend-full.md');
      expect(text).toContain(planFile);
      const file = fs.readFileSync(planFile, 'utf-8');
      // 逐字：原本回應＝判軌段＋header＋分隔線＋Web Server 組的 prompt
      expect(file.startsWith('## 任務軌道：FULL（規格驅動流程）')).toBe(true);
      expect(file).toContain('**Task ID:** task-1');
      expect(file).toContain('## Flow-Gated Development');
      expect(file.endsWith('---\n\n' + BIG)).toBe(true);
      // 摘要要讓 orchestrator 不必讀全文就能派工
      const lines = file.split('\n').length;
      expect(text).toContain(`共 ${lines} 行`);
      expect(text).toContain('建議派工模型');
      expect(text).toContain('FULL');
      expect(text).toContain('不要摘要或改寫');
      expect(text).toContain('offset');
      // 閘門副作用照舊：full 軌啟用流程圖閘、留 [TRACK]
      expect((testDb.prepare('SELECT flow_required FROM tasks WHERE id = ?').get('task-1') as { flow_required: number }).flow_required).toBe(1);
    });

    it('小計畫 → 照舊整段放在回應裡，不寫檔', async () => {
      stubPlan('PLAN BODY');
      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-1' })).content[0].text as string;
      expect(text.startsWith('## 任務軌道：FULL（規格驅動流程）')).toBe(true);
      expect(text.endsWith('---\n\nPLAN BODY')).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'plans'))).toBe(false);
    });

    it('同一任務不同角色／軌道各自一份檔案，重取時覆蓋為最新內容', async () => {
      stubPlan(BIG + '\n舊版');
      await callTool(server, 'get_execution_plan', { taskId: 'task-1', role: 'backend' });
      stubPlan(BIG + '\n新版');
      await callTool(server, 'get_execution_plan', { taskId: 'task-1', role: 'backend' });
      const f = fs.readFileSync(path.join(tmpDir, 'plans', 'task-1-backend-full.md'), 'utf-8');
      expect(f.endsWith('新版')).toBe(true);
      expect(f).not.toContain('舊版');
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

      // 模型政策：light 軌建議 sonnet
      expect(text).toContain('**建議派工模型（給 orchestrator）:** sonnet');

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
      // 模型政策：full 軌建議 opus
      expect(text).toContain('**建議派工模型（給 orchestrator）:** opus');
    });

    it('任務有設 preferredModel → 建議派工模型以它為準（覆寫軌道預設）', async () => {
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, preferred_model) VALUES ('task-pm', 'proj-1', 'SM27 查詢', 'frontend', 'bug', 'haiku')`).run();

      const text = (await callTool(server, 'get_execution_plan', { taskId: 'task-pm' })).content[0].text;
      // light 軌預設 sonnet，但 preferredModel=haiku 優先
      expect(text).toContain('**建議派工模型（給 orchestrator）:** haiku');
      expect(text).toContain('任務 preferredModel 指定');
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
      seedDispatch(testDb); // 開發任務結案需有執行計畫/派工記錄（R2）

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
      seedDispatch(testDb, 'task-1'); // 開發任務結案需有執行計畫/派工記錄（R2）

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      const a1 = testDb.prepare('SELECT status FROM agents WHERE id = ?').get('mcp-task-1') as { status: string };
      const a2 = testDb.prepare('SELECT status FROM agents WHERE id = ?').get('mcp-task-2') as { status: string };
      expect(a1.status).toBe('stopped');
      expect(a2.status).toBe('running');
    });
  });

  describe('update_task_status open-gaps 結案提醒（E4——不擋、不是閘門）', () => {
    it('completed 成功回應附上仍 open 的規格缺口清單', async () => {
      seedProject(testDb);
      seedTask(testDb);
      seedDispatch(testDb);
      testDb.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description)
        VALUES ('gap-1', 'task-1', 'proj-1', 'field_undefined', '狀態欄位下拉選項未定義')
      `).run();
      // resolved 的缺口不進提醒
      testDb.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description, status, resolution_note, resolved_at)
        VALUES ('gap-2', 'task-1', 'proj-1', 'other', '已裁決的缺口甲乙丙', 'resolved', '選 B：刪除前 confirm 彈窗', '2026-01-01 00:00:00')
      `).run();

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('status updated to "completed"');
      expect(text).toContain('尚有 1 筆規格缺口未裁決');
      expect(text).toContain('不影響結案');
      expect(text).toContain('[field_undefined] 狀態欄位下拉選項未定義');
      expect(text).toContain('gapId=gap-1');
      expect(text).toContain('resolve_spec_gap(gapId, resolutionNote=具體裁決)');
      expect(text).not.toContain('已裁決的缺口甲乙丙');
      // 提醒不擋：任務真的 completed 了
      expect((testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as any).status).toBe('completed');
    });

    it('沒有 open 缺口時 completed 回應不出現提醒', async () => {
      seedProject(testDb);
      seedTask(testDb);
      seedDispatch(testDb);

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain('規格缺口未裁決');
    });

    it('failed 不附提醒；被閘門擋下的 completed 照舊回錯誤（提醒不改閘門判定）', async () => {
      seedProject(testDb);
      seedTask(testDb);
      // 不 seedDispatch → 執行計畫閘門會擋 completed
      testDb.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description)
        VALUES ('gap-1', 'task-1', 'proj-1', 'other', '未裁決缺口')
      `).run();

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const blocked = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(blocked.isError).toBe(true);
      expect(blocked.content[0].text).toContain('從未取得執行計畫或派工記錄');
      // 實測 10-08 後 18/18 跳過此閘的都是「子任務沒有自己的程式」，卻沒人用 coveredBy——訊息要先指這條路
      expect(blocked.content[0].text).toContain('coveredBy=');
      expect(blocked.content[0].text.indexOf('coveredBy=')).toBeLessThan(blocked.content[0].text.indexOf('skipGates='));
      expect(blocked.content[0].text).not.toContain('規格缺口未裁決');
      expect((testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as any).status).toBe('in_progress');

      const failed = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'failed', summary: 'x' });
      expect(failed.isError).toBeUndefined();
      expect(failed.content[0].text).not.toContain('規格缺口未裁決');
    });
  });

  describe('update_task_status 驗收覆蓋提醒（不擋、不是閘門）', () => {
    /** 塞一筆 [VERIFICATION] 回報（格式同 report_verification_result 寫入）。 */
    function seedVerification(taskId: string, lines: string[], projectId = 'proj-1') {
      testDb.prepare(`
        INSERT OR IGNORE INTO agents (id, project_id, role, status, model, current_task_id)
        VALUES (?, ?, 'backend', 'running', 'external', ?)
      `).run(`mcp-${taskId}`, projectId, taskId);
      testDb.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(`mcp-${taskId}`, taskId, `[VERIFICATION] 驗收：${lines.length}/${lines.length} 通過\n${lines.join('\n')}`);
    }

    it('backend 任務一項驗收都沒報 → 回應列出未報項目（含 API 煙霧測試）', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', 'proj-1', 'backend');
      seedDispatch(testDb);

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('項驗收未回報');
      expect(text).toContain('不影響結案');
      expect(text).toContain('be-api-smoke');
      expect(text).toContain('be-ddl-match');
      expect(text).toContain('report_verification_result');
      // 提醒不擋：任務真的 completed 了
      expect((testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1') as any).status).toBe('completed');
    });

    it('驗收項全部回報 → 不出現提醒', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', 'proj-1', 'backend');
      seedDispatch(testDb);
      seedVerification('task-1', [
        '- [PASS] be-no-findall — 已 grep',
        '- [PASS] be-ddl-match — 逐欄比對過',
        '- [PASS] be-api-smoke — curl 回 200',
        '- [PASS] be-seed-sql — 欄位數一致',
      ]);

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain('驗收未回報');
    });

    it('用項目文字（而非 id）回報也算已報，不誤列為未報', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', 'proj-1', 'backend');
      seedDispatch(testDb);
      seedVerification('task-1', [
        '- [PASS] 靜態檢查：沒有「撈全表 + 記憶體過濾」的查詢 — ok',
        '- [PASS] API 煙霧測試：每個新 API 回 200 不是 500 — ok',
      ]);

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      const text = result.content[0].text;
      expect(text).toContain('驗收未回報');
      // 文字回報的兩項不可出現在未報清單
      expect(text).not.toContain('be-api-smoke');
      expect(text).not.toContain('be-no-findall');
      // 沒報的仍要列出
      expect(text).toContain('be-ddl-match');
      expect(text).toContain('be-seed-sql');
    });

    it('frontend 任務只列前端驗收項，不列後端項目', async () => {
      seedProject(testDb);
      seedTask(testDb, 'task-1', 'proj-1', 'frontend');
      seedDispatch(testDb);

      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });

      const text = result.content[0].text;
      expect(text).toContain('fe-tsc');
      expect(text).toContain('fe-browser');
      expect(text).not.toContain('be-api-smoke');
    });

    it('非開發 label（testing）不附驗收提醒', async () => {
      seedProject(testDb);
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES ('t-other', 'proj-1', 'Doc task', 'testing', 'other')`).run();

      await callTool(server, 'update_task_status', { taskId: 't-other', status: 'in_progress' });
      const result = await callTool(server, 'update_task_status', { taskId: 't-other', status: 'completed' });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain('驗收未回報');
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
      seedDispatch(testDb, taskId); // 開發任務結案需有執行計畫/派工記錄（R2）——不影響檢查表閘門
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

  describe('update_task_status unit test gate（單元測試閘門）', () => {
    const TEST_CMD_CONFIG = JSON.stringify({
      frontendTestCommand: 'pnpm vitest run',
      backendTestCommand: 'mvn test',
    });

    function startTask(label = 'backend', configJson: string | null = TEST_CMD_CONFIG, taskId = 'task-1') {
      seedProject(testDb);
      if (configJson !== null) {
        testDb.prepare("UPDATE projects SET config_json = ? WHERE id = 'proj-1'").run(configJson);
      }
      seedTask(testDb, taskId, 'proj-1', label);
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
      seedDispatch(testDb, taskId); // 開發任務結案需有執行計畫/派工記錄（R2）
    }

    /** 走真實的 report_verification_result 寫入路徑——釘住寫入格式與閘門解析同步 */
    async function reportUnitTest(item: string, passed: boolean, note?: string, taskId = 'task-1') {
      const result = await callTool(server, 'report_verification_result', {
        taskId, results: [{ item, passed, ...(note ? { note } : {}) }],
      });
      expect(result.isError).toBeUndefined();
    }

    beforeEach(() => {
      // 閘門解析的是 report_verification_result 寫入的格式——同一 server 註冊兩組工具做整合測試
      registerVerificationTools(server);
    });

    it('backend 任務設 backendTestCommand + 無驗收回報 → 擋，訊息含實際指令字串與回報指引', async () => {
      startTask('backend');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('單元測試閘門');
      expect(result.content[0].text).toContain('backendTestCommand（mvn test）');
      expect(result.content[0].text).toContain('report_verification_result(taskId="task-1"');
      expect(result.content[0].text).toContain('be-unit-tests');
      expect(result.content[0].text).toContain('get_test_baseline_plan');
      // G4 第三處（閘門錯誤訊息）與常數全文同步（task-tools 直接插值 UNRELATED_TEST_FAILURE_RULE）
      expect(result.content[0].text).toContain(UNRELATED_TEST_FAILURE_RULE);
      // 擋下時直接告訴 agent「只跑相關測試也能過、但要標範圍」——否則它會改去求跳過整道閘
      expect(result.content[0].text).toContain(TEST_SCOPE_NOTE_RULE);

      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('in_progress');
    });

    it('最新一筆 passed=false → 擋（訊息指出未通過需重跑）', async () => {
      startTask('backend');
      await reportUnitTest('be-unit-tests', false, '3 個測試失敗');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('未通過（FAIL）');
      expect(result.content[0].text).toContain('mvn test');
    });

    it('passed=true → 放行', async () => {
      startTask('backend');
      await reportUnitTest('be-unit-tests', true, '全數通過');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('completed');
    });

    it('先 false 後 true（取最新一筆）→ 放行', async () => {
      startTask('backend');
      await reportUnitTest('be-unit-tests', false, '第一次失敗');
      await reportUnitTest('be-unit-tests', true, '修復後全綠');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('先 true 後 false（取最新一筆）→ 擋', async () => {
      startTask('backend');
      await reportUnitTest('be-unit-tests', true);
      await reportUnitTest('be-unit-tests', false, '回歸失敗');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
    });

    it('用 item 文字（非 id）回報也算——與 get_verification_plan 的回報約定一致', async () => {
      startTask('frontend');
      await reportUnitTest('單元測試全數通過（指令：pnpm vitest run）', true);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('note 含無關失敗清單不影響判定（G4：誠實揭露不被別人的債卡死）', async () => {
      startTask('frontend');
      await reportUnitTest('fe-unit-tests', true, '本任務相關測試全綠；無關失敗清單：legacy-date.test.ts（既有失敗，建議 get_test_baseline_plan）');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('沒設 testCommand 的專案此閘門不存在（行為與現在完全一致）', async () => {
      startTask('backend', null);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('frontend 任務只看 frontendTestCommand——回報 fe-unit-tests 即放行，不要求 be', async () => {
      startTask('frontend');
      await reportUnitTest('fe-unit-tests', true);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('fullstack 兩側都要：只回報一側 → 擋且訊息指向缺的那側', async () => {
      startTask('fullstack');
      await reportUnitTest('be-unit-tests', true);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('frontendTestCommand（pnpm vitest run）');
      expect(result.content[0].text).not.toContain('backendTestCommand');

      // 補回報另一側後放行
      await reportUnitTest('fe-unit-tests', true);
      const retry = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(retry.isError).toBeUndefined();
    });

    it('testing label → 兩側有設的都要（測試就是它的產出）', async () => {
      startTask('testing', JSON.stringify({ frontendTestCommand: 'pnpm vitest run' }));

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('frontendTestCommand（pnpm vitest run）');
    });

    it('devops label → 不受單元測試閘門管制（部署任務拿無關的前端全套結果交差＝假證據）', async () => {
      startTask('devops', JSON.stringify({ frontendTestCommand: 'pnpm vitest run' }));

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.content[0].text).not.toContain('frontendTestCommand（pnpm vitest run）');
    });

    it('skipFlowGate=true + skipReason 跳過此閘門並記 [SKIP] 稽核', async () => {
      startTask('backend');

      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意：測試環境故障',
      });
      expect(result.isError).toBeUndefined();
      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('completed');

      const outputs = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[SKIP]%'").all() as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('[SKIP] 使用者跳過單元測試閘門') && o.content.includes('測試環境故障'))).toBe(true);
    });

    it('skipFlowGate=true 無 skipReason → 拒絕', async () => {
      startTask('backend');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', skipFlowGate: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skipReason');
    });

    it('壞 config_json → 閘門安全關閉不擋（與 get_verification_plan 行為一致）', async () => {
      startTask('backend', '{broken json');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });
  });

  // 一個 skipFlowGate=true 會把所有沒過的閘一起跳掉——實際發生過「使用者只同意跳執行計畫閘，
  // 單元測試閘也被連帶跳掉」。skipGates 只跳列出的閘，其他沒過的照擋。
  describe('update_task_status skipGates（只跳指定的閘）', () => {
    // 同時讓「單元測試閘」與「執行計畫閘」都不過：設了 backendTestCommand 但沒回報單測、也沒有派工記錄
    function startTwoGateTask() {
      seedProject(testDb);
      testDb.prepare("UPDATE projects SET config_json = ? WHERE id = 'proj-1'").run(JSON.stringify({ backendTestCommand: 'mvn test' }));
      seedTask(testDb, 'task-1', 'proj-1', 'backend');
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-1'").run();
    }
    const skipRows = () => testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[SKIP]%'").all() as Array<{ content: string }>;
    const statusOf = () => (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;

    it('只跳單元測試閘 → 執行計畫閘照擋；任務沒結案，也不留任何 [SKIP]（沒結案就不該有跳過紀錄）', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['unit'], skipReason: '使用者同意只跑相關測試，全綠',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('執行計畫');
      expect(statusOf()).toBe('in_progress');
      expect(skipRows()).toEqual([]);
    });

    it('兩道都列 → 結案；兩道各留一筆 [SKIP]，回應列出跳過了哪些閘', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['unit', 'plan'], skipReason: '使用者同意：口頭派工緊急修復，只跑相關測試',
      });
      expect(result.isError).toBeUndefined();
      expect(statusOf()).toBe('completed');
      const rows = skipRows().map(r => r.content);
      expect(rows.some(c => c.includes('[SKIP] 使用者跳過單元測試閘門'))).toBe(true);
      expect(rows.some(c => c.includes('[SKIP] 使用者跳過執行計畫閘門'))).toBe(true);
      expect(result.content[0].text).toMatch(/跳過.*單元測試.*執行計畫|跳過.*執行計畫.*單元測試/);
    });

    it('列了一道其實沒擋的閘 → 不留那道的 [SKIP]（只記真的被跳過的）', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['unit', 'plan', 'verify'], skipReason: '使用者同意：口頭派工緊急修復，只跑相關測試',
      });
      expect(result.isError).toBeUndefined();
      expect(skipRows().some(r => r.content.includes('驗收結果閘門'))).toBe(false);
    });

    it('skipGates 沒帶 skipReason → 拒絕', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', skipGates: ['unit', 'plan'] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skipReason');
      expect(statusOf()).toBe('in_progress');
    });

    it('閘門擋下時，訊息教的是 skipGates=["該閘"]，不是全跳的 skipFlowGate', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skipGates=["unit"]');
    });

    it('舊的 skipFlowGate=true 仍全跳（相容），但回應明列這次連帶跳過的每一道閘', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意全部跳過',
      });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('單元測試');
      expect(text).toContain('執行計畫');
      expect(text).toContain('skipGates');
    });

    // ── 一次列出全部沒過的閘＋擋下留紀錄 ──
    // 原本遇到第一道沒過就 return，agent 修完一道再呼叫才看到下一道；擋下也不留紀錄，
    // 量不出各閘每月擋了多少次。判斷條件不變。
    const blockRows = () => testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[GATE_BLOCK]%'").all() as Array<{ content: string }>;

    it('兩道都沒過 → 一次列出兩道（不用來回呼叫才看到下一道）', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('2 道閘');
      expect(text).toContain('單元測試閘門未通過');
      expect(text).toContain('從未取得執行計畫');
      // 照建議修復順序：先補流程紀錄（執行計畫）、再測試
      expect(text.indexOf('從未取得執行計畫')).toBeLessThan(text.indexOf('單元測試閘門未通過'));
      expect(statusOf()).toBe('in_progress');
    });

    it('只有一道沒過 → 訊息維持原樣（不加多閘標題）', async () => {
      startTwoGateTask();
      seedDispatch(testDb);   // 補上派工記錄，只剩單元測試閘
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.startsWith('Error: 單元測試閘門未通過')).toBe(true);
    });

    it('擋下時寫一筆 [GATE_BLOCK]，列出被擋的閘；同一組閘短時間內重複擋不重寫', async () => {
      startTwoGateTask();
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      const rows = blockRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('unit');
      expect(rows[0].content).toContain('plan');
    });

    it('被擋的閘組合變了 → 再寫一筆', async () => {
      startTwoGateTask();
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      seedDispatch(testDb);
      await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      const rows = blockRows();
      expect(rows).toHaveLength(2);
      expect(rows[1].content).toContain('unit');
      expect(rows[1].content).not.toContain('plan');
    });

    it('跳過一道、另一道擋下 → [GATE_BLOCK] 只記真的擋下的那道，不記 [SKIP]', async () => {
      startTwoGateTask();
      await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['unit'], skipReason: '使用者同意只跑相關測試，全綠',
      });
      const rows = blockRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('plan');
      expect(rows[0].content).not.toMatch(/\bunit\b/);
      expect(skipRows()).toEqual([]);
    });

    it('全部通過結案 → 不寫 [GATE_BLOCK]', async () => {
      startTwoGateTask();
      await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['unit', 'plan'], skipReason: '使用者同意：口頭派工緊急修復，只跑相關測試',
      });
      expect(blockRows()).toEqual([]);
    });

    it('不認得的閘名 → 拒絕（參數驗證）', async () => {
      startTwoGateTask();
      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['everything'], skipReason: '使用者同意',
      });
      expect(result.isError).toBe(true);
      expect(statusOf()).toBe('in_progress');
    });
  });

  // 實測 9–10 月 26 張任務跳過執行計畫閘，全是同一型：一張報表拆成幾張子任務，工作都在
  // 其中一張做完並走完閘門，其餘子任務沒東西可驗、只能跳閘。coveredBy 是這種情況的正式出口：
  // 把證據接到那張真的走完閘門的任務上，而不是靠一句「無程式變更」。只解開執行計畫閘。
  describe('update_task_status coveredBy（已由別張任務涵蓋）', () => {
    function seedCompletedCover(id = 'task-cover', projectId = 'proj-1', extraOutput?: string) {
      seedTask(testDb, id, projectId, 'backend');
      testDb.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(id);
      if (extraOutput) {
        testDb.prepare(`INSERT OR IGNORE INTO agents (id, project_id, role, status, model) VALUES (?, ?, 'backend', 'stopped', 'external')`).run(`mcp-${id}`, projectId);
        testDb.prepare(`INSERT INTO agent_outputs (agent_id, task_id, stream_type, content) VALUES (?, ?, 'system', ?)`).run(`mcp-${id}`, id, extraOutput);
      }
    }
    function startSubTask(configJson: string | null = null) {
      seedProject(testDb);
      if (configJson) testDb.prepare("UPDATE projects SET config_json = ? WHERE id = 'proj-1'").run(configJson);
      seedTask(testDb, 'task-1', 'proj-1', 'frontend');   // 沒有執行計畫、沒有派工記錄
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = 'task-1'").run();
    }
    const close = (args: Record<string, unknown>) =>
      callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', ...args });
    const outputs = (prefix: string) =>
      testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE ?").all(`${prefix}%`) as Array<{ content: string }>;
    const NOTE = '使用者同意：本子任務無程式變更，前後端都在 task-cover 做完並驗過';

    it('涵蓋任務已乾淨結案 → 可結案；留 [COVERED_BY]、不留 [SKIP]', async () => {
      startSubTask();
      seedCompletedCover();
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE });
      expect(result.isError).toBeUndefined();
      expect(outputs('[COVERED_BY]')).toHaveLength(1);
      expect(outputs('[COVERED_BY]')[0].content).toContain('task-cover');
      expect(outputs('[SKIP]')).toEqual([]);
      expect(result.content[0].text).toContain('task-cover');
    });

    it('涵蓋＋同時跳過另一道閘 → 回應兩件事都講（不互相蓋掉）', async () => {
      startSubTask(JSON.stringify({ frontendTestCommand: 'pnpm vitest run' }));
      seedCompletedCover();
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE, skipGates: ['unit'], skipReason: '使用者同意：無程式變更，沒有可跑的相關測試' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('已由 task-cover 涵蓋');
      expect(result.content[0].text).toContain('跳過的閘門：單元測試');
    });

    it('沒寫 coverageNote → 拒絕', async () => {
      startSubTask();
      seedCompletedCover();
      const result = await close({ coveredBy: 'task-cover' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('coverageNote');
    });

    it('涵蓋任務還沒結案 → 拒絕', async () => {
      startSubTask();
      seedTask(testDb, 'task-cover', 'proj-1', 'backend');
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('尚未結案');
    });

    it('涵蓋任務自己是跳過閘門才結案的 → 拒絕（不能拿沒驗完的任務當證據）', async () => {
      startSubTask();
      seedCompletedCover('task-cover', 'proj-1', '[SKIP] 使用者跳過單元測試閘門：趕時間');
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('[SKIP]');
    });

    it('涵蓋任務自己也是「被涵蓋」結案的 → 拒絕（不准串鏈）', async () => {
      startSubTask();
      seedCompletedCover('task-cover', 'proj-1', '[COVERED_BY] task-x：…');
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE });
      expect(result.isError).toBe(true);
    });

    it('涵蓋任務在別的專案 → 拒絕', async () => {
      startSubTask();
      seedProject(testDb, 'proj-2');
      seedCompletedCover('task-cover', 'proj-2');
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE });
      expect(result.isError).toBe(true);
    });

    it('指向自己 → 拒絕', async () => {
      startSubTask();
      const result = await close({ coveredBy: 'task-1', coverageNote: NOTE });
      expect(result.isError).toBe(true);
    });

    it('只解開執行計畫閘：專案有設單元測試指令時，單元測試閘照擋，也不留 [COVERED_BY]', async () => {
      startSubTask(JSON.stringify({ frontendTestCommand: 'pnpm vitest run' }));
      seedCompletedCover();
      const result = await close({ coveredBy: 'task-cover', coverageNote: NOTE });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('單元測試閘門');
      expect(result.content[0].text).not.toContain('從未取得執行計畫');
      expect(outputs('[COVERED_BY]')).toEqual([]);
    });
  });

  describe('update_task_status execution plan gate（執行計畫/派工記錄閘門 — R2）', () => {
    function startBareTask(label = 'backend', taskId = 'task-1') {
      seedProject(testDb);
      seedTask(testDb, taskId, 'proj-1', label);
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    }

    function seedTrackOutput(taskId = 'task-1') {
      testDb.prepare(`
        INSERT OR IGNORE INTO agents (id, project_id, role, status, model, current_task_id)
        VALUES (?, 'proj-1', 'backend', 'running', 'external', ?)
      `).run(`mcp-${taskId}`, taskId);
      testDb.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', '[TRACK] light — 自動判定：taskType=bug 且任務未綁定 SA/SD 規格文件')
      `).run(`mcp-${taskId}`, taskId);
    }

    it('開發任務（backend）無 track/無 [TRACK]/無 [DISPATCH] → 擋，訊息指向 get_execution_plan 與 save_task_dispatch', async () => {
      startBareTask('backend');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('從未取得執行計畫或派工記錄');
      expect(result.content[0].text).toContain('get_execution_plan');
      expect(result.content[0].text).toContain('save_task_dispatch');

      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('in_progress');
    });

    it('通過途徑 (a)：flow_state 有 track → 不被此閘擋（改由檢查表閘門把關）', async () => {
      startBareTask('backend');
      testDb.prepare("UPDATE tasks SET flow_state = ? WHERE id = 'task-1'")
        .run(JSON.stringify({ track: 'light', trackReason: 'test' }));

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      // 有 track 但沒檢查表 → 被「檢查表存在」閘門擋，而不是執行計畫閘門
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain('從未取得執行計畫');
      expect(result.content[0].text).toContain('尚未建立規格檢查表');
    });

    it('通過途徑 (b)：agent_outputs 有 [TRACK] 稽核行 → 放行', async () => {
      startBareTask('backend');
      seedTrackOutput();

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
      expect((testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status).toBe('completed');
    });

    it('通過途徑 (c)：agent_outputs 有 [DISPATCH] 派工快照 → 放行（基線修復路徑）', async () => {
      startBareTask('frontend');
      seedDispatch(testDb, 'task-1');

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('fullstack 也受此閘管制；其他 label（devops/testing/review）不受管制', async () => {
      startBareTask('fullstack', 'task-fs');
      const fs = await callTool(server, 'update_task_status', { taskId: 'task-fs', status: 'completed' });
      expect(fs.isError).toBe(true);
      expect(fs.content[0].text).toContain('從未取得執行計畫');

      for (const [i, label] of ['devops', 'testing', 'review'].entries()) {
        const tid = `task-other-${i}`;
        seedTask(testDb, tid, 'proj-1', label);
        testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(tid);
        const result = await callTool(server, 'update_task_status', { taskId: tid, status: 'completed' });
        expect(result.isError).toBeUndefined();
      }
    });

    it('skipFlowGate=true + skipReason 跳過此閘並記 [SKIP]；無 skipReason 拒絕', async () => {
      startBareTask('backend');

      const noReason = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', skipFlowGate: true });
      expect(noReason.isError).toBe(true);
      expect(noReason.content[0].text).toContain('skipReason');

      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意：口頭派工的緊急修復',
      });
      expect(result.isError).toBeUndefined();
      const outputs = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[SKIP]%'").all() as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('[SKIP] 使用者跳過執行計畫閘門') && o.content.includes('口頭派工的緊急修復'))).toBe(true);
    });

    it('in_progress / failed 轉換不受此閘影響', async () => {
      startBareTask('backend');
      const r1 = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'failed', summary: 'boom' });
      expect(r1.isError).toBeUndefined();
      const r2 = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(r2.isError).toBeUndefined();
    });
  });

  describe('update_task_status verification result gate（驗收 FAIL 擋結案 — R5）', () => {
    function startTask(label = 'backend', configJson: string | null = null, taskId = 'task-1') {
      seedProject(testDb);
      if (configJson !== null) {
        testDb.prepare("UPDATE projects SET config_json = ? WHERE id = 'proj-1'").run(configJson);
      }
      seedTask(testDb, taskId, 'proj-1', label);
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
      seedDispatch(testDb, taskId); // 通過執行計畫閘門（R2）
    }

    async function report(results: Array<{ item: string; passed: boolean; note?: string }>, taskId = 'task-1') {
      const r = await callTool(server, 'report_verification_result', { taskId, results });
      expect(r.isError).toBeUndefined();
    }

    beforeEach(() => {
      // 走真實的 report_verification_result 寫入路徑——釘住寫入格式與閘門解析同步
      registerVerificationTools(server);
    });

    // ── 「不適用」第三態 ──
    // 實測 9–10 月約 1/4 的 PASS 其實寫著「N/A／不適用」，統計分不出真的驗過的有多少。
    // N/A 只是分開記錄，不打開任何後門：不能當單元測試通過、不能蓋掉先前的 FAIL。
    const reportRaw = (results: unknown[]) => callTool(server, 'report_verification_result', { taskId: 'task-1', results });

    it('回報 N/A：記成 [N/A]、摘要分開計、不出現「未通過」警告', async () => {
      startTask('backend');
      const r = await reportRaw([
        { item: 'be-api-smoke', passed: true, note: 'curl 200' },
        { item: 'be-ddl-match', notApplicable: true, note: '本任務沒有動到任何資料表' },
      ]);
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toContain('1/1 通過');
      expect(r.content[0].text).toContain('不適用 1 項');
      expect(r.content[0].text).not.toContain('未通過');
      const row = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[VERIFICATION]%'").get() as { content: string };
      expect(row.content).toContain('- [N/A] be-ddl-match — 本任務沒有動到任何資料表');
    });

    it('N/A 沒寫理由 → 拒絕（不適用一定要說為什麼）', async () => {
      startTask('backend');
      const r = await reportRaw([{ item: 'be-ddl-match', notApplicable: true }]);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('理由');
    });

    it('既沒給 passed 也沒標 N/A → 拒絕', async () => {
      startTask('backend');
      const r = await reportRaw([{ item: 'be-ddl-match', note: 'x' }]);
      expect(r.isError).toBe(true);
    });

    it('N/A 項不擋結案，也算「已回報」（不出現在未回報提醒）', async () => {
      startTask('backend');
      await reportRaw([{ item: 'be-ddl-match', notApplicable: true, note: '沒動資料表' }]);
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain('- be-ddl-match：');
    });

    it('先 FAIL 後改報 N/A → 仍然擋（N/A 不能拿來蓋掉失敗）', async () => {
      startTask('backend');
      await report([{ item: 'be-ddl-match', passed: false, note: '欄位缺 MODIFY_DATE' }]);
      await reportRaw([{ item: 'be-ddl-match', notApplicable: true, note: '改說不適用' }]);
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('be-ddl-match');
    });

    it('單元測試項報 N/A → 單元測試閘照擋（N/A 不能當作測試通過）', async () => {
      startTask('backend', JSON.stringify({ backendTestCommand: 'mvn test' }));
      await reportRaw([{ item: 'be-unit-tests', notApplicable: true, note: '說沒有可測的' }]);
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('單元測試閘門');
    });

    it('任一驗收項最新一筆為 FAIL → 擋，訊息列出 FAIL 項並指引重新回報', async () => {
      startTask('backend');
      await report([
        { item: 'be-no-findall', passed: true },
        { item: 'be-api-smoke', passed: false, note: 'GET /api/x 回 500' },
      ]);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('驗收結果閘門未通過');
      expect(result.content[0].text).toContain('- be-api-smoke');
      expect(result.content[0].text).not.toContain('- be-no-findall'); // PASS 項不列
      expect(result.content[0].text).toContain('report_verification_result(taskId="task-1"');

      const status = (testDb.prepare("SELECT status FROM tasks WHERE id = 'task-1'").get() as { status: string }).status;
      expect(status).toBe('in_progress');
    });

    it('同一項先 FAIL 後 PASS（取最新一筆）→ 放行', async () => {
      startTask('backend');
      await report([{ item: 'be-api-smoke', passed: false, note: '500' }]);
      await report([{ item: 'be-api-smoke', passed: true, note: '修復後 200' }]);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('從未回報過的項目不擋（只回報部分項且全 PASS → 放行）', async () => {
      startTask('backend');
      await report([{ item: 'be-no-findall', passed: true }]);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('完全沒有任何驗收回報 → 此閘不擋（涵蓋性由流程管）', async () => {
      startTask('backend');
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('與單元測試閘門共存不重複報錯：required 單測項 FAIL 由單元測試閘門先擋（單一錯誤）', async () => {
      startTask('backend', JSON.stringify({ backendTestCommand: 'mvn test' }));
      await report([{ item: 'be-unit-tests', passed: false, note: '3 個失敗' }]);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('單元測試閘門');
      expect(result.content[0].text).not.toContain('驗收結果閘門'); // 專屬閘門先擋，不重複報
    });

    it('單測項 FAIL＋使用者只同意跳單元測試閘 → 可結案，不必再多列 verify（同一個 FAIL 歸單元測試閘管）', async () => {
      startTask('backend', JSON.stringify({ backendTestCommand: 'mvn test' }));
      await report([{ item: 'be-unit-tests', passed: false, note: '3 個既有失敗' }]);

      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipGates: ['unit'], skipReason: '使用者同意：3 個失敗皆為既有問題，另開基線修復',
      });
      expect(result.isError).toBeUndefined();
      const skips = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[SKIP]%'").all() as Array<{ content: string }>;
      expect(skips.map(s => s.content).some(c => c.includes('驗收結果閘門'))).toBe(false);
    });

    it('單測項 FAIL＋另一個驗收項也 FAIL → 兩道都擋（單測歸單測閘、其他歸驗收閘）', async () => {
      startTask('backend', JSON.stringify({ backendTestCommand: 'mvn test' }));
      await report([
        { item: 'be-unit-tests', passed: false, note: '3 個失敗' },
        { item: 'be-ddl-match', passed: false, note: '欄位缺 MODIFY_DATE' },
      ]);
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain('單元測試閘門');
      expect(text).toContain('驗收結果閘門');
      expect(text).toContain('be-ddl-match');
    });

    it('單測項 PASS 但其他驗收項 FAIL → 由驗收結果閘門擋', async () => {
      startTask('backend', JSON.stringify({ backendTestCommand: 'mvn test' }));
      await report([
        { item: 'be-unit-tests', passed: true },
        { item: 'be-ddl-match', passed: false, note: '欄位缺 MODIFY_DATE' },
      ]);

      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('驗收結果閘門未通過');
      expect(result.content[0].text).toContain('- be-ddl-match');
    });

    it('skipFlowGate=true + skipReason 跳過此閘並記 [SKIP]', async () => {
      startTask('backend');
      await report([{ item: 'be-api-smoke', passed: false, note: '500' }]);

      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意：環境限制無法煙霧測試',
      });
      expect(result.isError).toBeUndefined();
      const outputs = testDb.prepare("SELECT content FROM agent_outputs WHERE task_id = 'task-1' AND content LIKE '[SKIP]%'").all() as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('[SKIP] 使用者跳過驗收結果閘門') && o.content.includes('環境限制'))).toBe(true);
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
