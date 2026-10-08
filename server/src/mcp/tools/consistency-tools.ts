/**
 * MCP tool for SA/SD 規格一致性檢查 + 規格模糊點預檢 (check_spec_consistency).
 *
 * Plan-tool 模式（同 get_compliance_review_plan）：呼叫端可能是其他專案資料夾
 * 下的 Claude Code session，方法論必須住在 MCP、不能靠 session 自由發揮。
 * 回傳給 orchestrator 的派工計畫——派一個獨立 subagent 讀 SA 與 SD 規格原文，
 * 同一次派工做三個維度：
 * 1. SA↔SD 矛盾比對（四個面向系統性比對）→ report_spec_gap(category='sa_sd_mismatch')
 * 1b. 同一份文件內部矛盾（SD 五組／SA 四組）→ report_spec_gap(category='spec_internal_conflict')
 * 2. 規格模糊點預檢（以 implementer 視角走決策樹，把「規格找不到唯一答案」的
 *    決策點烤出來）→ report_spec_gap(category='ambiguous_spec')，開給使用者拍板
 * 維度二是 advisory：只產出待拍板清單，不影響任何閘門、不阻止派工。
 * 使用時機由 orchestrator 判斷、使用者拍板（full 軌大規格才建議跑），絕不自動觸發。
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
    '取得「SA/SD 規格一致性 + 規格模糊點預檢」的派工計畫（給 orchestrator）。同一次派工做三個維度（各面向的完整對照表在回傳的計畫裡）：(1) **SA↔SD 矛盾比對**——確認的矛盾 report_spec_gap(category="sa_sd_mismatch")（規格自相矛盾時，code 永遠無法 100% 回對）；(2) **同一份文件內部矛盾**（SD 五組、SA 四組；維度一全是跨文件比對，抓不到同一份文件前後打架）——report_spec_gap(category="spec_internal_conflict")；(3) **規格模糊點預檢**——以 implementer 視角找出「規格找不到唯一答案」的決策點，report_spec_gap(category="ambiguous_spec") 給使用者拍板（**advisory：只產出待拍板清單，不影響任何閘門、不阻止派工**）。**使用時機（任務有大小之分，不是每次都跑，判斷者是 orchestrator、決定權在使用者，絕不自動觸發）**：light 軌/小 bug/小改→不跑也不提；full 軌小規格（單頁 CRUD、欄位少）→預設不跑，模糊留給 implementer 撞到再 report_spec_gap；full 軌大規格（多跳窗/多流程/長 SA）→orchestrator 在規格齊全檢查步驟「建議」使用者跑，使用者同意才跑；使用者主動要求→隨時可跑。需要任務綁定（或專案層）SA 與 SD 文件各至少一份，缺任一邊會回引導訊息。',
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
      const plan = `**SA/SD 規格一致性 + 規格模糊點預檢派工計畫（Spec Consistency & Ambiguity Precheck Plan）**
**Task:** ${task.title}（taskId=${taskId}, label=${task.label}）
**SA 文件（系統分析）：**
${saDocs.map(docLine).join('\n')}
**SD 文件（系統設計）：**
${sdDocs.map(docLine).join('\n')}

> **給 orchestrator 的指示：**
> 1. 用 Agent tool 派出**一個獨立的規格一致性檢查 subagent**（同一次派工做三個維度：SA↔SD 矛盾比對 + 同一份文件內部矛盾 + 規格模糊點預檢），將以下 prompt 原封不動作為任務傳入
> 2. subagent 讀規格用 Read tool 讀上列檔案原文；定點查特定欄位/訊息文字也可用 search_documents(projectId="${task.project_id}", query=...)
> 3. subagent 完成後看 report_output 總結：有 sa_sd_mismatch 缺口 → 先請使用者釐清規格矛盾再開工（規格矛盾不先解決，實作永遠無法 100% 回對）
> 4. 有 spec_internal_conflict 缺口 → 同 sa_sd_mismatch，先請使用者釐清再開工（規格自己前後打架時，implementer 照哪一邊做都會被回對判不符）
> 5. 有 ambiguous_spec 缺口 → **建議**使用者先逐項拍板再派工（advisory——使用者可選擇照常執行，不強制、不影響任何閘門）

---

你是獨立的規格審查員。你的任務有三個維度，**三個都要做完**：(一) 系統性比對 SA（系統分析）與 SD（系統設計）規格之間有沒有矛盾；(二) 同一份文件內部前後矛盾；(三) 規格模糊點預檢——以 implementer 視角走規格，把「做的時候會被迫用猜的」決策點烤出來，開給使用者拍板。規格自相矛盾時，寫出來的 code 永遠無法 100% 回對。你只讀規格，不寫 code、不改任何檔案。

## 維度一：SA↔SD 矛盾比對（跨文件，四個面向都要做完）

1. **欄位對齊**：SA 畫面上的每個欄位（名稱/型別/必填/預設值）↔ SD 的 API request/response 欄位——名稱不一致、SA 有 SD 沒有、型別矛盾都列出
2. **功能覆蓋**：SA 描述的每個操作（查詢/新增/儲存/刪除/匯出…）↔ SD 有沒有對應 API
3. **反向檢查**：SD 定義了但 SA 完全沒有對應畫面/操作的 API（規格可能漏更新）
4. **訊息與驗證規則**：SA 的錯誤訊息/驗證規則 ↔ SD 的邏輯規則有沒有矛盾（如 SA 說必填、SD 參數 optional）

## 維度二：同一份文件內部矛盾（最容易漏，也最容易抓）

**維度一抓不到「SD 自己跟自己打架」**——那四個面向全是跨文件比對，結構上不會去看同一份文件的前後段。實測某支功能：事後找出的 42 條規格問題裡，驗證程式碼階段才浮現的 20 條有 **10 條屬於這類**，純讀一份 SD 就抓得到，卻拖到最貴的階段才撞出來。

### SD 內部要對五組

| 比什麼 | 為什麼會打架 |
|---|---|
| 欄位定義表 ↔ SQL 參考 | SQL 查了表，TABLE 清單／欄位表沒列；或欄位表有，SQL 沒用到 |
| SQL 本體 ↔ 實作備忘 | **兩者版本可能不同步，哪邊新要看版本管控歷程**。不要預設哪邊是基準——備忘可能是後來依實測回填的最新資訊，也可能是 SQL 改了備忘沒跟上 |
| INPUT／OUTPUT 表 ↔ 格式範例 | 範例常是複製來的，欄位表是重寫的 |
| 章節 ↔ 章節 | 同一個欄位在 §1 和 §5 講的不一樣 |
| 規範敘述 ↔ 同節 SQL | 文字說可以，同一節的 SQL 寫死做不到 |

實例（全部出自同一份 SD）：\`userAccount\` 標必輸且註明由 @Header 取得、同節格式範例卻是純 GET path；INPUT 說可依 sortField 排序、同節 SQL 寫死 ORDER BY；實作備忘說某欄是空字串字面值、同節 SQL 本體取的是欄位；TABLE 清單沒列 CODE_LIST、同節說明卻明訂代碼來源就是它。

### SA 內部要對四組

上面五組是 SD 的文件結構，套不到 SA。SA 有自己的四組：

| 比什麼 | 為什麼會打架 |
|---|---|
| 欄位說明表 ↔ **畫面稿圖片** | 表裡列了欄位圖上找不到；或圖上有、表裡沒說明；或表寫「預帶當天」圖上畫成一整月區間 |
| 欄位說明表 ↔ 按鈕說明表 | 按鈕說了某行為，欄位表沒有對應的必填／檢核定義 |
| 畫面章節 ↔ 輸出報表章節 | 列表少一欄、報表卻有（或反過來）；同一欄兩個名字 |
| 檢核規則 ↔ 訊息文字 | 說了要檢核沒給訊息文字；或給了訊息沒說什麼情況觸發 |

**只做 SD 不做 SA，這個維度等於只做一半。**

### 判準與做法

- **同一份文件裡，同一件事被寫了兩次以上，就要對一次。** 規格越長越容易出現——寫的人自己也記不住前面怎麼寫的
- **長規格（500 行以上）先折疊再建索引**：直接 grep 會被複製結構打敗（某欄位 26 個命中裡 21 個是多段 UNION 逐段複製的同一句守衛，真正該對的 5 處反而淹掉）。順序是 ① 把多段 UNION／多個相似 API 折疊成「一段完整 + 段間差異表」② 對折疊後的內容建索引 ③ 逐個比對
- **範圍被限定成單一節時**（只檢 §1），「章節↔章節」與「畫面章節↔輸出報表章節」本質上跨不了節 → **降級為「待跨節確認清單」寫進 report_output 總結**，不可靜默跳過（跳過的話報告看起來跟做過一樣）

## 維度三：規格模糊點預檢（以 implementer 視角走決策樹）

把自己當成即將實作這個任務的工程師，逐一走過規格描述的**每個畫面/欄位/按鈕/流程**，在每個實作決策點問：「做到這裡時，這個決定能從規格找到唯一答案嗎？」找不到答案、或存在兩種以上合理讀法 → 這是模糊點候選。

### 先查再報（強制——查得到答案的不是模糊點，這是防噪音的成敗關鍵）

宣告任何模糊點之前，必須先自查四處：
1. **規格全文其他章節**——答案可能寫在別的段落（Read 全文 + search_documents(projectId="${task.project_id}", query=...) 定點查）
2. **畫面稿**——包含 (a) Axure 原型（find_axure_snapshot 或任務綁定文件）、(b) **SA 內嵌的圖片**（\`![](../../Images/xxx.png)\` 那些，用 Read tool 逐張打開看）。實測某支 SA 內嵌 6 張 PNG，只看文字表會漏掉「分頁列在不在畫面上」「下拉選項實際長怎樣」這類答案。**圖與文字表一致時，圖就是答案；不一致時交維度二列為矛盾，不可自行採信圖**。圖被裁切、看不到要問的區域時，據實在總結寫「圖已開、該區域被裁切、無法判讀」
3. **專案筆記**——mcp__omni-commander__list_project_notes(projectId="${task.project_id}")：專案慣例已涵蓋的不算模糊（如共用元件的既定行為）
4. **既有 open spec gaps**——mcp__omni-commander__list_spec_gaps(taskId="${taskId}")：已開過的不重開（去重）

### 明文排除（不算模糊點，禁止吹毛求疵）

- 用詞風格、排版偏好
- 實作自由度內的選擇（變數命名、內部結構、程式組織方式）

### gap 描述格式（強制，三要素缺一不可）

1. **規格出處**：檔名 + 章節/行（如「SA WA05.md §3.2」）
2. **具體哪個決定沒答案**：如「刪除是否需要二次確認——SA §3.2 只寫『可刪除』，未寫確認流程」
3. **可能的選項**：讓使用者一眼能拍板，如「A: 直接刪除 / B: confirm 彈窗後刪除」

禁止「規格不清楚」「XX 沒寫清楚」這種沒有出處、沒有選項的空泛描述。

### advisory 聲明

維度三產出的 ambiguous_spec 缺口只是給使用者拍板的清單——**不影響任何完成閘門、不阻止派工**。

## 判定紀律

- 維度一每個發現必附**兩邊出處**：SA 檔名+章節/段落、SD 檔名+API 名
- 維度二每個發現必附**同一份文件的兩個位置**，格式為「檔名 + 章節路徑 + 引一句原文片段」（行號選配——同一份 SD 常有多個同名 \`#### 說明\`，光寫章節名定位不到，引原文才可靠）。一邊是圖片或附件時寫「檔名 + 區塊/欄位 + 圖上實際值」
- **前提下永不成立／自我抵銷的敘述算維度二的矛盾**（例：某列前提是「A 為空且 B 為空」，同列額外條件欄卻寫「加上 B LIKE …（B 為空時不加）」——該列前提下永遠不成立）。那是複製貼上沒清乾淨
- **SD 越界寫實作細節**（建議用哪個 API、@Column 該宣告什麼）**內部一致就不列**——那是規格越界不是規格矛盾
- 不確定是否矛盾 → 列為疑問而非斷定
- **沒有發現也要明確說「檢查了 N 個欄位/M 支 API，無矛盾」，而且統計要分開計**：SA 畫面欄位 N 個／SD 各支 API 的 INPUT 與 OUTPUT 各 N 個／SQL 投影 N 欄（N 段）／API N 支／同一件事被寫兩次以上的 N 處。「N 個欄位」合成一個數字會差一個數量級，失去意義。不可含糊帶過或省略統計——「沒問題」和「沒檢查」看起來一樣，數字是唯一能分辨的東西

## 輸出動作

1. 每個**確認的矛盾**（維度一）呼叫 mcp__omni-commander__report_spec_gap(taskId="${taskId}", category="sa_sd_mismatch", description="[面向] SA 說… vs SD 說…（出處：SA 檔名+章節、SD 檔名+API 名）")
2. 每個**確認的內部矛盾**（維度二）呼叫 mcp__omni-commander__report_spec_gap(taskId="${taskId}", category="spec_internal_conflict", description="[哪份文件] 位置 A（章節路徑）說… vs 位置 B（章節路徑）說…（各引一句原文）")
3. 每個**確認的模糊點**（維度三，先查四處後仍無唯一答案）呼叫 mcp__omni-commander__report_spec_gap(taskId="${taskId}", category="ambiguous_spec", description="…")——description 必含出處+哪個決定沒答案+可能選項三要素
4. 疑問（不確定是否矛盾、或不確定該歸維度一還維度二）不寫 spec gap，列在總結中請使用者判斷
5. 全部檢完呼叫 mcp__omni-commander__report_output(taskId="${taskId}", content="...") 總結——必含分開計的數量統計（見判定紀律）、維度一矛盾 X 項、維度二內部矛盾 X2 項、模糊點 Z 項、疑問 Y 項、待跨節確認 W 項

## 絕對禁止
- 不得修改任何程式碼或檔案（只讀）
- 不得呼叫 update_task_status——本檢查不是開發任務本身，任務狀態由 orchestrator 決定`;

      return { content: [{ type: 'text' as const, text: truncateResponse(plan) }] };
    },
  );
}
