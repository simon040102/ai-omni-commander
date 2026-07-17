# AI-OmniCommander

> AI 協作開發指揮中心 — 透過 MCP Server 管理多專案、多 Agent 的規格驅動開發工作。

AI-OmniCommander 是一個 MCP（Model Context Protocol）Server，讓 Claude Code 能管理多個軟體開發專案。它整合 Asana 任務同步、SVN + 本地資料夾規格文件雙來源抓取、規格檢查表與 AI 規格回對閘門、subagent 派遣，以及可選的 Web UI 即時監控。

## 特色

- **一次註冊、到處可用** — user-scope 註冊後，在任何專案資料夾開 Claude Code 都能使用；工具清單與使用規則由 MCP 協定連線時自動注入，不寫任何 CLAUDE.md
- **多專案管理** — 每個專案有獨立 workspace、規格來源、Extra Prompt 設定
- **Asana 整合** — PAT token 直打 REST API 同步任務，同步後自動偵測規格異動
- **規格雙來源** — SVN 自動抓取 + 本地規格資料夾（specFolders，含安全 git pull）
- **規格治理** — 規格檢查表、規格缺口記錄、程式預檢 + 獨立 AI 回對閘門（missing=0 才能標 completed）
- **自動判軌** — bug 無規格走 light 軌（輕量修復），規格驅動走 full 軌（Flow-Gated 流程圖閘門）
- **Web UI 監控（可選）** — 即時 agent 輸出、任務狀態、規格治理面板

## 架構

```
Orchestrator（你，Claude Code — 任何專案資料夾）
 ├─ OmniCommander MCP Server（stdio，自動 spawn）
 │   ├─ SQLite DB — 專案、任務、文件、檢查表（路徑以本 repo 解析，與 cwd 無關）
 │   ├─ Asana REST API — 任務同步
 │   └─ SVN + 本地規格資料夾 — 規格文件抓取
 │
 ├─ Agent tool → subagent
 │   ├─ 前端 subagent（cwd = frontendPath）
 │   ├─ 後端 subagent（cwd = backendPath）
 │   └─ 讀 workspace CLAUDE.md + .claude/skills/
 │
 └─ Web UI（可選，localhost:5174）— Web Server (:3457) 有跑才即時更新，沒跑工具照常可用
```

## Quick Start

### 前置需求

- Node.js >= 20
- pnpm
- Claude Code CLI（已登入）
- SVN CLI >= 1.10（建議 SlikSVN）
- Git

### 安裝

```bash
git clone https://github.com/simon040102/ai-omni-commander.git
cd ai-omni-commander
git checkout OmniCommander_MCP
pnpm install
pnpm build
```

### 跨專案註冊（推薦）

一次註冊，之後在**任何專案資料夾**開 Claude Code 都能用（路徑換成你的 clone 位置，必須用絕對路徑）：

```bash
claude mcp add --scope user omni-commander -- node "d:/暫存檔/claude code/ai-omni-commander-v5/server/dist/mcp-entry.js"
```

- `DB_PATH` 可省略 — MCP 自動解析到本 repo 的 `data/omni.db`，與啟動時的 cwd 無關
- 工具清單與 7 條使用規則由 MCP 協定連線時自動注入，**不需要改任何 CLAUDE.md**
- Web UI 即時更新需 Web Server (:3457) 在跑；沒跑時所有工具照常可用

### 啟動

```bash
# 在任何專案資料夾直接開 Claude Code，MCP Server 自動啟動
claude
```

或搭配 Web UI 監控：
```bash
pnpm dev    # Server:3457 + Web:5174（在本 repo 目錄執行）
claude      # 另開終端，任何資料夾皆可
```

### 首次設定

在 Claude Code 裡對話即可完成（Asana PAT / SVN 帳密用 `set_global_config` 工具設定，也可用 Web UI 的 Global Settings）：

```
你：有哪些專案                          → 確認 MCP Server 正常（異常時先跑 health_check）
你：幫我建一個專案叫「我的專案」，前端在 D:\fork\my-ui，後端在 D:\fork\my-api
你：幫我設定 Asana PAT，token 是 xxx    → set_global_config('asana.pat', ...)
你：幫我設定 SVN 帳密                   → set_global_config('svn.username' / 'svn.password')
你：幫我綁定 Asana，project GID 是 1234567890
```

