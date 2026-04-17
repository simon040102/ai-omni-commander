export type AgentRole =
  | 'master'
  | 'architect'
  | 'backend'
  | 'frontend'
  | 'coordinator'
  | 'devops'
  | 'testing'
  | 'review'
  | 'quick'
  | 'axure';

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reviewing'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface Agent {
  id: string;
  projectId: string;
  title: string | null;
  role: AgentRole;
  status: AgentStatus;
  sessionId: string | null;
  pid: number | null;
  currentTaskId: string | null;
  systemPrompt: string | null;
  model: string;
  allowedTools: string | null;
  totalCostUsd: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastHeartbeat: string | null;
  /** JSON-serialized flow plan (steps + progress) persisted across restarts */
  flowPlanJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AgentSpawnConfig {
  workingDir: string;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
  sessionId?: string;
  useWorkspaceSkills?: boolean; // Whether to load CLAUDE.md/.claude/ from workspace (default: true)
  mcpServers?: Record<string, McpStdioServerConfig>; // Extra MCP servers to load (bypasses .mcp.json approval requirement)
}

export interface AgentStartConfig {
  projectId: string;
  agentId?: string; // Pre-generated ID (allows client to link uploaded files to this agent)
  role: AgentRole;
  taskId?: string;
  prompt: string;
  model?: string;
  workingDir?: string; // Override working directory (default: auto-detect from project config)
  useWorkspaceSkills?: boolean; // Whether to load CLAUDE.md/.claude/ from workspace (default: true)
  skipTaskStatusUpdate?: boolean; // For fullstack subagents: don't update task status on completion
}

export interface AgentRoleConfig {
  role: AgentRole;
  displayName: string;
  model: string;
  systemPrompt: string;
  allowedTools: string[];
}

export interface AgentOutputEvent {
  agentId: string;
  taskId: string | null;
  streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  timestamp: string;
}

export interface AgentProgress {
  agentId: string;
  completedSteps: number;
  totalSteps: number;
  currentPhase: string;
  fileWrites: number;
  toolUses: number;
  percentage: number;
}
