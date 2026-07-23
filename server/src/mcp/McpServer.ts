/**
 * OmniCommander MCP Server.
 * Registers all tools and connects via stdio transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTaskTools } from './tools/task-tools.js';
import { registerDocumentTools } from './tools/document-tools.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerProgressTools } from './tools/progress-tools.js';
import { registerWorkspaceTools } from './tools/workspace-tools.js';
import { registerDbTools } from './tools/db-tools.js';
import { registerFlowTools } from './tools/flow-tools.js';
import { registerSpecGapTools } from './tools/spec-gap-tools.js';
import { registerVerificationTools } from './tools/verification-tools.js';
import { registerInsightTools } from './tools/insight-tools.js';
import { registerSearchTools } from './tools/search-tools.js';
import { registerContextTools } from './tools/context-tools.js';
import { registerComplianceTools } from './tools/compliance-tools.js';
import { registerConsistencyTools } from './tools/consistency-tools.js';
import { registerPrompts } from './prompts.js';

export function createOmniMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: 'omni-commander',
      version: '5.0.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
      // 這段 instructions 會在任何 Claude Code session 連上此 MCP 時自動注入 context，
      // 等於新使用者不用改全域 CLAUDE.md 就拿到使用規則。
      instructions: `OmniCommander MCP — 任務管理與開發脈絡提供者。連上此 MCP 的 session 必須遵守以下規則：

1. **開工前必先取執行計畫**：接到任何開發／實作任務（前端、後端、bug 修正），先呼叫 get_execution_plan(taskId) 並嚴格照回傳流程執行，不可跳步或臆測替代。找不到 taskId 先用 list_pending_tasks 或 next_task 定位。小型 bug（無 SA/SD）會自動走 light 軌——檢查表改抽 BUG 原文，回對標準不變（AI 回對 missing=0 才可標 completed）。
2. **規格一律從工具取得**：需要 SA/SD 規格用 fetch_svn_specs 從 SVN 撈最新版；讀文件用 read_document；找欄位名／API 路徑／訊息文字用 search_documents。不可憑記憶、舊檔或猜測。
3. **規格沒定義的不可自行編造**：遇到規格未定義的欄位／API／邏輯，呼叫 report_spec_gap(taskId, category, description) 記錄，標記 [NEEDS_CLARIFICATION] 後繼續其他有規格依據的部分。寧可不做也不要做錯。使用者對缺口拍板後必須立刻 resolve_spec_gap(gapId, resolutionNote=具體裁決) 落地 DB——裁決只由工具從 DB 自動注入派工／resume_task／AI 回對，嚴禁只把答案手動寫進派工 prompt 或對話帶過（不落地 = implementer 與 reviewer 看不到）。
4. **脈絡恢復與經驗累積**：接手先前開過的舊任務，第一步先 resume_task(taskId) 恢復脈絡；開發中發現此專案特有的坑／慣例（規格沒寫但必須遵守的），用 save_project_note 記錄讓後續任務受益。
5. **執行中持續回報**：每完成主要步驟用 report_output，關鍵節點用 report_milestone。讀完規格先用 save_spec_checklist 抽取檢查表；完成前用 get_verification_plan 取得驗收清單，逐項執行並用 report_verification_result 回報。規格回對分兩步：先跑 run_spec_compliance 做程式預檢（抓文字/路徑錯字，不解鎖閘門），再由 orchestrator 派**獨立 agent** 做 AI 規格回對（get_compliance_review_plan → save_compliance_review），最新 AI 回對 missing=0 才可標 completed。專案有設單元測試指令（frontendTestCommand/backendTestCommand）時，「單元測試全數通過」驗收項回報 passed=true 也是完成閘門之一——既有測試不是全綠，先用 get_test_baseline_plan 修測試基線。
6. **結束必須回報狀態**：成功 update_task_status(taskId, "completed", summary)；失敗必標 update_task_status(taskId, "failed", summary)。不回報任務會永遠卡在 in_progress。
7. **典型流程**：get_execution_plan → update_task_status(in_progress) → 執行（規格用工具取）→ report_output/report_milestone → get_verification_plan + report_verification_result → update_task_status(completed)。

（也可直接使用 start_task prompt 取得完整工作流指示。）`,
    },
  );

  // Register all tool groups
  registerTaskTools(server);
  registerDocumentTools(server);
  registerProjectTools(server);
  registerProgressTools(server);
  registerWorkspaceTools(server);
  registerDbTools(server);
  registerFlowTools(server);
  registerSpecGapTools(server);
  registerVerificationTools(server);
  registerInsightTools(server);
  registerSearchTools(server);
  registerContextTools(server);
  registerComplianceTools(server);
  registerConsistencyTools(server);

  // Register prompts (start_task workflow)
  registerPrompts(server);

  return server;
}
