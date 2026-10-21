/**
 * 抓一個 Asana 專案的任務（含未掛專案的 subtask 樹）——sync_asana_tasks 與 browse_asana_tasks 共用，
 * 兩邊看到的資料保證一致。**這裡不過濾 assignee、不碰 DB**：
 * 同步在呼叫端只收派給我的寫進 DB；瀏覽工具即時回傳、不寫入。
 */
import { ASANA_API_BASE, ASANA_FETCH_TIMEOUT_MS } from './helpers.js';
import { fetchAsanaSubtasksTree } from '../utils/asanaSubtasks.js';

// memberships.section.name → 分區；memberships.project.gid 用來挑出本專案對應的 membership
// tags.name → 標籤；custom_fields.* → 自訂欄位（display_value 落地最穩，enum 另取 enum_value.name 備援）
// num_subtasks → subtask 遞迴抓取的種子判斷
export const ASANA_TASK_OPT_FIELDS = 'name,notes,due_on,completed,num_subtasks,permalink_url,memberships.section.name,memberships.project.gid,tags.name,assignee.name,assignee.gid,custom_fields.name,custom_fields.display_value,custom_fields.enum_value.name,parent.gid,parent.name,parent.notes';

export type AsanaRawTask = Record<string, unknown>;

export interface SubtaskStats { fetched: number; requests: number; truncated: boolean; warnings: string[] }

export type ProjectTasksResult =
  | {
      ok: true;
      userGid: string | undefined;
      tasks: AsanaRawTask[];
      /** subtask（無 memberships）繼承根任務的 section；主清單任務不在這裡 */
      subtaskSections: Map<string, string | null>;
      subtaskStats: SubtaskStats | null;
      sectionOf: (task: AsanaRawTask) => string | null;
    }
  | { ok: false; error: string };

/** 一張 task 在不同 project 會有多筆 membership，挑出本專案對應的那筆 */
export function extractAsanaSection(task: AsanaRawTask, projectGid: string): string | null {
  const memberships = task['memberships'] as Array<{ project?: { gid?: string }; section?: { name?: string } }> | undefined;
  if (!memberships || memberships.length === 0) return null;
  const match = memberships.find(m => m.project?.gid === projectGid) || memberships[0];
  return match?.section?.name || null;
}

export async function fetchAsanaProjectTasks(
  pat: string,
  projectGid: string,
  opts: { includeSubtasks?: boolean; includeCompleted?: boolean } = {},
): Promise<ProjectTasksResult> {
  const headers = { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' };
  const get = (url: string) => fetch(url, { headers, signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS) });

  // 目前使用者：每次向 /users/me 取（不寫死，換 PAT 就換人）
  const userRes = await get(`${ASANA_API_BASE}/users/me`);
  if (!userRes.ok) return { ok: false, error: `Asana API error: ${userRes.status} ${await userRes.text()}` };
  const userGid = ((await userRes.json()) as { data?: { gid?: string } }).data?.gid;

  const sectionOf = (task: AsanaRawTask) => extractAsanaSection(task, projectGid);

  const tasks: AsanaRawTask[] = [];
  const completedParam = opts.includeCompleted ? '' : '&completed_since=now';
  let nextUrl: string | null = `${ASANA_API_BASE}/tasks?project=${projectGid}&limit=100${completedParam}&opt_fields=${ASANA_TASK_OPT_FIELDS}`;
  while (nextUrl) {
    const res = await get(nextUrl);
    if (!res.ok) return { ok: false, error: `Asana API error fetching tasks: ${res.status}` };
    const data = await res.json() as { data?: AsanaRawTask[]; next_page?: { uri?: string } };
    tasks.push(...(data.data || []));
    nextUrl = data.next_page?.uri || null;
  }

  // Subtask 遞迴抓取（先抓全樹）：專案任務清單抓不到未 multi-home 進專案的 subtask，
  // 真正要派工的工作項目常在第二層。共用邏輯見 utils/asanaSubtasks.ts（深度 ≤3、只抓未完成、gid 去重、≤300 支/次）。
  const subtaskSections = new Map<string, string | null>();
  let subtaskStats: SubtaskStats | null = null;
  if (opts.includeSubtasks !== false) {
    const tree = await fetchAsanaSubtasksTree(tasks, { fetchFn: get, optFields: ASANA_TASK_OPT_FIELDS });
    const rootSections = new Map(tasks.map(t => [String(t['gid'] || ''), sectionOf(t)] as const));
    for (const entry of tree.entries) {
      const gid = String(entry.task['gid'] || '');
      if (!gid) continue;
      subtaskSections.set(gid, rootSections.get(entry.rootGid) ?? null);
      tasks.push(entry.task);
    }
    subtaskStats = { fetched: tree.entries.length, requests: tree.requestCount, truncated: tree.truncated, warnings: tree.warnings };
  }

  return { ok: true, userGid, tasks, subtaskSections, subtaskStats, sectionOf };
}
