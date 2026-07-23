/**
 * MCP tools for context recovery, project experience notes, spec change
 * detection, and task dependency management.
 *
 * resume_task            — 一鍵恢復任務脈絡（新 session 接手舊任務的第一步）
 * save_project_note      — 記錄專案經驗筆記（前人踩坑教訓）
 * list_project_notes     — 列出專案經驗筆記
 * archive_project_note   — 封存筆記（不做實體刪除）
 * check_spec_changes     — 比對 task_spec_versions 與 SVN 最新 last-modified
 * add_task_dependency    — 新增任務依賴（防自依賴/跨專案/重複/循環）
 * remove_task_dependency — 移除任務依賴
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { truncateResponse, parseJson } from '../helpers.js';
import { getFlowState, getCompletionBlockers, logTaskOutput, type FlowGateState, type RoleFlowState, type FlowRole } from '../flow-gate.js';
import { runSpecChangeCheck, type SpecChangeTarget } from '../spec-change.js';
import { listResolvedSpecGaps } from '../../utils/specGapResolution.js';

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  label: string;
  task_type: string;
  source_ref: string | null;
  parent_name: string | null;
  result_summary: string | null;
  flow_required: number | null;
  due_date: string | null;
}

interface NoteRow {
  id: string;
  project_id: string;
  category: string | null;
  content: string;
  active: number;
  created_at: string;
  updated_at: string;
}

/** 派工快照稽核前綴（與 [SKIP]/[TRACK] 同機制，存進 agent_outputs stream_type='system'）。 */
const DISPATCH_PREFIX = '[DISPATCH]';

