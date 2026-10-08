# AI-OmniCommander — Architecture Reference

> **本檔為架構參考文件，行為規則一律以 CLAUDE.md 為準。**
> 本機 spawn 派工（PTY／SDK／`claude -p`）已整套移除（2026-10）；任務一律由外部 Claude Code session 經 MCP 執行。

## MCP Architecture (v5 — current)

```
┌─ Web UI (React + Vite :5174) ────┐
│  Project mgmt / Task mgmt         │
│  Document upload / Spec governance│
│        │ WebSocket                │
│        ▼                          │
├─ Web Server (Express :3457) ─────┤     ┌─ MCP Server (stdio) ───────┐
│  REST API + WebSocket             │     │  Spawned by Claude Code     │
│  /api/execution-plan/:taskId  ◄───╋─────╋── get_execution_plan        │
│  /api/mcp-notify (POST)       ◄───╋─────╋── on each MCP write op      │
│        │                          │     │        │                    │
│   SQLite (data/omni.db) ◄─────────╋─────╋── SQLite (same omni.db)    │
└───────────────────────────────────┘     └─────────────────────────────┘

Claude Code / Claude Desktop
  ├─ .mcp.json → spawns MCP Server process
  ├─ get_execution_plan(taskId) → full prompt (superpowers, specs, rulings, strategy)
  ├─ Agent tool → subagent in workspace executes the plan
  ├─ report_output() / report_milestone() → Web UI updates via /api/mcp-notify
  └─ update_task_status() → completion gates → task complete
```

**`get_execution_plan` 依賴 Web Server**：MCP process 不自己組 prompt，而是 HTTP 呼叫 Web Server 的
`/api/execution-plan/:taskId`（→ `ExecutionPipeline.buildExecutionPlan`／`preparePromptForRole` → `assembleContext`
→ `build*Section`／`buildTaskPrompt`）。Web Server 沒開，`get_execution_plan` 就會失敗。

### MCP Server
| File / Dir | Purpose |
|------|---------|
| `server/src/mcp-entry.ts` | stdio transport entry, spawned by Claude Code |
| `server/src/mcp/McpServer.ts` | Registers all 58 tools + `start_task` prompt + server instructions |
| `server/src/mcp/tools/` | Tool implementations（task／document／project／progress／compliance／spec-gap／flow／verification／insight／db…） |
| `server/src/mcp/db.ts` | Standalone SQLite connection for the MCP process |
| `server/src/mcp/notify.ts` | HTTP POST to Web Server for real-time UI updates |
| `server/src/mcp/helpers.ts` | Repo-root path resolution（**MCP 內嚴禁 `process.cwd()`**）、`ensureMcpAgent`（合成 `mcp-{taskId}` agent） |
| `server/src/mcp/flow-gate.ts`、`compliance-engine.ts`、`evidence-validator.ts`、`waiver-policy.ts` | 完成閘門與規格回對的純邏輯 |
| `server/src/mcp/harness-analysis.ts`、`attention.ts` | 自我觀察（`analyze_harness`／`get_attention_summary`）純函式 |

### Execution Flow
1. Web UI: user clicks Execute → shows MCP instruction modal
2. User pastes instruction into Claude Code
3. Claude Code calls `get_execution_plan(taskId)` → full prompt from Web Server API
4. Claude Code uses Agent tool to spawn a subagent with the prompt
5. Subagent calls `report_output` / `report_milestone` → Web UI updates in real time
6. `update_task_status("completed")` → completion gates（見 CLAUDE.md）→ Web UI reflects

## Monorepo Structure

### `shared/` — Shared TypeScript types & constants
| File | Purpose |
|------|---------|
| `agent-types.ts` | `AgentRole`, `AgentStatus`, `Agent` |
| `project-types.ts` | `Project`, `ProjectMode`, `ProjectStatus`, `Workspace`, `DocType` |
| `task-types.ts` | `Task`, `TaskStatus`, `DependencyEdge`, `TaskSummary` |
| `ws-protocol.ts` | WebSocket message interfaces (client→server and server→client) |
| `event-types.ts` | `BusEvent`, `EventTypes` constants for the internal event bus |

