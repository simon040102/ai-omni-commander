# AI-OmniCommander 功能文件

## 概述

AI-OmniCommander 是一個 **MCP Server**，為外部 Claude Code session 提供任務管理與開發脈絡：Asana 任務同步、SVN + 本地資料夾規格文件雙來源、規格檢查表與 AI 規格回對閘門、驗收清單、Web UI 即時監控。

執行模型：**orchestrator（外部 Claude Code session）透過 MCP 工具取得脈絡，再用 Agent tool 派 subagent 到各專案 workspace 開發**。舊的 spawn 派工路徑預設由 `ALLOW_LEGACY_SPAWN` 硬閘停用（未設此環境變數時任何 spawn 入口都會擋下），見文末「Legacy 模式」。

---

## 一、現行工作流

```
列專案 → 同步 Asana → 選任務 → 自動判軌（bug 無規格→light / 規格驅動→full）
→ 抓規格（SVN + 本地規格資料夾雙來源）→ 抽規格檢查表（checklist）
→ [full 軌] Flow-Gated 流程圖閘門 A/B → 開發
→ 程式預檢（run_spec_compliance）→ AI 回對（獨立 agent 逐項驗證，missing=0）
→ 驗收（get_verification_plan + 證據上傳）→ completed（閘門放行）
```

### 自動判軌（full / light）

`get_execution_plan(taskId)` 會自動判斷任務軌道：

- **light 軌**：taskType=bug 且無 SA/SD 規格文件 → 輕量修復流程。跳過 Flow-Gated 流程圖閘門、跳過 SA/SD 齊全檢查，規格檢查表改抽 BUG 原文
- **full 軌**：其他情況 → 規格驅動完整流程（規格齊全檢查 + 流程圖閘門）
- 輕的是**工序**不是**標準**：兩軌都要 AI 回對 missing=0 才能標 completed
- 可用 `track="full"` / `track="light"` 明確覆寫

### 完成閘門

`update_task_status(taskId, "completed")` 受兩道閘門管制：

1. **Flow gate B**（full 軌）：程式碼流程圖與計畫流程圖比對通過
2. **AI 規格回對閘門**：最新一次 AI 回對（ai_review run）missing=0

`skipFlowGate=true` + `skipReason` 可覆寫，**限使用者明確同意**，會記 `[SKIP]` 供稽核。

### 配套機制

| 機制 | 工具 | 說明 |
|------|------|------|
| 規格缺口 | `report_spec_gap` | 規格沒定義的欄位/API/邏輯一律記錄，不可自行編造；Web UI 有「待補規格」面板 |
| 專案經驗筆記 | `save_project_note` | 專案特有的坑/慣例記下來，自動注入之後的 execution plan |
| 規格異動偵測 | `check_spec_changes` | 比對開工時記錄的規格版本與 SVN/本地最新版；Asana 同步後自動跑，變更會自動開 `spec_changed` 缺口 |
| SA/SD 一致性檢查 | `check_spec_consistency` | 開工前建議跑：規格自相矛盾時實作永遠無法 100% 回對 |
| 接手舊任務 | `resume_task` | 一次回傳任務摘要 + 閘門進度 + 歷史回報 + 未解決缺口 + 依賴狀態 + 下一步 |
| 任務推薦 | `next_task` | 依賴未阻塞 + bug 優先的下一個可做任務 |

---

## 二、MCP 工具一覽（54 個）

### 任務 / 執行計畫（12）

- `get_execution_plan` — 取得任務完整執行計畫（自動判 full/light 軌，自動注入規格閱讀／規格遵循／後端效能／後端安全規範）— **開工第一步**
- `list_pending_tasks` — 待辦任務清單（可用 taskType / label / keyword / section / tag / statuses 過濾，含 sourceRef）
- `get_task` — 取任務詳情（documents 預設不回傳，`includeDocuments=true` 才含）
- `update_task_status` — 更新任務狀態（in_progress / completed / failed…）；completed 受 flow gate B + AI 回對閘門管制
- `update_task` — 更新任務欄位（title / label / taskType / tags / section；status 不在白名單）
- `next_task` — 推薦下一個可做任務（依賴已完成 + bug 優先）+ 備選清單
- `resume_task` — 接手舊任務的一站式脈絡恢復
- `get_task_outputs` — 取回任務歷史回報記錄（新 session 恢復脈絡用）
- `save_task_dispatch` — 存派工快照（中斷復原用；`resume_task` 會帶回最近一次派工 prompt）
- `create_task` — 建立任務
- `add_task_dependency` — 加任務依賴（同專案、防自依賴、防重複、防循環）
- `remove_task_dependency` — 移除任務依賴

### 文件 / 規格（6）

