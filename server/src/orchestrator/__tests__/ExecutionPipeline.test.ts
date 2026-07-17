import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
// 只有測試可跨 web/MCP 邊界 import——用來釘住 ExecutionPipeline 手抄的 uiTextRule 與 MCP 常數同文
import { UI_TEXT_EXTRACTION_RULE } from '../../mcp/tools/compliance-tools.js';
// 同理：釘住單元測試區塊的「禁裝擋板」「無關失敗回報規則」與 verification-tools 常數同文
import { NO_INSTALL_GUARD_RULE, UNRELATED_TEST_FAILURE_RULE } from '../../mcp/tools/verification-tools.js';

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
    // executeTask 有 legacy spawn 前置閘（預設拒絕）——測試預設放行，閘門行為由專屬測試覆蓋
    process.env['ALLOW_LEGACY_SPAWN'] = '1';
    pipeline = new ExecutionPipeline(
      mockAgentManager as any,
      mockEventBus as any,
      mockDocumentParser as any,
    );
  });

  afterEach(() => {
    delete process.env['ALLOW_LEGACY_SPAWN'];
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

    it('ALLOW_LEGACY_SPAWN 未設時在任何副作用（含 SA flow spawn）之前就 throw', async () => {
      delete process.env['ALLOW_LEGACY_SPAWN'];
      createProject({ id: 'p-gate', name: 'Gate Test', workingDir: '/tmp/gate' });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES ('t-gate', 'p-gate', 'Fix Login', 'crash', 'frontend', 'bug')
      `).run();

      await expect(pipeline.executeTask('t-gate')).rejects.toThrow('spawn 派工已停用');
      expect(mockStartAgent).not.toHaveBeenCalled();
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

    it('backend plan 含效能分析 + 安全檢查 + 撈全表禁令（stack 中性） + 驗收工具接線', async () => {
      createTask('p-be', 't-be', 'backend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-be');

      expect(plan.prompt).toContain('## 效能分析（強制 — 寫 code 之前必須完成，用 report_output 記錄）');
      expect(plan.prompt).toContain('N+1 問題');
      expect(plan.prompt).toContain('⚠ 禁止「撈全表回程式記憶體再過濾」');
      expect(plan.prompt).toContain('## 安全檢查（完成實作後逐項確認）');
      expect(plan.prompt).toContain('SQL 一律參數綁定（prepared statement / ORM 參數），禁止字串拼接');
      // stack 中性：通用注入不得含特定專案/技術棧的寫死內容
      expect(plan.prompt).not.toContain('NaNa');
      expect(plan.prompt).not.toContain('MetaData.java');
      expect(plan.prompt).not.toContain('findAll');
      expect(plan.prompt).toContain('mcp__omni-commander__get_verification_plan(taskId="t-be")');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_result(taskId="t-be", results=[...])');
      expect(plan.prompt).toContain('mcp__omni-commander__report_verification_evidence(taskId="t-be", filePath=...)');
    });

    it('R4：專案有 dbConnections → backend plan 注入資料異動驗證；frontend 不注入', async () => {
      createProject({
        id: 'p-db', name: 'DB Verify Test', workingDir: '/tmp/dbv',
        configJson: JSON.stringify({ dbConnections: [{ id: 'c1', label: 'MAIN', server: 'localhost' }] }),
      });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES ('t-db-be', 'p-db', 'WA05 儲存', '實作儲存 API', 'backend', 'feature')
      `).run();
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES ('t-db-fe', 'p-db', 'WA05 畫面', '實作查詢頁', 'frontend', 'feature')
      `).run();

      const bePlan = await pipeline.buildExecutionPlan('t-db-be');
      expect(bePlan.prompt).toContain('## 資料異動驗證（強制 — 專案已綁定外部 DB）');
      expect(bePlan.prompt).toContain('mcp__omni-commander__query_external_db');
      expect(bePlan.prompt).toContain('欄位名以 describe_table 為準，嚴禁猜');

      const fePlan = await pipeline.buildExecutionPlan('t-db-fe');
      expect(fePlan.prompt).not.toContain('## 資料異動驗證');
    });

    it('R4：專案無 dbConnections → backend plan 不注入資料異動驗證', async () => {
      createTask('p-nodb', 't-nodb', 'backend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-nodb');
      expect(plan.prompt).not.toContain('## 資料異動驗證');
      expect(plan.prompt).toContain('## 效能分析'); // 其他 backend 規範照舊
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
      expect(plan.prompt).not.toContain('撈全表回程式記憶體再過濾');
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
        // P2：行為敘述句禁存 ui_text——斷言「全文」與 MCP 常數逐字相同（釘住兩處手抄同步）
        expect(plan.prompt).toContain(UI_TEXT_EXTRACTION_RULE);
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
      // P2：light 軌同守——全文與 MCP 常數逐字相同（釘住兩處手抄同步）
      expect(plan.prompt).toContain(UI_TEXT_EXTRACTION_RULE);
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

  describe('單元測試（強制流程）注入', () => {
    const TEST_CMD_CONFIG = JSON.stringify({
      frontendTestCommand: 'pnpm vitest run',
      backendTestCommand: 'mvn test',
    });

    function createTask(projectId: string, taskId: string, label: string, taskType: string, configJson?: string) {
      createProject({ id: projectId, name: 'UnitTest Test', workingDir: '/tmp/ut', configJson });
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES (?, ?, 'WA05 查詢作業', '實作查詢頁', ?, ?)
      `).run(taskId, projectId, label, taskType);
    }

    it('full 軌注入單元測試區塊：先列案例清單 + 規格出處 + report_spec_gap + 案例分類', async () => {
      createTask('p-ut-fe', 't-ut-fe', 'frontend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-fe');

      expect(plan.prompt).toContain('## 單元測試（強制流程 — 先列案例清單，再寫測試）');
      expect(plan.prompt).toContain('**先列測試案例清單，列完才准寫測試**');
      expect(plan.prompt).toContain('mcp__omni-commander__report_output(taskId="t-ut-fe", content="...") 回報完整案例清單');
      // 案例分類：正常流程 / 失敗路徑 / 邊界
      expect(plan.prompt).toContain('每個自己 side 的 logic 項至少一條成功案例');
      expect(plan.prompt).toContain('必填空值、格式/長度錯誤、資料不存在、權限不足、依賴失敗');
      expect(plan.prompt).toContain('邊界值、重複送出、特殊字元、分頁邊界');
      expect(plan.prompt).toContain('每條案例標注對應的 checklist itemId 或規格出處');
      // 失敗案例預期結果必須有規格出處（規格未定義禁止自創）
      expect(plan.prompt).toContain('**失敗案例的預期結果必須有規格出處**');
      expect(plan.prompt).toContain('mcp__omni-commander__report_spec_gap(taskId="t-ut-fe", category=..., description=...)');
      expect(plan.prompt).toContain('嚴禁編造預期值');
      expect(plan.prompt).toContain('不得 crash');
      // 測試名稱標注 itemId → AI 回對可引用 file+line
      expect(plan.prompt).toContain('測試名稱或註解標注對應的 itemId/規格出處');
      // 單元測試只驗邏輯（煙霧測試照舊）
      expect(plan.prompt).toContain('單元測試只驗邏輯，不驗 SQL 和欄位名');
      // full 軌案例來源：SA 流程 + 檢查表 logic 項 + Axure
      expect(plan.prompt).toContain('重讀 SA 操作流程、規格檢查表的 logic 項、Axure 畫面操作');
      // 注入位置：規格檢查表區塊之後
      const checklistIdx = plan.prompt.indexOf('## 規格檢查表');
      const unitTestIdx = plan.prompt.indexOf('## 單元測試（強制流程');
      expect(checklistIdx).toBeGreaterThan(-1);
      expect(unitTestIdx).toBeGreaterThan(checklistIdx);
    });

    it('light 軌變體：案例來源改為 BUG 原文重現步驟', async () => {
      createTask('p-ut-lt', 't-ut-lt', 'frontend', 'bug', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-lt', undefined, undefined, undefined, undefined, 'light');

      expect(plan.prompt).toContain('## 單元測試（強制流程 — 先列案例清單，再寫測試）');
      expect(plan.prompt).toContain('重讀 BUG 原文的重現步驟與預期行為');
      expect(plan.prompt).toContain('修復後預期行為）至少一條成功案例');
      expect(plan.prompt).not.toContain('重讀 SA 操作流程、規格檢查表的 logic 項、Axure 畫面操作');
    });

    it('frontend 任務注入 frontendTestCommand（不含 backend 指令）', async () => {
      createTask('p-ut-cmd-fe', 't-ut-cmd-fe', 'frontend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-cmd-fe');

      expect(plan.prompt).toContain('測試指令：`pnpm vitest run`');
      expect(plan.prompt).not.toContain('mvn test');
    });

    it('backend 任務注入 backendTestCommand（不含 frontend 指令）', async () => {
      createTask('p-ut-cmd-be', 't-ut-cmd-be', 'backend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-cmd-be');

      expect(plan.prompt).toContain('測試指令：`mvn test`');
      expect(plan.prompt).not.toContain('pnpm vitest run');
    });

    it('其他 role（兩個都設定）→ 前後端指令都列', async () => {
      createTask('p-ut-both', 't-ut-both', 'devops', 'other', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-both');

      expect(plan.prompt).toContain('前端 `pnpm vitest run`');
      expect(plan.prompt).toContain('後端 `mvn test`');
    });

    it('無 testCommand → 注入 fallback 文案（workspace CLAUDE.md 的測試指令 / 無測試指令則記錄後跳過）', async () => {
      createTask('p-ut-none', 't-ut-none', 'frontend', 'feature');

      const plan = await pipeline.buildExecutionPlan('t-ut-none');

      expect(plan.prompt).toContain('## 單元測試（強制流程 — 先列案例清單，再寫測試）');
      expect(plan.prompt).toContain('用 workspace CLAUDE.md 定義的測試指令');
      expect(plan.prompt).toContain('此 workspace 無測試指令');
      expect(plan.prompt).not.toContain('pnpm vitest run');
    });

    it('測試分層（S3）：開發迴圈跑相關測試檔、完成前必跑全套（閘門認全套結果）', async () => {
      createTask('p-ut-layer', 't-ut-layer', 'frontend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-layer');

      // 開發迴圈：相關測試檔即可（路徑過濾加快迭代）
      expect(plan.prompt).toContain('與本任務相關的測試檔');
      expect(plan.prompt).toContain('路徑過濾、gradle 的 --tests 過濾');
      // 結案前：全套原樣執行，全綠才回報 passed
      expect(plan.prompt).toContain('完成前必須跑全套');
      expect(plan.prompt).toContain('測試指令：`pnpm vitest run`');
      expect(plan.prompt).toContain('閘門認的是全套結果，相關測試綠不等於全套綠');
      // 舊措辭移除
      expect(plan.prompt).not.toContain('完成前全套再跑一次');
    });

    it('禁裝擋板（G2）：框架不存在嚴禁自行安裝或改建置檔，重試 3 次僅適用測試本身失敗——與 MCP 常數同文', async () => {
      createTask('p-ut-guard', 't-ut-guard', 'backend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-guard');

      // 釘住兩處手抄同步：prompt 逐字含 verification-tools 匯出的禁裝擋板全文
      expect(plan.prompt).toContain(NO_INSTALL_GUARD_RULE);
      expect(plan.prompt).toContain('**禁裝擋板**');
      expect(plan.prompt).toContain('嚴禁自行安裝任何套件或修改建置檔');
      expect(plan.prompt).toContain('package.json / pom.xml / build.gradle / lockfile 一律不可動');
      expect(plan.prompt).toContain('僅適用於**測試本身的失敗**');
    });

    it('只准動本任務相關的測試（G4）：無關失敗不可順手修、建議 get_test_baseline_plan、回報規則與 MCP 常數同文', async () => {
      createTask('p-ut-scope', 't-ut-scope', 'frontend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-scope');

      expect(plan.prompt).toContain('**只准新增/修改與本任務直接相關的測試**');
      expect(plan.prompt).toContain('不可順手修');
      expect(plan.prompt).toContain('固化成斷言');
      expect(plan.prompt).toContain('get_test_baseline_plan');
      // 釘住兩處手抄同步：與 get_verification_plan 驗收項描述同文的回報規則
      expect(plan.prompt).toContain(UNRELATED_TEST_FAILURE_RULE);
      expect(plan.prompt).toContain('mcp__omni-commander__report_output(taskId="t-ut-scope", content="...") 記錄無關失敗清單');
    });

    it('完成標準含單元測試步驟：build 之後、run_spec_compliance 之前，最終失敗標 failed', async () => {
      createTask('p-ut-cc', 't-ut-cc', 'backend', 'feature', TEST_CMD_CONFIG);

      const plan = await pipeline.buildExecutionPlan('t-ut-cc');

      expect(plan.prompt).toContain('Build 通過後跑單元測試');
      expect(plan.prompt).toContain('最多 3 次');
      expect(plan.prompt).toContain('mcp__omni-commander__update_task_status(taskId="t-ut-cc", status="failed", summary="單元測試失敗：...")');
      // 順序：build → 單元測試 → run_spec_compliance
      const buildIdx = plan.prompt.indexOf('- 執行 build 指令，確保零錯誤');
      const unitIdx = plan.prompt.indexOf('Build 通過後跑單元測試');
      const complianceIdx = plan.prompt.indexOf('mcp__omni-commander__run_spec_compliance(taskId="t-ut-cc")');
      expect(buildIdx).toBeGreaterThan(-1);
      expect(unitIdx).toBeGreaterThan(buildIdx);
      expect(complianceIdx).toBeGreaterThan(unitIdx);
    });

    it('executeAdHoc（無 taskId）單元測試區塊省略 taskId 參數', async () => {
      createProject({ id: 'p-ut-adhoc', name: 'UT AdHoc', workingDir: '/tmp/ut-adhoc' });

      await pipeline.executeAdHoc('p-ut-adhoc', 'add a helper');

      const call = mockStartAgent.mock.calls[0][0];
      expect(call.prompt).toContain('## 單元測試（強制流程 — 先列案例清單，再寫測試）');
      expect(call.prompt).not.toContain('taskId="undefined"');
    });
  });
});