export function registerContextTools(server: McpServer): void {

  // ── resume_task ───────────────────────────────────────────
  server.tool(
    'resume_task',
    '一鍵恢復任務脈絡。**新 session 接手先前開過的任務時，第一步先呼叫此工具**：回傳任務核心資訊、flow-gate 閘門進度、最近歷史回報、未解決規格缺口、已裁決規格缺口（resolvedGaps——使用者拍板的裁決，效力等同規格，必須遵守）、最新驗收結果、任務依賴、專案經驗筆記，以及 nextSteps 下一步指引。',
    {
      taskId: z.string().describe('任務 ID'),
      outputLimit: z.number().int().positive().max(100).optional().describe('回傳最近幾筆歷史回報（預設 20，最多 100）'),
    },
    { title: 'Resume Task', readOnlyHint: true, openWorldHint: false },
    async ({ taskId, outputLimit }) => {
      const db = getMcpDb();

      const task = db.prepare(`
        SELECT id, project_id, title, status, label, task_type, source_ref, parent_name, result_summary, flow_required, due_date
        FROM tasks WHERE id = ?
      `).get(taskId) as TaskRow | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found. 用 list_pending_tasks 或 next_task 定位任務。` }], isError: true };
      }

      const project = db.prepare(
        'SELECT id, name, working_dir, frontend_path, backend_path FROM projects WHERE id = ?'
      ).get(task.project_id) as { id: string; name: string; working_dir: string; frontend_path: string | null; backend_path: string | null } | undefined;

      // ── track（任務軌道）── flow_state 不論 flow_required 都可能帶 track（light 軌不設 flow_required）
      const rawFlowState: FlowGateState | null = getFlowState(db, taskId);
      const track = rawFlowState?.track ?? 'full';
      const trackReason = rawFlowState?.trackReason ?? '未判定（get_execution_plan 執行後才會記錄；無記錄視同 full）';

      // ── flow-gate summary ──
      const flowState: FlowGateState | null = task.flow_required === 1 ? rawFlowState : null;
      let flowGate: Record<string, unknown>;
      if (task.flow_required !== 1) {
        flowGate = { enabled: false, note: '此任務未啟用 Flow-Gated Development（get_execution_plan 執行後才會啟用）' };
      } else if (!flowState) {
        flowGate = { enabled: true, note: 'flow_required 已設定但 flow_state 未初始化——重新呼叫 get_execution_plan 初始化' };
      } else {
        const roles = (Object.entries(flowState.roles) as Array<[FlowRole, RoleFlowState]>).map(([role, rs]) => ({
          role,
          required: rs.required,
          planFlowSaved: !!rs.plan,
          gateA: rs.gateA ? { passed: rs.gateA.passed, checkedAt: rs.gateA.checkedAt } : null,
          codeFlowSaved: !!rs.code,
          gateB: rs.gateB ? { passed: rs.gateB.passed, checkedAt: rs.gateB.checkedAt } : null,
          gateBFailures: rs.gateBFailures,
        }));
        flowGate = {
          enabled: true,
          specExpected: !!flowState.specExpected,
          specFlowSaved: !!flowState.spec,
          skipped: flowState.skipped ?? null,
          roles,
        };
      }

      // ── recent outputs (last N, chronological) ──
      const agentId = `mcp-${taskId}`;
      const limit = Math.min(outputLimit ?? 20, 100);
      // [DISPATCH] 快照是機器用的完整派工 prompt（可能很大），不是進度敘事——排除在
      // recentOutputs 之外，避免同一份 prompt 在回應中出現兩次而把 lastDispatch 擠出截斷上限。
      const outputsTotal = (db.prepare(
        "SELECT COUNT(*) as count FROM agent_outputs WHERE agent_id = ? AND content NOT LIKE '[DISPATCH]%'"
      ).get(agentId) as { count: number }).count;
      const recentOutputs = (db.prepare(`
        SELECT stream_type, content, timestamp FROM agent_outputs
        WHERE agent_id = ? AND content NOT LIKE '[DISPATCH]%' ORDER BY id DESC LIMIT ?
      `).all(agentId, limit) as Array<{ stream_type: string; content: string; timestamp: string }>)
        .reverse()
        .map(r => ({ type: r.stream_type, content: r.content, timestamp: r.timestamp }));

      // ── open spec gaps ──
      const openGaps = db.prepare(`
        SELECT id, category, description, created_at FROM spec_gaps
        WHERE task_id = ? AND status = 'open' ORDER BY created_at ASC
      `).all(taskId) as Array<{ id: string; category: string; description: string; created_at: string }>;

      // ── resolved spec gaps（使用者裁決——效力等同規格）──
      // 來源 SQL 與派工 prompt / AI 回對計畫共用（utils/specGapResolution），
      // 讓接手 session 看到「已裁決了什麼」，不需依賴前一個 session 的對話。
      const resolvedGaps = listResolvedSpecGaps(db, taskId);

      // ── latest verification result ──
      const lastVerification = db.prepare(`
        SELECT content, timestamp FROM agent_outputs
        WHERE agent_id = ? AND content LIKE '[VERIFICATION]%'
        ORDER BY id DESC LIMIT 1
      `).get(agentId) as { content: string; timestamp: string } | undefined;

      // ── last dispatch snapshot (save_task_dispatch 存的最近一筆 [DISPATCH]) ──
      // 中斷復原：session 被砍後，接手者可拿回上次派給 subagent 的完整 prompt。
      const lastDispatchRow = db.prepare(`
        SELECT content, timestamp FROM agent_outputs
        WHERE agent_id = ? AND content LIKE '[DISPATCH]%'
        ORDER BY id DESC LIMIT 1
      `).get(agentId) as { content: string; timestamp: string } | undefined;
      let lastDispatch: Record<string, unknown> | null = null;
      if (lastDispatchRow) {
        const body = lastDispatchRow.content.replace(/^\[DISPATCH\]\s*/, '');
        const parsed = parseJson<{ at?: string; meta?: unknown; prompt?: string } | null>(body, null);
        lastDispatch = parsed && typeof parsed === 'object'
          ? { dispatchedAt: parsed.at ?? lastDispatchRow.timestamp, meta: parsed.meta ?? null, prompt: parsed.prompt ?? '', savedAt: lastDispatchRow.timestamp }
          : { raw: body, savedAt: lastDispatchRow.timestamp };
      }

      // ── dependencies (此任務依賴哪些任務 + 目前狀態) ──
      const dependencies = db.prepare(`
        SELECT td.depends_on_id as id, t.title, t.status
        FROM task_dependencies td JOIN tasks t ON t.id = td.depends_on_id
        WHERE td.task_id = ?
      `).all(taskId) as Array<{ id: string; title: string; status: string }>;

      // ── project experience notes (active) ──
      const notes = (db.prepare(`
        SELECT id, category, content, created_at FROM project_notes
        WHERE project_id = ? AND active = 1 ORDER BY created_at ASC
      `).all(task.project_id) as Array<{ id: string; category: string | null; content: string; created_at: string }>);

      // ── nextSteps guidance ──
      const steps: string[] = [];
      const incompleteDeps = dependencies.filter(d => d.status !== 'completed');
      if (incompleteDeps.length > 0) {
        steps.push(`前置任務未完成：${incompleteDeps.map(d => `${d.title}（${d.status}）`).join('、')} → 先確認是否需等待前置任務`);
      }
      if (openGaps.length > 0) {
        steps.push(`規格缺口 ${openGaps.length} 筆未解決 → 先與使用者確認補規格（拍板後 resolve_spec_gap(gapId, resolutionNote=具體裁決) 落地），不要對缺口部分自行編造`);
      }
      if (resolvedGaps.length > 0) {
        steps.push(`已有 ${resolvedGaps.length} 筆規格裁決（見 resolvedGaps）——使用者已拍板，效力等同規格，實作與 AI 回對必須遵守，不可用對話轉述替代`);
      }
      if (task.status === 'completed') {
        steps.push('任務已標記 completed——如需重做或修正，先與使用者確認再 update_task_status。');
      } else if (task.status === 'failed') {
        steps.push(`任務先前標記 failed${task.result_summary ? `（原因：${task.result_summary}）` : ''} → 修正問題後 update_task_status(in_progress) 重啟`);
      } else if (task.status !== 'in_progress') {
        steps.push(`狀態 ${task.status} → 先呼叫 get_execution_plan(taskId) 取得執行計畫，再 update_task_status(in_progress) 開工`);
      } else {
        // in_progress
        if (task.flow_required === 1) {
          const blockers = getCompletionBlockers(flowState);
          if (blockers.length > 0 && !flowState?.skipped) {
            for (const b of blockers) {
              steps.push(`狀態 in_progress、role=${b.role}：${b.missing}`);
            }
          } else {
            steps.push('閘門已通過（或已跳過）→ get_verification_plan 逐項驗收，通過後 update_task_status(completed)');
          }
        } else {
          steps.push('狀態 in_progress（無 flow-gate）→ 繼續實作；完成前 get_verification_plan 逐項驗收後 update_task_status(completed)');
        }
      }

      const result = {
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          label: task.label,
          taskType: task.task_type,
          sourceRef: task.source_ref,
          parentName: task.parent_name,
          resultSummary: task.result_summary,
          dueDate: task.due_date ?? null,
        },
        track,
        trackReason,
        project: project ? {
          id: project.id,
          name: project.name,
          workingDir: project.working_dir,
          frontendPath: project.frontend_path,
          backendPath: project.backend_path,
        } : null,
        flowGate,
        // lastDispatch 放在 recentOutputs 之前：回應超過截斷上限時被切掉的是尾端，
        // 派工快照（中斷復原的關鍵資料）必須排在歷史敘事前面才不會被截掉。
        ...(lastDispatch ? { lastDispatch } : {}),
        recentOutputs: { total: outputsTotal, showing: recentOutputs.length, outputs: recentOutputs },
        openSpecGaps: openGaps.map(g => ({ id: g.id, category: g.category, description: g.description, createdAt: g.created_at })),
        // 使用者已拍板的規格裁決——效力等同規格條文，實作/驗證必須遵守（resolve_spec_gap 落地）
        resolvedGaps: resolvedGaps.map(g => ({ id: g.id, category: g.category, description: g.description, resolutionNote: g.resolutionNote, resolvedAt: g.resolvedAt })),
        lastVerification: lastVerification ? { content: lastVerification.content, timestamp: lastVerification.timestamp } : null,
        dependencies: dependencies.map(d => ({ taskId: d.id, title: d.title, status: d.status })),
        projectNotes: notes.map(n => ({ id: n.id, category: n.category, content: n.content })),
        nextSteps: steps.join('\n'),
      };

      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(JSON.stringify(result, null, 2), '歷史回報過多——用 get_task_outputs(taskId, limit, offset) 分頁取得其餘紀錄。'),
        }],
      };
    },
  );

  // ── save_task_dispatch ────────────────────────────────────
  server.tool(
    'save_task_dispatch',
    '存派工快照（中斷復原用）：把「最近一次派給 subagent 的完整 prompt」+ 時間存進任務稽核軌跡。session 被重啟/砍掉後，接手者用 resume_task(taskId) 就能拿回這份 prompt 續派，不用人工重建。非強制——orchestrator 派工前存一次即可。與 [SKIP]/[TRACK] 同機制（agent_outputs，stream_type=system，前綴 [DISPATCH]），不動 schema。',
    {
      taskId: z.string().describe('任務 ID'),
      prompt: z.string().min(1).describe('派給 subagent 的完整 prompt（原封不動存，供中斷後續派）'),
      meta: z.record(z.string(), z.unknown()).optional().describe('選填：派工相關的額外資訊（如 role、model、workspace 路徑），會原樣存回並由 resume_task 帶回'),
    },
    { title: 'Save Task Dispatch', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, prompt, meta }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const snapshot = { at: new Date().toISOString(), meta: meta ?? null, prompt };
      // 刻意不 notifyWebServer：快照是機器資料（完整派工 prompt），Web UI 的輸出流
      // 不顯示它（resume_task 的 recentOutputs 也排除 [DISPATCH]），即時通知沒有意義。
      logTaskOutput(db, taskId, task.project_id, `${DISPATCH_PREFIX} ${JSON.stringify(snapshot)}`);

      return { content: [{ type: 'text' as const, text: `派工快照已儲存（taskId=${taskId}，prompt ${prompt.length} 字）。中斷後用 resume_task(taskId="${taskId}") 取回。` }] };
    },
  );

  // ── save_project_note ─────────────────────────────────────
  server.tool(
    'save_project_note',
    '記錄專案經驗筆記——**目的只有一個：讓下一個_不同_任務不要重犯同一個錯**。不是流水帳、不是工作日誌、不是這次做了什麼的紀錄。\n\n**⚠ 必要性測試（寫之前先過，過不了就不要寫）：**\n這條資訊是不是「**規格沒寫、但下一個不同任務的 agent 不知道就會做錯**的可重用坑/慣例」？\n- ✅ 是 → 值得記，但寫成**去時間、去個案的規則**：「X 必須 Y，否則 Z」（如「分頁多欄查詢必寫 countQuery 且與主查詢對齊，否則筆數錯」）。\n- ❌ 不是 → **不要寫**，這些都是垃圾/流水帳：這次做了什麼、開發進度、某天某 commit 發生的一次性事件（「2026-XX-XX pull 後發現…」「結案後補修…」）、規格本身已寫的東西、讀一次 code 就知道的事、單一任務的修復摘要。\n  → 「這次發生什麼」屬於 report_output／update_task_status 的 summary，**不是筆記**。筆記記的是「以後都要遵守什麼」。\n\n判準一句話：**把時間、任務名、commit 拿掉後還成立的可重用規則才記；拿掉就沒意義的就是流水帳，不記。**\n\n**寫入紀律（通過必要性測試後才輪到這些）：**\n1. **一則一個重點、精簡可操作**——一兩句講清坑與正確做法，不要長篇。\n2. **附出處**——元件檔+行號／規格章節／觸發條件。**無出處不記**。\n3. **不要重複**——先 list_project_notes 看有沒有涵蓋；同主題補進既有筆記，不新增重複則。\n4. **過時就 archive**——坑已不成立（程式已改）用 archive_project_note 清掉，不留誤導。',
    {
      projectId: z.string().describe('專案 ID'),
      content: z.string().min(1).describe('筆記內容：具體描述坑/慣例與正確做法（一則筆記一個重點）'),
      category: z.string().optional().describe('分類（自由字串，如 "ui" / "db" / "build" / "api"）'),
    },
    { title: 'Save Project Note', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ projectId, content, category }) => {
      const db = getMcpDb();
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      const noteId = randomUUID();
      db.prepare(`
        INSERT INTO project_notes (id, project_id, category, content)
        VALUES (?, ?, ?, ?)
      `).run(noteId, projectId, category || null, content);

      const notifyOk = await notifyWebServer({
        event: 'project.noteSaved',
        data: { noteId, projectId, category: category || null, content },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return { content: [{ type: 'text' as const, text: `Project note saved (id: ${noteId})${warning}。此筆記會注入本專案後續任務的 execution plan。` }] };
    },
  );

  // ── list_project_notes ────────────────────────────────────
  server.tool(
    'list_project_notes',
    '列出專案經驗筆記。預設只回 active 筆記；includeArchived=true 連封存的一起回。',
    {
      projectId: z.string().describe('專案 ID'),
      includeArchived: z.boolean().optional().describe('是否包含已封存的筆記（預設 false）'),
    },
    { title: 'List Project Notes', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, includeArchived }) => {
      const db = getMcpDb();
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      const rows = (includeArchived
        ? db.prepare('SELECT * FROM project_notes WHERE project_id = ? ORDER BY created_at ASC').all(projectId)
        : db.prepare('SELECT * FROM project_notes WHERE project_id = ? AND active = 1 ORDER BY created_at ASC').all(projectId)
      ) as NoteRow[];

      const notes = rows.map(n => ({
        id: n.id,
        category: n.category,
        content: n.content,
        active: n.active === 1,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(JSON.stringify({ projectId, count: notes.length, notes }, null, 2)),
        }],
      };
    },
  );

  // ── archive_project_note ──────────────────────────────────
  server.tool(
    'archive_project_note',
    '封存一則專案經驗筆記（設 active=0，不做實體刪除）。封存後不再注入 execution plan。',
    {
      noteId: z.string().describe('筆記 ID（save_project_note 回傳的 id）'),
    },
    { title: 'Archive Project Note', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ noteId }) => {
      const db = getMcpDb();
      const note = db.prepare('SELECT id, active FROM project_notes WHERE id = ?').get(noteId) as { id: string; active: number } | undefined;
      if (!note) {
        return { content: [{ type: 'text' as const, text: `Error: Project note "${noteId}" not found. 用 list_project_notes 確認 noteId。` }], isError: true };
      }
      if (note.active === 0) {
        return { content: [{ type: 'text' as const, text: `Project note ${noteId} is already archived.` }] };
      }

      db.prepare("UPDATE project_notes SET active = 0, updated_at = datetime('now') WHERE id = ?").run(noteId);
      return { content: [{ type: 'text' as const, text: `Project note ${noteId} archived.` }] };
    },
  );

  // ── check_spec_changes ────────────────────────────────────
  server.tool(
    'check_spec_changes',
    '檢查任務的 SVN 規格文件是否有新版。比對 fetch_svn_specs 當時記錄的 last-modified 與 SVN 現況；發現變更會自動建一筆 spec gap（category=spec_changed）提醒重新撈規格。至少提供 projectId 或 taskId 其中一個；只給 projectId 時檢查該專案所有 in_progress 任務。',
    {
      projectId: z.string().optional().describe('專案 ID（檢查該專案所有 in_progress 任務）'),
      taskId: z.string().optional().describe('任務 ID（只檢查此任務）'),
    },
    { title: 'Check Spec Changes', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ projectId, taskId }) => {
      const db = getMcpDb();

      if (!projectId && !taskId) {
        return { content: [{ type: 'text' as const, text: 'Error: 至少提供 projectId 或 taskId 其中一個。' }], isError: true };
      }

      // Resolve target tasks
      let targets: SpecChangeTarget[];
      if (taskId) {
        const task = db.prepare('SELECT id, project_id, title FROM tasks WHERE id = ?').get(taskId) as SpecChangeTarget | undefined;
        if (!task) {
          return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
        }
        targets = [task];
      } else {
        const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId!) as { id: string } | undefined;
        if (!project) {
          return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
        }
        targets = db.prepare("SELECT id, project_id, title FROM tasks WHERE project_id = ? AND status = 'in_progress'")
          .all(projectId!) as SpecChangeTarget[];
      }

      let result;
      try {
        result = await runSpecChangeCheck(db, targets);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
      }

      if (result.filesChecked === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ tasksChecked: result.tasksChecked, filesChecked: 0, changes: [], note: '沒有任何規格版本記錄（fetch_svn_specs 成功抓到規格後才會記錄）。' }, null, 2),
          }],
        };
      }

      const summary = result.changedTotal > 0
        ? `發現 ${result.changedTotal} 個規格檔案有新版，已建立 spec gap（category=spec_changed）。請重新 fetch_svn_specs 並確認實作影響。`
        : '所有已記錄的規格檔案皆無變更。';

      return {
        content: [{
          type: 'text' as const,
          text: truncateResponse(JSON.stringify({ tasksChecked: result.tasksChecked, filesChecked: result.filesChecked, changedTotal: result.changedTotal, summary, tasks: result.tasks }, null, 2)),
        }],
      };
    },
  );

  // ── add_task_dependency ───────────────────────────────────
  server.tool(
    'add_task_dependency',
    '新增任務依賴：taskId 依賴 dependsOnTaskId（前置任務未 completed 時，next_task 不會推薦 taskId）。防呆：兩任務須同專案、不可自依賴、不可重複、不可造成循環。',
    {
      taskId: z.string().describe('任務 ID（後做的任務）'),
      dependsOnTaskId: z.string().describe('前置任務 ID（必須先完成的任務）'),
    },
    { title: 'Add Task Dependency', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, dependsOnTaskId }) => {
      const db = getMcpDb();

      if (taskId === dependsOnTaskId) {
        return { content: [{ type: 'text' as const, text: 'Error: 任務不可依賴自己。' }], isError: true };
      }

      const task = db.prepare('SELECT id, project_id, title FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; title: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }
      const dep = db.prepare('SELECT id, project_id, title, status FROM tasks WHERE id = ?').get(dependsOnTaskId) as { id: string; project_id: string; title: string; status: string } | undefined;
      if (!dep) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${dependsOnTaskId}" not found` }], isError: true };
      }
      if (task.project_id !== dep.project_id) {
        return { content: [{ type: 'text' as const, text: 'Error: 兩個任務必須屬於同一個專案。' }], isError: true };
      }

      const exists = db.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?').get(taskId, dependsOnTaskId);
      if (exists) {
        return { content: [{ type: 'text' as const, text: `Error: 依賴已存在（${task.title} → ${dep.title}）。` }], isError: true };
      }

      // Cycle detection: adding taskId→dependsOnTaskId creates a cycle iff
      // dependsOnTaskId (transitively) already depends on taskId.
      const depStmt = db.prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?');
      const visited = new Set<string>([dependsOnTaskId]);
      const parent = new Map<string, string>();
      const queue: string[] = [dependsOnTaskId];
      let cycleEnd: string | null = null;
      while (queue.length > 0 && !cycleEnd) {
        const current = queue.shift()!;
        const nexts = depStmt.all(current) as Array<{ depends_on_id: string }>;
        for (const n of nexts) {
          if (n.depends_on_id === taskId) {
            parent.set(taskId, current);
            cycleEnd = taskId;
            break;
          }
          if (!visited.has(n.depends_on_id)) {
            visited.add(n.depends_on_id);
            parent.set(n.depends_on_id, current);
            queue.push(n.depends_on_id);
          }
        }
      }
      if (cycleEnd) {
        // Reconstruct the existing chain dependsOnTaskId → … → taskId for the error message
        const chain: string[] = [];
        let cur: string | undefined = cycleEnd;
        while (cur) {
          chain.unshift(cur);
          cur = parent.get(cur);
        }
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 會造成循環依賴——「${dep.title}」已（間接）依賴「${task.title}」（既有鏈：${chain.join(' → ')}）。`,
          }],
          isError: true,
        };
      }

      db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(taskId, dependsOnTaskId);

      return {
        content: [{
          type: 'text' as const,
          text: `Dependency added：「${task.title}」依賴「${dep.title}」（目前 ${dep.status}）。next_task 與 resume_task 會反映此依賴。`,
        }],
      };
    },
  );

  // ── remove_task_dependency ────────────────────────────────
  server.tool(
    'remove_task_dependency',
    '移除任務依賴（add_task_dependency 的反向操作）。',
    {
      taskId: z.string().describe('任務 ID'),
      dependsOnTaskId: z.string().describe('要解除的前置任務 ID'),
    },
    { title: 'Remove Task Dependency', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ taskId, dependsOnTaskId }) => {
      const db = getMcpDb();
      const result = db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?').run(taskId, dependsOnTaskId);
      if (result.changes === 0) {
        return { content: [{ type: 'text' as const, text: `Error: 依賴不存在（${taskId} → ${dependsOnTaskId}）。用 resume_task 查看任務目前的依賴。` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `Dependency removed：${taskId} 不再依賴 ${dependsOnTaskId}。` }] };
    },
  );
}
