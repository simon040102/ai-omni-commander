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
import { ensureMcpAgent, compactJson, fitListToLimit, resolveIdPrefix, ambiguousIdMessage } from '../helpers.js';
import { validateResolutionNote, RESOLUTION_NOTE_MIN_LENGTH } from '../../utils/specGapResolution.js';

export const SPEC_GAP_CATEGORIES = ['sa_missing', 'sd_missing', 'field_undefined', 'api_undefined', 'logic_unclear', 'other', 'spec_changed', 'sa_sd_mismatch', 'spec_internal_conflict', 'ambiguous_spec'] as const;

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
  /** 'task' | 'project'。v22 遷移以 NOT NULL DEFAULT 'task' 加入，SQLite 會把既有列
   *  回填成 'task'，所以實務上不會是 NULL；型別留 null 只是對更舊的 schema 防禦。 */
  scope: string | null;
}

export function registerSpecGapTools(server: McpServer): void {

  // ── report_spec_gap ───────────────────────────────────────
  server.tool(
    'report_spec_gap',
    '回報規格缺口（SA/SD 沒定義的東西）。**遇到規格未定義、不清楚或矛盾的欄位/API/邏輯時，不要自行編造或猜測——呼叫此工具記錄，標記 [NEEDS_CLARIFICATION] 後繼續做其他部分。** 記錄會列入專案的「規格缺少/待補清單」，由使用者補規格。任務結束前應確保所有遇到的規格缺口都已回報。使用者拍板後必須用 resolve_spec_gap(gapId, resolutionNote=具體裁決, scope="project" 或 "task") 落地——裁決只由工具從 DB 自動注入後續派工與 AI 回對，嚴禁只在對話帶過。',
    {
      taskId: z.string().describe('任務 ID'),
      category: z.enum(SPEC_GAP_CATEGORIES).describe('缺口分類：sa_missing=SA 文件缺失 / sd_missing=SD 文件缺失 / field_undefined=欄位未定義 / api_undefined=API 未定義 / logic_unclear=邏輯不明確或矛盾 / other=其他 / spec_changed=規格檔案已在 SVN 更新（通常由 check_spec_changes 自動建立）/ sa_sd_mismatch=SA 與 SD 規格互相矛盾（通常由 check_spec_consistency 維度一建立）/ spec_internal_conflict=**同一份規格文件自己前後矛盾**（SD 的欄位定義表 vs SQL 參考、INPUT 表 vs 格式範例、章節 vs 章節；SA 的欄位說明表 vs 畫面稿圖片…通常由 check_spec_consistency 維度二建立）。與 sa_sd_mismatch 分開的理由：後者要兩份文件才看得出來，這個純讀一份就成立，處理的人也不同 / ambiguous_spec=規格模糊或有多種合理解讀——implementer 會被迫用猜的決策點（通常由 check_spec_consistency 維度二「規格模糊點預檢」在派工前建立，開給使用者拍板；advisory，不擋工）'),
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
      limit: z.number().int().min(1).max(200).optional().describe('一頁幾筆（預設 50）'),
      offset: z.number().int().min(0).optional().describe('從第幾筆開始（翻頁用；回應的 nextOffset 就是下一頁的值）'),
    },
    { title: 'List Spec Gaps', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, taskId, status, limit, offset }) => {
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
        ORDER BY g.created_at DESC, g.id DESC
        LIMIT ? OFFSET ?
      `).all(...params, limit ?? 50, offset ?? 0) as Array<SpecGapRow & { task_title: string | null }>;

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

      // 分頁＋放得下多少帶多少：原本固定 LIMIT 200、縮排 JSON，實測 105 次超過輸出上限，超過 200 筆的還無聲截掉
      const start = offset ?? 0;
      const { text } = fitListToLimit(gaps, shown => {
        const next = start + shown.length;
        const more = next < total;
        return compactJson({
          total, offset: start, count: shown.length, gaps: shown,
          ...(more ? { nextOffset: next, note: `還有 ${total - next} 筆，用 offset=${next} 取下一頁` } : {}),
        });
      });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ── resolve_spec_gap ──────────────────────────────────────
  server.tool(
    'resolve_spec_gap',
    '標記規格缺口為已解決並**落地使用者的裁決**（使用者拍板後必須立刻呼叫——這是裁決唯一生效管道）。裁決效力等同規格：resolutionNote 會自動注入後續派工 prompt、resume_task 與 AI 回對計畫，寫得含糊等於規格含糊。**嚴禁只把答案手動寫進派工 prompt 或在對話帶過**——不落地 = implementer 與 reviewer 看不到。',
    {
      gapId: z.string().describe('缺口 ID（report_spec_gap 回傳的 id；也接受唯一的前 8 碼以上前綴）'),
      resolutionNote: z.string().min(RESOLUTION_NOTE_MIN_LENGTH).describe('裁決內容（必填）：使用者拍板的具體決定，效力等同規格（例如「選 B：刪除前 confirm 彈窗」）。不可只寫「可以」「好」「照舊」等空泛詞。'),
      revise: z.boolean().optional().describe('修訂一則**已落地但發現是錯的**裁決。預設 false（已解決的缺口原樣拒收）。裁決會自動注入後續派工與 AI 回對，所以錯的裁決若沒有更正管道就會一直注入下去——這個旗標就是那個管道。前一版不會被刪掉，會以「已被取代」的形式附在新裁決之後。'),
      scope: z.enum(['task', 'project']).optional().describe(
        '這則裁決管到誰（**新裁決必填**；修訂沒帶就沿用原本的範圍）。`task`＝只注入開這個缺口的那一支任務；'
        + '`project`＝**同專案每一支任務都注入**。\n'
        + '缺口是「誰遇到誰開」的，而裁決管的往往是別人——**定共用基礎、命名、代碼值域、'
        + '設定鍵、跨功能契約的裁決，幾乎都該是 project**。判準：「照這則做的人，會不會有'
        + '別支任務的人？」會，就選 project。\n'
        + '選錯的代價不對稱：標成 project 只是多注入幾行；標成 task 而實際跨任務，'
        + '那支真正要照做的任務**看不到它**，獨立回對員會照原始規格判 missing。',
      ),
    },
    { title: 'Resolve Spec Gap', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ gapId: givenGapId, resolutionNote, revise, scope }) => {
      const db = getMcpDb();

      // 接受唯一的 8 碼前綴；之後一律用完整 ID（更新、稽核、通知都靠它）
      const resolvedId = resolveIdPrefix(db, 'spec_gaps', givenGapId);
      if (resolvedId && 'ambiguous' in resolvedId) {
        return { content: [{ type: 'text' as const, text: ambiguousIdMessage('gapId', givenGapId, resolvedId.ambiguous) }], isError: true };
      }
      const gapId = resolvedId?.id ?? givenGapId;
      const gap = db.prepare('SELECT * FROM spec_gaps WHERE id = ?').get(gapId) as SpecGapRow | undefined;
      if (!gap) {
        return { content: [{ type: 'text' as const, text: `Error: Spec gap "${gapId}" not found. 用 list_spec_gaps 確認 gapId。` }], isError: true };
      }
      if (gap.status === 'resolved' && !revise) {
        return {
          content: [{
            type: 'text' as const,
            text: `Spec gap ${gapId} is already resolved (at ${gap.resolved_at})。`
              + `\n\n若這一則裁決**本身是錯的**（而不是要補充細節），用 revise: true 重新呼叫來修訂。`
              + `裁決會自動注入後續派工與 AI 回對計畫，錯的裁決不更正就會一直注入下去；`
              + `修訂會把前一版以「已被取代」的形式保留在新裁決之後，不會憑空消失。`,
          }],
        };
      }

      // E1：答案品質驗證（zod 已擋長度，這裡再防呆一次並擋空泛詞——涵蓋不經 zod 的呼叫路徑）
      const validation = validateResolutionNote(resolutionNote);
      if (!validation.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${validation.error}` }], isError: true };
      }

      // 修訂：把前一版接在新裁決之後保留。
      //
      // 為什麼不直接覆蓋：一則錯的裁決被悄悄換掉，和不能換一樣糟——下一個人會看到一份
      // 與程式碼、與測試註解對不上的「規格條文」，而且查不出它何時變過。實例（2026-09-19）：
      // 碼值換中文的裁決當天落地、當天被推翻，撤回時程式／測試／流程圖／驗證報告都改了，
      // 唯獨這裡改不動，於是 reviewer 拿到兩份互相矛盾的條文。
      let finalNote = validation.note;
      if (gap.status === 'resolved') {
        const previous = (gap.resolution_note ?? '').trim();
        if (previous === validation.note) {
          return { content: [{ type: 'text' as const, text: `Error: revise 的裁決內容與現行版本完全相同，沒有東西可修訂。` }], isError: true };
        }
        if (previous) {
          finalNote = `${validation.note}\n\n---\n【已被取代的前一版裁決（落地於 ${gap.resolved_at}）——不可照辦，僅供追溯】\n${previous}`;
        }
      }

      // 新裁決必須明確選範圍：實測預設 task＋一句提醒不夠（SM07 有 4 則漏標全案適用，後續任務與審查員都看不到）。
      // 不改成預設 project——那會把只屬於單一任務的裁決誤套全案。修訂沒帶就沿用原本的範圍。
      if (gap.status !== 'resolved' && scope === undefined) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 新裁決必須明確指定 scope（這則裁決管到誰），裁決尚未落地：\n`
              + `- scope: "project" ＝同專案每一支任務都注入。共用基礎、命名、代碼值域、設定鍵、跨功能契約的裁決幾乎都是這個\n`
              + `- scope: "task" ＝只注入開這個缺口的那一支任務\n`
              + `判準：「照這則做的人，會不會有別支任務的人？」會，就是 project。標錯的代價不對稱：多標只是多注入幾行；少標的話，真正要照做的那支任務看不到它，審查員會照原始規格判 missing。`,
          }],
          isError: true,
        };
      }
      const finalScope = scope ?? (gap.scope === 'project' ? 'project' : 'task');

      db.prepare(`
        UPDATE spec_gaps SET status = 'resolved', resolution_note = ?, scope = ?, resolved_at = datetime('now')
        WHERE id = ?
      `).run(finalNote, finalScope, gapId);

      const notifyOk = await notifyWebServer({
        event: 'task.specGap',
        data: { gapId, taskId: gap.task_id, projectId: gap.project_id, category: gap.category, description: gap.description, status: 'resolved', action: 'resolved' },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      const scopeLine = finalScope === 'project'
        ? `\n\n📌 範圍：**全案適用**——同專案每一支任務的派工、resume_task 與 AI 回對都會注入這一則，並標示它由本任務裁決。`
        : `\n\n📌 範圍：**只有本任務**（scope=task，預設）。`
          + `\n若這則裁決其實**別支任務也要照做**（共用基礎、命名、代碼值域、設定鍵、跨功能契約通常都是），`
          + `現在就用 \`scope: "project"\` 重下一次。`
          + `\n判準：「照這則做的人，會不會有別支任務的人？」會，就是 project。`
          + `\n**標錯的代價不對稱**：多標只是多幾行；少標的話，真正要照做的那支任務看不到它，`
          + `而獨立回對員會照原始規格判 missing——把已經照裁決做對的東西判成沒做。`;
      const revised = gap.status === 'resolved'
        ? `Spec gap ${gapId} 的裁決已修訂${warning}。前一版已以「已被取代」的形式保留在同一則裡，供追溯但明示不可照辦。`
          + `\n\n⚠ 裁決錯過一次的話，同一個決定通常有好幾份副本：程式、測試、流程圖、驗證報告、以及這裡。`
          + `**回頭確認其餘幾份都跟著改了**——漏掉任何一份，下一個人會從那一份讀到已經不成立的事實。${scopeLine}`
        : `Spec gap ${gapId} marked as resolved${warning}。裁決已落地 DB——後續派工 prompt / resume_task / AI 回對計畫會自動注入此裁決（效力等同規格），不需（也不可）手動轉述。${scopeLine}`;
      return { content: [{ type: 'text' as const, text: revised }] };
    },
  );
}
