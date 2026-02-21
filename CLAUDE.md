# AI-OmniCommander

A dual-mode AI collaborative development system that orchestrates multiple Claude Code CLI instances (agents) to work on software projects simultaneously.

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

- Server runs on port 3456 (configurable via `PORT` env var)
- Vite dev server runs on port 5173 and proxies `/omni-ws` and `/api` to server
- SQLite database: `data/omni.db` (persists across restarts)
- Claude CLI path: configurable via `CLAUDE_PATH` env var (default: `claude`)

## Important Implementation Details

- **stdin prompt delivery**: Initial prompts are written to Claude's stdin (not CLI args) to avoid ARG_MAX limits. With `--input-format stream-json`, the prompt is sent as `{"type":"user","content":"..."}`.
- **useStreamInput**: All agents use `--input-format stream-json` to keep stdin open for follow-up instructions.
- **PDF handling**: PDF file paths are passed in the prompt text; agents use Claude's Read tool to read them natively.
- **Project skills**: Each agent's `cwd` is set to its workspace → Claude Code auto-discovers CLAUDE.md and `.claude/settings.json`.
- **EventBus wildcard**: `agent.*` events are broadcast directly as WS messages (e.g., `agent.started`, `agent.output`), NOT wrapped in `eventbus.notification`.
- **SQLite datetime**: `datetime('now')` returns UTC without 'Z' suffix. Frontend appends 'Z' before parsing.
