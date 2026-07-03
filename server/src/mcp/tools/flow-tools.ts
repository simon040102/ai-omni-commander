/**
 * MCP tools for Flow-Gated Development.
 * save_task_flow, report_flow_check, get_task_flows
 *
 * The MCP server is the flow-diagram repository + state machine + instruction
 * injector. Semantic comparison is done by the calling LLM; this layer enforces
 * STRUCTURAL preconditions (flows must exist, gate A before gate B) and counts
 * gate-B failures (max 3, then [NEEDS_HUMAN]).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import {
  type FlowRole, type FlowType, type FlowGateState,
  GATE_B_MAX_FAILURES, FLOW_COMPARE_RUBRIC, FLOW_NODE_LEVEL_SPEC,
  resolveRole, mutateFlowState, getFlowState, getRoleState,
  saveFlowFile, readFlowFile, logTaskOutput, findFlowInOtherRoles,
} from '../flow-gate.js';

interface TaskLite {
  id: string;
  project_id: string;
}

function getTaskLite(db: ReturnType<typeof getMcpDb>, taskId: string): TaskLite | undefined {
  return db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as TaskLite | undefined;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Format current flow/gate status of one role for display. */
function roleStatusLine(state: FlowGateState, role: FlowRole): string {
  const rs = state.roles[role];
  if (!rs) return `role=${role}: （無狀態）`;
  const flag = (v: boolean | undefined) => v === true ? '✅' : v === false ? '❌' : '—';
  return `role=${role}: spec=${state.spec ? '✅' : '—'} plan=${rs.plan ? '✅' : '—'} code=${rs.code ? '✅' : '—'} | 閘門A=${flag(rs.gateA?.passed)} 閘門B=${flag(rs.gateB?.passed)} | B失敗 ${rs.gateBFailures}/${GATE_B_MAX_FAILURES}`;
}

