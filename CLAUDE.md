# AI-OmniCommander

A dual-mode AI collaborative development system. Originally orchestrated multiple Claude Code CLI instances (agents) directly; now operates as an **MCP Server** that provides task management and execution context to external Claude Code sessions.

> 架構細節（系統圖、Monorepo 逐檔說明、Key Flows、Document Handling、Skills 清單）見 **ARCHITECTURE.md**。本檔只放行為規則。

## 互動式任務執行（必讀）

當使用者提到專案、任務、執行開發等話題時，遵循以下對話式流程。**不要一次倒出 MCP raw JSON，要整理成易讀的格式。**

### 列出專案
使用者問「有哪些專案」→ `mcp__omni-commander__list_projects()`，回覆：
```
目前有 N 個專案：
1. **專案名** — FE: 路徑 / BE: 路徑
2. ...
要看哪個專案的任務？
```

### 列出任務
使用者選專案後：
1. 先呼叫 `mcp__omni-commander__sync_asana_tasks({ projectId })` — 如果 5 分鐘內已同步過會自動跳過
2. 再呼叫 `mcp__omni-commander__list_pending_tasks({ projectId })`

**整理成分組列表**：

```
**專案名** 有 N 個待處理任務：

**Bug 修復：**
1. SM27 共用_查詢工程專案 — 計劃部門查詢欄位失效
2. SM26_使用者帳號維護 — 主部門點選儲存_職稱無儲存

**公文表單（DF）：**
4. DF01 收文單 — 前端 / 串接
...

選一個任務，或直接告訴我你要做什麼。
```

**格式要求：**
- 從 parent_name 提取功能代碼（`SM27_專案成員維護作業` → `SM27`）
- 同功能的前端/串接/後端合併成一行（`— 前端 / 串接`）
- 按功能分組：Bug 修復、DF 系列、PM 系列、WA 系列、其他
- 用編號列表，使用者可以直接回覆編號
- **絕對不要輸出 raw JSON**

### 選擇任務後

> **任務軌道**：`get_execution_plan` 會自動判軌——taskType=bug 且無 SA/SD 規格文件 → **light 軌**（輕量修復流程：跳過 Flow-Gated 流程圖閘門，規格檢查表改抽 BUG 原文），否則 **full 軌**（規格驅動流程，現狀）。light 軌不用做步驟 4 的 SA/SD 齊全檢查；輕的是工序不是標準，AI 回對 missing=0 才可標 completed 照舊。可用 `track="full"` / `track="light"` 明確覆寫。

1. 先問：「要做**前端**、**後端**、還是**都做**？」
2. 取得任務詳情 `get_task(taskId)`
3. 自動查找：SVN 文件 `get_documents()`（定點查欄位名／API 路徑／訊息文字可用 `search_documents`）、Axure 原型 `find_axure_snapshot(projectId, code)`
4. **檢查規格文件是否齊全**（只適用 **full 軌**——bug 無規格會自動走 light 軌，直接跳過此檢查）：
   - 前端任務 → 必須有 **SA 文件**（系統分析規格）+ **SD 文件**（系統設計規格），沒有就告知使用者並詢問是否提供
   - 後端任務 → 必須有 **SD 文件**（系統設計規格），沒有就告知使用者並詢問是否提供
   - 都做 → SA + SD 都要有
   - Axure 原型（前端任務建議有，非必要）
   - **規格不齊全不執行**，明確告知缺什麼：
     ```
     缺少規格文件：
     - SA 文件：未找到（前端開發必要）
     - SD 文件：WA05-design-spec.md
     - Axure 原型：6 個頁面

     請提供 SA 文件路徑，或說「跳過」強制執行。
     ```
   - **跳過時必須用 `report_output` 記錄**：`[SKIP] 使用者跳過規格檢查：缺少 {缺少的文件類型} 文件`
   - （可選）SA/SD 都齊時可先 `check_spec_consistency(taskId)`——同一次派工做三個維度：(1) **SA↔SD 矛盾比對**（規格自相矛盾時實作永遠無法 100% 回對，矛盾先解決再開工）；(2) **同一份文件內部矛盾**（SD 五組／SA 四組，開 `spec_internal_conflict` 缺口——見下方行為註記）；(3) **規格模糊點預檢**（以 implementer 視角走決策樹，把「規格找不到唯一答案」的決策點開成 `ambiguous_spec` 缺口讓使用者拍板；advisory，不影響任何閘門、不阻止派工）。**使用時機（任務有大小之分，不是每次都跑；判斷者是 orchestrator、決定權在使用者，絕不自動觸發）**：
     1. light 軌／小 bug／小改 → 不跑也不提
     2. full 軌小規格（單頁 CRUD、欄位少）→ 預設不跑——模糊留給 implementer 撞到再 `report_spec_gap` 的既有機制
     3. full 軌大規格（多跳窗／多流程／長 SA）→ orchestrator 在此規格齊全檢查步驟「建議」使用者跑，使用者同意才跑
     4. 使用者主動要求 → 隨時可跑

     發現 ambiguous_spec 缺口 → 建議使用者先逐項拍板再執行（可照常執行，不強制）
   - 任務若已是 in_progress（接手舊任務）→ 先 `resume_task(taskId)` 恢復脈絡再判斷
5. 告知使用者找到什麼，同時問：「有沒有額外文件？沒有的話說『執行』」
6. 使用者說「執行」才派 subagent（前端 → cwd=frontendPath，後端 → cwd=backendPath，都做 → 派兩個 subagent）

### Orchestrator 角色定位（強制）

**我（orchestrator）不直接修改任何專案的程式碼。** 所有開發工作（包含 bug 修復、feature、refactor）都必須派 subagent 執行。

