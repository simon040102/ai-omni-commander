/**
 * MCP tool for SA/SD 規格一致性檢查 (check_spec_consistency).
 *
 * Plan-tool 模式（同 get_compliance_review_plan）：呼叫端可能是其他專案資料夾
 * 下的 Claude Code session，方法論必須住在 MCP、不能靠 session 自由發揮。
 * 回傳給 orchestrator 的派工計畫——派一個獨立 subagent 讀 SA 與 SD 規格原文，
 * 從四個維度系統性比對，確認的矛盾用 report_spec_gap(category='sa_sd_mismatch')
 * 寫入待補規格清單。建議開工前執行：規格自相矛盾時，實作永遠無法 100% 回對。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { truncateResponse } from '../helpers.js';

interface DocRow {
  filename: string;
  file_path: string;
  doc_type: string | null;
}

export function registerConsistencyTools(server: McpServer): void {

  // ── check_spec_consistency ────────────────────────────────
  server.tool(
    'check_spec_consistency',
    '取得「SA/SD 規格一致性檢查」的派工計畫（給 orchestrator）。**建議開工前執行——規格自相矛盾時，寫出來的 code 永遠無法 100% 回對。** 回傳完整 prompt：由 orchestrator 派**獨立 subagent** 讀 SA 與 SD 規格原文，從四個維度（欄位對齊/功能覆蓋/反向檢查/訊息與驗證規則）系統性比對，每個確認的矛盾用 report_spec_gap(category="sa_sd_mismatch") 記錄成待補規格。需要任務綁定（或專案層）SA 與 SD 文件各至少一份，缺任一邊會回引導訊息。',
    {
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Check Spec Consistency', readOnlyHint: true, openWorldHint: false },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, project_id, title, label FROM tasks WHERE id = ?').get(taskId) as
        { id: string; project_id: string; title: string; label: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // 規格文件路徑（同 get_compliance_review_plan：task_documents 綁定優先，沒有則退回專案層）
      const taskDocs = db.prepare(`
        SELECT d.filename, d.file_path, d.doc_type
        FROM task_documents td JOIN documents d ON d.id = td.document_id
        WHERE td.task_id = ?
      `).all(taskId) as DocRow[];
      const docs = taskDocs.length > 0
        ? taskDocs
        : db.prepare('SELECT filename, file_path, doc_type FROM documents WHERE project_id = ?')
            .all(task.project_id) as DocRow[];

      const saDocs = docs.filter(d => d.doc_type === 'SA');
      const sdDocs = docs.filter(d => d.doc_type === 'SD');

      // SA 或 SD 缺任一邊 → 引導訊息（非 error）：一致性比對需要兩邊都在
      if (saDocs.length === 0 || sdDocs.length === 0) {
        const missing = [
          saDocs.length === 0 ? 'SA' : null,
          sdDocs.length === 0 ? 'SD' : null,
        ].filter(Boolean).join(' 與 ');
        return {
          content: [{
            type: 'text' as const,
            text: `缺少 ${missing} 文件，無法做一致性比對。先用 fetch_svn_specs(taskId="${taskId}") 從 SVN 撈取規格，或用 get_documents(projectId="${task.project_id}") 確認專案文件並綁定到任務，再呼叫 check_spec_consistency。`,
          }],
        };
      }

      const docLine = (d: DocRow) => `- ${d.filename} — ${d.file_path}`;
      const plan = `**SA/SD 規格一致性檢查派工計畫（Spec Consistency Check Plan）**
**Task:** ${task.title}（taskId=${taskId}, label=${task.label}）
**SA 文件（系統分析）：**
${saDocs.map(docLine).join('\n')}
**SD 文件（系統設計）：**
${sdDocs.map(docLine).join('\n')}

> **給 orchestrator 的指示：**
> 1. 用 Agent tool 派出**一個獨立的規格一致性檢查 subagent**，將以下 prompt 原封不動作為任務傳入
> 2. subagent 讀規格用 Read tool 讀上列檔案原文；定點查特定欄位/訊息文字也可用 search_documents(projectId="${task.project_id}", query=...)
> 3. subagent 完成後看 report_output 總結：有 sa_sd_mismatch 缺口 → 先請使用者釐清規格矛盾再開工（規格矛盾不先解決，實作永遠無法 100% 回對）

---

你是獨立的規格一致性審查員。你的任務：**系統性比對 SA（系統分析）與 SD（系統設計）規格之間有沒有矛盾**。規格自相矛盾時，寫出來的 code 永遠無法 100% 回對——你的發現決定要不要先請使用者釐清規格再開工。你只讀規格，不寫 code、不改任何檔案。

## 比對維度（強制，四個維度都要做完）

1. **欄位對齊**：SA 畫面上的每個欄位（名稱/型別/必填/預設值）↔ SD 的 API request/response 欄位——名稱不一致、SA 有 SD 沒有、型別矛盾都列出
2. **功能覆蓋**：SA 描述的每個操作（查詢/新增/儲存/刪除/匯出…）↔ SD 有沒有對應 API
3. **反向檢查**：SD 定義了但 SA 完全沒有對應畫面/操作的 API（規格可能漏更新）
4. **訊息與驗證規則**：SA 的錯誤訊息/驗證規則 ↔ SD 的邏輯規則有沒有矛盾（如 SA 說必填、SD 參數 optional）

## 判定紀律

- 每個發現必附**兩邊出處**：SA 檔名+章節/段落、SD 檔名+API 名
- 不確定是否矛盾 → 列為疑問而非斷定
- **沒有發現也要明確說「檢查了 N 個欄位/M 支 API，無矛盾」**——不可含糊帶過或省略統計

## 輸出動作

1. 每個**確認的矛盾**呼叫 mcp__omni-commander__report_spec_gap(taskId="${taskId}", category="sa_sd_mismatch", description="[維度] SA 說… vs SD 說…（出處：SA 檔名+章節、SD 檔名+API 名）")
2. 疑問（不確定是否矛盾）不寫 spec gap，列在總結中請使用者判斷
3. 全部檢完呼叫 mcp__omni-commander__report_output(taskId="${taskId}", content="...") 總結——必含檢查數量統計（檢查了 N 個欄位/M 支 API、確認矛盾 X 項、疑問 Y 項）

## 絕對禁止
- 不得修改任何程式碼或檔案（只讀）
- 不得呼叫 update_task_status——本檢查不是開發任務本身，任務狀態由 orchestrator 決定`;

      return { content: [{ type: 'text' as const, text: truncateResponse(plan) }] };
    },
  );
}