### `server/` — Backend (Node.js + Express + WebSocket)
| File / Dir | Purpose |
|-----------|---------|
| `index.ts` | Entry point. Express app, HTTP/WS server, REST routes, EventBus→WS bridge（只剩 `agent.*`）, 啟動清理、DB 備份與每日推送排程 |
| `config.ts` | Configuration from env vars (`PORT`, `HOST`, `DB_PATH`, `ASANA_PAT`…) |

#### `server/src/agent/`
| File | Purpose |
|------|---------|
| `AgentManager.ts` | Agent 狀態維護（只改 DB、發事件，不碰程序）：`recoverRunningAgents()` 啟動時把殘留的非 MCP agent 標 error、任務退回 pending（`mcp-*` 不動）；`stopAgent()` 供 Web UI 停止鈕。 |
| `ModelRouter.ts` | 依任務特性建議模型（execution plan 回傳的 `model`）。 |

#### `server/src/orchestrator/`
| File | Purpose |
|------|---------|
| `ExecutionPipeline.ts` | **派工 prompt 的真相來源**：`buildExecutionPlan`／`preparePromptForRole` → `assembleContext`（規格、裁決、筆記、Axure、單元測試與驗收規範…）。自動撈規格（SVN＋specFolders）。 |
| `SpecModeHandler.ts` | 文件上傳（`uploadDocument`）與 `DocumentParser` 的持有者。 |
| `TaskClassifier.ts` | Asana 同步時判 label／taskType（包 `utils/taskClassification`）。 |

#### `server/src/db/` — SQLite persistence
| File | Purpose |
|------|---------|
| `connection.ts` | Creates/opens SQLite DB via `better-sqlite3`. |
| `schema.ts` | Table definitions + migrations（v1…v22）。 |
| `queries/*.ts` | CRUD per table（projects／agents／tasks／events／documents…）。 |

#### `server/src/documents/` — Document handling
| File | Purpose |
|------|---------|
| `DocumentParser.ts` | Saves uploaded files (PDF/text/markdown/docx→md) to disk; metadata in `documents` with `doc_type` (SA/SD/other). |
| `SpecFetcher.ts` | Fetches `task.specUrl` content. |
| `FolderSpecSource.ts` | 本地資料夾規格來源（git pull 安全鐵律見 CLAUDE.md）。 |
| `SaFlowAnalyzer.ts` | SA 流程圖快取目錄的讀取（`getFlowPath`／`listProjectFlows`）；圖由 MCP `save_task_flow` 寫入。 |

#### `server/src/eventbus/`
| File | Purpose |
|------|---------|
| `EventBus.ts` | Pub/sub with wildcard support (e.g., `agent.*`)；目前發送者只有 AgentManager。 |

#### `server/src/websocket/` — WebSocket layer
| File | Purpose |
|------|---------|
| `WebSocketServer.ts` | WS server: connections, `send()`, `broadcast()`, `initialStateProvider`／`postConnectionHandler`. |
| `MessageRouter.ts` | WS message handlers：project.create／update／delete／getState／uploadDocument、task.*、agent.action（stop）、svn.*、config.*、asana.*。 |

#### `server/src/svn/` — SVN integration
| File | Purpose |
|------|---------|
| `SvnSpecService.ts` | Fetches spec documents from SVN for tasks. Root code extraction (e.g., `OV0101` → `OV`) to find the SVN folder, then recursively searches for matching .docx/.pdf. Also hosts `fetchFolderSpecsForTask` (delegates to FolderSpecSource). |

> 本地資料夾規格來源（`specFolders`）的設定格式與 git pull 安全鐵律屬**行為規則**，見 CLAUDE.md「本地資料夾規格來源」一節。