原因：
- 每個專案有自己的 CLAUDE.md 和 .claude/skills/，subagent 會讀取並遵循
- 我直接改會跳過專案的規範和 coding standards
- subagent 的 cwd 設在對應的 workspace，能正確 build 和測試

**唯一例外**：OmniCommander 自己的程式碼（server/、web/、CLAUDE.md、.claude/skills/）我可以直接改。

### 前端 + 串接同時派的衝突處理

前端 agent 和串接 agent 的 workspace 相同（都在 frontendPath），可能同時改同一個檔案（如 Index.tsx）。

**處理方式：**
- **前端 agent** 負責：頁面結構、UI 元件、樣式、表單驗證
- **串接 agent** 負責：API 呼叫、資料處理、狀態管理
- 如果功能簡單（如 WA03 這種查詢+刪除+復原），**不要同時派前端和串接兩個 agent**，合併成一個 agent 做完
- 只有功能複雜到需要拆分時（如 DF01 收文單有大量 UI + 複雜 API 流程），才分成兩個 agent

### 派 subagent 時必須做的事

#### 0. 派工模型政策（與主 session 模型脫鉤，一律明確帶 `model` 參數）

| 角色 | model | 理由 |
|---|---|---|
| AI 回對 reviewer | **`opus`（永遠）** | logic 項判定沒有程式兜底，最後防線不可降級 |
| 基線修復 fixer | `opus` | 「化石 vs 真 bug」分類判錯會把 bug 固化成斷言 |
| full 軌 implementer | `opus`（簡單規格可 `sonnet`） | 多檔推理與規格語意 |
| light 軌 bug implementer | `sonnet` | 範圍小、閘門兜底 |
| 煙霧測試類 | `sonnet` | 純機械操作 |

任務有設 `preferredModel` 時以它為準（`get_execution_plan` / `get_compliance_review_plan` 的回應會帶建議模型，照著帶即可）。

#### 1. 注入 Superpowers 方法論
根據任務類型自動選擇：
- **bug** → 告訴 subagent 使用 `/systematic-debugging` skill（先分析根因再修復）
- **feature** → 告訴 subagent 使用 `/brainstorming` + `/test-driven-development` skill
- **refactor** → 告訴 subagent 使用 `/brainstorming` skill
- **其他** → 告訴 subagent 使用 `/verification-before-completion` skill

在 prompt 中加入：
```
## 開發方法論（Superpowers）
本次任務類型為 {taskType}，請使用以下 skill：
- /systematic-debugging（或 /brainstorming + /test-driven-development 等）
在開發過程中主動使用這些 skill 來確保品質。
```

#### 2. get_execution_plan 已自動注入的規範（orchestrator 不需手動注入）

以下規範全文已由 `get_execution_plan` 自動注入 subagent prompt（真相來源：`server/src/orchestrator/ExecutionPipeline.ts` 的 buildTaskPrompt 系列）：
- **規格文件閱讀**（所有 role）：逐項完整讀 SA/SD/Axure，report_output 摘要理解重點
- **規格遵循最高原則**（所有 role）：規格沒寫的不做、規格寫的照做；不確定就 report_spec_gap / [NEEDS_CLARIFICATION]
- **單元測試強制流程**（所有 role）：先列測試案例清單（report_output 留稽核軌跡）再寫測試；失敗案例的預期結果必須有規格出處，規格沒定義就 report_spec_gap 不可編造；測試指令來自專案設定 `frontendTestCommand`/`backendTestCommand`（light 軌案例來源改為 BUG 原文重現步驟）
- **後端效能分析**（backend role）：寫 code 前分析資料表/過濾條件/N+1/資料流，禁「撈全表 + 記憶體過濾」
- **後端安全檢查**（backend role）：SQL 參數綁定、權限驗證、參數驗證、response/log 不外洩
- **可維護性規範**（所有 role）：先找現成的再造新、不複製貼上（第三次抽共用）、命名達意、註解只寫為什麼、最小侵入（不順手重構無關程式）、函式單一職責；與 workspace 規範衝突時以專案為準

> 注入內容為 **stack 中性通用版**。專案特有的技術棧慣例（如富邦系的 NaNa 大表禁 findAll()、MetaData.java 的 CREATE_DATE/MODIFY_DATE/DATA_REMARK 欄位）放在各專案的 `backendExtraPrompt` / 專案筆記，會自動注入，不寫死在通用工具。

**⚠ 嚴禁在 prompt 中手動摘要規格內容。** prompt 只放規格文件的完整路徑，讓 subagent 自己用 Read tool 讀取原始文件。手動摘要容易打錯字或遺漏細節（如「儲存」寫成「存儲」），subagent 會照著錯的摘要實作而不會核對原始文件。

**⚠ 規格裁決同理不可手寫。** 使用者對 spec_gap 的裁決一律先 `resolve_spec_gap(gapId, resolutionNote=具體裁決)` 落地 DB，由 `get_execution_plan`／派工 context 自動注入「## 規格裁決」區塊（AI 回對計畫也會自動帶）；不要手動把裁決文字塞進 prompt——打錯字或漏條 subagent 無從核對，且下一個 session 看不到。

#### 3. 讀取 Workspace 規範
subagent 的 prompt 必須包含：
```
## Workspace 規範（必讀）
1. 先讀取 {workspacePath}/CLAUDE.md — 了解專案架構、命名規範、開發規則
2. 執行 ls {workspacePath}/.claude/skills/ — 列出所有可用 skill
3. 讀取與本次任務相關的 skill
4. 嚴格遵循 CLAUDE.md 和 skills 裡的所有規則進行開發
```
這確保 subagent 會使用 workspace 自己的 CLAUDE.md 和 .claude/skills/，而不是只用 OmniCommander 的規則。

