/**
 * update_asana_task_status：改 Asana 任務的狀態欄位（單選自訂欄位，例如「處理狀態」）——**客戶看得到**。
 *
 * 只動指定的那一個欄位：不移分區、不碰完成勾選（實測林同棪 91 張單，完成勾選與狀態是獨立使用的）。
 * 欄位定義與選項直接從該任務讀（不必指定專案，也能在預覽顯示「從 X 改成 Y」）；
 * 欄位名稱、選項名稱都要完全相符，對不到回錯並列出可用的，不猜。同意機制比照 create_asana_task。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { getAsanaPat, ASANA_API_BASE, ASANA_FETCH_TIMEOUT_MS } from '../helpers.js';
import { writeAsanaAudit } from './asana-create-tools.js';

const err = (text: string) => ({ content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true as const });

interface TaskField {
  gid: string; name: string; resource_subtype?: string;
  enum_value?: { gid?: string; name?: string } | null;
  enum_options?: Array<{ gid: string; name: string; enabled?: boolean }>;
}

export function registerAsanaStatusTools(server: McpServer): void {
  server.tool(
    'update_asana_task_status',
    '改 Asana 任務的狀態欄位（單選自訂欄位，例如「處理狀態」）——**寫入客戶看得到的地方**。只改這一個欄位：不移分區、不勾選完成。可傳 taskId（omni UUID）或 taskGid。\n\n'
      + '⚠ **送出前必須先讓使用者看過「哪張單、哪個欄位、從什麼改成什麼」並取得明確同意**，再帶 userApproved=true。建議先 dryRun=true 取預覽（只讀不寫、不需同意旗標）給使用者看。\n\n'
      + '欄位名稱與選項名稱都要完全相符（選項從該任務本身讀），對不到回錯並列出可用的，不會猜。已經是該狀態就不送出。每次修改寫稽核紀錄（[ASANA_STATUS]）。',
    {
      taskId: z.string().optional().describe('Omni task UUID（自動查 Asana GID）'),
      taskGid: z.string().optional().describe('Asana 任務 GID（不在 omni 裡的單也可以）'),
      field: z.string().min(1).describe('狀態欄位名稱（單選自訂欄位），例如「處理狀態」'),
      status: z.string().min(1).describe('要改成的選項名稱（完全相符），例如「待測試」'),
      userApproved: z.literal(true).optional().describe('正式送出時必須為 true，代表使用者已看過「哪張單、從什麼改成什麼」並明確同意。dryRun 不需要'),
      approvalNote: z.string().optional().describe('使用者同意的情境摘要，會寫入稽核紀錄'),
      dryRun: z.boolean().optional().describe('true=只回傳預覽（單名、網址、從→到），不呼叫寫入 API。預設 false'),
    },
    { title: 'Update Asana Task Status', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ taskId, taskGid, field, status, userApproved, approvalNote, dryRun }) => {
      if (!dryRun && userApproved !== true) {
        return err('正式修改必須帶 userApproved=true（代表使用者已看過要改哪張單、從什麼改成什麼並明確同意）。還沒給使用者看過，先用 dryRun=true 取得預覽。');
      }
      const db = getMcpDb();

      let gid = taskGid;
      let omniTask: { id: string; project_id: string } | undefined;
      if (taskId) {
        const row = db.prepare('SELECT id, project_id, source_ref FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string; source_ref: string | null } | undefined;
        if (!row) return err(`Task "${taskId}" not found`);
        if (!gid) {
          if (!row.source_ref) return err(`Task "${taskId}" has no Asana sourceRef (not synced from Asana)`);
          gid = row.source_ref;
        }
        omniTask = { id: row.id, project_id: row.project_id };
      }
      if (!gid) return err('Must provide either taskId or taskGid');
      if (!omniTask) {
        omniTask = db.prepare("SELECT id, project_id FROM tasks WHERE source = 'asana' AND source_ref = ? LIMIT 1").get(gid) as { id: string; project_id: string } | undefined;
      }

      const pat = getAsanaPat(db);
      if (!pat) return err('Asana PAT not configured. Use set_global_config to set asana.pat.');
      const headers = { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' };

      // ── 讀任務本身的欄位定義與目前值 ──
      let task: { name?: string; permalink_url?: string; custom_fields?: TaskField[] } | undefined;
      try {
        const r = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(gid)}?opt_fields=name,permalink_url,custom_fields.name,custom_fields.resource_subtype,custom_fields.enum_value.name,custom_fields.enum_options.name,custom_fields.enum_options.enabled`,
          { headers, signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS) });
        if (!r.ok) return err(`Asana API error: ${r.status} ${await r.text()}（讀取任務 ${gid}）`);
        task = ((await r.json()) as { data?: typeof task }).data;
      } catch (e: unknown) {
        return err(e instanceof Error ? e.message : String(e));
      }
      if (!task) return err(`Asana task ${gid} not found`);

      const fields = task.custom_fields ?? [];
      const enumNames = fields.filter(f => f.resource_subtype === 'enum').map(f => `「${f.name}」`).join('、') || '（無）';
      const def = fields.find(f => f.name.trim() === field.trim());
      if (!def) return err(`這張單沒有欄位「${field}」。這張單的單選欄位：${enumNames}`);
      if (def.resource_subtype !== 'enum') return err(`欄位「${field}」不是單選欄位（類型：${def.resource_subtype ?? '未知'}），這支工具只改狀態類的單選欄位。這張單的單選欄位：${enumNames}`);
      const enabled = (def.enum_options ?? []).filter(o => o.enabled !== false);
      const target = enabled.find(o => o.name.trim() === status.trim());
      if (!target) return err(`欄位「${field}」沒有可用的選項「${status}」。可用的選項：${enabled.map(o => `「${o.name}」`).join('、') || '（無）'}`);

      const from = def.enum_value?.name ?? null;
      const preview = { task: task.name ?? gid, taskGid: gid, url: task.permalink_url ?? null, field: def.name, from, to: target.name };
      if (from === target.name) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, changed: false, ...preview, note: `已經是「${target.name}」，不必修改（沒有送出任何東西）。` }, null, 2) }] };
      }
      if (dryRun) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          dryRun: true, preview,
          next: '把「哪張單、從什麼改成什麼」給使用者看過並取得明確同意後，帶 userApproved=true（不帶 dryRun）正式送出。',
        }, null, 2) }] };
      }

      // ── 正式修改：只送這一個欄位 ──
      try {
        const r = await fetch(`${ASANA_API_BASE}/tasks/${encodeURIComponent(gid)}`, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { custom_fields: { [def.gid]: target.gid } } }),
          signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
        });
        if (!r.ok) {
          const hint = r.status === 403 ? '（403 通常代表 PAT 沒有該任務的寫入權限）' : '';
          return err(`Asana API error: ${r.status} ${await r.text()}${hint}（狀態沒有修改）`);
        }
      } catch (e: unknown) {
        return err(`${e instanceof Error ? e.message : String(e)}（狀態沒有修改）`);
      }

      writeAsanaAudit(db, 'asana-status.jsonl', {
        taskGid: gid, task: preview.task, url: preview.url, field: def.name, from, to: target.name, approvalNote: approvalNote?.trim() || null,
      }, omniTask,
        `[ASANA_STATUS] 已修改 Asana 任務 ${gid}「${preview.task}」的「${def.name}」：${from ?? '（空）'} → ${target.name}\n網址：${preview.url ?? '(無)'}\n使用者同意：${approvalNote?.trim() || '(未填 approvalNote)'}`);

      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true, changed: true, ...preview,
        audited: omniTask ? `稽核檔＋omni 任務 ${omniTask.id} 的紀錄` : '稽核檔',
      }, null, 2) }] };
    },
  );
}
