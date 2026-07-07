/**
 * Flow-Gated Development — shared state machine logic.
 *
 * Three business-step-level Mermaid flowcharts per task (spec / plan / code)
 * with two gates:
 *   Gate A (before coding):  plan-flow covers every spec-flow step/branch
 *   Gate B (before testing): code-flow matches plan-flow AND spec-flow
 *
 * The MCP server stores flows, validates STRUCTURAL preconditions, counts
 * gate-B failures, and injects next-step instructions into tool responses.
 * The semantic comparison itself is done by the calling LLM (see FLOW_COMPARE_RUBRIC).
 *
 * Design doc: docs/superpowers/specs/2026-07-02-flow-gated-development-design.md
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir, ensureMcpAgent } from './helpers.js';

export type FlowRole = 'frontend' | 'backend' | 'default';
export type FlowType = 'spec' | 'plan' | 'code' | 'mindmap';

export interface FlowRef {
  hash: string;
  savedAt: string;
}

export interface GateResult {
  passed: boolean;
  checkedAt: string;
  diffs?: string;
}

export interface RoleFlowState {
  required: boolean;
  plan?: FlowRef;
  code?: FlowRef;
  gateA?: GateResult;
  gateB?: GateResult;
  gateBFailures: number;
}

export interface FlowGateState {
  /**
   * Whether this task has SA/SD spec documents — the SINGLE source of truth
   * for three-flow vs two-flow mode (review I-1). Set by get_execution_plan
   * from the documents table; upgrade-only (false→true when docs are added
   * later, never downgraded — removing docs must not bypass spec comparison).
   */
  specExpected?: boolean;
  /** Task-shared spec flow; save_task_flow('spec') ignores the role param. */
  spec?: FlowRef;
  roles: Partial<Record<FlowRole, RoleFlowState>>;
  skipped?: { reason: string; at: string };
}

export const GATE_B_MAX_FAILURES = 3;

// ── state persistence ───────────────────────────────────────

export function resolveRole(role?: string | null): FlowRole {
  return role === 'frontend' || role === 'backend' ? role : 'default';
}

export function emptyRoleState(required = false): RoleFlowState {
  return { required, gateBFailures: 0 };
}

export function getFlowState(db: Database.Database, taskId: string): FlowGateState | null {
  const row = db.prepare('SELECT flow_state FROM tasks WHERE id = ?').get(taskId) as { flow_state: string | null } | undefined;
  if (!row?.flow_state) return null;
  try {
    const state = JSON.parse(row.flow_state) as FlowGateState;
    if (!state.roles) state.roles = {};
    return state;
  } catch {
    return null;
  }
}