#### 4. 注入專案 Extra Prompt（強制）
每次派 subagent 前，**必須**先讀取專案的 `config_json`，檢查是否有 `frontendExtraPrompt` 或 `backendExtraPrompt`。如果有，**必須**原封不動加入 subagent prompt 中。

```python
# 虛擬碼
project = get_project(projectId)
config = JSON.parse(project.config_json)

if task.label == 'frontend' and config.frontendExtraPrompt:
    prompt += f"\n## 專案額外指示（來自專案設定，必須遵守）\n{config.frontendExtraPrompt}\n"

if task.label == 'backend' and config.backendExtraPrompt:
    prompt += f"\n## 專案額外指示（來自專案設定，必須遵守）\n{config.backendExtraPrompt}\n"
```

**注意事項：**
- `{AXURE_SNAPSHOT_PATH}` 變數要替換成實際的 Axure snapshot 路徑
- 不要修改 extraPrompt 的內容，原封不動傳給 subagent
- 這個步驟適用於所有專案，不只特定專案

### 執行時
- 不確定做哪個任務時，可用 `next_task(projectId)` 取得推薦
- **spec_gap 裁決落地（強制）**：使用者在對話中對規格缺口拍板後，orchestrator 必須**立刻** `resolve_spec_gap(gapId, resolutionNote=具體裁決)` 寫進 DB；**嚴禁只把答案手動寫進派工 prompt 或對話帶過**。裁決區塊只由工具從 DB 自動注入（派工 prompt Layer 2.75／resume_task 的 resolvedGaps／AI 回對計畫的「規格裁決」段）——不落地 = implementer 和 reviewer 看不到，這就是結構性強制。resolutionNote 必須是具體決定（如「選 B：刪除前 confirm 彈窗」），空泛詞（「可以」「照舊」）會被拒絕
- **任務來源決定流程**：
  - **Asana 已存在的任務**（已有 taskId）→ 直接 `update_task_status(taskId, "in_progress")`
  - **使用者口述的新任務**（沒有 taskId）→ 先 `create_task(projectId, title, label, ...)`，用回傳的 taskId，再 `update_task_status(taskId, "in_progress")`
- Agent tool 派 subagent，prompt 包含所有收集到的上下文
- **流水線並行**：任務 A 進入 AI 回對（獨立背景 agent）後，orchestrator 不必乾等——可立即開始備料/派工任務 B。回對結果回來再收 A 的尾。前端+後端雙 agent 並行照舊
- subagent 用 `report_output` / `report_milestone` 回報進度
- 完成後 `update_task_status(taskId, "completed")`

### 狀態回報（強制 — subagent 必須確實執行）

**⚠ subagent prompt 中必須包含以下狀態回報指令，並且在 prompt 的最後再次強調：**

```
## 狀態回報（強制）
- 每完成一個主要步驟用 mcp__omni-commander__report_output(taskId="{taskId}", content="...")
- 重要節點用 mcp__omni-commander__report_milestone(taskId="{taskId}", milestone="...")
- ⚠ 全部完成後【必須】呼叫 mcp__omni-commander__update_task_status(taskId="{taskId}", status="completed", summary="...")
- ⚠ 如果失敗【必須】呼叫 mcp__omni-commander__update_task_status(taskId="{taskId}", status="failed", summary="失敗原因")
- 不論成功或失敗，結束前一定要回報狀態，否則任務會永遠卡在 in_progress
```

**為什麼需要強調三次（prompt 開頭 + 結尾 + MCP tool response）：** subagent 在長時間執行後，早期的 prompt 可能被 context compaction 壓縮掉。多處重複確保 subagent 在任何時刻都能看到這個要求。

### 任務完成後驗證
subagent 完成開發後，必須在標記 completed 之前：
1. 確認程式碼可以 build（執行 workspace 的 build 指令）
2. 如果有 lint/typecheck 指令，也要跑
3. build 失敗 → 修復後再試，最多 3 次
4. 最終失敗 → `update_task_status(taskId, "failed", "build 失敗：錯誤訊息")`
5. 跑單元測試（專案設定的 `frontendTestCommand` / `backendTestCommand`，沒設定就用 workspace CLAUDE.md 的測試指令；都沒有則 `report_output` 記錄後跳過），失敗修復後重跑最多 3 次，最終失敗 → `update_task_status(taskId, "failed", "單元測試失敗：...")`。單元測試只驗邏輯，不驗 SQL 和欄位名——API 煙霧測試照舊
6. 跑 `run_spec_compliance(taskId)` 做程式預檢（抓文字/路徑錯字並修掉）——預檢僅 advisory，不解鎖完成閘門
7. 通知 orchestrator 派**獨立 AI 回對 agent**（implementer 不可自評）：`get_compliance_review_plan(taskId)` → reviewer 逐項驗證 → `save_compliance_review`，最新 AI 回對 missing=0 才可標 completed

### subagent 完成後的 orchestrator 驗證（我自己要做）

subagent 回報完成後，**我（orchestrator）必須自己驗證**，不能直接信 subagent 的結果：

#### 通用（前端/後端都要）— 規格回對兩步流程
0a. **程式預檢**：`run_spec_compliance(taskId)` 用程式比對 checklist 與程式碼，抓文字/路徑錯字（advisory，不解鎖完成閘門；有正當理由的項目用 `waive_checklist_item` 豁免並附理由）
0b. **AI 回對（完成閘門依據）**：`get_compliance_review_plan(taskId)` 取得派工計畫 → 派**獨立的 AI 審查 subagent**（絕不可由寫 code 的 implementer 自評）讀規格原文 + checklist + 實際程式碼逐項判定（含 logic 項目，matched 必附 file+line 證據）→ `save_compliance_review` 寫回。**最新 AI 回對 missing=0 才可標 completed**；missing>0 → 交回 implementer 修正後重新派 AI 回對。**修正後的重審會自動走增量模式**（get_compliance_review_plan 偵測上輪 missing>0 會帶「增量重審」指示）：reviewer 只重判上輪 missing / 新增 / 有疑慮項，其餘上輪 matched 項由 `save_compliance_review(carryForward=true)` 程式重驗證據自動沿用——不需整份重審，閘門標準不變

