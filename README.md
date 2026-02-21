# AI-OmniCommander

> Multi-agent AI development orchestrator — let multiple Claude Code instances collaborate on your project simultaneously.

AI-OmniCommander is a web-based control center that spawns and coordinates multiple [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI agents to work on different parts of a software project at the same time. Each agent operates in its own workspace, follows project-specific skills and conventions, and reports progress back to a real-time dashboard.

## Features

- **Dual Mode**
  - **Spec Mode** — Upload SA/SD specification documents (PDF, Markdown, text), then let agents decompose and implement
  - **Creative Mode** — An architect agent interviews you to understand requirements, generates specs, then orchestrates implementation

- **Multi-Workspace Agents** — Assign separate folders (e.g. `frontend/`, `backend/`) each with their own CLAUDE.md / `.claude/` skills; agents follow workspace-level conventions automatically

- **Smart Document Routing** — SA documents go to frontend agents; SD documents go to both frontend and backend agents

- **Plan-Before-Code** — Agents are required to produce a detailed implementation plan (task breakdown, tech decisions, file list) before writing any code

- **Real-Time Dashboard** — Live streaming terminal output for every agent, agent status cards, cost tracking, elapsed time, step progress

- **Send Instructions** — Type follow-up instructions to any running agent mid-execution via the terminal input

- **Human Intervention** — Agents can request human help with `[NEEDS_HUMAN]`; you get a notification bell and approval dialog

- **Code Review Agent** — Optional read-only review agent that checks code quality after tasks complete

- **Iterative Workflow** — After agents finish, upload new documents and start a new execution round on the same project

- **Persistence** — All projects, agents, outputs, and documents are stored in SQLite; survive server restarts

## Architecture

```
                    ┌──────────────────────────────┐
                    │   Web Dashboard (React)       │
                    │   Vite + Tailwind + Zustand   │
                    └──────────────┬───────────────┘
                                   │ WebSocket
                    ┌──────────────▼───────────────┐
                    │   Server (Node.js + Express)  │
                    │                               │
                    │   MasterOrchestrator          │
                    │   ├─ SpecModeHandler          │
                    │   └─ CreativeModeHandler      │
                    │                               │
                    │   AgentManager                │
                    │   ├─ AgentProcess (claude CLI) │
                    │   ├─ AgentProcess (claude CLI) │
                    │   └─ ...                      │
                    │                               │
                    │   EventBus ──► WS Broadcast   │
                    │   SQLite DB (persistence)     │
                    └───────────────────────────────┘
```

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **pnpm** (or npm)
- **Claude Code CLI** installed and authenticated (`claude` command available in PATH)

### Install & Run

```bash
# Clone the repo
git clone https://github.com/your-org/ai-omni-commander.git
cd ai-omni-commander

# Install dependencies
pnpm install

# Start both server and frontend in one command
pnpm dev
```

This starts:
- **Server** on `http://localhost:3456` (API + WebSocket)
- **Frontend** on `http://localhost:5173` (Vite dev server with HMR, proxies to server)

Open `http://localhost:5173` in your browser.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |
| `CLAUDE_PATH` | `claude` | Path to Claude Code CLI binary |
| `DB_PATH` | `data/omni.db` | SQLite database file path |
| `AI_CONTEXT_DIR` | `.ai_context` | Directory for shared API contracts |
| `MAX_AGENT_BUDGET_USD` | _(none)_ | Max budget per agent in USD |

## Usage

### 1. Create a Project

Click **New Project** in the sidebar:

1. **Choose mode** — Spec Mode (upload documents) or Creative Mode (interview)
2. **Configure workspaces** — Add workspace entries with a label (e.g. `frontend`, `backend`) and folder path
3. **Code Review** — Optionally enable the review agent and choose which workspace skills it follows

### 2. Upload Spec Documents (Spec Mode)

- Drag & drop or paste PDF / Markdown / text files
- Each file is auto-tagged as **SA** (System Analysis) or **SD** (System Design) based on filename
- You can manually toggle the type per file
- Document routing:
  - **Frontend agent** receives SA + SD
  - **Backend agent** receives SD only

### 3. Start Execution

Click **Start Execution**. For each workspace, an agent is spawned that:

1. Reads the workspace's `CLAUDE.md` and `.claude/` skills
2. Reads the assigned spec documents (PDF via Claude's native Read tool)
3. Produces a detailed **implementation plan** with task breakdown
4. Executes the plan step by step

### 4. Monitor Progress

The **Dashboard** shows:

- **Agent cards** — Role, status (running/stopped/error), cost, turns, tool calls
- **Terminal output** — Live streaming output per agent; click a card to focus
- **Step tracker** — Setup → Planning → Developing → Testing → Completed
- **Intervention bell** — Notification when an agent needs human input

### 5. Send Instructions

While agents are running, type in the terminal input field to send follow-up instructions to a specific agent. The instruction is delivered via stdin and appears as `[USER INSTRUCTION]` in the output.

### 6. Iterate

After all agents finish:

1. Click **New Execution** on the dashboard
2. Upload additional spec documents if needed
3. Click **Start Execution** — new agents are spawned with all documents (old + new)

## Project Structure

```
ai-omni-commander/
├── shared/              # Shared TypeScript types & constants
│   └── src/
│       ├── agent-types.ts
│       ├── project-types.ts
│       ├── task-types.ts
│       ├── ws-protocol.ts
│       ├── event-types.ts
│       ├── claude-stream.ts
│       └── contracts.ts
│
├── server/              # Backend (Node.js + Express + WS)
│   └── src/
│       ├── index.ts                 # Entry point
│       ├── config.ts                # Env config
│       ├── agent/                   # Agent lifecycle
│       │   ├── AgentManager.ts      # Process management
│       │   ├── AgentProcess.ts      # Claude CLI wrapper
│       │   ├── AgentRoles.ts        # Role definitions
│       │   └── StreamParser.ts      # JSON stream parser
│       ├── orchestrator/            # Execution orchestration
│       │   ├── MasterOrchestrator.ts
│       │   ├── SpecModeHandler.ts   # Document routing + agent spawning
│       │   ├── CreativeModeHandler.ts
│       │   ├── TaskDispatcher.ts
│       │   └── DependencyGraph.ts
│       ├── db/                      # SQLite persistence
│       │   ├── schema.ts
│       │   ├── connection.ts
│       │   └── queries/
│       ├── documents/               # File upload + parsing
│       │   └── DocumentParser.ts
│       ├── eventbus/                # Internal pub/sub
│       │   ├── EventBus.ts
│       │   ├── ContextSync.ts
│       │   └── ContractWatcher.ts
│       ├── websocket/               # WebSocket layer
│       │   ├── WebSocketServer.ts
│       │   └── MessageRouter.ts
│       └── review/                  # Code review agent
│
├── web/                 # Frontend (React + Vite + Tailwind)
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       ├── hooks/
│       │   └── useWebSocket.ts      # WS connection + message dispatch
│       ├── stores/                  # Zustand state management
│       │   ├── projectStore.ts
│       │   ├── agentStore.ts
│       │   ├── wsStore.ts
│       │   └── toastStore.ts
│       └── components/
│           ├── layout/              # AppShell, Header, Sidebar
│           ├── dashboard/           # Dashboard, Terminal, StepTracker
│           ├── project/             # Setup, DocumentUpload, FolderPicker
│           ├── tasks/               # TaskBoard, TaskCard
│           ├── events/              # EventLog
│           └── ui/                  # ToastContainer
│
├── data/                # Runtime data (SQLite DB, uploads)
├── CLAUDE.md            # Developer reference (file-by-file docs)
└── package.json         # Monorepo root (workspaces)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 6, Tailwind CSS 3, Zustand 5, Radix UI |
| Backend | Node.js, Express 4, WebSocket (ws) |
| Database | SQLite via better-sqlite3 |
| AI | Claude Code CLI (`--print --output-format stream-json --input-format stream-json`) |
| Monorepo | npm workspaces, TypeScript project references |

## How It Works Under the Hood

### Agent Spawning

Each agent is a child process running:

```
claude --print \
  --output-format stream-json \
  --input-format stream-json \
  --model sonnet \
  --system-prompt "..." \
  --permission-mode bypassPermissions \
  --dangerously-skip-permissions \
  --session-id <uuid> \
  --verbose
```

- The initial prompt is written to stdin as `{"type":"user","content":"..."}` (avoids ARG_MAX limits)
- stdin stays open for follow-up instructions via `sendInput()`
- stdout is parsed as newline-delimited JSON for real-time streaming
- `cwd` is set to the workspace directory so Claude Code auto-discovers project-level CLAUDE.md and `.claude/settings.json`

### Document Routing

| Workspace | Receives |
|-----------|----------|
| Frontend | SA + SD |
| Backend | SD only |
| Other | All documents |

### Agent Execution Flow

```
1. Read CLAUDE.md / .claude/ skills
2. Read spec documents (SA/SD, including PDFs)
3. Produce implementation plan [PLAN_READY]
4. Execute plan step by step
5. Signal completion [TASK_COMPLETE] or request help [NEEDS_HUMAN]
```

## License

MIT
