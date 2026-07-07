# AI-OmniCommander

A dual-mode AI collaborative development system. Originally orchestrated multiple Claude Code CLI instances (agents) directly; now operates as an **MCP Server** that provides task management and execution context to external Claude Code sessions.

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
3. DM05_簽呈類別維護作業 — 刪除跳窗文字錯誤

**公文表單（DF）：**
4. DF01 收文單 — 前端 / 串接
5. DF02 展延單 — 前端 / 串接
...

**流程管理（PM）：**
12. PM0301 簽核流程 — 前端 / 串接
...

**其他：**
30. PS01 代理人設定作業 — 前端 / 串接
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
1. 先問：「要做**前端**、**後端**、還是**都做**？」
2. 取得任務詳情 `get_task(taskId)`
3. 自動查找：SVN 文件 `get_documents()`（定點查欄位名／API 路徑／訊息文字可用 `search_documents`）、Axure 原型 `find_axure_snapshot(projectId, code)`
4. **檢查規格文件是否齊全**：
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

#### 2. 確實閱讀規格文件

> 此區塊已內建於 get_execution_plan（ExecutionPipeline 自動注入所有 role），orchestrator 不需手動注入。

subagent prompt 中必須加入：
```
## 規格文件閱讀（強制，寫 code 之前必須完成）
1. 用 Read tool 完整讀取 SA 文件 — 不是掃過去，是逐項讀每個欄位名稱、按鈕文字、訊息文字、操作流程
2. 用 Read tool 完整讀取 SD 文件 — 逐個 API 讀清楚 path、method、每個參數名和型別、response 結構
3. 如果有 Axure HTML — 用 Read tool 讀取，對照 SA 確認 UI 結構
4. 讀完後，在 report_output 摘要你理解的重點（欄位清單、API 清單、特殊邏輯）
5. 開發過程中遇到任何文字、欄位名、API 路徑，回頭查規格確認，不要憑印象寫
```

**⚠ 嚴禁在 prompt 中手動摘要規格內容。** prompt 只放規格文件的完整路徑，讓 subagent 自己用 Read tool 讀取原始文件。手動摘要容易打錯字或遺漏細節（如「儲存」寫成「存儲」），subagent 會照著錯的摘要實作而不會核對原始文件。

#### 2a. 嚴禁自行編造（最高原則）

> 此區塊已內建於 get_execution_plan（ExecutionPipeline 自動注入所有 role），orchestrator 不需手動注入。

subagent prompt 中必須包含以下指令：
```
## 規格遵循（最高原則 — 違反此規則等同任務失敗）

**所有實作都必須有規格依據。規格沒寫的東西，不做。規格寫的東西，照做。**

具體規則：
1. 欄位名稱、按鈕文字、訊息文字 → 必須從 SA/SD 文件逐字抄，不可以自己翻譯或改寫
2. API 路徑、參數名、型別 → 必須從 SD 文件抄，不可以自己命名
3. SQL 欄位名 → 必須從 DB schema 或 Entity @Column 確認，不可以猜
4. UI 元件選擇（checkbox/radio/select）→ 必須從 SA 或 Axure 確認，不可以自己決定
5. 查詢邏輯（WHERE 條件、JOIN、排序）→ 必須照 SD 規格的 SQL/規則實作，不可以簡化或替代
6. DDL 欄位 → 必須讀 Entity 的 @Column name + MetaData.java 確認，不可以猜

如果規格不清楚或有矛盾：
- 用 report_output 說明你不確定的地方
- 不要自己做決定，標記 [NEEDS_CLARIFICATION] 繼續做其他部分
- 寧可不做也不要做錯
```

#### 2b. 後端 subagent 必須先做效能分析

> 此區塊已內建於 get_execution_plan（ExecutionPipeline 對 backend role 自動注入），orchestrator 不需手動注入。

後端 subagent 的 prompt 中必須包含：
```
## 效能分析（強制 — 寫 code 之前必須完成，用 report_output 記錄）

寫任何 Service 方法前，先完成以下分析：

1. 列出涉及的所有資料表 + 估計資料量（不知道就問使用者）
2. 對每個 DB 查詢寫出 WHERE 條件（對應 SD 的哪條規則）+ 預期回傳筆數
3. 寫完後檢查每個迴圈裡有沒有 DB 查詢（N+1 問題）
4. 從 Controller 到 DB 走一遍完整資料流：總共打幾次 DB？最大查詢回幾筆？

⚠ 禁止 findAll() + Java 記憶體過濾。Legacy 表（NaNa）可能有幾十萬筆。
```

