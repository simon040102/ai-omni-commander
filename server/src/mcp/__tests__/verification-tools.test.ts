import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import {
  registerVerificationTools,
  getRequiredUnitTestItems,
  parseTestCommands,
  findLatestUnitTestVerification,
  UNRELATED_TEST_FAILURE_RULE,
  NO_INSTALL_GUARD_RULE,
} from '../tools/verification-tools.js';
import { notifyWebServer } from '../notify.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedTask(db: Database.Database, label: string, id = 'task-1', configJson: string | null = null) {
  db.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES (?, ?, ?, ?)`).run('proj-1', 'Test', '/tmp', configJson);
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
    id, 'proj-1', 'Test Task', label, 'feature',
  );
}

const TEST_CMD_CONFIG = JSON.stringify({
  frontendTestCommand: 'pnpm vitest run',
  backendTestCommand: 'mvn test',
});

describe('verification-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerVerificationTools(server);
    vi.clearAllMocks();
  });

  describe('get_verification_plan', () => {
    it('returns backend checklist for backend tasks', async () => {
      seedTask(testDb, 'backend');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.label).toBe('backend');
      const ids = plan.items.map((i: any) => i.id);
      expect(ids).toEqual(['be-no-findall', 'be-ddl-match', 'be-api-smoke', 'be-seed-sql']);
      expect(plan.items.every((i: any) => i.item && i.how)).toBe(true);
    });

    it('returns frontend checklist for frontend tasks', async () => {
      seedTask(testDb, 'frontend');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.items.map((i: any) => i.id)).toEqual(['fe-tsc', 'fe-browser']);
    });

    it('returns both checklists for fullstack tasks', async () => {
      seedTask(testDb, 'fullstack');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.items).toHaveLength(6);
    });

    it('returns full list with note for other labels', async () => {
      seedTask(testDb, 'devops');
      const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
      const plan = JSON.parse(result.content[0].text);
      expect(plan.items).toHaveLength(6);
      expect(plan.note).toContain('devops');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'get_verification_plan', { taskId: 'nope' });
      expect(result.isError).toBe(true);
    });

    describe('unit test command items (config_json testCommand)', () => {
      it('backend task with backendTestCommand → be-unit-tests prepended with the command', async () => {
        seedTask(testDb, 'backend', 'task-1', TEST_CMD_CONFIG);
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        const plan = JSON.parse(result.content[0].text);
        expect(plan.items[0].id).toBe('be-unit-tests');
        expect(plan.items[0].item).toBe('單元測試全數通過（指令：mvn test）');
        // 後端清單不含前端的單元測試項
        expect(plan.items.map((i: any) => i.id)).not.toContain('fe-unit-tests');
      });

      it('frontend task with frontendTestCommand → fe-unit-tests prepended with the command', async () => {
        seedTask(testDb, 'frontend', 'task-1', TEST_CMD_CONFIG);
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        const plan = JSON.parse(result.content[0].text);
        expect(plan.items[0].id).toBe('fe-unit-tests');
        expect(plan.items[0].item).toBe('單元測試全數通過（指令：pnpm vitest run）');
        expect(plan.items.map((i: any) => i.id)).not.toContain('be-unit-tests');
      });

      it('fullstack task with both commands → both unit test items prepended', async () => {
        seedTask(testDb, 'fullstack', 'task-1', TEST_CMD_CONFIG);
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        const plan = JSON.parse(result.content[0].text);
        expect(plan.items[0].id).toBe('be-unit-tests');
        expect(plan.items[1].id).toBe('fe-unit-tests');
        expect(plan.items).toHaveLength(8);
      });

      it('no testCommand configured → no unit test items (existing lists unchanged)', async () => {
        seedTask(testDb, 'backend', 'task-1', JSON.stringify({ frontendExtraPrompt: 'x' }));
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        const plan = JSON.parse(result.content[0].text);
        expect(plan.items.map((i: any) => i.id)).toEqual(['be-no-findall', 'be-ddl-match', 'be-api-smoke', 'be-seed-sql']);
      });

      it('blank/whitespace testCommand is treated as not configured', async () => {
        seedTask(testDb, 'frontend', 'task-1', JSON.stringify({ frontendTestCommand: '   ' }));
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        const plan = JSON.parse(result.content[0].text);
        expect(plan.items.map((i: any) => i.id)).toEqual(['fe-tsc', 'fe-browser']);
      });

      it('corrupted config_json → falls back to no unit test items instead of throwing', async () => {
        seedTask(testDb, 'frontend', 'task-1', '{broken json');
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        expect(result.isError).toBeUndefined();
        const plan = JSON.parse(result.content[0].text);
        expect(plan.items.map((i: any) => i.id)).toEqual(['fe-tsc', 'fe-browser']);
      });

      it('unit test item how-text carries the unrelated-failure rule + baseline plan pointer (G4)', async () => {
        seedTask(testDb, 'frontend', 'task-1', TEST_CMD_CONFIG);
        const result = await callTool(server, 'get_verification_plan', { taskId: 'task-1' });
        const plan = JSON.parse(result.content[0].text);
        const unit = plan.items.find((i: any) => i.id === 'fe-unit-tests');
        expect(unit.how).toContain(UNRELATED_TEST_FAILURE_RULE);
        expect(unit.how).toContain('get_test_baseline_plan');
        expect(unit.how).toContain('不可順手修');
      });

      it('plan unit items always mirror getRequiredUnitTestItems（共用 helper，兩處行為一致）', async () => {
        testDb.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES ('proj-1', 'Test', '/tmp', ?)`).run(TEST_CMD_CONFIG);
        const unitIds = new Set(['fe-unit-tests', 'be-unit-tests']);
        const labels = ['frontend', 'backend', 'fullstack', 'devops'];
        for (let i = 0; i < labels.length; i++) {
          const label = labels[i]!;
          const taskId = `task-eq-${i}`;
          testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, 'proj-1', 'T', ?, 'feature')`)
            .run(taskId, label);
          const plan = JSON.parse((await callTool(server, 'get_verification_plan', { taskId })).content[0].text);
          const planUnitIds = plan.items.map((it: any) => it.id).filter((id: string) => unitIds.has(id));
          const helperIds = getRequiredUnitTestItems(label, parseTestCommands(TEST_CMD_CONFIG)).map(it => it.id);
          expect(planUnitIds).toEqual(helperIds);
        }
      });
    });
  });

  describe('getRequiredUnitTestItems / parseTestCommands（G1 共用 helper）', () => {
    const cmds = parseTestCommands(TEST_CMD_CONFIG);

    it('frontend label → 只有 fe-unit-tests', () => {
      expect(getRequiredUnitTestItems('frontend', cmds)).toEqual([
        { id: 'fe-unit-tests', side: 'frontend', command: 'pnpm vitest run' },
      ]);
    });

    it('backend label → 只有 be-unit-tests', () => {
      expect(getRequiredUnitTestItems('backend', cmds)).toEqual([
        { id: 'be-unit-tests', side: 'backend', command: 'mvn test' },
      ]);
    });

    it('fullstack / 其他 label → 兩側有設的都要', () => {
      expect(getRequiredUnitTestItems('fullstack', cmds).map(i => i.id)).toEqual(['be-unit-tests', 'fe-unit-tests']);
      expect(getRequiredUnitTestItems('devops', cmds).map(i => i.id)).toEqual(['be-unit-tests', 'fe-unit-tests']);
    });

    it('只設一側 → 其他 label 也只要求那一側；沒設 → 空', () => {
      const feOnly = parseTestCommands(JSON.stringify({ frontendTestCommand: 'npm test' }));
      expect(getRequiredUnitTestItems('fullstack', feOnly).map(i => i.id)).toEqual(['fe-unit-tests']);
      expect(getRequiredUnitTestItems('backend', feOnly)).toEqual([]);
      expect(getRequiredUnitTestItems('fullstack', parseTestCommands(null))).toEqual([]);
    });

    it('parseTestCommands：trim、空白視為未設定、壞 JSON 安全回空', () => {
      expect(parseTestCommands(JSON.stringify({ frontendTestCommand: '  npm test  ', backendTestCommand: '   ' })))
        .toEqual({ frontend: 'npm test', backend: undefined });
      expect(parseTestCommands('{broken')).toEqual({ frontend: undefined, backend: undefined });
      expect(parseTestCommands(null)).toEqual({ frontend: undefined, backend: undefined });
    });
  });

  describe('findLatestUnitTestVerification（閘門解析 report_verification_result 格式）', () => {
    const feReq = { id: 'fe-unit-tests' as const, side: 'frontend' as const, command: 'pnpm vitest run' };

    async function report(results: Array<{ item: string; passed: boolean; note?: string }>) {
      const r = await callTool(server, 'report_verification_result', { taskId: 'task-1', results });
      expect(r.isError).toBeUndefined();
    }

    it('無任何回報 → null；其他項目的回報不誤中', async () => {
      seedTask(testDb, 'frontend');
      expect(findLatestUnitTestVerification(testDb as any, 'task-1', feReq)).toBeNull();
      await report([{ item: 'fe-tsc', passed: true }]);
      expect(findLatestUnitTestVerification(testDb as any, 'task-1', feReq)).toBeNull();
    });

    it('取最新一筆：id 回報、item 文字回報都支援', async () => {
      seedTask(testDb, 'frontend');
      await report([{ item: 'fe-unit-tests', passed: false, note: '2 個失敗' }]);
      expect(findLatestUnitTestVerification(testDb as any, 'task-1', feReq)).toEqual({ passed: false });

      await report([{ item: '單元測試全數通過（指令：pnpm vitest run）', passed: true }]);
      expect(findLatestUnitTestVerification(testDb as any, 'task-1', feReq)).toEqual({ passed: true });
    });

    it('note 中提到其他 item id 不會誤中（只比對 item 欄位）', async () => {
      seedTask(testDb, 'frontend');
      await report([{ item: 'fe-tsc', passed: true, note: '順帶一提 fe-unit-tests 還沒跑' }]);
      expect(findLatestUnitTestVerification(testDb as any, 'task-1', feReq)).toBeNull();
    });
  });

  describe('get_test_baseline_plan', () => {
    const TEST_CMD_ONLY_BE = JSON.stringify({ backendTestCommand: 'mvn test' });

    function seedProjectWithPaths(configJson: string | null, opts: { fe?: string | null; be?: string | null } = {}) {
      testDb.prepare(`INSERT INTO projects (id, name, working_dir, frontend_path, backend_path, config_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('proj-1', 'Baseline Test', '/tmp', opts.fe !== undefined ? opts.fe : '/tmp/web', opts.be !== undefined ? opts.be : '/tmp/server', configJson);
    }

    it('returns error for non-existent project', async () => {
      const result = await callTool(server, 'get_test_baseline_plan', { projectId: 'nope' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('side=frontend 但未設 frontendTestCommand → 明確錯誤指路 update_project / Web 專案設定', async () => {
      seedProjectWithPaths(TEST_CMD_ONLY_BE);
      const result = await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1', side: 'frontend' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('未設定 frontendTestCommand');
      expect(result.content[0].text).toContain('update_project');
      expect(result.content[0].text).toContain('專案設定');
    });

    it('both（預設）但兩側都沒設 → 明確錯誤', async () => {
      seedProjectWithPaths(null);
      const result = await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('都未設定');
    });

    it('testCommand 有設但對應 workspace 路徑未設 → 明確錯誤', async () => {
      seedProjectWithPaths(TEST_CMD_ONLY_BE, { be: null });
      const result = await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1', side: 'backend' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('backendPath 未設定');
    });

    it('回傳計畫含 orchestrator 指示 + 三分類 + 禁裝擋板 + 嚴禁現狀當答案 + report_spec_gap', async () => {
      seedProjectWithPaths(TEST_CMD_CONFIG);
      const result = await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;

      // orchestrator 指示（風格比照 get_compliance_review_plan）
      expect(text).toContain('給 orchestrator 的指示');
      expect(text).toContain('create_task(projectId="proj-1"');
      expect(text).toContain('taskType="refactor"');
      expect(text).toContain('update_task_status(taskId, "in_progress")');
      // 三分類（每條失敗強制分類）
      expect(text).toContain('每條失敗強制三分類');
      expect(text).toContain('測試化石');
      expect(text).toContain('真 bug');
      expect(text).toContain('環境問題');
      expect(text).toContain('不改測試也不改程式');
      expect(text).toContain('建議另開 bug 任務');
      // 規格依據
      expect(text).toContain('fetch_svn_specs');
      expect(text).toContain('report_spec_gap');
      expect(text).toContain('嚴禁把程式現狀當正確答案改寫斷言');
      // 禁裝擋板（與 ExecutionPipeline / 常數同文）
      expect(text).toContain(NO_INSTALL_GUARD_RULE);
      // 重跑到綠 + skip 標注 + 總結
      expect(text).toContain('重跑全套到綠');
      expect(text).toContain('skip');
      // 完成後可開強制
      expect(text).toContain('單元測試強制');
    });

    it('side=backend → 只含 backend fixer prompt；both → 兩側都含（指令與 workspace 逐一入列）', async () => {
      seedProjectWithPaths(TEST_CMD_CONFIG);

      const be = (await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1', side: 'backend' })).content[0].text;
      expect(be).toContain('Fixer Prompt — backend');
      expect(be).toContain('mvn test');
      expect(be).toContain('/tmp/server');
      expect(be).not.toContain('Fixer Prompt — frontend');
      expect(be).not.toContain('pnpm vitest run');

      const both = (await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1' })).content[0].text;
      expect(both).toContain('Fixer Prompt — frontend');
      expect(both).toContain('Fixer Prompt — backend');
      expect(both).toContain('pnpm vitest run');
      expect(both).toContain('mvn test');
      expect(both).toContain('/tmp/web');
    });

    it('both 只設一側 → 只排入有設的那側（不報錯）', async () => {
      seedProjectWithPaths(TEST_CMD_ONLY_BE);
      const result = await callTool(server, 'get_test_baseline_plan', { projectId: 'proj-1' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      expect(text).toContain('Fixer Prompt — backend');
      expect(text).not.toContain('Fixer Prompt — frontend');
    });
  });

  describe('report_verification_result', () => {
    it('stores results in agent_outputs and notifies milestone 驗收：X/Y 通過', async () => {
      seedTask(testDb, 'backend');

      const result = await callTool(server, 'report_verification_result', {
        taskId: 'task-1',
        results: [
          { item: 'be-no-findall', passed: true },
          { item: 'be-api-smoke', passed: false, note: 'GET /api/x 回 500' },
        ],
      });

      expect(result.content[0].text).toContain('驗收：1/2 通過');
      expect(result.content[0].text).toContain('未通過');

      const outputs = testDb.prepare("SELECT * FROM agent_outputs WHERE agent_id = 'mcp-task-1'").all() as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].stream_type).toBe('system');
      expect(outputs[0].content).toContain('[VERIFICATION] 驗收：1/2 通過');
      expect(outputs[0].content).toContain('[FAIL] be-api-smoke — GET /api/x 回 500');

      const events = testDb.prepare("SELECT * FROM events WHERE event_type = 'task.milestone'").all() as any[];
      expect(events).toHaveLength(1);

      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.milestone',
        data: expect.objectContaining({ taskId: 'task-1', milestone: '驗收：1/2 通過' }),
      });
    });

    it('suggests completion when all pass', async () => {
      seedTask(testDb, 'frontend');
      const result = await callTool(server, 'report_verification_result', {
        taskId: 'task-1',
        results: [{ item: 'fe-tsc', passed: true }],
      });
      expect(result.content[0].text).toContain('全部通過');
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_verification_result', {
        taskId: 'nope', results: [{ item: 'x', passed: true }],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('report_verification_evidence', () => {
    let tmpDir: string;
    let prevDbPath: string | undefined;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-evidence-'));
      prevDbPath = process.env['DB_PATH'];
      // getDataDir() derives the data dir from DB_PATH
      process.env['DB_PATH'] = path.join(tmpDir, 'omni.db');
    });

    afterEach(() => {
      if (prevDbPath === undefined) delete process.env['DB_PATH'];
      else process.env['DB_PATH'] = prevDbPath;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('copies the file, writes documents (doc_type=verification) + binding + [EVIDENCE] output + milestone', async () => {
      seedTask(testDb, 'frontend');
      const srcPath = path.join(tmpDir, 'screenshot 1.png');
      fs.writeFileSync(srcPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await callTool(server, 'report_verification_evidence', {
        taskId: 'task-1', filePath: srcPath, description: 'WA05 查詢結果截圖',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Verification evidence saved');

      // copied into {dataDir}/uploads/{projectId}/verification/{taskId}/
      const destDir = path.join(tmpDir, 'uploads', 'proj-1', 'verification', 'task-1');
      const copied = fs.readdirSync(destDir);
      expect(copied).toEqual(['screenshot 1.png']);

      // documents row + task binding
      const doc = testDb.prepare("SELECT * FROM documents WHERE doc_type = 'verification'").get() as any;
      expect(doc).toBeTruthy();
      expect(doc.project_id).toBe('proj-1');
      expect(doc.filename).toBe('screenshot 1.png');
      expect(doc.file_type).toBe('image/png');
      const binding = testDb.prepare('SELECT * FROM task_documents WHERE document_id = ?').get(doc.id) as any;
      expect(binding.task_id).toBe('task-1');

      // [EVIDENCE] output line
      const outputs = testDb.prepare("SELECT * FROM agent_outputs WHERE agent_id = 'mcp-task-1'").all() as any[];
      expect(outputs).toHaveLength(1);
      expect(outputs[0].content).toBe('[EVIDENCE] WA05 查詢結果截圖');

      // milestone event + notify
      const events = testDb.prepare("SELECT * FROM events WHERE event_type = 'task.milestone'").all() as any[];
      expect(events).toHaveLength(1);
      expect(notifyWebServer).toHaveBeenCalledWith({
        event: 'task.milestone',
        data: expect.objectContaining({ taskId: 'task-1', milestone: '驗收證據：screenshot 1.png' }),
      });
    });

    it('de-duplicates filenames with a numeric suffix', async () => {
      seedTask(testDb, 'frontend');
      const srcPath = path.join(tmpDir, 'shot.png');
      fs.writeFileSync(srcPath, 'a');

      await callTool(server, 'report_verification_evidence', { taskId: 'task-1', filePath: srcPath });
      await callTool(server, 'report_verification_evidence', { taskId: 'task-1', filePath: srcPath });

      const destDir = path.join(tmpDir, 'uploads', 'proj-1', 'verification', 'task-1');
      expect(fs.readdirSync(destDir).sort()).toEqual(['shot-1.png', 'shot.png']);
    });

    it('returns a clear error for a non-existent file path', async () => {
      seedTask(testDb, 'frontend');
      const result = await callTool(server, 'report_verification_evidence', {
        taskId: 'task-1', filePath: path.join(tmpDir, 'missing.png'),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('檔案不存在');
      expect(testDb.prepare('SELECT COUNT(*) as c FROM documents').get()).toEqual({ c: 0 });
    });

    it('returns error for non-existent task', async () => {
      const result = await callTool(server, 'report_verification_evidence', { taskId: 'nope', filePath: 'x' });
      expect(result.isError).toBe(true);
    });
  });
});