#### 後端任務
1. **靜態檢查**：grep 資料存取層有沒有「撈全表 + 記憶體過濾」的查詢（專案技術棧的具體禁用寫法見該專案 extraPrompt / 專案筆記）
2. **DDL 比對**：確認 CREATE TABLE 欄位名與 ORM/模型定義逐欄一致（含系統共用欄位，如建立/修改時間——確切欄位名以專案慣例為準）
3. **API 煙霧測試**：啟動服務後 curl 每個新 API，確認回 200 不是 500
4. **seed SQL 檢查**：確認 INSERT 欄位數量與 VALUES 參數數量一致

#### 前端任務
1. **tsc --noEmit**：確認 TypeScript 零錯誤
2. **瀏覽器測試**：用 Playwright 開頁面確認能正常操作（如果服務有跑的話）

**單元測試只驗邏輯，不驗 SQL 和欄位名。API 煙霧測試才是真正的驗收。**

### 錯誤處理
- subagent 執行中遇到無法解決的問題 → `update_task_status(taskId, "failed", "原因")`
- 回報給使用者，詢問是否要調整後重試

### 編號對應
列出任務時，內部記住每個編號對應的 taskId。使用者回覆編號時，用對應的 taskId 取得任務詳情。
如果同功能有前端+串接兩個任務（如 DF01），使用者選了後再問「要做前端還是串接？」來決定具體 taskId。

## MCP Server (v5 — current)

MCP Server（stdio，由 Claude Code 經 .mcp.json spawn）與 Web Server（Express :3457）共用同一個 SQLite（`data/omni.db`），MCP 每次寫入操作會 POST `/api/mcp-notify` 讓 Web UI 即時更新。架構圖、entry point 檔案清單與 Execution Flow 見 **ARCHITECTURE.md**。

### 跨專案載入（重要）

這個 MCP 常從**其他專案的資料夾**啟動（user-scope 註冊，session 開在 tvedi 等 workspace），此時 `process.cwd()` 不是本 repo。因此：

- **MCP process 內所有相對路徑（DB_PATH、data dir、axure snapshots）一律以 repo root 解析**（由模組自身位置推導，見 `mcp/helpers.ts` 的 `resolveFromRepoRoot`），與 cwd 無關
- `DB_PATH` env 可省略（預設 repo 的 `data/omni.db`）；MCP 啟動時會在 stderr 印出實際使用的 DB 路徑
- 從其他專案註冊時，**mcp-entry.js 的路徑必須用絕對路徑**：
  ```bash
  claude mcp add --scope user omni-commander -- node "d:/暫存檔/claude code/ai-omni-commander-v5/server/dist/mcp-entry.js"
  ```
- 新增程式碼時**嚴禁**在 MCP process 內用 `process.cwd()` 解析路徑，一律走 `getDataDir()` / `resolveFromRepoRoot()`

### MCP Tools (59 total)

完整用法見各工具 description 與 server instructions（連線時自動注入）。分組一覽：

- **任務 / 執行計畫**：`get_task`, `list_pending_tasks`（in_progress 任務附 `stalledHours`/`stalled` 卡死偵測）, `get_execution_plan`, `update_task_status`, `update_task`, `next_task`（附 `stalledTasks` 疑似停滯清單）, `get_task_outputs`, `resume_task`（附最近 `lastDispatch` 派工快照）, `save_task_dispatch`（派工快照，中斷復原）, `add_task_dependency`, `remove_task_dependency`, `create_task`
- **文件 / 規格**：`get_documents`, `read_document`, `search_documents`, `find_axure_snapshot`, `fetch_svn_specs`, `fetch_task_attachments`
- **專案 / 設定**：`list_projects`, `get_project`, `create_project`, `update_project`, `set_extra_prompt`, `set_global_config`
- **規格缺口**：`report_spec_gap`, `list_spec_gaps`, `resolve_spec_gap`, `check_spec_changes`, `check_spec_consistency`
- **規格回對（checklist / compliance）**：`save_spec_checklist`, `get_spec_checklist`, `waive_checklist_item`, `run_spec_compliance`, `get_compliance_review_plan`, `save_compliance_review`, `verify_db_schema`（db_field 對實體 DB 核對）
- **驗收**：`get_verification_plan`, `get_test_baseline_plan`, `report_verification_result`, `report_verification_evidence`
- **專案筆記**：`save_project_note`, `list_project_notes`, `archive_project_note`
- **流程圖（Flow-Gated）**：`save_task_flow`, `report_flow_check`, `get_task_flows`, `save_sa_flow`
- **回報**：`report_output`, `report_milestone`
- **Asana / 其他**：`sync_asana_tasks`, `list_asana_projects`, `get_asana_task_comments`, `get_skill_gen_plan`, `query_external_db`, `health_check`
- **自我觀察（唯讀，不碰閘門）**：`analyze_harness`（讀回對/缺口/筆記 trace，找**機制本身**哪裡失靈；所有統計按月切——總數會把已修好的舊帳和還在壞的混成一個數字）, `get_attention_summary`（「該注意什麼」：卡著工作的缺口／帶著缺口結案／失敗任務的缺口／停滯／逾期，**依要做什麼分組、不依資料來源分組**；什麼都沒有就明說沒有）。純函式在 `mcp/harness-analysis.ts`、`mcp/attention.ts`
- **每日「該注意什麼」推送（Web Server 排程，非 MCP tool）**：`utils/attentionDigest.ts`，每 15 分鐘檢查、每天過了 `ATTENTION_DIGEST_HOUR`（預設 9，本地時間）跑一次，**只推比上次多出來的**（快照存 `data/attention/state.json`）；有新變化才寫 `data/attention/YYYY-MM-DD.md` + Windows 氣泡通知，沒有就安靜（不推「一切正常」）。第一次執行只建立基線。唯讀、best-effort（失敗只 log），不改任務/缺口、不回寫 Asana。`ATTENTION_DIGEST=0` 關閉