- `fetch_svn_specs` — 依任務 parent_name 從 **SVN + 本地規格資料夾（specFolders）雙來源**合併抓取 SA/SD（docx 自動轉 md，含快取）
- `get_documents` — 列出專案/任務的文件
- `read_document` — 讀取文件內容
- `search_documents` — 規格全文搜尋（回檔名 + 行號 + 前後文片段；查欄位名/API 路徑/訊息文字用這個，比整份讀省 context）
- `find_axure_snapshot` — 依功能代碼找 Axure 原型 HTML
- `fetch_task_attachments` — 下載 Asana 任務附件（如 BUG 截圖）

### 規格缺口（5）

- `report_spec_gap` — 記錄規格未定義的欄位/API/邏輯（結構化的 [NEEDS_CLARIFICATION]）
- `list_spec_gaps` — 依專案/任務/狀態列出待補規格
- `resolve_spec_gap` — 使用者補完規格後標記已解決
- `check_spec_changes` — 偵測規格檔案是否在開工後被改過（SVN + 本地 file_ref 皆支援；變更自動開 `spec_changed` 缺口）
- `check_spec_consistency` — SA/SD 規格互相矛盾檢查（開工前建議）

### 規格回對（checklist / compliance）（6）

- `save_spec_checklist` — 讀完規格後抽取逐項檢查表（light 軌改抽 BUG 原文）
- `get_spec_checklist` — 取回任務的規格檢查表
- `waive_checklist_item` — 豁免檢查項（必附理由，供稽核）
- `run_spec_compliance` — **程式預檢**：用程式比對 checklist 與程式碼，抓文字/路徑錯字（advisory，不解鎖完成閘門）
- `get_compliance_review_plan` — 取得 **AI 回對**派工計畫（派獨立 reviewer agent，implementer 不可自評）
- `save_compliance_review` — 寫回 AI 回對結果；**最新回對 missing=0 才可標 completed**

### 驗收（4）

- `get_verification_plan` — 依任務 label 取驗收清單（後端：findAll / DDL / API 煙霧測試 / seed SQL；前端：tsc / Playwright）
- `get_test_baseline_plan` — 既有單元測試不是全綠時，取得測試基線修復計畫（先修基線再開發）
- `report_verification_result` — 回報逐項驗收結果
- `report_verification_evidence` — 上傳驗收證據檔（如 Playwright 截圖），存進任務記錄

### 專案筆記（3）

- `save_project_note` — 記錄專案特有的坑/慣例（規格沒寫但必須遵守），自動注入後續 execution plan
- `list_project_notes` — 查看筆記（預設只列 active）
- `archive_project_note` — 封存筆記（不實體刪除）

### Flow-Gated 流程圖（4）

- `save_task_flow` — 儲存流程圖（spec / plan / code / mindmap）
- `report_flow_check` — 回報流程圖閘門 A/B 比對結果
- `get_task_flows` — 列出任務已存的流程圖
- `save_sa_flow` — 儲存 SA 文件的 Mermaid 流程圖快取

### Asana（3）

- `sync_asana_tasks` — 同步 Asana 任務進本地 DB（5 分鐘內去重，`force=true` 覆寫；**同步後自動跑規格異動檢查**）
- `list_asana_projects` — 列出 Asana workspace 專案（找 GID 綁定用）
- `get_asana_task_comments` — 取任務留言（支援 omni UUID 或 Asana GID）

### 進度回報（2）

- `report_output` — 回報關鍵輸出到 Web UI
- `report_milestone` — 回報里程碑

### 專案 / 設定 / 診斷（9）

- `list_projects` — 列出所有專案
- `get_project` — 專案詳情（含任務統計、config_json）
- `create_project` — 建立專案
- `update_project` — 更新專案設定（含 specFolders，設定時做安全驗證）
- `set_extra_prompt` — 設定專案前端/後端 Extra Prompt（自動注入每個 subagent）
- `set_global_config` — 設定全域設定（`svn.username` / `svn.password` / `asana.pat`）
- `get_skill_gen_plan` — 產生 workspace CLAUDE.md / .claude/skills 的完整計畫（官方 SKILL.md 資料夾格式 + 經驗筆記注入 + 開發前必讀章節）
- `query_external_db` — 唯讀查詢專案綁定的外部 DB（列表、表結構、SELECT）
- `health_check` — 診斷 DB / Web Server / Asana PAT / SVN CLI 狀態（畫面沒更新、撈不到規格先跑這個）

### MCP Prompt（1）

- `start_task` — 標準任務工作流（get_execution_plan → in_progress → 執行 → 回報 → 驗收 → completed/failed；taskId 可省略，會自動定位）

> 連上此 MCP 的 session 會自動收到 server instructions（7 條使用規則），不需要改任何 CLAUDE.md。

