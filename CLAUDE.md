# AI-OmniCommander

A dual-mode AI collaborative development system. Originally orchestrated multiple Claude Code CLI instances (agents) directly; now operates as an **MCP Server** that provides task management and execution context to external Claude Code sessions.

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

### MCP Server Entry Point
- `server/src/mcp-entry.ts` — stdio transport, spawned by Claude Code
- `server/src/mcp/McpServer.ts` — registers all 14 tools
- `server/src/mcp/tools/` — tool implementations (task, document, project, progress, workspace)
- `server/src/mcp/db.ts` — standalone SQLite connection for MCP process
- `server/src/mcp/notify.ts` — HTTP POST to Web Server for real-time UI updates

### MCP Tools (14 total)
| Tool | Purpose |
|------|---------|
| `get_task` | Fetch task details with project context |
| `list_pending_tasks` | List pending/queued tasks |
| `get_execution_plan` | Full execution prompt (superpowers + docs + strategy + completion criteria) |
| `update_task_status` | Update task status (in_progress/completed/failed) |
| `get_documents` | List documents for project/task |
| `read_document` | Read document content |
| `list_projects` | List all projects |
| `get_project` | Get project details with task stats |
| `create_project` | Create new project |
| `create_task` | Create task in project |
| `report_output` | Push execution output to Web UI terminal |
| `report_milestone` | Report progress milestone |
| `get_skill_gen_plan` | Get prompt for CLAUDE.md/.claude/skills generation |
| `save_sa_flow` | Save Mermaid SA flow diagram to cache |

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

## Key Flows

### Spec Mode (primary flow)
1. User creates project with workspaces (label + path)
2. User uploads SA/SD documents with type tags
3. User clicks "Start Execution"
4. `SpecModeHandler.execute()`:
   - Routes documents by type: Frontend gets SA+SD, Backend gets SD
   - For each workspace: spawns an agent with `cwd` = workspace path
   - Agent prompt includes document content/PDF paths
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

## Development

```bash
# Install dependencies
pnpm install

# Start server (with auto-rebuild)
cd server && pnpm dev

# Start frontend (Vite dev server with HMR)
cd web && pnpm dev

# TypeScript check
npx tsc --build shared/tsconfig.json server/tsconfig.json web/tsconfig.json
```

- Server runs on port 3457 (configurable via `PORT` env var)
- Vite dev server runs on port 5174 and proxies `/omni-ws` and `/api` to server
- SQLite database: `data/omni.db` (persists across restarts)
- Claude CLI path: configurable via `CLAUDE_PATH` env var (default: `claude`)

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
- **Fullstack task label**: `fullstack` label triggers `FullstackController` (4-phase flow). Requires both `frontendPath` AND `backendPath` on the project. Uses `skipTaskStatusUpdate` flag (persistent `Set` in AgentManager) to prevent subagents from marking task completed. Coordinator and integration-test agents skip auto-resume (one-shot execution). Markers: `[FULLSTACK_FIX]{json}[/FULLSTACK_FIX]` for coordinator, `[INTEGRATION_TEST_RESULT]{json}[/INTEGRATION_TEST_RESULT]` for Playwright agent. Reports: `docs/verification-reports/{taskId}-frontend.md` and `{taskId}-backend.md`.