#### 2c. 安全弱點檢查

> 此區塊已內建於 get_execution_plan（ExecutionPipeline 對 backend role 自動注入），orchestrator 不需手動注入。

後端 subagent 的 prompt 中必須包含：
```
## 安全檢查（完成實作後逐項確認）

- SQL 參數用 @Param 綁定，禁止字串拼接
- API 驗證當前使用者只能操作自己的資料
- Controller 參數有長度限制和格式驗證
- response 不回傳密碼、token、內部 ID
- 批次操作有上限（如一次最多 100 筆）
- log 不印密碼、token、個資
```

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
- **任務來源決定流程**：
  - **Asana 已存在的任務**（已有 taskId）→ 直接 `update_task_status(taskId, "in_progress")`
  - **使用者口述的新任務**（沒有 taskId）→ 先 `create_task(projectId, title, label, ...)`，用回傳的 taskId，再 `update_task_status(taskId, "in_progress")`
- Agent tool 派 subagent，prompt 包含所有收集到的上下文
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

### subagent 完成後的 orchestrator 驗證（我自己要做）

subagent 回報完成後，**我（orchestrator）必須自己驗證**，不能直接信 subagent 的結果：

#### 後端任務
1. **靜態檢查**：grep ServiceImpl 有沒有 `findAll()`
2. **DDL 比對**：確認 CREATE TABLE 欄位名與 Entity @Column name 一致（特別是 MetaData 的 CREATE_DATE / MODIFY_DATE / DATA_REMARK）
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

## MCP Architecture (v5 — current)

```
┌─ Web UI (React + Vite :5174) ────┐
│  Project mgmt / Task mgmt        │
│  Document upload / Agent monitor  │
│        │ WebSocket                │
│        ▼                          │
├─ Web Server (Express :3457) ─────┤     ┌─ MCP Server (stdio) ───────┐
│  REST API + WebSocket             │     │  Spawned by Claude Code     │
│  /api/execution-plan/:taskId      │     │  via .mcp.json              │
│  /api/mcp-notify (POST)           │     │        │                    │
│        │                          │     │        ▼                    │
│   SQLite (data/omni.db) ◄─────────╋─────╋── SQLite (same omni.db)    │
│        ▲                          │     │                             │
│        │  HTTP notify             │     │  POST /api/mcp-notify ───►  │
│        └──────────────────────────╋─────╋── on each MCP write op      │
└───────────────────────────────────┘     └─────────────────────────────┘

Claude Code / Claude Desktop
  ├─ .mcp.json → spawns MCP Server process
  ├─ get_execution_plan(taskId) → full prompt with superpowers, docs, strategy
  ├─ Agent tool → subagent in workspace executes the plan
  ├─ report_output() / report_milestone() → syncs to Web UI Agents view
  └─ update_task_status() → marks task complete
```

### 跨專案載入（重要）

這個 MCP 常從**其他專案的資料夾**啟動（user-scope 註冊，session 開在 tvedi 等 workspace），此時 `process.cwd()` 不是本 repo。因此：

- **MCP process 內所有相對路徑（DB_PATH、data dir、axure snapshots）一律以 repo root 解析**（由模組自身位置推導，見 `mcp/helpers.ts` 的 `resolveFromRepoRoot`），與 cwd 無關
- `DB_PATH` env 可省略（預設 repo 的 `data/omni.db`）；MCP 啟動時會在 stderr 印出實際使用的 DB 路徑
- 從其他專案註冊時，**mcp-entry.js 的路徑必須用絕對路徑**：
  ```bash
  claude mcp add --scope user omni-commander -- node "d:/暫存檔/claude code/ai-omni-commander-v5/server/dist/mcp-entry.js"
  ```
- 新增程式碼時**嚴禁**在 MCP process 內用 `process.cwd()` 解析路徑，一律走 `getDataDir()` / `resolveFromRepoRoot()`

