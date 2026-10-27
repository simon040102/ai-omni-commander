/**
 * 任務 ID 短碼：在工具註冊入口統一把指向 omni 任務的參數（taskId／dependsOnTaskId／coveredBy）
 * 的唯一前綴（≥8 碼）換成完整 ID，再交給工具。
 *
 * 放在入口而不是逐支改：帶任務 ID 的工具有三十多支，逐支改一定有漏，新工具也會忘；
 * 這裡攔一次，各工具程式碼不動、照舊只認完整 ID。完整 ID、不存在、不到 8 碼都原樣放行，
 * 由工具回它自己的 not found——行為與加這層之前完全相同。前綴對到多筆才在這裡擋下。
 * Asana 的 GID（taskGid 等）不屬於 omni 任務，不碰。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getMcpDb } from './db.js';
import { resolveIdPrefix, ambiguousIdMessage } from './helpers.js';

export const TASK_ID_PARAMS = ['taskId', 'dependsOnTaskId', 'coveredBy'] as const;

type Handler = (args: Record<string, unknown>, extra: unknown) => unknown;

export function installTaskIdPrefixResolution(server: McpServer): void {
  const target = server as unknown as { tool: (...a: unknown[]) => unknown };
  const original = target.tool.bind(server);
  target.tool = (...a: unknown[]) => {
    const handler = a[a.length - 1];
    if (typeof handler === 'function') {
      a[a.length - 1] = async (args: Record<string, unknown> | undefined, extra: unknown) => {
        if (args && typeof args === 'object') {
          const db = getMcpDb();
          for (const key of TASK_ID_PARAMS) {
            const v = args[key];
            if (typeof v !== 'string') continue;
            const hit = resolveIdPrefix(db, 'tasks', v);
            if (hit && 'ambiguous' in hit) {
              return { content: [{ type: 'text' as const, text: ambiguousIdMessage(`任務（${key}）`, v, hit.ambiguous) }], isError: true };
            }
            if (hit) args = { ...args, [key]: hit.id };
          }
        }
        return (handler as Handler)(args as Record<string, unknown>, extra);
      };
    }
    return original(...a);
  };
}
