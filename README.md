# AI-OmniCommander

> AI 協作開發指揮中心 — 透過 MCP Server 管理多專案、多 Agent 的軟體開發工作。

AI-OmniCommander 是一個 MCP（Model Context Protocol）Server，讓 Claude Code 能管理多個軟體開發專案。它整合了 Asana 任務同步、SVN 規格文件自動抓取、subagent 派遣，以及可選的 Web UI 即時監控。

## 特色

- **MCP 模式** — 不需要開 Web Server，Claude Code 啟動時自動 spawn MCP Server
- **多專案管理** — 同時管理多個前後端專案，每個專案有獨立的 workspace 和設定
- **Asana 整合** — 直接用 PAT token 同步任務，不依賴 Web Server
- **SVN 規格自動抓取** — 從 parent_name 提取功能代碼，自動搜尋 SVN 下載 SA/SD 文件
- **Subagent 派遣** — 用 Agent tool 派 subagent 到各專案 workspace，subagent 自動讀取 CLAUDE.md 和 skills
- **品質規範** — 規格遵循、效能分析、安全檢查、orchestrator 驗證
- **Web UI 監控（可選）** — 即時 agent 輸出、任務狀態、里程碑追蹤

## 架構

```
Orchestrator（你，Claude Code）
 ├─ OmniCommander MCP Server（stdio，自動 spawn）
 │   ├─ SQLite DB — 專案、任務、文件
 │   ├─ Asana REST API — 任務同步
 │   └─ SVN — 規格文件抓取
 │
 ├─ Agent tool → subagent
 │   ├─ 前端 subagent（cwd = frontendPath）
 │   ├─ 後端 subagent（cwd = backendPath）
 │   └─ 讀 workspace CLAUDE.md + .claude/skills/
 │
 └─ Web UI（可選，localhost:5174）
```

## Quick Start

### 前置需求

- Node.js >= 20
- pnpm
- Claude Code CLI（已登入）
- SVN CLI（建議 SlikSVN）
- Git

### 安裝

```bash
git clone https://github.com/simon040102/ai-omni-commander.git
cd ai-omni-commander
git checkout OmniCommander_MCP
pnpm install
pnpm build
```

### 啟動

```bash
# 直接開 Claude Code，MCP Server 自動啟動
claude
```

或搭配 Web UI：
```bash
pnpm dev    # Server:3457 + Web:5174
claude      # 另開終端
```

### 首次設定

在 Claude Code 裡對話：

```
你：有哪些專案
→ 確認 MCP Server 正常

你：幫我建一個專案叫「我的專案」，前端在 D:\fork\my-ui，後端在 D:\fork\my-api
→ 建立專案

你：幫我綁定 Asana，project GID 是 1234567890
→ 綁定 Asana（可選）
```

Asana PAT 和 SVN 帳密透過 Web UI 的 Global Settings 設定，或直接寫入 DB：
```bash
cd server && node -e "
const Database = require('better-sqlite3');
const db = new Database('../data/omni.db');
db.prepare(\"INSERT OR REPLACE INTO global_config (key, value) VALUES ('asana.pat', 'YOUR_TOKEN')\").run();
db.prepare(\"INSERT OR REPLACE INTO global_config (key, value) VALUES ('svn.username', 'YOUR_USER')\").run();
db.prepare(\"INSERT OR REPLACE INTO global_config (key, value) VALUES ('svn.password', 'YOUR_PASS')\").run();
"
```

## MCP 工具

| 工具 | 用途 |
|------|------|
| `list_projects` / `create_project` | 專案管理 |
| `sync_asana_tasks` | Asana 任務同步（直打 REST API） |
| `list_pending_tasks` / `create_task` | 任務管理 |
| `fetch_svn_specs` | SVN 規格文件自動抓取（含 hash 快取） |
| `fetch_task_attachments` | Asana 附件下載 |
| `update_task_status` | 任務狀態更新 |
| `report_output` / `report_milestone` | 進度回報到 Web UI |

## 操作流程

```
列出專案 → 同步 Asana → 選任務 → 抓規格 → 確認 → 派 subagent → 驗證
```

1. `list_projects()` → 列出專案
2. `sync_asana_tasks(projectId)` → 同步任務
3. 使用者選任務，問前端/後端/都做
4. `fetch_svn_specs(projectId, taskId)` → 自動抓 SA/SD
5. 確認規格齊全，使用者說「執行」
6. Agent tool 派 subagent（帶規格路徑 + extra prompt + 品質規範）
7. Subagent 完成後 orchestrator 驗證

詳細操作說明見 [`docs/操作手冊.md`](docs/操作手冊.md)。

## 專案結構

```
ai-omni-commander/
├── server/              # Backend + MCP Server
│   └── src/
│       ├── mcp/         # MCP Server（stdio transport）
│       │   ├── mcp-entry.ts    # 進入點
│       │   └── tools/          # 工具實作
│       ├── agent/       # Agent 管理
│       ├── asana/       # Asana 整合
│       ├── svn/         # SVN 整合
│       └── db/          # SQLite
├── web/                 # Web UI（React + Vite）
├── shared/              # 共用型別
├── docs/                # 操作手冊
├── .mcp.json            # MCP Server 設定
├── CLAUDE.md            # Orchestrator 規則
└── data/                # SQLite DB + 上傳文件
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| MCP Server | Node.js, @modelcontextprotocol/sdk, better-sqlite3 |
| Web UI | React 19, Vite 6, Tailwind CSS, Zustand |
| Backend | Express, WebSocket |
| AI | Claude Code CLI + Agent tool |
| Integrations | Asana REST API, SVN CLI |

## License

MIT