### MCP Server Entry Point
- `server/src/mcp-entry.ts` — stdio transport, spawned by Claude Code
- `server/src/mcp/McpServer.ts` — registers all 45 tools + start_task prompt + server instructions
- `server/src/mcp/tools/` — tool implementations (task, document, project, progress, workspace)
- `server/src/mcp/db.ts` — standalone SQLite connection for MCP process
- `server/src/mcp/notify.ts` — HTTP POST to Web Server for real-time UI updates

### MCP Tools (45 total)
| Tool | Purpose |
|------|---------|
| `get_task` | Fetch task details (documents excluded by default; use `includeDocuments=true` to include) |
| `list_pending_tasks` | List tasks with sourceRef. Filters: `taskType`, `label`, `keyword`, `section`, `tag`, `statuses` |
| `get_execution_plan` | Full execution prompt (superpowers + docs + strategy + completion criteria) |
| `update_task_status` | Update task status (in_progress/completed/failed); completed gated by flow gate B |
| `update_task` | Update task fields (whitelist: title/label/taskType/tags/section; status excluded) |
| `next_task` | Recommend next executable task (unblocked deps; bug first, then created_at) + alternatives |
| `get_task_outputs` | Fetch historical report_output/milestone records for a task (context recovery for new sessions) |
| `resume_task` | One-shot context recovery: task core + flow-gate progress + recent outputs + open spec gaps + last verification + dependencies + project notes + nextSteps |
| `add_task_dependency` | Add task dependency (guards: same project, no self-dep, no duplicate, no cycle) |
| `remove_task_dependency` | Remove a task dependency |
| `create_task` | Create task in project |
| `get_documents` | List documents for project/task |
| `read_document` | Read document content |
| `search_documents` | Full-text search across project spec documents (filename + line + ±2-line snippet) |
| `find_axure_snapshot` | Find Axure prototype HTML by function code under `docs/axure-snapshots/{projectId}/` |
| `fetch_svn_specs` | Auto-fetch SA/SD spec documents from SVN by task parent_name |
| `fetch_task_attachments` | Download Asana task attachments (e.g. bug screenshots) |
| `list_projects` | List all projects |
| `get_project` | Get project details with task stats |
| `create_project` | Create new project |
| `update_project` | Update project settings |
| `set_extra_prompt` | Set per-project frontend/backend extra prompt |
| `set_global_config` | Set global config (SVN credentials, Asana PAT) |
| `report_output` | Push execution output to Web UI terminal |
| `report_milestone` | Report progress milestone |
| `report_spec_gap` | Record a spec gap (規格未定義的欄位/API/邏輯) — structured [NEEDS_CLARIFICATION] |
| `list_spec_gaps` | List spec gaps by project/task/status (規格缺少/待補清單) |
| `resolve_spec_gap` | Mark a spec gap resolved (after the user supplies the spec/value) |
| `check_spec_changes` | Compare recorded spec versions (task_spec_versions) against SVN last-modified; changed files auto-create a `spec_changed` spec gap |
| `save_project_note` | Save a project experience note (前人踩坑教訓) — auto-injected into future execution plans |
| `list_project_notes` | List project notes (active by default; `includeArchived=true` for all) |
| `archive_project_note` | Archive a project note (active=0, no physical delete) |
| `get_verification_plan` | Acceptance checklist by task label (backend: findAll/DDL/API smoke/seed SQL; frontend: tsc/Playwright) |
| `report_verification_result` | Report checklist results → agent_outputs + milestone「驗收：X/Y 通過」 |
| `report_verification_evidence` | Upload verification evidence file (screenshot/report) → documents (doc_type=verification) + task binding + milestone |
| `save_task_flow` | Save a flow diagram (spec/plan/code/mindmap) for Flow-Gated Development |
| `report_flow_check` | Report flow gate A/B comparison result |
| `get_task_flows` | List saved flow diagrams for a task |
| `save_sa_flow` | Save Mermaid SA flow diagram to cache |
| `get_skill_gen_plan` | Get prompt for CLAUDE.md/.claude/skills generation |
| `sync_asana_tasks` | Sync Asana tasks into local DB (5-min dedupe; `force=true` to override) |
| `list_asana_projects` | List Asana workspace projects (to find project GID) |
| `get_asana_task_comments` | Fetch Asana task comments (accepts omni UUID or Asana GID) |
| `query_external_db` | Query a project's external database (read-only) |
| `health_check` | Diagnose DB / Web Server / Asana PAT / SVN CLI health |