特殊行為註記（行為規則）：
- **`update_task_status` 完成閘門（六道）**：`completed` 受以下閘門管制——(1) **完工閘（實作邏輯對齊，原閘門 B）**（flow-gated 任務）；(2) **檢查表存在**（有軌道的任務必須有規格檢查表）；(3) **AI 規格回對**（最新 ai_review run missing=0，含 staleness 防護）；(4) **單元測試**（專案有設 `frontendTestCommand`/`backendTestCommand` 時，對應 side 的「單元測試全數通過」驗收項最新一筆回報必須 passed=true；既有測試不是全綠先用 `get_test_baseline_plan` 修基線）；(5) **執行計畫/派工記錄**（frontend/backend/fullstack 任務必須有 `get_execution_plan` 的 track、`[TRACK]` 稽核行或 `save_task_dispatch` 的 `[DISPATCH]` 快照其一）；(6) **驗收 FAIL 擋結案**（任何驗收項最新一筆 `report_verification_result` 為 FAIL 即拒絕，從未回報的項目不擋——改由下述**覆蓋提醒**負責可見性；驗收項可回報 `notApplicable:true`（記 `[N/A]`，note 必寫理由）——**不算通過**：不滿足單元測試閘、不蓋掉先前的 FAIL，只在覆蓋提醒裡算已回報。實測 9–10 月約 1/4 的 PASS 其實寫著 N/A，分開後才量得出真的驗過的有多少）。跳過閘門**限使用者明確同意**、需 `skipReason`、記 `[SKIP]` 供稽核：`skipGates=["unit","plan",...]`（代號 flow/checklist/ai_review/unit/plan/verify）**只跳列出的閘**，其他沒過的照擋——使用者同意跳哪道就只列哪道；舊的 `skipFlowGate=true` 仍會跳過**所有**沒過的閘（相容保留，實測發生過「只同意跳執行計畫閘、單元測試閘被連帶跳掉」）。不論哪種，成功結案的回應都會明列這次實際跳過了哪幾道；`[SKIP]` 只在真的結案時才寫（「跳了 A、被 B 擋下」不留紀錄）。**每道閘都判完才回報**：多道沒過時一次列出、照建議修復順序（執行計畫 → 完工閘 → 檢查表 → 單元測試 → 驗收 → AI 回對；改 code 會讓回對失效所以放最後），判斷條件不變；擋下時寫一筆 `[GATE_BLOCK] {閘代號}`（同組閘 10 分鐘內不重寫）供量測各閘擋了多少次。單元測試項的 FAIL 只歸單元測試閘管，驗收結果閘門不重複報。**`coveredBy=<taskId>` + `coverageNote`**（「已由別張任務涵蓋」，限使用者明確同意）：本任務沒有自己的程式變更、工作在另一張任務做完——涵蓋任務必須同專案、已結案、結案時沒有任何 `[SKIP]`、自己不是被涵蓋結案的（不准串鏈）；**只解開執行計畫閘**，其他閘照常判定；記 `[COVERED_BY]`。實測 9–10 月 26 張跳過執行計畫閘的任務全是這型（報表拆子任務）。開工閘（規格理解確認，原閘門 A）在寫 code 前由 `report_flow_check(gate="A")` 把關
- **`update_task_status` 結案提醒（兩則，不擋門）**：`completed` **成功後**在回應附上 (a) 仍未裁決的規格缺口清單、(b) **未回報的驗收項清單**（僅 frontend/backend/fullstack；回報時用 id 或項目文字皆算已報）。刻意不做成閘門——實測 60 筆已結案開發任務 68% 本來就報齊，沒報的多為 light 軌小改，強制覆蓋只會換來一排自我認證的 N/A（看似驗過、實為儀式，比沉默更糟）。要不要升級成閘門，等這則提醒累積出「警告有沒有人理」的實據再決定
- **規格裁決的注入（派工 prompt／AI 回對計畫／resume_task 三處同一套）**：`buildRulingsBlock`（`utils/specGapResolution.ts`）——預算內逐條列；超過就把**全部**裁決（本任務的＋全案適用的）**全文**寫進 `data/rulings/<taskId>.md`（每次由 DB 重新產生、不截短、帶 gapId），prompt 列放得下的本任務裁決＋「還有幾則、全文在哪、先 Grep 再動手／判定」。回對計畫另要求「判 missing 前先搜尋裁決檔」。原本派工全塞（實測某專案 423 則、21 萬字，且 418 則被截短）、回對只給前 4000 字（約 10 則）——兩邊看到的不一樣，回對員會把照裁決做對的判成 missing。不做相關性挑選（挑錯＝把該照做的裁決藏起來）。`resume_task` 回的是全文 JSON，預算以全文大小算
- **`resume_task` 防截斷**：欄位依重要性排序（nextSteps、缺口、裁決、依賴、筆記在前；派工快照、歷史回報在後）、每筆歷史回報截到 500 字（全文用 get_task_outputs）、專案筆記設預算（其餘給則數＋list_project_notes 指引）、JSON 不縮排；仍超過上限就先少帶最舊的歷史回報，不把 JSON 從中間截斷。實測 120 支進行中任務：截斷 40→0、nextSteps 被切掉 39→0
- **`sync_asana_tasks` subtask 遞迴抓取**：專案任務清單抓不到未 multi-home 進專案的 subtask（工作項目常在第二層），同步時自動對 `num_subtasks>0` 的未完成任務遞迴抓 subtask（深度上限 3、只抓未完成、gid 去重、每次同步 subtask API 上限 300 支超過截斷+警告）；assignee 過濾以任務本身判（先抓全樹再過濾）、parent_name=直接母任務、section 繼承根任務；`includeSubtasks=false` 可退回舊行為。共用邏輯：`server/src/utils/asanaSubtasks.ts`（Web 端 `AsanaSyncService.syncOnce` 同一份；Web 端截斷/部分失敗時本輪跳過任務刪除防誤刪）
- **`fetch_svn_specs` 雙來源**：從 SVN **加上**專案設定的本地 `specFolders` 合併撈取；git 資料夾先安全 `git pull --ff-only`（dirty → 跳過 pull + 警告）
- **`get_execution_plan` 自動判軌**：full / light 軌（見「選擇任務後」的任務軌道說明），並自動注入規格閱讀／規格遵循／可維護性／後端效能／後端安全五項規範
- **`check_spec_consistency` 維度二「同一份文件內部矛盾」（新增，advisory）**：既有維度一的四個面向（欄位對齊/功能覆蓋/反向檢查/訊息與驗證規則）**全是跨文件比對，結構上不會去看同一份文件的前後段**——「SD 自己跟自己打架」永遠抓不到。實測某支功能（SA 362 行 + SD 979 行）事後找出 42 條規格問題，**驗證程式碼階段才浮現的 20 條裡有 10 條屬於這類**，純讀一份 SD 就成立，卻拖到最貴的階段才撞出來。因此派工 prompt 增加維度二：**SD 內部五組**（欄位定義表↔SQL 參考、SQL 本體↔實作備忘（明訂不要預設哪邊是基準——備忘可能是後來依實測回填的最新資訊）、INPUT/OUTPUT 表↔格式範例、章節↔章節、規範敘述↔同節 SQL）＋ **SA 內部四組**（欄位說明表↔**畫面稿圖片**、↔按鈕說明表、畫面章節↔輸出報表章節、檢核規則↔訊息文字）。判準「同一份文件裡同一件事被寫兩次以上就要對一次」；長規格（500 行以上）**先折疊重複結構（多段 UNION／相似 API 收成「一段完整＋段間差異表」）再建索引**（直接 grep 會被複製結構打敗：某欄位 26 個命中裡 21 個是逐段複製的同一句守衛）；範圍限定單一節時「章節↔章節」降級為「待跨節確認清單」寫進 report_output，不可靜默跳過。產出走 `report_spec_gap(category="spec_internal_conflict")`——**與 `sa_sd_mismatch` 分開的理由：後者要兩份文件才看得出來，這個純讀一份就成立，處理的人也不同**。新分類需要 spec_gaps 的 CHECK 擴充（v20 migration，照 v12/v17/v19 的重建 pattern，有 migration 測試守住資料保存）。**純 advisory：不影響任何閘門、不阻止派工**（grep 確認過沒有任何閘門讀 `spec_gaps`）
- **`check_spec_consistency` 模糊點自查的「原型」含 SA 內嵌圖片**：原本只認外部 Axure（`find_axure_snapshot`），但 SA 常把畫面稿以 `![](../../Images/xxx.png)` 內嵌，**要用 Read tool 逐張打開看**。實測某支 SA 內嵌 6 張 PNG，打開後當場抓到三條文字表與圖打架（表寫「預帶當天」圖上是一整月區間、表寫「由新到舊排序」圖上是由舊到新、表寫彈窗標題「串連訊息」圖上畫成「檢視作業」）。配套紀律：**圖與文字表一致時圖是答案；不一致時交維度二列為矛盾，不可自行採信圖**（否則維度二要抓的東西會被維度三當成答案吞掉）；圖被裁切看不到要問的區域時據實寫「圖已開、該區域被裁切、無法判讀」
- **`get_compliance_review_plan` 實體 DB 核對（步驟 4c，db_field 專用，**進判定**）**：前面所有關卡看的都是程式碼（原始碼字面、Entity `@Column`、DDL 檔），證明得了「程式碼裡有這個名字」，證明不了「正式資料庫真的有這個欄位」——**DDL 沒套用到該環境、Entity 對到另一張同名欄位的表、規格寫了一個從沒建過的欄位**，這三種在程式碼層面全都看不出來（規格與程式可以一起錯）。因此 reviewer plan 在**專案有設 `dbConnections` 且檢查表有 db_field 項**時會多一步：呼叫 `verify_db_schema(taskId, connectionLabel)` 查 `INFORMATION_SCHEMA.COLUMNS` 逐欄核對。判定規則——**實體 DB 明確說沒有該欄位（或整張表不存在）→ 該 db_field 判 missing（資料庫的答案優先於程式碼）**；實體 DB 確實有才可判 matched（evidence 照舊附程式碼 `file:line`，證據驗證器驗的是程式碼位置不是 DB）；**「無從判定」（沒撈到該表 schema）絕不可當成通過**，改用 `tables` 參數重跑或在 note 據實寫「未經實體 DB 核對」；型別/長度/nullable 與 SD 不符**不影響 matched/missing**（欄位確實存在），改開 `report_spec_gap(category="field_undefined")` 交使用者裁決。專案沒設 DB 連線 → 整步不出現（不叫 reviewer 做做不到的事，那只會換來一句自我認證的「已確認」）。核心比對為純函式 `server/src/mcp/db-schema-check.ts`；連線解析與 `query_external_db` 共用 `resolveDbConnection`，表名一律參數綁定、只讀 `INFORMATION_SCHEMA`（不碰業務資料表），一次上限 40 張表
- **`get_compliance_review_plan` 合約反向對齊（code→spec 欄位，advisory）**：full 軌 reviewer plan 除既有單向逐項回對（spec→code）與「反向掃描規格原文」（spec→checklist 補檢查表）外，另含**合約反向對齊**步驟——枚舉程式對每個 api 實際帶的 request 參數／response 欄位／對應 db_field，與規格定義比對，**程式有、規格沒定義、且屬業務語意**的欄位用 `report_spec_gap(category="field_undefined")` 開缺口交使用者裁決（是過度實作該移除，還是規格待補）。**只做欄位維度**（param/response_field/db_field，**絕不對 ui_text/logic 反向**——誤報海嘯）；排除基礎設施雜訊（分頁 page/size/offset/limit、排序 sort/order、auth token、時間戳 createdAt/updatedAt、專案系統共用欄位如 MetaData 的 CREATE_DATE/MODIFY_DATE/DATA_REMARK）；規格對該 API 欄位定義不足則略過（不硬 diff）。**純 advisory：不影響 matched/missing 判定、不進完成閘門、不擋結案**，產出走既有 report_spec_gap 進 Web UI 待補規格面板。light 軌無 SA/SD 規格文件，不做此步驟
- **Asana due date 同步**：兩條同步路徑（MCP `sync_asana_tasks`、Web `AsanaSyncService`）都把 due_on 落地到 `tasks.due_date`（原樣 YYYY-MM-DD，非字串→null，改期會觸發 UPDATE）；`get_task`/`list_pending_tasks`（另附 `overdue`）/`resume_task` 回傳 `dueDate`；`next_task` 在既有排序（bug 優先）之下同優先級內逾期/近到期優先（null 排最後），推薦理由帶到期資訊（如「已逾期 2 天」）；Web TaskList 任務列顯示到期日（逾期紅字）。共用純函式見 `server/src/utils/dueDate.ts`

