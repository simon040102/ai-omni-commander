export type AgentRole =
  | 'master'
  | 'architect'
  | 'backend'
  | 'frontend'
  | 'devops'
  | 'testing'
  | 'review';

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
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
  createdAt: string;
  updatedAt: string;
}

export interface AgentSpawnConfig {
  workingDir: string;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
  sessionId?: string;
}

export interface AgentStartConfig {
  projectId: string;
  role: AgentRole;
  taskId?: string;
  prompt: string;
  model?: string;
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