### MCP Prompts (1)
| Prompt | Purpose |
|--------|---------|
| `start_task` | Standard task workflow: get_execution_plan → in_progress → execute (specs via tools, gaps via report_spec_gap) → report → verification → completed/failed. `taskId` optional (locates via list_pending_tasks/next_task when omitted). |

### Execution Flow
1. Web UI: user clicks Execute → shows MCP instruction modal
2. User pastes instruction into Claude Code
3. Claude Code calls `get_execution_plan(taskId)` → gets full prompt from Web Server API
4. Claude Code uses Agent tool to spawn subagent with the prompt
5. Subagent calls `report_output` / `report_milestone` → Web UI updates in real-time
6. Subagent completes → `update_task_status("completed")` → Web UI reflects

## Architecture Overview

```
┌─ web/ (React + Vite) ───────────┐     WebSocket      ┌─ server/ (Node.js + Express) ──────────┐
│ Zustand stores ◄──────────────── │ ◄──────────────────►│ WebSocketServer ► MessageRouter        │
│ Dashboard / Terminal / Setup     │                     │           │                              │
└──────────────────────────────────┘                     │     MasterOrchestrator                   │
                                                         │     ├─ SpecModeHandler (spec mode)       │
                                                         │     └─ CreativeModeHandler (creative)    │
                                                         │           │                              │
                                                         │     AgentManager                         │
                                                         │     ├─ AgentProcess (Claude CLI child)   │
                                                         │     └─ AgentProcess (Claude CLI child)   │
                                                         │           │                              │
                                                         │     EventBus (agent.* / task.* / etc.)   │
                                                         │     SQLite DB (persistence)              │
                                                         └─────────────────────────────────────────┘
```

## Monorepo Structure

### `shared/` — Shared TypeScript types & constants

| File | Purpose |
|------|---------|
| `agent-types.ts` | `AgentRole`, `AgentStatus`, `Agent`, `AgentSpawnConfig`, `AgentStartConfig`, `AgentRoleConfig`, `AgentOutputEvent` |
| `project-types.ts` | `Project`, `ProjectMode`, `ProjectStatus`, `Workspace`, `DocType` |
| `task-types.ts` | `Task`, `TaskStatus`, `DependencyEdge`, `TaskSummary` |
| `ws-protocol.ts` | All WebSocket message interfaces (client→server and server→client) |
| `event-types.ts` | `BusEvent`, `EventTypes` constants for the internal event bus |
| `claude-stream.ts` | Types for Claude Code `--output-format stream-json` messages |
| `contracts.ts` | API contract and DB schema types |

### `server/` — Backend (Node.js + Express + WebSocket)

| File / Dir | Purpose |
|-----------|---------|
| `index.ts` | Entry point. Creates Express app, HTTP server, WebSocket server, wires EventBus→WS broadcast |
| `config.ts` | Configuration from env vars (`PORT`, `CLAUDE_PATH`, `DB_PATH`, etc.) |

#### `server/src/agent/` — Agent lifecycle
| File | Purpose |
|------|---------|
| `AgentManager.ts` | Manages all agent processes. `startAgent()` creates DB record + spawns `AgentProcess`. Handles completion, errors, markers (`[NEEDS_HUMAN]`, `[ENTITY_CHANGED]`). Auto-completes project when all agents finish. |
| `AgentProcess.ts` | Wraps a single Claude Code CLI child process. `spawn()` launches `claude --print --output-format stream-json --input-format stream-json`. `sendInput()` sends follow-up instructions via stdin. |
| `AgentRoles.ts` | Defines system prompts and allowed tools for each role (`master`, `architect`, `backend`, `frontend`, `devops`, `testing`, `review`). |
| `StreamParser.ts` | Parses newline-delimited JSON from Claude's stdout into typed `ClaudeStreamMessage` events. |