---

## 三、規格文件來源（雙來源）

### SVN 自動抓取

1. 從任務 `parent_name` 提取功能代碼（`WA04_已轉派工作清單` → `WA04` → root code `WA`）
2. `svn list --xml` 搜尋匹配資料夾（XML 輸出確保 UTF-8）
3. 遞迴搜尋 `.docx` / `.pdf`，下載到 `data/uploads/{projectId}/`
4. `.docx` 自動轉 `.md`（mammoth + turndown，含圖片抽取）
5. 三層快取：SVN last-modified → SHA-256 hash → DB 記錄

### 本地規格資料夾（specFolders）

專案設定 `config_json.specFolders`（Web UI 的 ProjectSettings「規格資料夾」區塊，或 `update_project`）：

```json
{ "specFolders": [ { "path": "D:\\specs\\tvedi-docs", "gitPull": true } ] }
```

- 抓取時與 SVN 結果**合併**，功能代碼比對邏輯相同，docx→md 轉換與版本記錄同構
- docType 由檔名慣例推斷（SA/SD token 或「需求規格/系統分析/系統設計」字樣，預設 SD）
- **git pull 安全鐵律**：git 只允許 `status --porcelain` / `rev-parse HEAD` / `log -1 --format=%cI -- <file>` / `pull --ff-only` 四種操作，絕不寫入、絕不 stash/reset；working tree dirty → 跳過 pull + 警告；pull 逾時/失敗 → 用現有內容 + 明確警告
- **設定驗證**：path 必須是絕對路徑；與該專案 frontendPath/backendPath 相同或互為父子**一律拒絕**（防誤 pull 程式碼 workspace）

---

## 四、Web UI（可選監控）

Web Server (:3457) + Vite (:5174)。MCP 每次寫入操作會 POST `/api/mcp-notify` 讓 UI 即時更新；**Web Server 沒跑時 MCP 工具照常可用**。

- **Dashboard** — 專案概況、任務狀態、agent 輸出、里程碑
- **規格治理收合區**（Dashboard 內）— 三個面板：
  - **待補規格** — report_spec_gap 記錄的缺口，可標記已解決
  - **規格回對** — checklist 項目與比對結果（matched / missing / waived）
  - **專案筆記** — save_project_note 累積的經驗
- **Tasks** — 任務清單、狀態追蹤
- **Settings** — Global Settings（SVN 帳密、Asana PAT）、Project Settings（SVN 規格路徑、規格資料夾、Extra Prompt、Asana 綁定、外部 DB 連線）
- **Gen Skills** — 觸發 get_skill_gen_plan 產生 workspace 的 CLAUDE.md + skills

---

## 五、產生 Workspace Skills

`get_skill_gen_plan(projectId, workspaceType)` 回傳完整計畫，讓 orchestrator 派 Opus 級 subagent 深讀 codebase，產生或增強該 workspace 的 `CLAUDE.md` 與 `.claude/skills/`：

- 採**官方 SKILL.md 資料夾格式**（`<skill-name>/SKILL.md`），也認得舊的平面 .md
- 注入專案經驗筆記（save_project_note 累積的坑）
- 含「開發前必讀」章節

---

## 六、Legacy 模式（已停用）

早期版本由 Web UI 直接 spawn Claude Code CLI 子程序執行任務（Spec Mode / Creative Mode / Quick Mode、master / architect / backend / frontend / devops / testing / review 角色、SDK / `claude -p` 派工）。

**這條路徑預設由 `ALLOW_LEGACY_SPAWN` 硬閘停用**（AgentManager / ExecutionPipeline 在 spawn 前檢查，未設環境變數即 throw）：現行執行一律走**外部 Claude Code session + MCP 工具 + Agent tool 派 subagent**。相關程式碼（AgentManager、SpecModeHandler 等）僅供歷史參考與硬閘後的殘留能力，細節見 `ARCHITECTURE.md` 標注「Legacy」的章節。

---

## 七、技術細節

- MCP Server：stdio transport（`server/dist/mcp-entry.js`），由 Claude Code 依 `.mcp.json` 或 user-scope 註冊自動 spawn
- **跨專案載入**：MCP process 內所有路徑以 repo root 解析（與 cwd 無關）；`DB_PATH` 可省略，啟動時 stderr 印出實際 DB 路徑
- SQLite：`data/omni.db`，MCP process 與 Web Server 共用
- Server port：3457（`PORT` env）；預設綁 `127.0.0.1`（`HOST` env 可改）
- Node.js >= 20；SVN CLI >= 1.10（認證走 `--password-from-stdin`）
- Windows：`tsx watch` 不穩定，改 `.ts` 後手動重啟 server；SVN 輸出用 `--xml` 避免 CP950 亂碼