MCP Prompt：`start_task` — 標準任務工作流（get_execution_plan → in_progress → 執行 → 回報 → 驗收 → completed/failed；`taskId` 可省略，會用 list_pending_tasks/next_task 定位）。

### 本地資料夾規格來源（specFolders — 與 SVN 並存）

專案級設定 `config_json.specFolders`（ProjectSettings 的「規格資料夾」區塊編輯）：

```json
{ "specFolders": [ { "path": "D:\\specs\\tvedi-docs", "gitPull": true }, { "path": "\\\\nas\\share\\規格", "gitPull": false } ] }
```

- 抓取時（ExecutionPipeline / MCP `fetch_svn_specs`）與 SVN 結果**合併**：功能代碼比對邏輯與 SVN 相同（root code + 檔名/路徑段命中 + 中文名 fallback + `0_共用` fallback），docx→md 轉換、documents（`source='folder'`，`source_url`=絕對路徑）、task_documents 綁定、task_spec_versions（`file_ref`=絕對路徑、`last_modified`=git 檔案 commit 日期或 mtime ISO）全部同構
- docType 由檔名慣例推斷（含 SA/SD token 或「需求規格/系統分析/系統設計」字樣；預設 SD）
- `check_spec_changes` 支援本地 file_ref：先 prepareFolder（安全 pull）→ 重算版本 → 比對；資料夾已移除設定或檔案不存在 → 列 unknown（絕不視為「沒變」）
- 三態呈現：有檔案+有警告（pull 失敗/dirty/部分來源失敗）→ 文件區塊列警告；全失敗 → `[SPEC_FETCH_ERROR]` banner（與 SVN error 同路徑）
- **git pull 安全鐵律**（`server/src/documents/FolderSpecSource.ts`，純函式核心，Web/MCP 兩 process 共用）：
  - git 只允許 `status --porcelain` / `rev-parse HEAD` / `log -1 --format=%cI -- <file>` / `pull --ff-only` 四種操作（白名單守衛），**絕不寫入、絕不 stash/reset**
  - working tree dirty → 跳過 pull + 警告；pull 逾時 15s / 失敗 → best-effort 用現有內容 + 明確警告
  - git 指令一律 spawn 陣列參數（不過 shell）
