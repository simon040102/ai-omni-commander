/**
 * MCP prompts — reusable workflow instructions exposed via the prompts API.
 * start_task: the standard OmniCommander task workflow.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function buildStartTaskText(taskId?: string): string {
  const idPart = taskId ? `taskId="${taskId}"` : 'taskId';
  const locate = taskId
    ? ''
    : `## 第 0 步：定位任務
尚未指定 taskId。先用 list_pending_tasks(projectId, keyword?) 以關鍵字／模組代碼定位，或用 next_task(projectId) 取得推薦任務，確定 taskId 後再往下走。

`;
  return `依 OmniCommander 標準工作流執行開發任務：

${locate}## 標準工作流（依序執行，不可跳步）

1. **取得執行計畫**：get_execution_plan(${idPart}) — 取得完整開發流程與脈絡，嚴格照回傳的流程步驟執行（含 Flow-Gated 閘門指示）。
2. **標記開工**：update_task_status(${idPart}, status="in_progress")
3. **執行**：
   - 需要 SA/SD 規格 → fetch_svn_specs 從 SVN 撈最新版；已有文件用 read_document 讀取；找欄位名／API 路徑／訊息文字用 search_documents 全文搜尋。不可憑記憶或猜測。
   - **規格沒定義的東西不可自行編造** → 呼叫 report_spec_gap(taskId, category, description) 記錄，標記 [NEEDS_CLARIFICATION] 後繼續其他有規格依據的部分。
   - 讀完規格先用 save_spec_checklist(taskId, items) 抽規格檢查表（結案閘門要求檢查表存在）。
4. **回報進度**：每完成一個主要步驟 report_output(taskId, content)；關鍵節點 report_milestone(taskId, milestone)。
5. **程式預檢**：run_spec_compliance(taskId) 抓文字／路徑錯字並修掉（只是預檢，不解鎖結案）。
6. **驗收（完成前必做）**：get_verification_plan(taskId) 取得驗收清單，逐項執行後 report_verification_result(taskId, results) 回報。有未通過項目先修復再重驗。
7. **獨立 AI 規格回對（結案閘門的依據）**：由 orchestrator 用 get_compliance_review_plan(taskId) 派**獨立** reviewer 逐項回對，結果用 save_compliance_review 寫回——寫 code 的人不可自評。最新回對 missing=0 才能結案；missing>0 就修正後再回對。
8. **結案**：全部通過 → update_task_status(${idPart}, status="completed", summary="完成摘要")。
   **失敗必標**：無法完成 → update_task_status(${idPart}, status="failed", summary="失敗原因")。不論成功或失敗都必須回報狀態，否則任務會永遠卡在 in_progress。`;
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'start_task',
    {
      title: '開始執行任務（標準工作流）',
      description: 'OmniCommander 標準任務工作流：get_execution_plan → in_progress → 執行（規格用 fetch_svn_specs/read_document/search_documents，缺規格 report_spec_gap；抽 save_spec_checklist）→ 回報 → 預檢 → 驗收 → 獨立 AI 回對（missing=0）→ completed/failed。',
      argsSchema: {
        taskId: z.string().optional().describe('任務 ID（不給則先用 list_pending_tasks / next_task 定位任務）'),
      },
    },
    async ({ taskId }) => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: buildStartTaskText(taskId) },
        },
      ],
    }),
  );
}