#### `server/src/orchestrator/` — Execution orchestration
| File | Purpose |
|------|---------|
| `MasterOrchestrator.ts` | Routes between Spec and Creative modes. Entry point: `start(projectId)`. |
| `SpecModeHandler.ts` | **Spec mode workflow**: Gets uploaded documents, routes them by type (SA/SD) to workspace agents. Frontend gets SA+SD, Backend gets SD only. Each agent's `cwd` is set to its workspace path so it auto-discovers CLAUDE.md/.claude/ skills. |
| `CreativeModeHandler.ts` | **Creative mode**: Architect agent interviews user, generates SA/SD, then hands off to execution. |
| `TaskDispatcher.ts` | Legacy task queue (used by creative mode). Respects dependency graphs. |
| `DependencyGraph.ts` | Topological sort for task dependencies. |
| `FullstackController.ts` | **Fullstack mode**: 4-phase execution for `fullstack` label tasks. Phase 1: FE+BE parallel agents. Phase 2: wait both. Phase 3a: coordinator analyzes reports. Phase 3b: Playwright integration test (optional). Phase 4: fix agents if needed. Uses `skipTaskStatusUpdate` to prevent subagents from marking task completed. |

#### `server/src/db/` — SQLite persistence
| File | Purpose |
|------|---------|
| `connection.ts` | Creates/opens SQLite DB via `better-sqlite3`. |
| `schema.ts` | Table definitions: `projects`, `agents`, `tasks`, `task_dependencies`, `documents`, `events`, `agent_outputs`, `interventions`. |
| `queries/projects.ts` | CRUD for projects table. |
| `queries/agents.ts` | CRUD for agents table. `getAgentsByProject()` used for completion detection. |
| `queries/tasks.ts` | CRUD for tasks + dependencies. |
| `queries/events.ts` | Event logging, agent output persistence, interventions. `getAgentOutputs()` loads historical terminal output. |

#### `server/src/documents/` — Document handling
| File | Purpose |
|------|---------|
| `DocumentParser.ts` | Saves uploaded files (PDF/text/markdown) to disk. Parses text content. Stores metadata in `documents` table with `doc_type` (SA/SD/other). |

#### `server/src/eventbus/` — Internal event system
| File | Purpose |
|------|---------|
| `EventBus.ts` | Pub/sub with wildcard support (e.g., `agent.*`). |
| `ContextSync.ts` | Manages `.ai_context/` directory for API contracts and DB schema files. |
| `ContractWatcher.ts` | Watches `.ai_context/api-contracts/` for changes, emits contract update events. |

#### `server/src/websocket/` — WebSocket layer
| File | Purpose |
|------|---------|
| `WebSocketServer.ts` | WS server. Handles client connections, message routing, `send()`, `broadcast()`. Supports `initialStateProvider` and `postConnectionHandler`. |
| `MessageRouter.ts` | Registers all WS message handlers. Key handlers: `project.create`, `project.uploadDocument`, `project.startExecution`, `agent.command`, `agent.action`, `project.getState`. On new connection: sends `projects.list` + full state for executing projects + historical agent outputs. |

#### `server/src/review/` — Code review
| File | Purpose |
|------|---------|
| `CodeReviewAgent.ts` | Spawns a read-only review agent after tasks complete. |
| `ReviewTrigger.ts` | Listens for task completion events to trigger reviews. |

### `web/` — Frontend (React + Vite + Tailwind + Zustand)

#### `web/src/stores/` — State management (Zustand)
| File | Purpose |
|------|---------|
| `projectStore.ts` | Projects, agents, tasks, dependencies, interventions. `addOrUpdateAgent()` upsert. |
| `agentStore.ts` | Agent terminal outputs. `appendOutput()` for streaming, `setOutputsBulk()` for historical load. |
| `wsStore.ts` | WebSocket connection state + client reference. |
| `toastStore.ts` | Toast notification queue. |

#### `web/src/hooks/`
| File | Purpose |
|------|---------|
| `useWebSocket.ts` | Connects to WS, dispatches all incoming messages to stores. Handles `projects.list`, `project.state`, `project.agentOutputs`, `agent.output`, `agent.started`, `agent.completed`, `agent.statusChange`, `task.statusChange`, `intervention.request`, `interview.*`, `error`. |

