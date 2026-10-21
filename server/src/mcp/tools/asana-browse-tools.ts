/**
 * browse_asana_tasks：即時查 Asana 專案上「全部／派給別人／未指派」的任務，或單張任務詳情。
 * **唯讀、不寫 DB**——同步照舊只存派給我的單，所以 omni 的清單、推薦、統計、閘門完全不受影響；
 * 使用者明確要看別人或沒人接的單時才用這支。抓取邏輯與 sync_asana_tasks 共用（asana-project-fetch.ts）。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { getAsanaPat, ASANA_API_BASE, ASANA_FETCH_TIMEOUT_MS, compactJson, fitListToLimit } from '../helpers.js';
import { fetchAsanaProjectTasks, extractAsanaSection, ASANA_TASK_OPT_FIELDS, type AsanaRawTask } from '../asana-project-fetch.js';
import { normalizeDueDate } from '../../utils/dueDate.js';

const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true });
const NOTES_EXCERPT = 200;
/** compactJson 會省略 null；「沒人接」是使用者要看的重點，明寫出來 */
const UNASSIGNED = '（未指派）';

export function registerAsanaBrowseTools(server: McpServer): void {
  server.tool(
    'browse_asana_tasks',
    '即時查 Asana 上「不在 omni 待辦裡」的任務：列出專案的全部、派給別人、或未指派的任務（含 subtask），或查單張任務詳情與留言。**唯讀、不寫 DB**——omni 同步只存派給我的單，所以 list_pending_tasks／next_task 等照舊只看我的；**使用者明確要看別人或沒人接的單時才用這支**。要接手某張單：在 Asana 改派給自己，下次同步就會進 omni。',
    {
      projectId: z.string().optional().describe('專案 ID（列清單用）'),
      scope: z.enum(['all', 'others', 'unassigned']).optional().describe('all=全部（含我的）／others=派給別人的／unassigned=沒人接的（預設 all）'),
      keyword: z.string().optional().describe('比對標題、描述、母任務名稱（不分大小寫、部分符合）'),
      section: z.string().optional().describe('比對 Asana 區段名稱（部分符合，例如「問題回報」）'),
      includeCompleted: z.boolean().optional().describe('包含已完成的任務（預設 false；subtask 永遠只抓未完成）'),
      limit: z.number().int().min(1).max(200).optional().describe('最多回幾筆（預設 50）'),
      taskGid: z.string().optional().describe('查單張任務：Asana task GID（可以不是我的單），回全文描述與留言'),
    },
    { title: 'Browse Asana Tasks', readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async ({ projectId, scope, keyword, section, includeCompleted, limit, taskGid }) => {
      const db = getMcpDb();
      const pat = getAsanaPat(db);
      if (!pat) return err('Asana PAT not configured. Set it in global settings or ASANA_PAT env var.');
      const headers = { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' };
      const get = (url: string) => fetch(url, { headers, signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS) });
      const omniIdOf = (gid: string) =>
        (db.prepare("SELECT id FROM tasks WHERE source = 'asana' AND source_ref = ? LIMIT 1").get(gid) as { id: string } | undefined)?.id;

      // ── 單張詳情 ──
      if (taskGid) {
        const res = await get(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}?opt_fields=${ASANA_TASK_OPT_FIELDS}`);
        if (!res.ok) return err(`Asana API error fetching task ${taskGid}: ${res.status}`);
        const t = ((await res.json()) as { data?: AsanaRawTask }).data;
        if (!t) return err(`Asana task ${taskGid} not found`);
        const st = await get(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}/stories?opt_fields=type,text,created_by.name,created_at`);
        const stories = st.ok ? ((await st.json()) as { data?: Array<Record<string, unknown>> }).data ?? [] : [];
        const comments = stories
          .filter(s => s['type'] === 'comment')
          .map(s => ({ author: (s['created_by'] as { name?: string } | null)?.name ?? null, at: s['created_at'] ?? null, text: String(s['text'] ?? '') }));
        // 附件只列名稱（下載交給 fetch_task_attachments(taskGid)，下載後才能用 Read 看圖）；列不到不擋詳情
        let attachments: string[] | null = null;
        try {
          const at = await get(`${ASANA_API_BASE}/tasks/${encodeURIComponent(taskGid)}/attachments?opt_fields=name`);
          if (at.ok) attachments = (((await at.json()) as { data?: Array<{ name?: string }> }).data ?? []).map(a => a.name ?? '(未命名)');
        } catch { /* 列不到就不附 */ }
        const memberships = t['memberships'] as Array<{ project?: { gid?: string } }> | undefined;
        const omniTaskId = omniIdOf(taskGid);
        return {
          content: [{
            type: 'text' as const,
            text: compactJson({
              task: {
                gid: taskGid,
                name: t['name'],
                assignee: (t['assignee'] as { name?: string } | null)?.name ?? UNASSIGNED,
                completed: t['completed'] ?? false,
                due: normalizeDueDate(t['due_on']),
                section: extractAsanaSection(t, memberships?.[0]?.project?.gid ?? ''),
                parent: (t['parent'] as { name?: string } | null)?.name ?? null,
                url: t['permalink_url'] ?? null,
                notes: String(t['notes'] ?? ''),
                ...(omniTaskId ? { omniTaskId } : {}),
              },
              comments,
              ...(attachments ? {
                attachments,
                ...(attachments.length > 0 ? { attachmentsHint: `要看附件內容：fetch_task_attachments(projectId=<專案 ID>, taskGid="${taskGid}") 下載後用 Read 打開` } : {}),
              } : {}),
              ...(stories.length === 0 && !st.ok ? { note: `留言讀取失敗（${st.status}）` } : {}),
            }),
          }],
        };
      }

      // ── 列清單 ──
      if (!projectId) return err('給 projectId（列清單）或 taskGid（查單張）其中一個。');
      const project = db.prepare('SELECT asana_project_gid FROM projects WHERE id = ?').get(projectId) as { asana_project_gid: string | null } | undefined;
      if (!project) return err(`Project "${projectId}" not found`);
      if (!project.asana_project_gid) return err(`Project "${projectId}" has no Asana project GID. Set it in project settings.`);

      const fetched = await fetchAsanaProjectTasks(pat, project.asana_project_gid, { includeCompleted });
      if (!fetched.ok) return err(fetched.error);
      const { userGid, tasks, subtaskSections, sectionOf, subtaskStats } = fetched;

      const wanted = scope ?? 'all';
      const kw = keyword?.trim().toLowerCase();
      const sec = section?.trim().toLowerCase();
      const items = tasks.map(t => {
        const gid = String(t['gid'] || '');
        const assignee = t['assignee'] as { gid?: string; name?: string } | null | undefined;
        const notes = String(t['notes'] ?? '');
        return {
          gid,
          name: String(t['name'] ?? ''),
          assignee: assignee?.name ?? UNASSIGNED,
          assigneeGid: assignee?.gid ?? null,
          mine: !!userGid && assignee?.gid === userGid,
          section: subtaskSections.has(gid) ? (subtaskSections.get(gid) ?? null) : sectionOf(t),
          parent: (t['parent'] as { name?: string } | null)?.name ?? null,
          due: normalizeDueDate(t['due_on']),
          completed: t['completed'] === true,
          url: (t['permalink_url'] as string | undefined) ?? null,
          notes,
        };
      }).filter(i => {
        if (wanted === 'others' && (!i.assigneeGid || i.mine)) return false;
        if (wanted === 'unassigned' && i.assigneeGid) return false;
        if (kw && ![i.name, i.notes, i.parent ?? ''].some(s => s.toLowerCase().includes(kw))) return false;
        if (sec && !(i.section ?? '').toLowerCase().includes(sec)) return false;
        return true;
      });

      const matched = items.length;
      const shownItems = items.slice(0, limit ?? 50).map(({ assigneeGid: _g, notes, ...rest }) => {
        const omniTaskId = omniIdOf(rest.gid);
        return {
          ...rest,
          ...(notes ? { notes: notes.length > NOTES_EXCERPT ? `${notes.slice(0, NOTES_EXCERPT)}…` : notes } : {}),
          ...(omniTaskId ? { omniTaskId } : {}),
        };
      });
      const render = (shown: typeof shownItems) => compactJson({
        scope: wanted, matched, count: shown.length,
        note: '即時查 Asana，唯讀、未寫入 omni。查單張全文與留言用 taskGid；要接手請在 Asana 改派給自己，下次同步就會進 omni。',
        ...(matched > shown.length ? { more: `還有 ${matched - shown.length} 筆沒列出——加 keyword／section 縮小範圍，或調大 limit` } : {}),
        ...(subtaskStats?.truncated ? { warning: 'subtask 抓取達上限已截斷，可能有漏列' } : {}),
        tasks: shown,
      });
      const { text } = fitListToLimit(shownItems, render);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
