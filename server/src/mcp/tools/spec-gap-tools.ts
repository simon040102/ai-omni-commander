/**
 * MCP tools for structured spec-gap tracking.
 * report_spec_gap, list_spec_gaps, resolve_spec_gap
 *
 * Backs the project rule「完成任務後必須列出規格缺少/待補清單」— instead of
 * free-text [NEEDS_CLARIFICATION] markers, gaps are persisted in the spec_gaps
 * table and surfaced in the Web UI.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { ensureMcpAgent } from '../helpers.js';
import { validateResolutionNote, RESOLUTION_NOTE_MIN_LENGTH } from '../../utils/specGapResolution.js';

export const SPEC_GAP_CATEGORIES = ['sa_missing', 'sd_missing', 'field_undefined', 'api_undefined', 'logic_unclear', 'other', 'spec_changed', 'sa_sd_mismatch', 'ambiguous_spec'] as const;

interface SpecGapRow {
  id: string;
  task_id: string;
  project_id: string;
  category: string;
  description: string;
  status: string;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function registerSpecGapTools(server: McpServer): void {

  // ── report_spec_gap ───────────────────────────────────────
  server.tool(
    'report_spec_gap',
    '回報規格缺口（SA/SD 沒定義的東西）。**遇到規格未定義、不清楚或矛盾的欄位/API/邏輯時，不要自行編造或猜測——呼叫此工具記錄，標記 [NEEDS_CLARIFICATION] 後繼續做其他部分。** 記錄會列入專案的「規格缺少/待補清單」，由使用者補規格。任務結束前應確保所有遇到的規格缺口都已回報。使用者拍板後必須用 resolve_spec_gap(gapId, resolutionNote=具體裁決) 落地——裁決只由工具從 DB 自動注入後續派工與 AI 回對，嚴禁只在對話帶過。',
    {
      taskId: z.string().describe('任務 ID'),
      category: z.enum(SPEC_GAP_CATEGORIES).describe('缺口分類：sa_missing=SA 文件缺失 / sd_missing=SD 文件缺失 / field_undefined=欄位未定義 / api_undefined=API 未定義 / logic_unclear=邏輯不明確或矛盾 / other=其他 / spec_changed=規格檔案已在 SVN 更新（通常由 check_spec_changes 自動建立）/ sa_sd_mismatch=SA 與 SD 規格互相矛盾（通常由 check_spec_consistency 的一致性檢查 agent 建立）/ ambiguous_spec=規格模糊或有多種合理解讀——implementer 會被迫用猜的決策點（通常由 check_spec_consistency 維度二「規格模糊點預檢」在派工前建立，開給使用者拍板；advisory，不擋工）'),
      description: z.string().min(1).describe('缺口描述：具體說明缺什麼（哪個欄位/API/流程）、在哪份規格找過、需要使用者補什麼'),
    },
    { title: 'Report Spec Gap', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, category, description }) => {
      const db = getMcpDb();

      const task = db.prepare('SELECT project_id, title FROM tasks WHERE id = ?').get(taskId) as { project_id: string; title: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const gapId = randomUUID();
      db.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description)
        VALUES (?, ?, ?, ?, ?)
      `).run(gapId, taskId, task.project_id, category, description);

      // Also log a system line into agent_outputs so the gap shows up in the terminal view
      const { agentId, created, role, title } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: task.project_id, taskId, role, title, model: 'external (MCP)' },
        });
      }
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, taskId, `[SPEC_GAP][${category}] ${description}`);

      const notifyOk = await notifyWebServer({
        event: 'task.specGap',
        data: { gapId, taskId, projectId: task.project_id, category, description, status: 'open', action: 'reported' },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return {
        content: [{
          type: 'text' as const,
          text: `Spec gap recorded (id: ${gapId})${warning}。已列入待補規格清單。請標記 [NEEDS_CLARIFICATION] 並繼續其他有規格依據的部分，不要自行編造補值。`,
        }],
      };
    },
  );

  // ── list_spec_gaps ────────────────────────────────────────
  server.tool(
    'list_spec_gaps',
    '列出規格缺口清單。至少提供 projectId 或 taskId 其中一個過濾條件。用於任務結束前彙整「規格缺少/待補清單」給使用者。',
    {
      projectId: z.string().optional().describe('專案 ID（列出整個專案的缺口）'),
      taskId: z.string().optional().describe('任務 ID（只列出此任務的缺口）'),
      status: z.enum(['open', 'resolved']).optional().describe('過濾狀態（不給則回全部）'),
    },
    { title: 'List Spec Gaps', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, taskId, status }) => {
      const db = getMcpDb();

      if (!projectId && !taskId) {
        return { content: [{ type: 'text' as const, text: 'Error: 至少提供 projectId 或 taskId 其中一個過濾條件' }], isError: true };
      }

      const conditions: string[] = [];
      const params: unknown[] = [];
      if (projectId) { conditions.push('g.project_id = ?'); params.push(projectId); }
      if (taskId) { conditions.push('g.task_id = ?'); params.push(taskId); }
      if (status) { conditions.push('g.status = ?'); params.push(status); }
      const where = `WHERE ${conditions.join(' AND ')}`;

      const total = (db.prepare(`SELECT COUNT(*) as count FROM spec_gaps g ${where}`).get(...params) as { count: number }).count;
      const rows = db.prepare(`
        SELECT g.*, t.title as task_title
        FROM spec_gaps g LEFT JOIN tasks t ON t.id = g.task_id
        ${where}
        ORDER BY g.created_at DESC
        LIMIT 200
      `).all(...params) as Array<SpecGapRow & { task_title: string | null }>;

      const gaps = rows.map(r => ({
        id: r.id,
        taskId: r.task_id,
        taskTitle: r.task_title,
        projectId: r.project_id,
        category: r.category,
        description: r.description,
        status: r.status,
        resolutionNote: r.resolution_note,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ total, count: gaps.length, gaps }, null, 2),
        }],
      };
    },
  );

  // ── resolve_spec_gap ──────────────────────────────────────
  server.tool(
    'resolve_spec_gap',
    '標記規格缺口為已解決並**落地使用者的裁決**（使用者拍板後必須立刻呼叫——這是裁決唯一生效管道）。裁決效力等同規格：resolutionNote 會自動注入後續派工 prompt、resume_task 與 AI 回對計畫，寫得含糊等於規格含糊。**嚴禁只把答案手動寫進派工 prompt 或在對話帶過**——不落地 = implementer 與 reviewer 看不到。',
    {
      gapId: z.string().describe('缺口 ID（report_spec_gap 回傳的 id）'),
      resolutionNote: z.string().min(RESOLUTION_NOTE_MIN_LENGTH).describe('裁決內容（必填）：使用者拍板的具體決定，效力等同規格（例如「選 B：刪除前 confirm 彈窗」）。不可只寫「可以」「好」「照舊」等空泛詞。'),
    },
    { title: 'Resolve Spec Gap', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ gapId, resolutionNote }) => {
      const db = getMcpDb();

      const gap = db.prepare('SELECT * FROM spec_gaps WHERE id = ?').get(gapId) as SpecGapRow | undefined;
      if (!gap) {
        return { content: [{ type: 'text' as const, text: `Error: Spec gap "${gapId}" not found. 用 list_spec_gaps 確認 gapId。` }], isError: true };
      }
      if (gap.status === 'resolved') {
        return { content: [{ type: 'text' as const, text: `Spec gap ${gapId} is already resolved (at ${gap.resolved_at}).` }] };
      }

      // E1：答案品質驗證（zod 已擋長度，這裡再防呆一次並擋空泛詞——涵蓋不經 zod 的呼叫路徑）
      const validation = validateResolutionNote(resolutionNote);
      if (!validation.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.error}` }], isError: true };
      }

      db.prepare(`
        UPDATE spec_gaps SET status = 'resolved', resolution_note = ?, resolved_at = datetime('now')
        WHERE id = ?
      `).run(validation.note, gapId);

      const notifyOk = await notifyWebServer({
        event: 'task.specGap',
        data: { gapId, taskId: gap.task_id, projectId: gap.project_id, category: gap.category, description: gap.description, status: 'resolved', action: 'resolved' },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return { content: [{ type: 'text' as const, text: `Spec gap ${gapId} marked as resolved${warning}。裁決已落地 DB——後續派工 prompt / resume_task / AI 回對計畫會自動注入此裁決（效力等同規格），不需（也不可）手動轉述。` }] };
    },
  );
}