## 操作流程

```
列專案 → 同步 Asana → 選任務 → 自動判軌（bug 無規格→light / 規格驅動→full）
→ 抓規格（SVN + 本地規格資料夾雙來源）→ 抽規格檢查表（checklist）
→ [full 軌] Flow-Gated 開工閘（規格理解確認，原閘門 A）/ 完工閘（實作邏輯對齊，原閘門 B）→ 開發
→ 程式預檢（run_spec_compliance）→ AI 回對（獨立 agent 逐項驗證，missing=0）
→ 驗收（get_verification_plan + 證據上傳）→ completed（閘門放行）
```

配套機制：規格缺口記錄（`report_spec_gap`）、專案經驗筆記（自動注入 execution plan）、規格異動偵測（`check_spec_changes`，Asana 同步後自動跑）、SA/SD 一致性檢查（`check_spec_consistency`）、`resume_task` 接手舊任務、`next_task` 推薦。

## MCP 工具（54 個 + start_task prompt）

| 分組 | 工具 |
|------|------|
| 任務 / 執行計畫 | `get_execution_plan`, `list_pending_tasks`, `get_task`, `update_task_status`, `update_task`, `next_task`, `resume_task`, `get_task_outputs`, `save_task_dispatch`, `create_task`, `add_task_dependency`, `remove_task_dependency` |
| 文件 / 規格 | `fetch_svn_specs`, `get_documents`, `read_document`, `search_documents`, `find_axure_snapshot`, `fetch_task_attachments` |
| 規格缺口 | `report_spec_gap`, `list_spec_gaps`, `resolve_spec_gap`, `check_spec_changes`, `check_spec_consistency` |
| 規格回對 | `save_spec_checklist`, `get_spec_checklist`, `waive_checklist_item`, `run_spec_compliance`, `get_compliance_review_plan`, `save_compliance_review` |
| 驗收 | `get_verification_plan`, `get_test_baseline_plan`, `report_verification_result`, `report_verification_evidence` |
| 專案筆記 | `save_project_note`, `list_project_notes`, `archive_project_note` |
| Flow-Gated 流程圖 | `save_task_flow`, `report_flow_check`, `get_task_flows`, `save_sa_flow` |
| Asana | `sync_asana_tasks`, `list_asana_projects`, `get_asana_task_comments` |
| 進度回報 | `report_output`, `report_milestone` |
| 專案 / 設定 / 診斷 | `list_projects`, `get_project`, `create_project`, `update_project`, `set_extra_prompt`, `set_global_config`, `get_skill_gen_plan`, `query_external_db`, `health_check` |

每個工具的用途一句話說明見 [`docs/功能說明.md`](docs/功能說明.md)，逐步操作見 [`docs/操作手冊.md`](docs/操作手冊.md)，架構細節見 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 專案結構

```
ai-omni-commander/
├── server/              # Backend + MCP Server
│   └── src/
│       ├── mcp-entry.ts # MCP 進入點（stdio）
│       ├── mcp/         # McpServer + tools/ 工具實作
│       ├── asana/       # Asana 整合
│       ├── svn/         # SVN 整合
│       ├── documents/   # 文件處理（docx→md、specFolders）
│       └── db/          # SQLite
├── web/                 # Web UI（React + Vite）
├── shared/              # 共用型別
├── docs/                # 操作手冊、功能說明、axure-snapshots
├── .mcp.json            # 本 repo 的 MCP Server 設定
├── CLAUDE.md            # Orchestrator 行為規則
└── data/                # SQLite DB + 上傳文件（gitignore）
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| MCP Server | Node.js, @modelcontextprotocol/sdk, better-sqlite3 |
| Web UI | React 19, Vite 6, Tailwind CSS, Zustand |
| Backend | Express, WebSocket |
| AI | Claude Code CLI + Agent tool |
| Integrations | Asana REST API, SVN CLI, 本地規格資料夾（git pull） |

## License

MIT
