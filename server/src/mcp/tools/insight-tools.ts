/**
 * MCP tools for task insight & maintenance.
 * next_task, get_task_outputs, update_task, health_check
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
}