export function registerFlowTools(server: McpServer): void {

  // ── save_task_flow ────────────────────────────────────────
  server.tool(
    'save_task_flow',
    'Save a business-step-level Mermaid flowchart for Flow-Gated Development. flowType: "spec" (from SA/SD), "plan" (implementation plan, drawn BEFORE coding), "code" (reverse-engineered from actual code AFTER coding), "mindmap" (optional detail-coverage checklist, no gate effect). The response tells you the next step in the workflow — follow it.',
    {
      taskId: z.string().describe('The task ID'),
      flowType: z.enum(['spec', 'plan', 'code', 'mindmap']).describe('Which flow this is'),
      mermaidContent: z.string().describe('The Mermaid content (flowchart TD for spec/plan/code; mindmap for mindmap)'),
      role: z.enum(['frontend', 'backend']).optional().describe('Role slot for plan/code flows on dual-role tasks. Omit for single-role tasks.'),
      filename: z.string().optional().describe('Optional source document filename for display (e.g. SA spec filename)'),
      resetFailures: z.boolean().optional().describe('Reset the gate-B failure counter. ONLY with explicit user approval after [NEEDS_HUMAN]; the reset is logged.'),
    },
    async ({ taskId, flowType, mermaidContent, role, filename, resetFailures }) => {
      const db = getMcpDb();
      const task = getTaskLite(db, taskId);
      if (!task) return err(`Error: Task "${taskId}" not found`);
      if (!mermaidContent.trim()) return err('Error: mermaidContent is empty');

      const flowRole = resolveRole(role);
      const ft = flowType as FlowType;

      const saved = saveFlowFile({
        projectId: task.project_id,
        taskId,
        flowType: ft,
        role: flowRole,
        mermaidContent,
        filename,
      });

      let resetLogged = false;
      const state = mutateFlowState(db, taskId, (s) => {
        const now = new Date().toISOString();
        if (ft === 'spec') {
          s.spec = { hash: saved.hash, savedAt: now };
          // Re-saving spec invalidates ALL roles' gates (stale-pass rule)
          for (const rs of Object.values(s.roles)) {
            if (rs) { delete rs.gateA; delete rs.gateB; }
          }
        } else if (ft === 'plan') {
          const rs = getRoleState(s, flowRole);
          rs.plan = { hash: saved.hash, savedAt: now };
          delete rs.gateA;
          delete rs.gateB;
        } else if (ft === 'code') {
          const rs = getRoleState(s, flowRole);
          rs.code = { hash: saved.hash, savedAt: now };
          delete rs.gateB;
          if (resetFailures && rs.gateBFailures > 0) {
            rs.gateBFailures = 0;
            resetLogged = true;
          }
        }
        // mindmap: stored only, no state machine effect
      });

      if (resetLogged) {
        logTaskOutput(db, taskId, task.project_id,
          `[RESET] 使用者同意重置閘門 B 失敗計數器（role=${flowRole}），重新進入比對循環。`);
      }

      notifyWebServer({
        event: 'sa-flow.saved',
        data: { projectId: task.project_id, taskId, filename: filename || null, flowPath: saved.flowPath, flowType: ft, role: flowRole },
      }).catch(() => {});

      // ── next-step instruction injection ──
      if (ft === 'mindmap') {
        return ok(`Mindmap 已存檔（${saved.flowPath}）。此圖為細節覆蓋清單，不影響閘門狀態。實作完成後請逐項核對程式碼是否涵蓋清單中的每個細節（欄位/訊息文字/驗證規則/按鈕/API 參數）。`);
      }

      if (ft === 'spec') {
        return ok(`spec-flow 已存檔（hash=${saved.hash}）。
${roleStatusLine(state, flowRole)}

## 下一步
實作者完整讀取 SA/SD 規格文件後，畫出**實作計畫流程圖（plan-flow）**——「我打算怎麼做」的業務步驟流程——並以 save_task_flow(taskId="${taskId}", flowType="plan"${role ? `, role="${role}"` : ''}) 儲存。

${FLOW_NODE_LEVEL_SPEC}`);
      }

      if (ft === 'plan') {
        // Branch on specExpected — the single source of truth (review I-1).
        // Never silently degrade to two-flow mode just because spec-flow wasn't drawn.
        if (state.specExpected) {
          const specContent = state.spec ? readFlowFile(task.project_id, state.spec.hash) : null;
          if (specContent) {
            return ok(`plan-flow 已存檔（hash=${saved.hash}，role=${flowRole}）。閘門狀態已重置。
${roleStatusLine(state, flowRole)}

## ⚠ 閘門 A：計畫涵蓋檢查（寫 code 之前必須完成）
逐節點比對下方 spec-flow，確認 plan-flow **涵蓋規格的每個步驟與分支**。語意比對即可（措辭可不同），但規格的任何步驟/分支在計畫中完全沒有對應 → 不通過，先補計畫再重存。
比對完成後呼叫 report_flow_check(taskId="${taskId}", gate="A", passed=…, diffs="…"${role ? `, role="${role}"` : ''})。**閘門 A 通過前不可開始寫 code。**

### spec-flow（規格流程）
\`\`\`mermaid
${specContent}
\`\`\``);
          }
          return ok(`plan-flow 已存檔（hash=${saved.hash}，role=${flowRole}）。閘門狀態已重置。
${roleStatusLine(state, flowRole)}

## ⚠ 此任務有 SA/SD 規格文件，但 spec-flow 尚未儲存
閘門 A 需要 spec-flow 才能做涵蓋檢查（**不會因缺 spec-flow 而降級為兩圖模式**）。
下一步：讀取 SA/SD 規格文件，畫出規格流程圖，以 save_task_flow(taskId="${taskId}", flowType="spec") 儲存，然後再回報閘門 A。
（雙角色任務：先用 get_task_flows 確認另一 role 是否已畫過 spec-flow，已存在就沿用不重畫。）`);
        }
        return ok(`plan-flow 已存檔（hash=${saved.hash}，role=${flowRole}）。閘門狀態已重置。
${roleStatusLine(state, flowRole)}

## ⚠ 閘門 A（兩圖模式）
此任務無 SA/SD 規格文件，採**兩圖模式**（plan↔code）。
請對照**任務描述**做自洽檢查：plan-flow 是否涵蓋任務要求的每個行為與邊界條件？
檢查完成後呼叫 report_flow_check(taskId="${taskId}", gate="A", passed=…${role ? `, role="${role}"` : ''})。`);
      }

      // ft === 'code'
      const rs = getRoleState(state, flowRole);
      if (rs.gateBFailures >= GATE_B_MAX_FAILURES) {
        return ok(`code-flow 已存檔（hash=${saved.hash}，role=${flowRole}），但閘門 B 已失敗 ${rs.gateBFailures}/${GATE_B_MAX_FAILURES} 次。

## ⚠ [NEEDS_HUMAN] 停止自動修正
請向使用者回報累積的差異清單，由使用者裁示：
- 使用者同意重來 → 重新呼叫 save_task_flow 並帶 resetFailures=true
- 使用者同意跳過閘門 → update_task_status 時帶 skipFlowGate=true + skipReason
不要在未經使用者裁示的情況下繼續自動修正循環。`);
      }

      const specContent = state.spec ? readFlowFile(task.project_id, state.spec.hash) : null;
      const planContent = rs.plan ? readFlowFile(task.project_id, rs.plan.hash) : null;
      const mode = specContent ? '三方比對（code↔plan、code↔spec）' : '兩圖模式（code↔plan）';

      return ok(`code-flow 已存檔（hash=${saved.hash}，role=${flowRole}）。閘門 B 已重置，目前失敗 ${rs.gateBFailures}/${GATE_B_MAX_FAILURES} 次。
${roleStatusLine(state, flowRole)}

## ⚠ 閘門 B：${mode}（跑測試之前必須完成）
建議由**主 session（orchestrator）**執行比對，不要由寫 code 的 subagent 自評。
比對完成後呼叫 report_flow_check(taskId="${taskId}", gate="B", passed=…, diffs="…"${role ? `, role="${role}"` : ''})。**閘門 B 通過前不可跑測試、不可標記 completed。**

${FLOW_COMPARE_RUBRIC}
${planContent ? `
### plan-flow（實作計畫）
\`\`\`mermaid
${planContent}
\`\`\`` : '\n（警告：plan-flow 檔案讀取失敗）'}
${specContent ? `
### spec-flow（規格流程）
\`\`\`mermaid
${specContent}
\`\`\`` : ''}`);
    },
  );

  // ── report_flow_check ─────────────────────────────────────
  server.tool(
    'report_flow_check',
    'Report the result of a flow-gate semantic comparison (done by you, the LLM). gate="A": plan-flow covers spec-flow (before coding). gate="B": code-flow matches plan-flow and spec-flow (before testing). Structural preconditions are enforced: gate A requires a saved plan-flow; gate B requires gate A passed and a saved code-flow.',
    {
      taskId: z.string().describe('The task ID'),
      gate: z.enum(['A', 'B']).describe('Which gate this check is for'),
      passed: z.boolean().describe('Whether the comparison passed'),
      diffs: z.string().optional().describe('Difference list (each item marked 必修/警告). Required in spirit when passed=false.'),
      role: z.enum(['frontend', 'backend']).optional().describe('Role slot for dual-role tasks. Omit for single-role tasks.'),
    },
    async ({ taskId, gate, passed, diffs, role }) => {
      const db = getMcpDb();
      const task = getTaskLite(db, taskId);
      if (!task) return err(`Error: Task "${taskId}" not found`);

      const flowRole = resolveRole(role);
      const state = getFlowState(db, taskId);
      const rs = state?.roles[flowRole];

      // ── structural preconditions (C1 / I-1 / I-2) ──
      const roleHint = (flow: 'plan' | 'code'): string => {
        if (!state) return '';
        const others = findFlowInOtherRoles(state, flow, flowRole);
        return others.length > 0
          ? `（注意：${flow}-flow 存在於 role=${others.join(', ')} 槽 — 可能是 role 參數不一致，請確認 save_task_flow 與 report_flow_check 使用相同的 role）`
          : '';
      };

      if (gate === 'A') {
        if (state?.specExpected && !state.spec) {
          return err(`Error: 閘門 A 前置條件不足 — 此任務有 SA/SD 規格文件，但 spec-flow 尚未儲存。請先讀取規格畫出 spec-flow 並以 save_task_flow(flowType="spec") 儲存（不可降級為兩圖模式）。`);
        }
        if (!rs?.plan) {
          return err(`Error: 閘門 A 前置條件不足 — role=${flowRole} 的 plan-flow 尚未儲存。請先 save_task_flow(flowType="plan") 再回報閘門 A。${roleHint('plan')}`);
        }
      } else {
        if (rs?.gateA?.passed !== true) {
          return err(`Error: 閘門 B 前置條件不足 — role=${flowRole} 的閘門 A 尚未通過。請先完成 plan-flow 涵蓋檢查（report_flow_check gate="A"）。${roleHint('plan')}`);
        }
        if (!rs.code) {
          return err(`Error: 閘門 B 前置條件不足 — role=${flowRole} 的 code-flow 尚未儲存。請先 save_task_flow(flowType="code") 再回報閘門 B。${roleHint('code')}`);
        }
      }

      const now = new Date().toISOString();
      const newState = mutateFlowState(db, taskId, (s) => {
        const r = getRoleState(s, flowRole);
        const result = { passed, checkedAt: now, ...(diffs ? { diffs } : {}) };
        if (gate === 'A') {
          r.gateA = result;
        } else {
          r.gateB = result;
          if (passed) {
            r.gateBFailures = 0;
          } else {
            r.gateBFailures += 1;
          }
        }
      });
      const newRs = getRoleState(newState, flowRole);

      // Log check result + diffs to task outputs (same channel as report_output)
      const gateLabel = gate === 'A' ? '閘門A(計畫涵蓋)' : '閘門B(實作比對)';
      logTaskOutput(db, taskId, task.project_id,
        `[FLOW_GATE] ${gateLabel} role=${flowRole} → ${passed ? '通過 ✅' : `不通過 ❌（第 ${newRs.gateBFailures} 次失敗）`}${diffs ? `\n差異清單：\n${diffs}` : ''}`);

      notifyWebServer({
        event: 'task.milestone',
        data: { taskId, projectId: task.project_id, milestone: `${gateLabel} ${passed ? '通過' : '不通過'}`, details: diffs || null },
      }).catch(() => {});

      // ── next-step instruction injection ──
      if (gate === 'A') {
        if (passed) {
          return ok(`閘門 A 通過 ✅（role=${flowRole}）。

## 下一步：開始實作
- 嚴格照 plan-flow 的步驟與分支實作
- 複雜任務（多欄位表單、多驗證規則）建議先產**心智圖細節覆蓋清單**：save_task_flow(flowType="mindmap")
- 實作完成後，從**實際程式碼**反推 code-flow（業務步驟層），以 save_task_flow(taskId="${taskId}", flowType="code"${role ? `, role="${role}"` : ''}) 儲存，進入閘門 B`);
        }
        return ok(`閘門 A 不通過 ❌（role=${flowRole}），差異已記錄。

## 下一步：補計畫
依差異清單補齊 plan-flow 缺漏的步驟/分支，重新 save_task_flow(flowType="plan"${role ? `, role="${role}"` : ''})（重存會重置閘門狀態），再重新回報閘門 A。**尚不可開始寫 code。**`);
      }

      // gate B
      if (passed) {
        return ok(`閘門 B 通過 ✅（role=${flowRole}），失敗計數已歸零。

## 下一步：跑測試
現在才可以執行測試（build / lint / 單元測試 / 煙霧測試）。
**測試全部通過後**，呼叫 update_task_status(taskId="${taskId}", status="completed", summary="...") 結案。測試失敗屬於實作問題：修復後若影響業務流程，需重存 code-flow 再過一次閘門 B；純技術修復（不動業務步驟）可直接重跑測試。`);
      }

      if (newRs.gateBFailures >= GATE_B_MAX_FAILURES) {
        return ok(`閘門 B 不通過 ❌（role=${flowRole}），已達失敗上限 ${newRs.gateBFailures}/${GATE_B_MAX_FAILURES}。

## ⚠ [NEEDS_HUMAN] 停止自動修正
請彙整全部差異清單向使用者回報，由使用者裁示：
- 重來 → save_task_flow(flowType="code", resetFailures=true)（限使用者明確同意）
- 跳過閘門結案 → update_task_status 帶 skipFlowGate=true + skipReason（限使用者明確同意）
不要繼續自動修正。`);
      }

      return ok(`閘門 B 不通過 ❌（role=${flowRole}），第 ${newRs.gateBFailures}/${GATE_B_MAX_FAILURES} 次失敗，差異已記錄。

## 下一步：修正循環
1. 依差異清單修正程式碼（必修項優先）
2. 從修正後的程式碼**重新反推** code-flow
3. save_task_flow(taskId="${taskId}", flowType="code"${role ? `, role="${role}"` : ''}) 重存
4. 重新比對並回報閘門 B（剩 ${GATE_B_MAX_FAILURES - newRs.gateBFailures} 次機會）`);
    },
  );

  // ── get_task_flows ────────────────────────────────────────
  server.tool(
    'get_task_flows',
    'Get all saved flow diagrams (spec/plan/code) and gate state for a task, plus the comparison rubric. Use this as the orchestrator to perform the gate-B three-way comparison.',
    {
      taskId: z.string().describe('The task ID'),
      role: z.enum(['frontend', 'backend']).optional().describe('Role slot to read plan/code from. Omit for single-role tasks.'),
    },
    async ({ taskId, role }) => {
      const db = getMcpDb();
      const task = getTaskLite(db, taskId);
      if (!task) return err(`Error: Task "${taskId}" not found`);

      const flowRole = resolveRole(role);
      const state = getFlowState(db, taskId);
      if (!state) {
        return ok(`Task ${taskId} 尚無 flow 狀態（未走 Flow-Gated 流程，或 get_execution_plan 未呼叫過）。`);
      }

      const rs = state.roles[flowRole];
      const sections: string[] = [];

      const statusLines = (Object.keys(state.roles) as FlowRole[]).map(r => roleStatusLine(state, r)).join('\n');
      sections.push(`## Flow 狀態\n${statusLines}${state.skipped ? `\n⚠ 已跳過閘門：${state.skipped.reason}（${state.skipped.at}）` : ''}`);

      const spec = state.spec ? readFlowFile(task.project_id, state.spec.hash) : null;
      if (spec) sections.push(`## spec-flow（規格流程）\n\`\`\`mermaid\n${spec}\n\`\`\``);
      const plan = rs?.plan ? readFlowFile(task.project_id, rs.plan.hash) : null;
      if (plan) sections.push(`## plan-flow（實作計畫，role=${flowRole}）\n\`\`\`mermaid\n${plan}\n\`\`\``);
      const code = rs?.code ? readFlowFile(task.project_id, rs.code.hash) : null;
      if (code) sections.push(`## code-flow（實作反推，role=${flowRole}）\n\`\`\`mermaid\n${code}\n\`\`\``);

      sections.push(FLOW_COMPARE_RUBRIC);
      sections.push(`比對完成後呼叫 report_flow_check(taskId="${taskId}", gate="A"|"B", passed=…, diffs="…"${role ? `, role="${role}"` : ''}) 回報。`);

      return ok(sections.join('\n\n'));
    },
  );
}