- 設定驗證（WS `project.update` + MCP `update_project`，`validateSpecFolders`）：path 必須是**絕對路徑**（MCP 跨專案載入，嚴禁相對路徑）、`gitPull` boolean、**與該專案 frontendPath/backendPath 相同或互為父子一律拒絕**（防誤 pull 程式碼 workspace）；路徑不存在只警告不拒絕
- **規格資料夾同時是「證據 root」（AI 回對用）**：交付物是規格文件本身的任務（architect：SA/SD 改寫、知識庫維護）產出不在 frontend/backend workspace 裡（常常連磁碟都不同），證據驗證只認 workspace root 時整批被拒收（「絕對路徑不在 workspace 之下」）、run 寫不進去，而完工閘要求「最新 ai_review missing=0」→ 這類任務結構性地永遠結不了案，逼 reviewer 在假證據／假 missing／卡死之間選。因此 `save_compliance_review` 的證據解析除了 workspace root，另認 **本專案已登記的 specFolders**（`WorkspaceRoots.specRoots`，`resolveProjectSpecRoots`）：
  - **綁專案，不綁磁碟**：只取該專案 `config_json.specFolders` 的 path；登記的資料夾底下若直接放著「以某個專案 id 命名的子資料夾」（多專案共用知識庫版面）→ **只收 `<kb>/<本專案 id>`**，本專案的子資料夾不存在就整個 root 不收（A 專案不得引用 B 專案的規格當證據）
  - **驗法完全不變**：產物目錄排除、2MB 上限、`..` 逃逸防護、±10 行內容相關性一條不少；放寬的只是「哪些樹算數」。**沒有跳過驗證的旗標**，未登記規格資料夾的專案行為與修改前完全相同
  - **引擎（`run_spec_compliance`）刻意不掃 specRoots**：規格文件逐字寫著 checklist 的 content，掃進去就是拿規格證明規格（`.html` Axure 原型在掃描白名單內，真的會中）
  - `get_compliance_review_plan` 會把規格 root 列進 Workspace 段並明說「交付物是規格文件就引規格檔，不要湊 workspace 內的假證據、也不要因為引用不到就判假 missing」
  - 與上一條「不可與 workspace 重疊」不變量無關：那條是為了**不對程式碼 workspace 跑 git pull**（寫入風險），這裡只做唯讀開檔驗證，沒有改動 specFolders 的設定語意或驗證條件

