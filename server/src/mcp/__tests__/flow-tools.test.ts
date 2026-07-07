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
import { registerFlowTools } from '../tools/flow-tools.js';
import { registerTaskTools } from '../tools/task-tools.js';
import { getFlowState } from '../flow-gate.js';
import type { FlowGateState } from '../flow-gate.js';
import { callTool } from './test-helpers.js';

let tmpDataDir: string;

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

function seedSaDocument(db: Database.Database, projectId = 'proj-1', docType = 'SA') {
  db.prepare(`INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES (?, ?, ?, ?, ?)`).run(
    `doc-${docType}`, projectId, `SPEC_${docType}.docx`, `/tmp/spec-${docType}.docx`, docType,
  );
}

function setFlowState(db: Database.Database, taskId: string, state: FlowGateState, flowRequired = 1) {
  db.prepare('UPDATE tasks SET flow_required = ?, flow_state = ? WHERE id = ?')
    .run(flowRequired, JSON.stringify(state), taskId);
}

const MMD = 'flowchart TD\n  A[查詢資料] --> B[顯示清單]';
const MMD2 = 'flowchart TD\n  A[查詢資料] --> B[顯示清單] --> C[刪除]';

describe('flow-gated development', () => {
  let server: McpServer;
  let savedDbPath: string | undefined;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerFlowTools(server);
    registerTaskTools(server);
    // flow files resolve their dir from DB_PATH — point at an isolated temp dir
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-gate-test-'));
    savedDbPath = process.env['DB_PATH'];
    process.env['DB_PATH'] = path.join(tmpDataDir, 'omni.db');
    seedProject(testDb);
    seedTask(testDb);
  });

  afterEach(() => {
    if (savedDbPath === undefined) delete process.env['DB_PATH'];
    else process.env['DB_PATH'] = savedDbPath;
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  // ── migration ─────────────────────────────────────────────
  describe('migration', () => {
    it('is idempotent and adds flow columns', () => {
      runMigrations(testDb); // second run must not throw
      const cols = testDb.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
      const names = cols.map(c => c.name);
      expect(names).toContain('flow_required');
      expect(names).toContain('flow_state');
    });
  });

  // ── save_task_flow ────────────────────────────────────────
  describe('save_task_flow', () => {
    it('saves spec flow with legacy-compatible file pair and updates state', async () => {
      const result = await callTool(server, 'save_task_flow', {
        taskId: 'task-1', flowType: 'spec', mermaidContent: MMD, filename: 'SPEC_SA.docx',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('plan-flow');

      const state = getFlowState(testDb, 'task-1')!;
      expect(state.spec?.hash).toBeTruthy();

      // legacy naming pair so SaFlowAnalyzer.listProjectFlows / Web UI see it
      const flowsDir = path.join(tmpDataDir, 'sa-flows');
      const files = fs.readdirSync(flowsDir);
      expect(files).toContain(`proj-1-${state.spec!.hash}-flow.mmd`);
      expect(files).toContain(`proj-1-${state.spec!.hash}-meta.json`);
      const meta = JSON.parse(fs.readFileSync(path.join(flowsDir, `proj-1-${state.spec!.hash}-meta.json`), 'utf-8'));
      expect(meta.flowType).toBe('spec');
      expect(meta.taskIds).toContain('task-1');
    });

    it('plan response includes gate-A instructions with spec content when spec exists', async () => {
      setFlowState(testDb, 'task-1', { specExpected: true, roles: { default: { required: true, gateBFailures: 0 } } });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'spec', mermaidContent: MMD });
      const result = await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD2 });
      expect(result.content[0].text).toContain('閘門 A');
      expect(result.content[0].text).toContain('查詢資料'); // spec content inlined
    });

    it('plan response demands spec-flow first (no degrade) when specExpected but spec missing', async () => {
      setFlowState(testDb, 'task-1', { specExpected: true, roles: {} });
      const result = await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD });
      expect(result.content[0].text).toContain('spec-flow 尚未儲存');
      expect(result.content[0].text).toContain('不會因缺 spec-flow 而降級');
      expect(result.content[0].text).not.toContain('閘門 A（兩圖模式）');
    });

    it('plan response uses two-flow mode when specExpected=false', async () => {
      setFlowState(testDb, 'task-1', { specExpected: false, roles: {} });
      const result = await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD });
      expect(result.content[0].text).toContain('兩圖模式');
    });

    it('re-saving plan clears gateA and gateB for that role only', async () => {
      setFlowState(testDb, 'task-1', {
        roles: {
          default: { required: true, gateBFailures: 1, plan: { hash: 'x', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' }, gateB: { passed: true, checkedAt: 'now' } },
          frontend: { required: true, gateBFailures: 0, gateA: { passed: true, checkedAt: 'now' } },
        },
      });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD });
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.roles.default!.gateA).toBeUndefined();
      expect(state.roles.default!.gateB).toBeUndefined();
      expect(state.roles.default!.gateBFailures).toBe(1); // invalidation does NOT reset the counter
      expect(state.roles.frontend!.gateA).toBeDefined(); // other role untouched
    });

    it('re-saving code clears gateB but keeps gateA', async () => {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 0, gateA: { passed: true, checkedAt: 'now' }, gateB: { passed: true, checkedAt: 'now' } } },
      });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'code', mermaidContent: MMD });
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.roles.default!.gateA?.passed).toBe(true);
      expect(state.roles.default!.gateB).toBeUndefined();
    });

    it('re-saving spec clears gates for ALL roles', async () => {
      setFlowState(testDb, 'task-1', {
        roles: {
          frontend: { required: true, gateBFailures: 0, gateA: { passed: true, checkedAt: 'now' }, gateB: { passed: true, checkedAt: 'now' } },
          backend: { required: true, gateBFailures: 0, gateA: { passed: true, checkedAt: 'now' } },
        },
      });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'spec', mermaidContent: MMD });
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.roles.frontend!.gateA).toBeUndefined();
      expect(state.roles.frontend!.gateB).toBeUndefined();
      expect(state.roles.backend!.gateA).toBeUndefined();
    });

    it('role slots do not interfere', async () => {
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD, role: 'frontend' });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD2, role: 'backend' });
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.roles.frontend!.plan!.hash).not.toBe(state.roles.backend!.plan!.hash);
    });

    it('code save at failure cap responds with NEEDS_HUMAN', async () => {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 3, gateA: { passed: true, checkedAt: 'now' } } },
      });
      const result = await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'code', mermaidContent: MMD });
      expect(result.content[0].text).toContain('[NEEDS_HUMAN]');
    });

    it('resetFailures resets the counter and logs [RESET]', async () => {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 3, gateA: { passed: true, checkedAt: 'now' } } },
      });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'code', mermaidContent: MMD, resetFailures: true });
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.roles.default!.gateBFailures).toBe(0);
      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('[RESET]'))).toBe(true);
    });

    it('mindmap is stored without state machine effect', async () => {
      const result = await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'mindmap', mermaidContent: 'mindmap\n  root((表單))' });
      expect(result.content[0].text).toContain('不影響閘門');
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.spec).toBeUndefined();
      expect(Object.keys(state.roles)).toHaveLength(0);
    });

    it('rejects empty content and unknown task', async () => {
      const r1 = await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: '   ' });
      expect(r1.isError).toBe(true);
      const r2 = await callTool(server, 'save_task_flow', { taskId: 'nope', flowType: 'plan', mermaidContent: MMD });
      expect(r2.isError).toBe(true);
    });
  });

  // ── report_flow_check preconditions (C1 regression) ───────
  describe('report_flow_check preconditions', () => {
    it('rejects gate A without a saved plan-flow', async () => {
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'A', passed: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('plan-flow 尚未儲存');
    });

    it('rejects gate A when specExpected but spec-flow missing (I-1 regression)', async () => {
      setFlowState(testDb, 'task-1', {
        specExpected: true,
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' } } },
      });
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'A', passed: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('spec-flow 尚未儲存');
    });

    it('rejects gate B before gate A passed', async () => {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' }, code: { hash: 'y', savedAt: 'now' } } },
      });
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'B', passed: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('閘門 A 尚未通過');
    });

    it('rejects gate B without code-flow', async () => {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' } } },
      });
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'B', passed: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code-flow 尚未儲存');
    });

    it('hints when the flow exists in another role slot (I-2)', async () => {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' } } },
      });
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'A', passed: true, role: 'frontend' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('role=default');
    });
  });

  // ── report_flow_check state machine ───────────────────────
  describe('report_flow_check state', () => {
    function readyForGateA(specExpected = false) {
      setFlowState(testDb, 'task-1', {
        specExpected,
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' } } },
      });
    }
    function readyForGateB(failures = 0) {
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: failures, plan: { hash: 'x', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' }, code: { hash: 'y', savedAt: 'now' } } },
      });
    }

    it('gate A pass records state and instructs to implement', async () => {
      readyForGateA();
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'A', passed: true });
      expect(result.content[0].text).toContain('開始實作');
      expect(getFlowState(testDb, 'task-1')!.roles.default!.gateA!.passed).toBe(true);
    });

    it('gate A fail instructs to fix the plan, not to code', async () => {
      readyForGateA();
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'A', passed: false, diffs: '- 必修：缺少刪除分支' });
      expect(result.content[0].text).toContain('補計畫');
      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('缺少刪除分支'))).toBe(true);
    });

    it('gate B fail increments the failure counter (only on fail)', async () => {
      readyForGateB(0);
      await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'B', passed: false, diffs: '- 必修：X' });
      expect(getFlowState(testDb, 'task-1')!.roles.default!.gateBFailures).toBe(1);
    });

    it('third gate B failure responds with NEEDS_HUMAN', async () => {
      readyForGateB(2);
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'B', passed: false, diffs: '- 必修：X' });
      expect(result.content[0].text).toContain('[NEEDS_HUMAN]');
      expect(getFlowState(testDb, 'task-1')!.roles.default!.gateBFailures).toBe(3);
    });

    it('gate B pass resets the failure counter and unlocks testing', async () => {
      readyForGateB(2);
      const result = await callTool(server, 'report_flow_check', { taskId: 'task-1', gate: 'B', passed: true });
      expect(result.content[0].text).toContain('跑測試');
      const rs = getFlowState(testDb, 'task-1')!.roles.default!;
      expect(rs.gateB!.passed).toBe(true);
      expect(rs.gateBFailures).toBe(0);
    });
  });

  // ── get_task_flows ────────────────────────────────────────
  describe('get_task_flows', () => {
    it('returns flows, state and rubric', async () => {
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'spec', mermaidContent: MMD });
      await callTool(server, 'save_task_flow', { taskId: 'task-1', flowType: 'plan', mermaidContent: MMD2 });
      const result = await callTool(server, 'get_task_flows', { taskId: 'task-1' });
      const text = result.content[0].text;
      expect(text).toContain('spec-flow');
      expect(text).toContain('plan-flow');
      expect(text).toContain('比對準則');
    });

    it('reports when no flow state exists', async () => {
      const result = await callTool(server, 'get_task_flows', { taskId: 'task-1' });
      expect(result.content[0].text).toContain('尚無 flow 狀態');
    });
  });

  // ── update_task_status exit gate ──────────────────────────
  describe('update_task_status flow gate', () => {
    function inProgress(taskId = 'task-1') {
      testDb.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
    }

    it('rejects completed when gate B not passed', async () => {
      inProgress();
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' } } },
      });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('code-flow 未儲存');
    });

    it('rejects completed when one of two required roles has not passed gate B', async () => {
      inProgress();
      setFlowState(testDb, 'task-1', {
        roles: {
          frontend: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' }, code: { hash: 'y', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' }, gateB: { passed: true, checkedAt: 'now' } },
          backend: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' } },
        },
      });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('role=backend');
    });

    it('allows completed when every required role passed gate B', async () => {
      inProgress();
      setFlowState(testDb, 'task-1', {
        roles: { default: { required: true, gateBFailures: 0, plan: { hash: 'x', savedAt: 'now' }, code: { hash: 'y', savedAt: 'now' }, gateA: { passed: true, checkedAt: 'now' }, gateB: { passed: true, checkedAt: 'now' } } },
      });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', summary: 'done' });
      expect(result.isError).toBeUndefined();
      expect(testDb.prepare('SELECT status FROM tasks WHERE id = ?').get('task-1')).toEqual({ status: 'completed' });
    });

    it('rejects skipFlowGate without skipReason', async () => {
      inProgress();
      setFlowState(testDb, 'task-1', { roles: { default: { required: true, gateBFailures: 0 } } });
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed', skipFlowGate: true });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('skipReason');
    });

    it('skipFlowGate with reason completes and logs [SKIP]', async () => {
      inProgress();
      setFlowState(testDb, 'task-1', { roles: { default: { required: true, gateBFailures: 0 } } });
      const result = await callTool(server, 'update_task_status', {
        taskId: 'task-1', status: 'completed', skipFlowGate: true, skipReason: '使用者同意：純設定變更',
      });
      expect(result.isError).toBeUndefined();
      const outputs = testDb.prepare('SELECT content FROM agent_outputs WHERE task_id = ?').all('task-1') as Array<{ content: string }>;
      expect(outputs.some(o => o.content.includes('[SKIP]'))).toBe(true);
      expect(getFlowState(testDb, 'task-1')!.skipped?.reason).toContain('純設定變更');
    });

    it('does not gate tasks that never went through get_execution_plan', async () => {
      inProgress();
      const result = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'completed' });
      expect(result.isError).toBeUndefined();
    });

    it('does not gate failed / in_progress transitions', async () => {
      setFlowState(testDb, 'task-1', { roles: { default: { required: true, gateBFailures: 0 } } });
      const r1 = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'in_progress' });
      expect(r1.isError).toBeUndefined();
      const r2 = await callTool(server, 'update_task_status', { taskId: 'task-1', status: 'failed', summary: 'boom' });
      expect(r2.isError).toBeUndefined();
    });
  });

  // ── get_execution_plan flow initialization ────────────────
  describe('get_execution_plan flow init', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ prompt: 'do the thing', workingDir: '/tmp/project', model: 'sonnet', frontendPath: null, backendPath: null }),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sets flow_required, specExpected and required role on success', async () => {
      seedSaDocument(testDb);
      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1', role: 'backend' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Flow-Gated Development');

      const row = testDb.prepare('SELECT flow_required FROM tasks WHERE id = ?').get('task-1') as { flow_required: number };
      expect(row.flow_required).toBe(1);
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.specExpected).toBe(true);
      expect(state.roles.backend!.required).toBe(true);
    });

    it('specExpected=false without SA/SD docs, and two-flow instruction in prompt', async () => {
      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(getFlowState(testDb, 'task-1')!.specExpected).toBe(false);
      expect(result.content[0].text).toContain('兩圖模式');
    });

    it('merges into existing flow_state without wiping counters (C2 regression)', async () => {
      setFlowState(testDb, 'task-1', {
        specExpected: false,
        spec: { hash: 'abc', savedAt: 'now' },
        roles: { backend: { required: true, gateBFailures: 2 } },
      }, 0);
      await callTool(server, 'get_execution_plan', { taskId: 'task-1', role: 'backend' });
      const state = getFlowState(testDb, 'task-1')!;
      expect(state.roles.backend!.gateBFailures).toBe(2); // preserved
      expect(state.spec?.hash).toBe('abc');               // preserved
    });

    it('upgrades specExpected false→true when docs appear, never downgrades (I-1)', async () => {
      setFlowState(testDb, 'task-1', { specExpected: true, roles: {} }, 0);
      // no docs seeded → detection is false, but existing true must survive
      await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(getFlowState(testDb, 'task-1')!.specExpected).toBe(true);
    });

    it('does not set flow_required when the web server fetch fails (M6)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await callTool(server, 'get_execution_plan', { taskId: 'task-1' });
      expect(result.isError).toBe(true);
      const row = testDb.prepare('SELECT flow_required FROM tasks WHERE id = ?').get('task-1') as { flow_required: number };
      expect(row.flow_required).toBe(0);
    });
  });
});
