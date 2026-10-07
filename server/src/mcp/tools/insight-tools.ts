/**
 * MCP tools for task insight & maintenance.
 * next_task, get_task_outputs, update_task, health_check, analyze_harness
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { getAsanaPat, ASANA_API_BASE, truncateResponse, getDbPath } from '../helpers.js';
import { listStalledTasks, DEFAULT_STALE_THRESHOLD_HOURS } from '../stale-tasks.js';
import { localTodayYmd, describeDueDate } from '../../utils/dueDate.js';
import { TASK_LABELS, TASK_TYPES } from '@omni/shared';
import {
  firstRoundPerTask, missRateByType, toolLimitationTrend, readTrend,
  reviewRounds, divergenceByType, divergenceTrend, emergingDivergence, gapStats, gapShape, noteChurn,
  type ReviewRun, type SpecGapRow, type ProjectNoteRow,
} from '../harness-analysis.js';
import { type GapGroup } from '../attention.js';
import { collectAttention } from '../attention-query.js';

const PENDING_STATUSES = ['pending', 'queued', 'assigned'] as const;

interface CandidateRow {
  id: string;
  title: string;
  label: string;
  task_type: string;
  source_ref: string | null;
  due_date: string | null;
  created_at: string;
}

export function registerInsightTools(server: McpServer): void {

  // ── next_task ─────────────────────────────────────────────
  server.tool(
    'next_task',
    '推薦下一個可執行的任務。排除前置任務（task_dependencies）未完成的；bug 類型優先，同優先級內逾期/近到期（due_date 越早）優先、無 due date 排最後，其餘按建立時間。回傳推薦任務 + 最多 4 個備選，各附推薦理由（含到期資訊，如「已逾期 2 天」「3 天後到期」）。額外附一段 stalledTasks（疑似卡死的 in_progress 任務，停滯時數 ≥ 門檻），建議 resume_task 或標 failed——不影響推薦邏輯本身。',
    {
      projectId: z.string().describe('專案 ID'),
      staleThresholdHours: z.number().int().positive().optional().describe(`疑似停滯任務的停滯時數門檻（小時，預設 ${DEFAULT_STALE_THRESHOLD_HOURS}）`),
    },
    { title: 'Next Task', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, staleThresholdHours }) => {
      const db = getMcpDb();

      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      // 疑似停滯任務（卡死偵測）——獨立於推薦邏輯，各回傳路徑都附上。即使沒有待辦
      // 任務，卡在 in_progress 的舊任務也要被提醒（resume_task 或標 failed）。
      const threshold = staleThresholdHours ?? DEFAULT_STALE_THRESHOLD_HOURS;
      const stalledTasks = listStalledTasks(db, projectId, threshold);
      const staleHint = stalledTasks.length > 0
        ? `偵測到 ${stalledTasks.length} 個疑似卡死的 in_progress 任務（停滯 ≥ ${threshold}h）：建議對每個先 resume_task 恢復脈絡，確認無法接續就 update_task_status(status="failed")。`
        : undefined;
      const staleSection = { staleThresholdHours: threshold, stalledTasks, ...(staleHint ? { staleHint } : {}) };

      const statusPlaceholders = PENDING_STATUSES.map(() => '?').join(',');
      const pendingTotal = (db.prepare(
        `SELECT COUNT(*) as count FROM tasks WHERE project_id = ? AND status IN (${statusPlaceholders})`
      ).get(projectId, ...PENDING_STATUSES) as { count: number }).count;

      if (pendingTotal === 0) {
        const anyTasks = (db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project_id = ?').get(projectId) as { count: number }).count;
        const reason = anyTasks === 0
          ? '此專案沒有任何任務。可用 create_task 建立，或 sync_asana_tasks 同步 Asana。'
          : '沒有待處理任務（全部已完成、進行中或失敗）。用 list_pending_tasks(statuses=["in_progress","failed"]) 查看進行中/失敗的任務。';
        return { content: [{ type: 'text' as const, text: JSON.stringify({ recommended: null, alternatives: [], reason, ...staleSection }, null, 2) }] };
      }

      // Unblocked pending tasks: no incomplete dependency.
      // 排序：bug 優先（既有語意不變）→ 同優先級內逾期/近到期優先
      // （due_date 越早越前，NULL 排最後）→ 建立時間。
      const candidates = db.prepare(`
        SELECT t.id, t.title, t.label, t.task_type, t.source_ref, t.due_date, t.created_at
        FROM tasks t
        WHERE t.project_id = ? AND t.status IN (${statusPlaceholders})
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies td
            JOIN tasks dep ON dep.id = td.depends_on_id
            WHERE td.task_id = t.id AND dep.status != 'completed'
          )
        ORDER BY (t.task_type = 'bug') DESC, (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at ASC
        LIMIT 5
      `).all(projectId, ...PENDING_STATUSES) as CandidateRow[];

      if (candidates.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              recommended: null,
              alternatives: [],
              reason: `有 ${pendingTotal} 個待處理任務，但全部被未完成的前置任務擋住（blocked）。先完成前置任務，或用 list_pending_tasks 檢視依賴關係。`,
              ...staleSection,
            }, null, 2),
          }],
        };
      }

      const today = localTodayYmd();
      const describe = (t: CandidateRow, isTop: boolean): Record<string, unknown> => {
        const dueInfo = describeDueDate(t.due_date, today); // 「已逾期 N 天」/「今天到期」/「N 天後到期」/ null
        const dueSuffix = dueInfo ? `（${dueInfo}）` : '';
        const baseReason = t.task_type === 'bug'
          ? (isTop ? 'bug 修復優先，且無未完成前置任務' : 'bug 修復優先')
          : (t.due_date
            ? `無未完成前置任務，截止日期較近 ${t.due_date}`
            : `無未完成前置任務，建立時間較早（${t.created_at}）`);
        return {
          id: t.id,
          title: t.title,
          label: t.label,
          taskType: t.task_type,
          sourceRef: t.source_ref,
          dueDate: t.due_date ?? null,
          reason: baseReason + dueSuffix,
        };
      };

      const [top, ...rest] = candidates;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            recommended: describe(top!, true),
            alternatives: rest.map(t => describe(t, false)),
            pendingTotal,
            ...staleSection,
          }, null, 2),
        }],
      };
    },
  );

  // ── get_task_outputs ──────────────────────────────────────
  server.tool(
    'get_task_outputs',
    '取回任務的歷史回報紀錄（report_output / report_milestone / 驗收結果，agent_id = mcp-{taskId}）。用途：新 session 接手任務時恢復脈絡。依時間正序回傳。',
    {
      taskId: z.string().describe('任務 ID'),
      limit: z.number().int().positive().max(500).optional().describe('最多回傳筆數（預設 50）'),
      offset: z.number().int().min(0).optional().describe('略過筆數，用於分頁（預設 0）'),
    },
    { title: 'Get Task Outputs', readOnlyHint: true, openWorldHint: false },
    async ({ taskId, limit, offset }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, title, status, result_summary FROM tasks WHERE id = ?').get(taskId) as
        { id: string; title: string; status: string; result_summary: string | null } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const agentId = `mcp-${taskId}`;
      const effLimit = limit ?? 50;
      const effOffset = offset ?? 0;

      const total = (db.prepare('SELECT COUNT(*) as count FROM agent_outputs WHERE agent_id = ?').get(agentId) as { count: number }).count;
      const rows = db.prepare(`
        SELECT stream_type, content, timestamp FROM agent_outputs
        WHERE agent_id = ?
        ORDER BY id ASC
        LIMIT ? OFFSET ?
      `).all(agentId, effLimit, effOffset) as Array<{ stream_type: string; content: string; timestamp: string }>;

      const text = JSON.stringify({
        taskId: task.id,
        title: task.title,
        status: task.status,
        resultSummary: task.result_summary,
        total,
        count: rows.length,
        offset: effOffset,
        hasMore: effOffset + rows.length < total,
        outputs: rows.map(r => ({ type: r.stream_type, content: r.content, timestamp: r.timestamp })),
      }, null, 2);

      return { content: [{ type: 'text' as const, text: truncateResponse(text, `用 offset/limit 分頁取得其餘紀錄（total: ${total}）`) }] };
    },
  );

  // ── update_task ───────────────────────────────────────────
  server.tool(
    'update_task',
    '更新任務欄位（白名單：title / label / taskType / tags / section）。至少提供一個欄位。不可改 status——狀態請用 update_task_status。',
    {
      taskId: z.string().describe('任務 ID'),
      title: z.string().min(1).optional().describe('新標題'),
      label: z.enum(TASK_LABELS).optional().describe('新 label（frontend/backend/fullstack/...）'),
      taskType: z.enum(TASK_TYPES).optional().describe('新任務類型（bug/feature/refactor/testing/other）'),
      tags: z.array(z.string()).optional().describe('新標籤陣列（整組覆蓋）'),
      section: z.string().optional().describe('新 Section 名稱（Asana 分區）'),
    },
    { title: 'Update Task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ taskId, title, label, taskType, tags, section }) => {
      const db = getMcpDb();

      const task = db.prepare('SELECT id, project_id, status FROM tasks WHERE id = ?').get(taskId) as
        { id: string; project_id: string; status: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const sets: string[] = [];
      const values: unknown[] = [];
      const changed: string[] = [];
      if (title !== undefined) { sets.push('title = ?'); values.push(title); changed.push('title'); }
      if (label !== undefined) { sets.push('label = ?'); values.push(label); changed.push('label'); }
      if (taskType !== undefined) { sets.push('task_type = ?'); values.push(taskType); changed.push('taskType'); }
      if (tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(tags)); changed.push('tags'); }
      if (section !== undefined) { sets.push('section = ?'); values.push(section); changed.push('section'); }

      if (sets.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: 至少提供一個要更新的欄位（title/label/taskType/tags/section）。狀態請用 update_task_status。' }], isError: true };
      }

      sets.push("updated_at = datetime('now')");
      values.push(taskId);
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

      // Notify with the full updated task (camelCase, mirrors task.created payload)
      // so the Web UI can merge the row in place.
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
      const notifyOk = await notifyWebServer({
        event: 'task.updated',
        data: {
          taskId,
          projectId: task.project_id,
          updatedFields: changed,
          task: {
            id: row['id'],
            projectId: row['project_id'],
            title: row['title'],
            description: row['description'] ?? null,
            label: row['label'],
            status: row['status'],
            assignedAgentId: row['assigned_agent_id'] ?? null,
            priority: row['priority'],
            retryCount: row['retry_count'] ?? 0,
            taskType: row['task_type'],
            source: row['source'],
            sourceRef: row['source_ref'] ?? null,
            branchName: row['branch_name'] ?? null,
            specUrl: row['spec_url'] ?? null,
            preferredModel: row['preferred_model'] ?? null,
            parentName: row['parent_name'] ?? null,
            dueDate: row['due_date'] ?? null,
            createdAt: row['created_at'],
            updatedAt: row['updated_at'],
          },
        },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return { content: [{ type: 'text' as const, text: `Task ${taskId} updated (${changed.join(', ')})${warning}` }] };
    },
  );

  // ── health_check ──────────────────────────────────────────
  server.tool(
    'health_check',
    '診斷 OmniCommander 各依賴的健康狀態：DB 連線、Web Server (:3457)、Asana PAT、SVN CLI。每項獨立檢查，一項失敗不影響其他。',
    {},
    { title: 'Health Check', readOnlyHint: true, openWorldHint: true },
    async () => {
      const result: Record<string, unknown> = {};

      // (a) DB
      try {
        const db = getMcpDb();
        db.prepare('SELECT 1').get();
        result['db'] = { ok: true, path: getDbPath().replace(/\\/g, '/') };
      } catch (err) {
        result['db'] = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      // (b) Web Server
      const notifyUrl = process.env['NOTIFY_URL'] || 'http://127.0.0.1:3457/api/mcp-notify';
      const baseUrl = notifyUrl.replace('/api/mcp-notify', '');
      try {
        const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data = await res.json() as { ok?: boolean; uptime?: number; status?: string };
          result['webServer'] = { ok: true, url: baseUrl, uptimeSeconds: typeof data.uptime === 'number' ? Math.round(data.uptime) : null };
        } else {
          result['webServer'] = { ok: false, url: baseUrl, error: `HTTP ${res.status}` };
        }
      } catch (err) {
        result['webServer'] = { ok: false, url: baseUrl, error: `無法連線（Web Server 沒開？）: ${err instanceof Error ? err.message : String(err)}` };
      }

      // (c) Asana
      try {
        const db = getMcpDb();
        const pat = getAsanaPat(db);
        if (!pat) {
          result['asana'] = { status: 'not_configured', hint: '用 set_global_config 設定 asana.pat' };
        } else {
          try {
            const res = await fetch(`${ASANA_API_BASE}/users/me`, {
              headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' },
              signal: AbortSignal.timeout(10000),
            });
            result['asana'] = res.ok ? { status: 'valid' } : { status: 'invalid', error: `HTTP ${res.status}` };
          } catch (err) {
            result['asana'] = { status: 'invalid', error: err instanceof Error ? err.message : String(err) };
          }
        }
      } catch (err) {
        result['asana'] = { status: 'invalid', error: err instanceof Error ? err.message : String(err) };
      }

      // (d) SVN (local binary check only, no network)
      try {
        const svn = spawnSync('svn', ['--version', '--quiet'], { encoding: 'utf-8', timeout: 5000 });
        if (!svn.error && svn.status === 0 && svn.stdout) {
          result['svn'] = { status: 'ok', version: svn.stdout.trim() };
        } else {
          result['svn'] = { status: 'not_found', hint: '安裝 svn CLI 或確認 PATH（fetch_svn_specs 需要）' };
        }
      } catch (err) {
        result['svn'] = { status: 'not_found', error: err instanceof Error ? err.message : String(err) };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── analyze_harness ───────────────────────────────────────
  // Loop 4 的第一步：讓 omni 讀自己累積的 trace。唯讀，不改任何資料、不碰閘門。
  server.tool(
    'analyze_harness',
    '分析 omni 自己累積的回對／缺口／筆記資料，找出**這套機制本身**在哪裡失靈（不是找某個任務的 bug）。回答：哪類檢查項第一輪失敗率最高（prompt 或比對規則沒把要求傳達到）、reviewer 有多常在 note 裡自述「這是工具誤判」、重審率、程式預檢與 AI 判定分歧集中在哪、哪類規格缺口久未裁決、哪類專案筆記常被推翻。**所有統計按月份切**——單一總數會把已修好的舊帳和現在還在壞的混成同一個數字，照著總數改就會改錯地方。純唯讀 SELECT，不影響任何閘門或判定。',
    {
      projectId: z.string().optional().describe('只看單一專案（省略＝全部專案）'),
      sinceMonths: z.number().int().positive().max(36).optional().describe('只看最近 N 個月（省略＝全部歷史）'),
    },
    { title: 'Analyze Harness', readOnlyHint: true },
    async ({ projectId, sinceMonths }) => {
      const db = getMcpDb();

      const since = sinceMonths
        ? new Date(Date.now() - sinceMonths * 31 * 86_400_000).toISOString().slice(0, 10)
        : null;
      const nowIso = new Date().toISOString();

      // ── 回對 run ──
      const runWhere: string[] = ["r.source = 'ai_review'"];
      const runParams: string[] = [];
      if (projectId) { runWhere.push('t.project_id = ?'); runParams.push(projectId); }
      if (since) { runWhere.push('r.run_at >= ?'); runParams.push(since); }
      const runRows = db.prepare(`
        SELECT r.task_id, r.run_at, r.source, r.results_json
          FROM spec_compliance_runs r JOIN tasks t ON t.id = r.task_id
         WHERE ${runWhere.join(' AND ')}
         ORDER BY r.run_at
      `).all(...runParams) as Array<{ task_id: string; run_at: string; source: string; results_json: string | null }>;

      const runs: ReviewRun[] = [];
      let unparsable = 0;
      for (const row of runRows) {
        let results: ReviewRun['results'] = [];
        try {
          const parsed = JSON.parse(row.results_json || '[]');
          results = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
        } catch { unparsable++; continue; }
        runs.push({ taskId: row.task_id, runAt: row.run_at, source: row.source, results });
      }

      if (runs.length === 0) {
        return { content: [{ type: 'text' as const, text: `沒有符合條件的 AI 回對紀錄${projectId ? `（專案 ${projectId}）` : ''}${since ? `（${since} 之後）` : ''}——無從分析。` }] };
      }

      // ── 規格缺口 ──
      const gapWhere: string[] = [];
      const gapParams: string[] = [];
      if (projectId) { gapWhere.push('project_id = ?'); gapParams.push(projectId); }
      if (since) { gapWhere.push('created_at >= ?'); gapParams.push(since); }
      const gaps = (db.prepare(`
        SELECT id, category, status, created_at, resolved_at FROM spec_gaps
        ${gapWhere.length ? 'WHERE ' + gapWhere.join(' AND ') : ''}
      `).all(...gapParams) as Array<{ id: string; category: string; status: string; created_at: string; resolved_at: string | null }>)
        .map<SpecGapRow>(g => ({ id: g.id, category: g.category, status: g.status, createdAt: g.created_at, resolvedAt: g.resolved_at }));

      // ── 專案筆記 ──
      const notes = (db.prepare(`
        SELECT id, category, active, created_at FROM project_notes
        ${projectId ? 'WHERE project_id = ?' : ''}
      `).all(...(projectId ? [projectId] : [])) as Array<{ id: string; category: string | null; active: number; created_at: string }>)
        .map<ProjectNoteRow>(n => ({ id: n.id, category: n.category, active: n.active, createdAt: n.created_at }));

      // ── 分析 ──
      const first = firstRoundPerTask(runs);
      const rates = missRateByType(first);
      const trend = toolLimitationTrend(runs);
      const rounds = reviewRounds(runs);
      const diverge = divergenceByType(runs);
      const divTrend = divergenceTrend(runs);
      const emerging = emergingDivergence(divTrend);
      const gapsStat = gapStats(gaps, nowIso);
      const shape = gapShape(gaps, nowIso);
      const churn = noteChurn(notes);

      const pct = (n: number) => `${n}%`;
      const L: string[] = [];
      L.push(`# Harness 自我分析${projectId ? `（專案 ${projectId}）` : '（全部專案）'}`);
      L.push('');
      L.push(`範圍：${runs.length} 輪 AI 回對、${rounds.totalTasks} 個任務、${gaps.length} 條規格缺口、${notes.length} 則專案筆記${since ? `（${since} 之後）` : ''}`);
      if (unparsable) L.push(`⚠ 有 ${unparsable} 輪的 results_json 解不開，已略過`);
      L.push('');

      L.push('## 1. 工具自述「這是誤判」的趨勢（先看這個）');
      L.push('');
      L.push('| 月份 | 判不符 | 自述工具問題 | 比例 |');
      L.push('|---|---:|---:|---:|');
      for (const t of trend) L.push(`| ${t.month} | ${t.missing} | ${t.flagged} | ${pct(t.pct)} |`);
      L.push('');
      L.push(`**判讀**：${readTrend(trend)}`);
      L.push('');
      L.push('> 這是關鍵字掃 note 的結果，**不是事實**——reviewer 換個講法就掃不到。只能當「往哪裡看」的指引。');
      L.push('> 要精確，得讓 reviewer 填結構化旗標而不是寫在自由文字裡。');
      L.push('');

      L.push('## 2. 第一輪各類型不符率');
      L.push('');
      L.push('只算每個任務**最早**那一輪——第二輪以後是「修完再驗」，本來就該過。');
      L.push('');
      L.push('| 檢查項類型 | 總數 | 不符 | 不符率 |');
      L.push('|---|---:|---:|---:|');
      for (const r of rates) L.push(`| ${r.itemType} | ${r.total} | ${r.missing} | ${pct(r.rate)} |`);
      L.push('');

      L.push('## 3. 重審輪數');
      L.push('');
      L.push(`${rounds.totalTasks} 個任務裡 **${rounds.needsRework} 個（${pct(rounds.reworkRate)}）第一輪沒過**。`);
      L.push('');
      L.push('| 跑幾輪 | 任務數 |');
      L.push('|---:|---:|');
      for (const d of rounds.distribution) L.push(`| ${d.rounds} | ${d.tasks} |`);
      if (rounds.heavyTasks.length) {
        L.push('');
        L.push(`**跑三輪以上的 ${rounds.heavyTasks.length} 個任務**（reviewer 反覆抓同一件事，通常是規格或 prompt 的問題）：`);
        for (const h of rounds.heavyTasks.slice(0, 15)) L.push(`- \`${h.taskId}\` — ${h.rounds} 輪`);
        if (rounds.heavyTasks.length > 15) L.push(`- （其餘 ${rounds.heavyTasks.length - 15} 個略）`);
      }
      L.push('');

      if (diverge.length) {
        L.push('## 4. 程式預檢與 AI 判定分歧');
        L.push('');
        L.push('| 檢查項類型 | 預檢說有、AI 說沒有 | 預檢說沒有、AI 說有 |');
        L.push('|---|---:|---:|');
        for (const d of diverge) L.push(`| ${d.itemType} | ${d.engineMatchedAiMissing} | ${d.engineMissingAiMatched} |`);
        L.push('');
        L.push('**兩欄意義相反**：左欄是「字面存在但實際沒接上」，AI 通常是對的；');
        L.push('右欄是「比對規則抓不到的寫法」，那是規則要補的地方。');
        L.push('');
        L.push('⚠ **上表是全期加總，不要照它決定修什麼。** 加總會同時藏住兩種相反的狀況——');
        L.push('已修好的舊帳被誇大、這個月才冒出來的新問題被攤平。看下面的月份趨勢：');
        L.push('');
        L.push('| 類型 | 月份 | 可比項目 | 規則抓不到 | 比例 |');
        L.push('|---|---|---:|---:|---:|');
        for (const d of divTrend.filter(x => x.ruleGap > 0 || x.compared >= 20)) {
          L.push(`| ${d.itemType} | ${d.month} | ${d.compared} | ${d.ruleGap} | ${d.ruleGapRate}% |`);
        }
        L.push('');
        if (emerging.length) {
          L.push('**最近才冒出來或明顯變嚴重的**（這些才是現在該查的，不是總數最大的）：');
          for (const e of emerging) {
            L.push(`- **${e.itemType}**（${e.month}）：${e.rate}%，${e.prevRate === null ? '之前沒有足夠資料' : `前一期 ${e.prevRate}%`}——${e.ruleGap} 筆程式預檢漏判`);
          }
        } else {
          L.push('沒有最近才冒出來的分歧——現有的分歧都是舊帳或在收斂。');
        }
        L.push('');
      }

      if (gapsStat.length) {
        L.push('## 5. 規格缺口的裁決速度');
        L.push('');
        L.push(`**判讀**：${shape.reading}`);
        L.push('');
        const rw = shape.resolvedWithin, of = shape.openFor;
        L.push(`已裁決 ${shape.resolved} 條：一小時內 ${rw.hour}、一天內 ${rw.day}、一週內 ${rw.week}、更久 ${rw.later}`);
        L.push(`未裁決 ${shape.open} 條：不到一週 ${of.underWeek}、一週到一個月 ${of.weekToMonth}、**超過一個月 ${of.overMonth}**`);
        L.push('');
        L.push('| 分類 | 未裁決 | 已裁決 | 裁決中位時間 | 最久未決 |');
        L.push('|---|---:|---:|---:|---:|');
        const fmtH = (h: number | null) => h == null ? '—' : h < 48 ? `${h} 小時` : `${Math.round(h / 24)} 天`;
        for (const g of gapsStat) {
          L.push(`| ${g.category} | ${g.open} | ${g.resolved} | ${fmtH(g.medianResolveHours)} | ${g.oldestOpenDays != null ? `${g.oldestOpenDays} 天` : '—'} |`);
        }
        L.push('');
        L.push('未裁決堆積的分類，代表那個 prompt 沒把「需要人拍板」講到位，或那類缺口本來就沒人在乎。');
        L.push('');
      }

      if (churn.length) {
        L.push('## 6. 專案筆記的汰換率');
        L.push('');
        L.push('| 分類 | 有效 | 已封存 | 封存率 |');
        L.push('|---|---:|---:|---:|');
        for (const n of churn) L.push(`| ${n.category} | ${n.active} | ${n.archived} | ${pct(n.archiveRate)} |`);
        L.push('');
        L.push('封存率高＝那類「經驗」常被推翻，記下來的品質有問題。');
        L.push('');
      }

      L.push('---');
      L.push('');
      L.push('**這份是分析不是結論。** 改哪裡、要不要改，由人決定——尤其第 1 節在收斂時，');
      L.push('照總數去改比對規則會修到已經修好的東西。');

      return { content: [{ type: 'text' as const, text: truncateResponse(L.join('\n')) }] };
    },
  );

  // ── get_attention_summary ─────────────────────────────────
  // 把 omni 已知、但要有人來問才說的事收在一起。唯讀，不改資料、不碰閘門、不推送。
  server.tool(
    'get_attention_summary',
    '「現在該注意什麼」摘要：卡著工作的規格缺口（進行中任務上擱置超過門檻）、帶著未裁決缺口就結案的任務、失敗任務上的缺口、疑似停滯的進行中任務、已逾期的任務。**依「要做什麼」分組**——同樣擱置一個月的缺口，掛在進行中任務上是工作卡著、掛在已結案任務上是帶著問題結案，要找的人不同。什麼都沒有時明說「沒有需要注意的事」。純唯讀 SELECT，不影響任何閘門。',
    {
      projectId: z.string().optional().describe('只看單一專案（省略＝全部專案）'),
      staleGapDays: z.number().int().positive().max(365).optional().describe('進行中任務的缺口擱置超過幾天算卡住（預設 30）'),
      stalledHours: z.number().int().positive().optional().describe(`進行中任務多久沒動靜算停滯（預設 ${DEFAULT_STALE_THRESHOLD_HOURS}）`),
    },
    { title: 'Attention Summary', readOnlyHint: true },
    async ({ projectId, staleGapDays, stalledHours }) => {
      const db = getMcpDb();
      const collected = collectAttention(db, { projectId, staleGapDays, stalledHours });
      if (!collected) {
        return { content: [{ type: 'text' as const, text: `找不到專案 ${projectId}` }], isError: true };
      }
      const { summary: s, scope } = collected;
      if (s.empty) {
        return { content: [{ type: 'text' as const, text: `${scope}：沒有需要注意的事。` }] };
      }

      const TOP = 10;
      const more = (n: number) => (n > TOP ? `- （其餘 ${n - TOP} 項略，用 projectId 縮小範圍）` : null);
      // 缺口描述常含換行，不壓平會把清單排版拆散
      const cut = (t: string, n = 60) => {
        const flat = t.replace(/\s+/g, ' ').trim();
        return flat.length > n ? flat.slice(0, n) + '…' : flat;
      };
      const perProject = (xs: Array<{ projectName: string; count: number }>) =>
        '各專案：' + xs.map(x => `${x.projectName} ${x.count}`).join('、');
      const L: string[] = [`# 該注意什麼（${scope}）`, ''];
      const c = s.counts;
      L.push(`卡住的缺口 ${c.blocking}・結案仍有缺口 ${c.closedWithOpenGaps}・失敗任務的缺口 ${c.failedWithOpenGaps}・停滯任務 ${c.stalled}・逾期任務 ${c.overdue}`);
      if (c.stalledAndOverdue) L.push(`（其中 ${c.stalledAndOverdue} 個任務既停滯又逾期——同一件事，別當兩件算）`);
      L.push('');

      const gapSection = (title: string, hint: string, groups: GapGroup[], count: number) => {
        if (!groups.length) return;
        L.push(`## ${title}（${groups.length} 個任務、${count} 條缺口）`, '', hint, '');
        for (const g of groups.slice(0, TOP)) {
          L.push(`- **${g.taskTitle ?? '(任務已刪除)'}**（${g.projectName}）— ${g.gapCount} 條，最久 ${g.oldestDays} 天｜${g.categories.join(', ')}`);
          L.push(`  - 例：${cut(g.sample)}${g.taskId ? `　\`${g.taskId}\`` : ''}`);
        }
        const m = more(groups.length); if (m) L.push(m);
        L.push('');
      };
      gapSection('卡著工作的缺口', `進行中的任務上擱置超過 ${staleGapDays ?? 30} 天、還沒人拍板。**要找能裁決規格的人。**`, s.blocking, c.blocking);
      gapSection('帶著未裁決缺口結案', '任務已標完成，但缺口沒裁決。要嘛是真的沒影響（那就 resolve 並寫明理由），要嘛是結案結早了。', s.closedWithOpenGaps, c.closedWithOpenGaps);
      gapSection('失敗任務上的缺口', '任務可能就是卡在這裡失敗的——重試前先裁決。', s.failedWithOpenGaps, c.failedWithOpenGaps);

      if (s.stalled.length) {
        L.push(`## 疑似停滯的進行中任務（${s.stalled.length}）`, '', 'session 可能已中斷、沒人回報狀態。用 resume_task 接手，或標 failed。', '', perProject(s.stalledByProject), '');
        for (const t of s.stalled.slice(0, TOP)) L.push(`- **${t.title}**（${t.projectName}）— ${t.stalledHours} 小時沒動靜　\`${t.taskId}\``);
        const m = more(s.stalled.length); if (m) L.push(m);
        L.push('');
      }
      if (s.overdue.length) {
        L.push(`## 已逾期（${s.overdue.length}）`, '', perProject(s.overdueByProject), '');
        for (const t of s.overdue.slice(0, TOP)) L.push(`- **${t.title}**（${t.projectName}）— ${t.dueText}${t.alsoStalled ? '，且停滯中' : ''}　\`${t.taskId}\``);
        const m = more(s.overdue.length); if (m) L.push(m);
        L.push('');
      }
      return { content: [{ type: 'text' as const, text: truncateResponse(L.join('\n')) }] };
    },
  );
}