#### `web/src/components/layout/`
| File | Purpose |
|------|---------|
| `AppShell.tsx` | Main layout. View switcher (setup/dashboard/tasks/events). Auto-switches to dashboard when agents start. |
| `Header.tsx` | Top bar with project name, mode badge, status, connection indicator. |
| `Sidebar.tsx` | Navigation, project list, status summary. Clicking a project sends `project.getState` to load its full state. |

#### `web/src/components/dashboard/`
| File | Purpose |
|------|---------|
| `Dashboard.tsx` | Main monitoring view. Project stats (elapsed time, agent count, cost, turns). Agent summary cards. "New Execution" panel for iterative workflow (upload new docs + re-execute). |
| `DualTerminal.tsx` | Multi-terminal view. Groups agents by role. Supports focus mode (click agent card → full-width terminal). |
| `TerminalOutput.tsx` | Single agent terminal. Shows streaming output with syntax coloring by type (text/tool_use/tool_result/error/system). Input field for sending instructions to running agents. |
| `StepTracker.tsx` | Visual step progress (Setup → Planning → Developing → Testing → Completed). |
| `InterventionBell.tsx` | Notification bell for human intervention requests with approval/reject dialog. |

#### `web/src/components/project/`
| File | Purpose |
|------|---------|
| `ProjectSetup.tsx` | Multi-step project creation: mode selection → workspace config → document upload/interview → execution. |
| `ModeSelector.tsx` | Choose Spec or Creative mode. |
| `DocumentUpload.tsx` | Drag-and-drop file upload + paste area. Auto-detects SA/SD from filename. Doc type toggle per file. |
| `FolderPicker.tsx` | Server-side directory browser for selecting workspace paths. |
| `InterviewChat.tsx` | Creative mode interview UI. |

#### `server/src/svn/` — SVN integration
| File | Purpose |
|------|---------|
| `SvnSpecService.ts` | Fetches spec documents from SVN for tasks. Uses root code extraction (e.g., `OV0101` → `OV`) to find the correct SVN folder, then recursively searches for matching .docx/.pdf files. Caches downloads in `data/uploads/{projectId}/`. |

#### `server/src/asana/` — Asana integration
| File | Purpose |
|------|---------|
| `AsanaMcpClient.ts` | MCP-based Asana API client. |
| `AsanaSyncService.ts` | Syncs Asana tasks to local DB. Stores `parent_name` (e.g., `OV0101`) for SVN spec matching. |

### `web/src/components/agents/`
| File | Purpose |
|------|---------|
| `AgentsView.tsx` | Manage agents per project. Add new agents (pre-generates `agentId` client-side, passes to both upload and `agent.add` messages so files land in per-agent folder). Delete confirmation with z-index fix. |
| `ActiveAgents.tsx` | Shows running agents summary. |
| `ReviewBadge.tsx` | Badge indicating review status. |

### `web/src/components/settings/`
| File | Purpose |
|------|---------|
| `GlobalSettings.tsx` | Global settings page: SVN credentials, Asana PAT. |
| `ProjectSettings.tsx` | Per-project settings: SVN spec paths (frontend/backend), Asana project link. |

### `web/src/components/asana/`
| File | Purpose |
|------|---------|
| `AsanaTaskPanel.tsx` | Displays Asana tasks with sync status. |

## Key Flows

### Spec Mode (primary flow)
1. User creates project with workspaces (label + path)
2. User uploads SA/SD documents with type tags
3. User clicks "Start Execution"
4. `SpecModeHandler.execute()`:
   - Routes documents by type: Frontend gets SA+SD, Backend gets SD
   - For each workspace: spawns an agent with `cwd` = workspace path
   - Agent prompt includes document content/PDF paths (DOCX → Markdown path via Read tool)
   - Each agent reads its workspace's CLAUDE.md/.claude/ and follows those skills
5. Agents work autonomously. Output streams via EventBus → WebSocket → frontend terminal
6. When all agents complete, project status auto-transitions to `completed`

### Iterative Execution
After a project completes, the Dashboard shows a "New Execution" panel:
- Upload additional SA/SD documents
- Click "Start Execution" to spawn new agents with ALL documents (old + new)
- Old agent outputs remain visible; new agents get new IDs

### Send Instruction to Running Agent
- Terminal input → `agent.command` WS message → `AgentManager.sendInputToAgent()` → `AgentProcess.sendInput()` → writes JSON to Claude's stdin (requires `--input-format stream-json`)
- Feedback message `[USER INSTRUCTION]` appears in terminal output