#### `server/src/asana/` — Asana integration
| File | Purpose |
|------|---------|
| `AsanaMcpClient.ts` | Asana API client（名稱歷史遺留：實作為直接呼叫 Asana REST API，並非 MCP client）. |
| `AsanaSyncService.ts` | Syncs Asana tasks to local DB. Stores `parent_name` (e.g., `OV0101`) for SVN spec matching. |

### `web/` — Frontend (React + Vite + Tailwind + Zustand)

#### `web/src/stores/` — State management (Zustand)
| File | Purpose |
|------|---------|
| `projectStore.ts` | Projects, tasks, agents, dependencies, documents, project activity. |
| `wsStore.ts` | WebSocket connection state + client reference. |
| `toastStore.ts` / `themeStore.ts` / `asanaStore.ts` / `schemaStore.ts` | Toasts, theme, Asana UI state, DB schema explorer. |

#### `web/src/hooks/`
| File | Purpose |
|------|---------|
| `useWebSocket.ts` | Connects to WS and dispatches messages to `wsHandlers/*`（project／task／agent／asana／misc）. Unknown types are only logged. |

#### `web/src/components/`
| Dir | Purpose |
|-----|---------|
| `layout/` | `AppShell`（view switcher；舊 session 存的 agents／events 會導回 tasks）、`Header`、`Sidebar` |
| `dashboard/` | `Dashboard`、`TaskList`、規格治理（`SpecGovernanceView`／`SpecGapsPanel`／`SpecCompliancePanel`／`ProjectNotesPanel`）、`SaFlowModal`、Asana 匯入與同步設定、`SvnBrowser` |
| `task/` | `NewTaskView`（Quick Run：產生 MCP 指令；Spec 模式：建專案＋上傳文件＋產生 MCP 指令） |
| `project/`、`settings/`、`mockup/`、`db/`、`home/`、`ui/` | 專案建立、全域／專案設定、Axure mockup、DB 瀏覽、首頁、共用元件 |

## Document Handling

### Upload Directory Structure
```
data/uploads/{projectId}/                              ← project-level (SVN downloads, Spec mode uploads)
data/uploads/{projectId}/{code}_{taskId8}[/{runId}]/   ← task-scoped attachments
```

### DOCX → Markdown Conversion
`.docx` files are converted to `.md` at upload time (both manual upload and SVN fetch):
1. `mammoth.convertToHtml()` with image extraction callback → images saved as `{docId}-img-N.{ext}`
2. `turndown` + `turndown-plugin-gfm` converts HTML → Markdown (strips `<p>` inside `<td>`/`<th>` before conversion for correct GFM tables)
3. Saves `{docId}-{basename}.md` alongside original `.docx`
4. `parsed_text` in DB = `[Document saved at: /abs/path/to/file.md]` — agents read the `.md` via the Read tool

### PDF Handling
PDF file paths are passed in the prompt; agents use Claude's Read tool to read them natively (supports images).

## Available Skills

本 repo 的 `.claude/skills/`：

| Skill | Purpose |
|-------|---------|
| `crawl-axure-snapshots` | Two-phase Axure crawler（座標 JSON → styled HTML） |
| `execute-project-task` | 互動式任務執行流程（列任務 → 收集規格 → 派 subagent） |
| `spec-compliance-review`、`spec-consistency-check`、`verifying-end-to-end` | 可獨立分享的規格回對／規格一致性／端到端驗收 skill |

Superpowers 相關內容在 repo 內的實際位置：

- `server/src/skills/superpowers/` — 注入 subagent prompt 用的方法論片段（`brainstorm.md` / `debugging.md` / `tdd.md`，由 `loadSuperpowersPrompt()` 載入）
- `docs/superpowers/` — 設計文件（本地產物，`docs/*` 被 .gitignore 排除，fresh clone 不會有）

`/brainstorming`、`/systematic-debugging` 等完整 superpowers skill 來自使用者環境安裝的 superpowers plugin，不在本 repo 版控內。