export function saveFlowState(db: Database.Database, taskId: string, state: FlowGateState): void {
  db.prepare("UPDATE tasks SET flow_state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(state), taskId);
}

/**
 * Read-modify-write flow_state atomically via an IMMEDIATE transaction —
 * the write lock is taken up-front so a concurrent process (Web Server shares
 * the same SQLite file) cannot interleave between our read and write.
 */
export function mutateFlowState(
  db: Database.Database,
  taskId: string,
  fn: (state: FlowGateState) => void,
): FlowGateState {
  const txn = db.transaction(() => {
    const state = getFlowState(db, taskId) ?? { roles: {} };
    fn(state);
    saveFlowState(db, taskId, state);
    return state;
  });
  return txn.immediate();
}

export function getRoleState(state: FlowGateState, role: FlowRole): RoleFlowState {
  if (!state.roles[role]) state.roles[role] = emptyRoleState();
  return state.roles[role]!;
}

// ── flow file storage (legacy sa-flows compatible) ──────────

/** Resolve data/sa-flows dir from DB_PATH (same convention as save_sa_flow). */
export function getFlowsDir(): string {
  const flowsDir = path.join(getDataDir(), 'sa-flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  return flowsDir;
}

/**
 * Save a flow using the legacy naming pair so SaFlowAnalyzer.listProjectFlows()
 * and the Web UI SA Flow panel pick it up without changes:
 *   {projectId}-{hash}-flow.mmd  +  {projectId}-{hash}-meta.json
 * Meta is extended with flowType / taskId / role.
 */
export function saveFlowFile(opts: {
  projectId: string;
  taskId?: string;
  flowType: FlowType;
  role: FlowRole;
  mermaidContent: string;
  filename?: string;
}): { hash: string; flowPath: string } {
  const flowsDir = getFlowsDir();
  const hash = crypto.createHash('sha256').update(opts.mermaidContent).digest('hex').slice(0, 16);
  const flowPath = path.join(flowsDir, `${opts.projectId}-${hash}-flow.mmd`);
  const metaPath = path.join(flowsDir, `${opts.projectId}-${hash}-meta.json`);

  fs.writeFileSync(flowPath, opts.mermaidContent, 'utf-8');

  let meta: Record<string, unknown> = {};
  if (fs.existsSync(metaPath)) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { /* ignore */ }
  }
  meta.hash = hash;
  meta.generatedAt = new Date().toISOString();
  meta.filename = opts.filename || `${opts.flowType}-flow${opts.taskId ? ` (task ${opts.taskId})` : ''}`;
  meta.projectId = opts.projectId;
  meta.flowType = opts.flowType;
  meta.role = opts.role;
  if (!Array.isArray(meta.taskIds)) meta.taskIds = [];
  if (opts.taskId && !(meta.taskIds as string[]).includes(opts.taskId)) {
    (meta.taskIds as string[]).push(opts.taskId);
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  return { hash, flowPath };
}

export function readFlowFile(projectId: string, hash: string): string | null {
  const flowPath = path.join(getFlowsDir(), `${projectId}-${hash}-flow.mmd`);
  try {
    return fs.readFileSync(flowPath, 'utf-8');
  } catch {
    return null;
  }
}

// ── task-output logging (same channel as report_output) ────

/**
 * Write a system-type line into agent_outputs under the synthetic mcp-{taskId}
 * agent, creating the agent record if needed (mirrors progress-tools behavior).
 */
export function logTaskOutput(db: Database.Database, taskId: string, projectId: string, content: string): void {
  const { agentId } = ensureMcpAgent(db, taskId, projectId);
  db.prepare(`
    INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
    VALUES (?, ?, 'system', ?)
  `).run(agentId, taskId, content);
}

/**
 * Determine whether a task has SA/SD spec documents (review I-1 single source).
 * task_documents links take priority; falls back to project-level documents.
 */
export function detectSpecDocuments(db: Database.Database, taskId: string, projectId: string): boolean {
  const taskDoc = db.prepare(`
    SELECT 1 FROM task_documents td JOIN documents d ON d.id = td.document_id
    WHERE td.task_id = ? AND d.doc_type IN ('SA','SD') LIMIT 1
  `).get(taskId);
  if (taskDoc) return true;
  const projDoc = db.prepare(
    "SELECT 1 FROM documents WHERE project_id = ? AND doc_type IN ('SA','SD') LIMIT 1"
  ).get(projectId);
  return !!projDoc;
}

/** Find which other role slots hold a given flow — for role-mismatch hints (review I-2). */
export function findFlowInOtherRoles(state: FlowGateState, flow: 'plan' | 'code', excludeRole: FlowRole): FlowRole[] {
  return (Object.entries(state.roles) as Array<[FlowRole, RoleFlowState]>)
    .filter(([r, rs]) => r !== excludeRole && rs?.[flow])
    .map(([r]) => r);
}

// ── comparison rubric (injected into tool responses) ────────

export const FLOW_COMPARE_RUBRIC = `## 流程圖比對準則（語意比對，不是字面 diff）

節點措辭必然有出入，用語意判斷等價性：「查詢符合條件的資料」≈「依條件查詢清單」。

**必修（判定不符）：**
- spec-flow 的某個步驟/分支在 code-flow 完全沒有對應節點
- 順序顛倒導致邏輯錯誤（例如先寫入才驗證）
- 條件分支缺失（規格有「有/無資料」兩條路，code 只有一條）

**警告（記錄但可通過）：**
- code-flow 多出 spec 沒有的技術性節點（loading 狀態、快取、重試）
- 節點粒度不同但語意等價（一個節點拆成兩個、或合併）

**判定輸出：** passed（布林）+ 差異清單（每條標「必修」或「警告」），用 report_flow_check 回報。`;

export const FLOW_NODE_LEVEL_SPEC = `流程圖規範：
- 使用 Mermaid \`flowchart TD\` 格式
- 節點統一為**功能/業務步驟層**（「驗證權限」「查詢待辦清單」「寫入 audit log」），不是函式呼叫層
- 節點標籤使用中文，簡潔描述動作
- 涵蓋主要操作路徑與條件分支（有/無資料、權限、狀態判斷）`;

// ── gate evaluation for update_task_status ──────────────────

export interface GateBlockReason {
  role: FlowRole;
  missing: string;
}

/**
 * Returns the list of reasons completion should be blocked, empty when clear.
 * A task passes when every required role has gateB.passed === true, or when
 * flow_state.skipped is set.
 */
export function getCompletionBlockers(state: FlowGateState | null): GateBlockReason[] {
  if (!state) {
    return [{ role: 'default', missing: 'flow_state 未初始化（get_execution_plan 未正確執行）' }];
  }
  if (state.skipped) return [];

  const blockers: GateBlockReason[] = [];
  const roles = Object.entries(state.roles) as Array<[FlowRole, RoleFlowState]>;
  const requiredRoles = roles.filter(([, rs]) => rs.required);

  if (requiredRoles.length === 0) {
    blockers.push({ role: 'default', missing: '無任何 required role（get_execution_plan 未正確初始化）' });
    return blockers;
  }

  for (const [role, rs] of requiredRoles) {
    if (rs.gateB?.passed === true) continue;
    if (!rs.plan) blockers.push({ role, missing: 'plan-flow 未儲存（save_task_flow flowType="plan"）' });
    else if (rs.gateA?.passed !== true) blockers.push({ role, missing: '閘門 A 未通過（report_flow_check gate="A"）' });
    else if (!rs.code) blockers.push({ role, missing: 'code-flow 未儲存（save_task_flow flowType="code"）' });
    else blockers.push({ role, missing: '閘門 B 未通過（report_flow_check gate="B"）' });
  }
  return blockers;
}