### Adding an Agent (AgentsView)
1. Client pre-generates `agentId = crypto.randomUUID()` before any network calls
2. Upload WS message (`project.uploadDocument`) includes `agentId` → files saved to `uploads/{projectId}/{agentId}/`
3. Add WS message (`agent.add`) includes same `agentId` → `createAgent({ id: agentId })`
4. On delete: `deleteByAgent(agentId, projectId)` cleans up only that agent's folder

## Document Handling

### Upload Directory Structure
```
data/uploads/{projectId}/{agentId}/   ← per-agent folder (AgentsView uploads)
data/uploads/{projectId}/             ← project-level (SVN downloads, SpecMode uploads)
```

### DOCX → Markdown Conversion
`.docx` files are converted to `.md` at upload time (both manual upload and SVN fetch):
1. `mammoth.convertToHtml()` with image extraction callback → images saved as `{docId}-img-N.{ext}`
2. `turndown` + `turndown-plugin-gfm` converts HTML → Markdown (strips `<p>` inside `<td>`/`<th>` before conversion for correct GFM tables)
3. Saves `{docId}-{basename}.md` alongside original `.docx`
4. `parsed_text` in DB = `[Document saved at: /abs/path/to/file.md]`
5. `SpecModeHandler.getDocumentContext()` detects this pattern → tells agent to use Read tool

### PDF Handling
PDF file paths are passed in the prompt; agents use Claude's Read tool to read them natively (supports images).

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
```

- Server runs on port 3457 (configurable via `PORT` env var)
- Vite dev server runs on port 5174 and proxies `/omni-ws` and `/api` to server
- SQLite database: `data/omni.db` (persists across restarts)
- Claude CLI path: configurable via `CLAUDE_PATH` env var (default: `claude`)

## Available Skills (`.claude/skills/`)

Superpowers skill framework is installed. Key skills:

| Skill | Purpose |
|-------|---------|
| `brainstorming` | Visual brainstorming companion with local server |
| `dispatching-parallel-agents` | Launch multiple subagents in parallel |
| `executing-plans` | Execute a written plan step by step |
| `finishing-a-development-branch` | Checklist for completing a feature branch |
| `receiving-code-review` | Process and respond to code review feedback |
| `requesting-code-review` | Request structured code review from a subagent |
| `subagent-driven-development` | Spec → implement → review via subagents |
| `systematic-debugging` | Root cause analysis with structured debugging |
| `test-driven-development` | TDD cycle with anti-patterns guide |
| `using-git-worktrees` | Parallel development with git worktrees |
| `verification-before-completion` | Checklist before marking work done |
| `writing-plans` | Create structured implementation plans |
| `writing-skills` | Best practices for writing Claude skills |
| `using-superpowers` | Overview of all available skills |

Use `/brainstorming`, `/systematic-debugging`, etc. to invoke.

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
- **svn CLI ≥ 1.10 required**: SVN 認證改走 `--password-from-stdin`（避免密碼出現在指令列），此旗標需要 svn 1.10+（2018）。舊版 svn 會報 unknown option 且不會走 curl NTLM fallback。
- **Server binds 127.0.0.1 by default**: `HOST` env 可改（如 `0.0.0.0` 供區網存取）。所有內部預設 URL（NOTIFY_URL、Vite proxy、health_check）都用 `127.0.0.1` 而非 `localhost`，避免 Node 18 的 IPv6 解析問題（engines 已要求 Node ≥ 20）。
- **Fullstack task label**: `fullstack` label triggers `FullstackController` (4-phase flow). Requires both `frontendPath` AND `backendPath` on the project. Uses `skipTaskStatusUpdate` flag (persistent `Set` in AgentManager) to prevent subagents from marking task completed. Coordinator and integration-test agents skip auto-resume (one-shot execution). Markers: `[FULLSTACK_FIX]{json}[/FULLSTACK_FIX]` for coordinator, `[INTEGRATION_TEST_RESULT]{json}[/INTEGRATION_TEST_RESULT]` for Playwright agent. Reports: `docs/verification-reports/{taskId}-frontend.md` and `{taskId}-backend.md`.