## Development

```bash
# Install dependencies
pnpm install

# Start server (with auto-rebuild)
cd server && pnpm dev

# Start frontend (Vite dev server with HMR)
cd web && pnpm dev

# TypeScript check
npx tsc --build shared/tsconfig.json server/tsconfig.json

# 完整驗證（改完 code 必跑）：vitest + tsc --build + vite build
pnpm verify
```

- Server runs on port 3457 (configurable via `PORT` env var)
- Vite dev server runs on port 5174 and proxies `/omni-ws` and `/api` to server
- SQLite database: `data/omni.db` (persists across restarts)
- Claude CLI path: configurable via `CLAUDE_PATH` env var (default: `claude`)

## Important Implementation Details

- **stdin prompt delivery**: Initial prompts are written to Claude's stdin (not CLI args) to avoid ARG_MAX limits. With `--input-format stream-json`, the prompt is sent as `{"type":"user","content":"..."}`.
- **useStreamInput**: All agents use `--input-format stream-json` to keep stdin open for follow-up instructions.
- **DOCX → Markdown**: `.docx` files are converted to `.md` on upload. `parsed_text` stores a path pointer, not inline text. Agent reads via Read tool after context compression.
- **PDF handling**: PDF file paths are passed in the prompt text; agents use Claude's Read tool to read them natively.
- **Per-agent upload folders**: `uploads/{projectId}/{agentId}/`. Client pre-generates `agentId` before uploading, passes same ID to `agent.add` so files and agent share the same subfolder.
- **Project skills**: Each agent's `cwd` is set to its workspace → Claude Code auto-discovers CLAUDE.md and `.claude/settings.json`.
- **EventBus wildcard**: `agent.*` events are broadcast directly as WS messages (e.g., `agent.started`, `agent.output`), NOT wrapped in `eventbus.notification`.
- **SQLite datetime**: `datetime('now')` returns UTC without 'Z' suffix. Frontend appends 'Z' before parsing.
- **SVN root code extraction**: `OV0101` → `OV` (take leading alphabetic chars). Used to match `OV.銷項發票管理/` folder in SVN.
- **z-index stacking**: Fixed overlays use `z-10`. Confirm dialogs inside overlays must use `relative z-20` or higher to receive click events.
- **Two separate Asana import paths**: `AsanaImportDrawer.tsx` sends `task.create` directly (client-side label decision). `AsanaSyncService.syncOnce()` is used by auto-sync / `asana.syncNow`. Changes to server-side classification only affect the sync path — NOT the manual import drawer.
- **tsx watch unreliable on Windows**: `pnpm dev` uses `tsx watch` which may not detect file changes on Windows. Always **manually restart the server** after editing `.ts` files to guarantee the new code is loaded.
- **Legacy spawn 硬閘（`ALLOW_LEGACY_SPAWN`）**: 本機 spawn 派工（PTY/SDK）預設**停用**——`AgentManager.startAgent` 與 `ExecutionPipeline.executeTask` 未設 `ALLOW_LEGACY_SPAWN=1` 一律 throw。P3 清理後硬閘之外的觸發點也已拆除：Web UI Spec mode 改產生 MCP 指令（不再送 `project.startExecution`）、Asana auto-execute 已移除（同步只匯入任務）、mockup.crawl／SkillGenerator／Quick/Creative mode handler 已刪。僅剩 agent.add／agent.resume／project.startExecution 仍會走到 AgentManager（被硬閘擋下）。執行一律走外部 Claude Code session + MCP；MCP 合成 agent（`mcp-{taskId}`）與啟動恢復（kill-only）不受影響。
- **svn CLI ≥ 1.10 required**: SVN 認證改走 `--password-from-stdin`（避免密碼出現在指令列），此旗標需要 svn 1.10+（2018）。舊版 svn 會報 unknown option 且不會走 curl NTLM fallback。
- **Server binds 127.0.0.1 by default**: `HOST` env 可改（如 `0.0.0.0` 供區網存取）。所有內部預設 URL（NOTIFY_URL、Vite proxy、health_check）都用 `127.0.0.1` 而非 `localhost`，避免 Node 18 的 IPv6 解析問題（engines 已要求 Node ≥ 20）。
- **Fullstack task label**: `fullstack` label triggers `FullstackController` (4-phase flow). Requires both `frontendPath` AND `backendPath` on the project. Uses `skipTaskStatusUpdate` flag (persistent `Set` in AgentManager) to prevent subagents from marking task completed. Coordinator and integration-test agents skip auto-resume (one-shot execution). Markers: `[FULLSTACK_FIX]{json}[/FULLSTACK_FIX]` for coordinator, `[INTEGRATION_TEST_RESULT]{json}[/INTEGRATION_TEST_RESULT]` for Playwright agent. Reports: `docs/verification-reports/{taskId}-frontend.md` and `{taskId}-backend.md`.
