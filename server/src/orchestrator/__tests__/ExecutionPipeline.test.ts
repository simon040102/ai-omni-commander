import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

// Create in-memory DB for tests
let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDb: () => testDb,
}));

// Mock AgentManager
const mockStartAgent = vi.fn().mockResolvedValue('agent-123');
const mockAgentManager = {
  startAgent: mockStartAgent,
};

// Mock EventBus
const mockEventBus = {
  emit: vi.fn(),
  on: vi.fn(),
};

// Mock DocumentParser
const mockDocumentParser = {
  getDocuments: vi.fn().mockReturnValue([]),
  getUploadDir: vi.fn().mockReturnValue('/tmp/uploads'),
};

import { ExecutionPipeline } from '../ExecutionPipeline.js';
import { createProject } from '../../db/queries/projects.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('ExecutionPipeline', () => {
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    testDb = freshDb();
    vi.clearAllMocks();
    pipeline = new ExecutionPipeline(
      mockAgentManager as any,
      mockEventBus as any,
      mockDocumentParser as any,
    );
  });

  describe('classifyTask()', () => {
    // Access private method through any cast
    const classify = (desc: string) => (pipeline as any).classifyTask(desc);

    it('classifies bug-related descriptions', () => {
      expect(classify('fix login bug')).toBe('bug');
      expect(classify('Fix the crash on submit')).toBe('bug');
      expect(classify('debug authentication error')).toBe('bug');
      expect(classify('hotfix for payment issue')).toBe('bug');
    });

    it('classifies refactor-related descriptions', () => {
      expect(classify('refactor auth module')).toBe('refactor');
      expect(classify('reorganize the utils folder')).toBe('refactor');
      expect(classify('clean up database queries')).toBe('refactor');
    });

    it('classifies feature-related descriptions', () => {
      expect(classify('add user profile page')).toBe('feature');
      expect(classify('implement dark mode')).toBe('feature');
      expect(classify('create new endpoint for orders')).toBe('feature');
      expect(classify('build the notification system')).toBe('feature');
    });

    it('defaults to other for ambiguous descriptions', () => {
      expect(classify('update documentation')).toBe('other');
      expect(classify('misc changes')).toBe('other');
    });
  });

  describe('selectSuperpowers()', () => {
    const select = (type: string) => (pipeline as any).selectSuperpowers(type);

    it('bug → debugging', () => {
      expect(select('bug')).toEqual(['debugging']);
    });

    it('feature → brainstorm + tdd', () => {
      expect(select('feature')).toEqual(['brainstorm', 'tdd']);
    });

    it('refactor → brainstorm', () => {
      expect(select('refactor')).toEqual(['brainstorm']);
    });

    it('other → empty', () => {
      expect(select('other')).toEqual([]);
    });
  });

  describe('resolveWorkingDir()', () => {
    const resolve = (project: any, label: string) => (pipeline as any).resolveWorkingDir(project, label);

    it('frontend label → frontendPath', () => {
      expect(resolve({ frontendPath: '/fe', backendPath: '/be', workingDir: '/root' }, 'frontend')).toBe('/fe');
    });

    it('backend label → backendPath', () => {
      expect(resolve({ frontendPath: '/fe', backendPath: '/be', workingDir: '/root' }, 'backend')).toBe('/be');
    });

    it('fallback to workingDir when frontendPath is null', () => {
      expect(resolve({ frontendPath: null, backendPath: null, workingDir: '/root' }, 'frontend')).toBe('/root');
    });

    it('unknown label → workingDir', () => {
      expect(resolve({ frontendPath: '/fe', backendPath: '/be', workingDir: '/root' }, 'devops')).toBe('/root');
    });
  });

  describe('executeAdHoc()', () => {
    it('spawns an agent via agentManager', async () => {
      createProject({ id: 'p-adhoc', name: 'AdHoc', workingDir: '/tmp/adhoc' });

      await pipeline.executeAdHoc('p-adhoc', 'Build a login page');

      expect(mockStartAgent).toHaveBeenCalledTimes(1);
      const call = mockStartAgent.mock.calls[0][0];
      expect(call.projectId).toBe('p-adhoc');
      expect(call.prompt).toContain('Build a login page');
    });

    it('uses specified model', async () => {
      createProject({ id: 'p-model', name: 'Model Test', workingDir: '/tmp/model' });

      await pipeline.executeAdHoc('p-model', 'test', 'opus');

      const call = mockStartAgent.mock.calls[0][0];
      expect(call.model).toBe('opus');
    });
  });

  describe('executeTask()', () => {
    it('creates a task-based execution', async () => {
      createProject({ id: 'p-task', name: 'Task Test', workingDir: '/tmp/task' });

      // Create a task in the DB
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES ('t1', 'p-task', 'Fix Login', 'The login form crashes', 'frontend', 'bug')
      `).run();

      await pipeline.executeTask('t1');

      expect(mockStartAgent).toHaveBeenCalledTimes(1);
      const call = mockStartAgent.mock.calls[0][0];
      expect(call.projectId).toBe('p-task');
      expect(call.taskId).toBe('t1');
      expect(call.prompt).toContain('Fix Login');
    });
  });

  describe('SVN spec fetch handling（規格不齊全不執行）', () => {
    const SVN_CONFIG_JSON = JSON.stringify({
      svnConfig: { frontendSpecUrl: 'https://svn.example.com/specs/fe', username: 'u', password: 'p' },
    });

    function createSvnProjectAndTask(projectId: string, taskId: string) {
      createProject({ id: projectId, name: 'SVN Test', workingDir: '/tmp/svn', configJson: SVN_CONFIG_JSON });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type, parent_name)
        VALUES (?, ?, 'WA05 查詢作業', '實作查詢頁', 'frontend', 'feature', 'WA05')
      `).run(taskId, projectId);
    }

    it('(c) fetch throws → plan starts with [SPEC_FETCH_ERROR] banner and docs section shows the error', async () => {
      createSvnProjectAndTask('p-svn-err', 't-err');
      const fetchSpecsForTask = vi.fn().mockRejectedValue(new Error('SVN 認證失敗 (E170001)'));
      pipeline.setSvnSpecService({ fetchSpecsForTask } as any);

      const plan = await pipeline.buildExecutionPlan('t-err');

      expect(fetchSpecsForTask).toHaveBeenCalledTimes(1);
      // Banner must be at the very front of the plan
      expect(plan.prompt.startsWith('⚠ [SPEC_FETCH_ERROR] 規格自動撈取失敗（SVN／規格資料夾）：SVN 認證失敗 (E170001)')).toBe(true);
      expect(plan.prompt).toContain('規格不齊全不執行');
      expect(plan.prompt).toContain('[SKIP] 使用者跳過規格檢查');
      // Docs section must show the error honestly, not "no documents"
      expect(plan.prompt).toContain('## 規格文件（自動取得：SVN／規格資料夾）');
      expect(plan.prompt).toContain('⚠ 撈取失敗：SVN 認證失敗 (E170001)');
    });

    it('(b) fetch succeeds with 0 documents → plan contains explicit "未找到規格文件" warning', async () => {
      createSvnProjectAndTask('p-svn-empty', 't-empty');
      const fetchSpecsForTask = vi.fn().mockResolvedValue([]);
      pipeline.setSvnSpecService({ fetchSpecsForTask } as any);

      const plan = await pipeline.buildExecutionPlan('t-empty');

      expect(fetchSpecsForTask).toHaveBeenCalledTimes(1);
      expect(plan.prompt).not.toContain('[SPEC_FETCH_ERROR]');
      expect(plan.prompt).toContain('未找到規格文件');
      expect(plan.prompt).toContain('WA05');
      expect(plan.prompt).toContain('規格不齊全不執行');
    });

    it('(a) SVN not configured → no fetch, no warning, plan builds as before', async () => {
      createProject({ id: 'p-nosvn', name: 'No SVN', workingDir: '/tmp/nosvn' });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type, parent_name)
        VALUES ('t-nosvn', 'p-nosvn', 'WA05 查詢作業', '實作查詢頁', 'frontend', 'feature', 'WA05')
      `).run();
      const fetchSpecsForTask = vi.fn();
      pipeline.setSvnSpecService({ fetchSpecsForTask } as any);

      const plan = await pipeline.buildExecutionPlan('t-nosvn');

      expect(fetchSpecsForTask).not.toHaveBeenCalled();
      expect(plan.prompt).not.toContain('[SPEC_FETCH_ERROR]');
      expect(plan.prompt).not.toContain('未找到規格文件');
      expect(plan.prompt).toContain('WA05 查詢作業');
    });

    it('(c) executeTask also carries the banner into the spawned agent prompt', async () => {
      createSvnProjectAndTask('p-svn-exec', 't-exec');
      const fetchSpecsForTask = vi.fn().mockRejectedValue(new Error('svn: E175002: connection refused'));
      pipeline.setSvnSpecService({ fetchSpecsForTask } as any);

      await pipeline.executeTask('t-exec');

      expect(mockStartAgent).toHaveBeenCalledTimes(1);
      const call = mockStartAgent.mock.calls[0][0];
      expect(call.prompt.startsWith('⚠ [SPEC_FETCH_ERROR] 規格自動撈取失敗（SVN／規格資料夾）：svn: E175002: connection refused')).toBe(true);
    });
  });

  describe('本地規格資料夾來源（specFolders 三態呈現）', () => {
    const FOLDER_CONFIG_JSON = JSON.stringify({
      specFolders: [{ path: 'D:\\specs\\demo', gitPull: true }],
    });
    const BOTH_CONFIG_JSON = JSON.stringify({
      svnConfig: { frontendSpecPath: 'https://svn.example.com/specs/fe' },
      specFolders: [{ path: 'D:\\specs\\demo', gitPull: true }],
    });

    function createFolderProjectAndTask(projectId: string, taskId: string, configJson: string) {
      createProject({ id: projectId, name: 'Folder Test', workingDir: '/tmp/folder', configJson });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type, parent_name)
        VALUES (?, ?, 'WA05 查詢作業', '實作查詢頁', 'frontend', 'feature', 'WA05')
      `).run(taskId, projectId);
    }

    function seedFolderDoc(projectId: string, taskId: string, docId: string) {
      testDb.prepare(`
        INSERT INTO documents (id, project_id, filename, file_path, doc_type, parsed_text, source, source_url)
        VALUES (?, ?, '[SA] SPEC_WA05.md', 'D:/specs/demo/SPEC_WA05.md', 'SA', ?, 'folder', 'D:/specs/demo/SPEC_WA05.md')
      `).run(docId, projectId, 'WA05 查詢作業規格內容。'.repeat(10));
      testDb.prepare('INSERT INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, docId);
    }

    it('資料夾來源有文件 + pull 警告 → 文件區塊列警告，無 error banner', async () => {
      createFolderProjectAndTask('p-fold-warn', 't-fold-warn', FOLDER_CONFIG_JSON);
      seedFolderDoc('p-fold-warn', 't-fold-warn', 'doc-fold-1');
      const fetchSpecsForTask = vi.fn();
      const fetchFolderSpecsForTask = vi.fn().mockResolvedValue({
        docIds: ['doc-fold-1'],
        warnings: ['D:\\specs\\demo: git pull --ff-only 失敗（使用現有內容）：timeout'],
        errors: [],
      });
      pipeline.setSvnSpecService({ fetchSpecsForTask, fetchFolderSpecsForTask } as any);

      const plan = await pipeline.buildExecutionPlan('t-fold-warn');

      expect(fetchSpecsForTask).not.toHaveBeenCalled(); // no svnConfig
      expect(fetchFolderSpecsForTask).toHaveBeenCalledTimes(1);
      expect(plan.prompt).not.toContain('[SPEC_FETCH_ERROR]');
      expect(plan.prompt).toContain('## 規格文件（自動取得：SVN／規格資料夾）');
      expect(plan.prompt).toContain('規格來源警告');
      expect(plan.prompt).toContain('git pull --ff-only 失敗（使用現有內容）：timeout');
      expect(plan.prompt).toContain('SPEC_WA05.md');
    });

    it('SVN 失敗但資料夾來源成功 → 錯誤降級為警告，不掛 banner', async () => {
      createFolderProjectAndTask('p-fold-rescue', 't-fold-rescue', BOTH_CONFIG_JSON);
      seedFolderDoc('p-fold-rescue', 't-fold-rescue', 'doc-fold-2');
      const fetchSpecsForTask = vi.fn().mockRejectedValue(new Error('SVN 認證失敗 (E170001)'));
      const fetchFolderSpecsForTask = vi.fn().mockResolvedValue({ docIds: ['doc-fold-2'], warnings: [], errors: [] });
      pipeline.setSvnSpecService({ fetchSpecsForTask, fetchFolderSpecsForTask } as any);

      const plan = await pipeline.buildExecutionPlan('t-fold-rescue');

      expect(plan.prompt).not.toContain('[SPEC_FETCH_ERROR]');
      expect(plan.prompt).toContain('規格來源警告');
      expect(plan.prompt).toContain('SVN 認證失敗 (E170001)');
    });

    it('SVN 與資料夾來源全失敗（0 文件）→ [SPEC_FETCH_ERROR] banner 包含兩者', async () => {
      createFolderProjectAndTask('p-fold-fail', 't-fold-fail', BOTH_CONFIG_JSON);
      const fetchSpecsForTask = vi.fn().mockRejectedValue(new Error('SVN 認證失敗 (E170001)'));
      const fetchFolderSpecsForTask = vi.fn().mockResolvedValue({
        docIds: [], warnings: [], errors: ['規格資料夾不存在或無法存取：D:\\specs\\demo'],
      });
      pipeline.setSvnSpecService({ fetchSpecsForTask, fetchFolderSpecsForTask } as any);

      const plan = await pipeline.buildExecutionPlan('t-fold-fail');

      expect(plan.prompt).toContain('[SPEC_FETCH_ERROR]');
      expect(plan.prompt).toContain('SVN 認證失敗 (E170001)');
      expect(plan.prompt).toContain('規格資料夾：規格資料夾不存在或無法存取');
    });
  });

  describe('強制開發規範注入（規格遵循 / 效能分析 / 安全檢查 / 驗收工具）', () => {
    function createTask(projectId: string, taskId: string, label: string, taskType: string) {
      createProject({ id: projectId, name: 'Mandate Test', workingDir: '/tmp/mandate' });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES (?, ?, 'WA05 查詢作業', '實作查詢頁', ?, ?)
      `).run(taskId, projectId, label, taskType);
    }

    it('frontend plan 含規格遵循（最高原則）+ 規格文件閱讀 + 驗收工具接線', async () => {
      createTask('p-fe', 't-fe', 'frontend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-fe');

      // 規格遵循（最高原則）
      expect(plan.prompt).toContain('## 規格遵循（最高原則 — 違反此規則等同任務失敗）');
      expect(plan.prompt).toContain('所有實作都必須有規格依據。規格沒寫的東西，不做。規格寫的東西，照做。');
      expect(plan.prompt).toContain('欄位名稱、按鈕文字、訊息文字 → 必須從 SA/SD 文件逐字抄');
      expect(plan.prompt).toContain('[NEEDS_CLARIFICATION]');
      // 規格文件閱讀協議（report_output 帶 taskId）
      expect(plan.prompt).toContain('## 規格文件閱讀（強制，寫 code 之前必須完成）');
      expect(plan.prompt).toContain('mcp__omni-commander__report_output(taskId="t-fe", content="...")');
      // 驗收工具接線（含 evidence）
      expect(plan.prompt).toContain('mcp__omni-commander__get_verification_plan(taskId="t-fe")');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_result(taskId="t-fe", results=[...])');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_evidence(taskId="t-fe", filePath=...)');
    });

    it('backend plan 含效能分析 + 安全檢查 + findAll 禁令 + 驗收工具接線', async () => {
      createTask('p-be', 't-be', 'backend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-be');

      expect(plan.prompt).toContain('## 效能分析（強制 — 寫 code 之前必須完成，用 report_output 記錄）');
      expect(plan.prompt).toContain('N+1 問題');
      expect(plan.prompt).toContain('⚠ 禁止 findAll() + Java 記憶體過濾');
      expect(plan.prompt).toContain('## 安全檢查（完成實作後逐項確認）');
      expect(plan.prompt).toContain('SQL 參數用 @Param 綁定，禁止字串拼接');
      expect(plan.prompt).toContain('mcp__omni-commander__get_verification_plan(taskId="t-be")');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_result(taskId="t-be", results=[...])');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_evidence(taskId="t-be", filePath=...)');
    });

    it('bug plan 修復策略含步驟 0（fetch_task_attachments + get_asana_task_comments）', async () => {
      createTask('p-bug', 't-bug', 'frontend', 'bug');

      const plan = await pipeline.buildExecutionPlan('t-bug');

      expect(plan.prompt).toContain('## 修復策略');
      expect(plan.prompt).toContain('0. **取得 BUG 現場**');
      expect(plan.prompt).toContain('mcp__omni-commander__fetch_task_attachments(projectId="p-bug", taskId="t-bug")');
      expect(plan.prompt).toContain('mcp__omni-commander__get_asana_task_comments(taskId="t-bug")');
    });

    it('非 backend（frontend）plan 不含效能分析與安全檢查區塊', async () => {
      createTask('p-fe2', 't-fe2', 'frontend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-fe2');

      expect(plan.prompt).not.toContain('## 效能分析');
      expect(plan.prompt).not.toContain('## 安全檢查');
      expect(plan.prompt).not.toContain('禁止 findAll()');
    });

    it('非 bug 任務策略不含取得 BUG 現場步驟', async () => {
      createTask('p-feat', 't-feat', 'frontend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-feat');

      expect(plan.prompt).not.toContain('fetch_task_attachments');
      expect(plan.prompt).toContain('## 開發策略');
    });

    it('report_spec_gap 出現在所有 role（frontend / backend / 其他）', async () => {
      createTask('p-all-fe', 't-all-fe', 'frontend', 'feature');
      createTask('p-all-be', 't-all-be', 'backend', 'feature');
      createTask('p-all-ot', 't-all-ot', 'devops', 'other');

      for (const tid of ['t-all-fe', 't-all-be', 't-all-ot']) {
        const plan = await pipeline.buildExecutionPlan(tid);
        expect(plan.prompt).toContain(`mcp__omni-commander__report_spec_gap(taskId="${tid}", category=..., description=...)`);
        expect(plan.prompt).toContain('category: sa_missing/sd_missing/field_undefined/api_undefined/logic_unclear/other');
      }
    });

    it('其他 role 的完成標準含 get_verification_plan + report_verification_result（不含 evidence）', async () => {
      createTask('p-ot', 't-ot', 'devops', 'other');

      const plan = await pipeline.buildExecutionPlan('t-ot');

      expect(plan.prompt).toContain('mcp__omni-commander__get_verification_plan(taskId="t-ot")');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_result(taskId="t-ot", results=[...])');
      expect(plan.prompt).not.toContain('report_verification_evidence');
    });

    it('規格檢查表（save_spec_checklist）+ 兩步規格回對（程式預檢 + AI 回對）出現在所有 role', async () => {
      createTask('p-cl-fe', 't-cl-fe', 'frontend', 'feature');
      createTask('p-cl-be', 't-cl-be', 'backend', 'feature');
      createTask('p-cl-ot', 't-cl-ot', 'devops', 'other');

      for (const tid of ['t-cl-fe', 't-cl-be', 't-cl-ot']) {
        const plan = await pipeline.buildExecutionPlan(tid);
        // 規格檢查表區塊（讀完規格後立即抽取，content 逐字抄）
        expect(plan.prompt).toContain('## 規格檢查表（強制 — 讀完規格後立即執行）');
        expect(plan.prompt).toContain(`mcp__omni-commander__save_spec_checklist(taskId="${tid}", items=[{itemType, content, side?, sourceRef?}, ...])`);
        expect(plan.prompt).toContain('itemType="logic"');
        // 第一步：run_spec_compliance 程式預檢（advisory，不解鎖閘門）
        expect(plan.prompt).toContain(`mcp__omni-commander__run_spec_compliance(taskId="${tid}")`);
        expect(plan.prompt).toContain('程式預檢');
        expect(plan.prompt).toContain('不解鎖完成閘門');
        expect(plan.prompt).toContain('waive_checklist_item');
        // 第二步：獨立 AI 回對（get_compliance_review_plan → save_compliance_review），missing=0 才可標 completed
        expect(plan.prompt).toContain('通知 orchestrator 派獨立 AI 回對 agent');
        expect(plan.prompt).toContain(`get_compliance_review_plan(taskId="${tid}")`);
        expect(plan.prompt).toContain('save_compliance_review');
        expect(plan.prompt).toContain('**missing=0 才可標 completed**');
        expect(plan.prompt).toContain('你（implementer）不可自行執行 AI 回對');
      }
    });

    it('executeAdHoc（無 taskId）工具呼叫範例省略 taskId 參數', async () => {
      createProject({ id: 'p-adhoc-mandate', name: 'AdHoc Mandate', workingDir: '/tmp/adhoc-mandate' });

      await pipeline.executeAdHoc('p-adhoc-mandate', 'fix the login crash');

      const call = mockStartAgent.mock.calls[0][0];
      expect(call.prompt).toContain('mcp__omni-commander__report_spec_gap(category=..., description=...)');
      expect(call.prompt).toContain('mcp__omni-commander__fetch_task_attachments(projectId="p-adhoc-mandate")');
      expect(call.prompt).not.toContain('taskId="undefined"');
      expect(call.prompt).not.toContain('docs/verification-reports/undefined.md');
    });
  });

  describe('任務軌道（light / full）prompt 變體', () => {
    function createTask(projectId: string, taskId: string, label: string, taskType: string) {
      createProject({ id: projectId, name: 'Track Test', workingDir: '/tmp/track' });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES (?, ?, 'SM27 查詢欄位失效', '計劃部門查詢欄位失效', ?, ?)
      `).run(taskId, projectId, label, taskType);
    }

    it('track=light：檢查表改抽 BUG 原文、規格閱讀改讀 BUG 原文、規格遵循含 light 註記', async () => {
      createTask('p-lt', 't-lt', 'frontend', 'bug');

      const plan = await pipeline.buildExecutionPlan('t-lt', undefined, undefined, undefined, undefined, 'light');

      // 規格檢查表 light 變體（BUG 原文抽取）
      expect(plan.prompt).toContain('## 規格檢查表（light 軌 — 從 BUG 原文抽取，強制）');
      expect(plan.prompt).toContain('修復後預期行為');
      expect(plan.prompt).toContain('itemType="logic"');
      expect(plan.prompt).toContain('mcp__omni-commander__get_asana_task_comments(taskId="t-lt")');
      expect(plan.prompt).toContain('mcp__omni-commander__fetch_task_attachments(projectId="p-lt", taskId="t-lt")');
      expect(plan.prompt).toContain('mcp__omni-commander__save_spec_checklist(taskId="t-lt"');
      expect(plan.prompt).toContain('計劃部門查詢欄位輸入值後查詢，結果正確過濾'); // 範例
      // 不含 SA/SD 閱讀強制節；改為 BUG 原文閱讀
      expect(plan.prompt).not.toContain('## 規格文件閱讀（強制，寫 code 之前必須完成）');
      expect(plan.prompt).not.toContain('## 規格檢查表（強制 — 讀完規格後立即執行）');
      expect(plan.prompt).toContain('## BUG 原文閱讀（light 軌 — 強制，寫 code 之前必須完成）');
      // 規格遵循（最高原則）保留 + light 語境註記
      expect(plan.prompt).toContain('## 規格遵循（最高原則 — 違反此規則等同任務失敗）');
      expect(plan.prompt).toContain('light 軌註記');
      expect(plan.prompt).toContain('現有程式碼慣例');
      // 完成標準：兩步規格回對照舊（missing=0 才可標 completed）
      expect(plan.prompt).toContain('mcp__omni-commander__run_spec_compliance(taskId="t-lt")');
      expect(plan.prompt).toContain('get_compliance_review_plan(taskId="t-lt")');
      expect(plan.prompt).toContain('**missing=0 才可標 completed**');
    });

    it('預設（未帶 track）維持 full：規格文件閱讀 / 規格檢查表照舊、無 light 內容', async () => {
      createTask('p-ft', 't-ft', 'frontend', 'bug');

      const plan = await pipeline.buildExecutionPlan('t-ft');

      expect(plan.prompt).toContain('## 規格檢查表（強制 — 讀完規格後立即執行）');
      expect(plan.prompt).toContain('## 規格文件閱讀（強制，寫 code 之前必須完成）');
      expect(plan.prompt).not.toContain('light 軌');
      expect(plan.prompt).not.toContain('## BUG 原文閱讀');
    });

    it('preparePromptForRole 也透傳 track=light', async () => {
      createTask('p-pr', 't-pr', 'frontend', 'bug');

      const plan = await pipeline.preparePromptForRole('t-pr', 'frontend', { track: 'light' });

      expect(plan.prompt).toContain('## 規格檢查表（light 軌 — 從 BUG 原文抽取，強制）');
      expect(plan.prompt).toContain('## BUG 原文閱讀（light 軌 — 強制，寫 code 之前必須完成）');
    });
  });
});
