export type SuperpowersFeature = 'brainstorm' | 'tdd' | 'debugging';

export interface SuperpowersConfig {
  enabled: boolean;
  features: SuperpowersFeature[];
}

export type ProjectStatus =
  | 'idle'
  | 'setup'
  | 'planning'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  workingDir: string;
  frontendPath: string | null;
  backendPath: string | null;
  asanaProjectGid: string | null;
  dbConnectionString: string | null;
  configJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  label: string;       // e.g. "frontend", "backend", "shared"
  path: string;        // absolute path to this workspace folder
}

export interface PlanConfig {
  requireApproval: boolean;  // If true, agent pauses after [PLAN_READY] and waits for approval
}

export interface AsanaSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  autoExecuteRules: {
    bug: boolean;
    feature: boolean;
    refactor: boolean;
    other: boolean;
  };
  maxConcurrentAgents: number;
}

export interface SvnConfig {
  frontendSpecPath: string;  // SVN root for frontend specs
  backendSpecPath: string;   // SVN root for backend specs
}

/** SVN credentials stored in global config (not per-project) */
export interface SvnCredentials {
  username: string;
  password: string;
}

export interface ProjectConfig {
  maxConcurrentAgents?: number;
  defaultModel?: string;
  autoReview?: boolean;
  planConfig?: PlanConfig;
  autoExecuteConfig?: { bug: boolean; feature: boolean; refactor: boolean };
  asanaSyncConfig?: AsanaSyncConfig;
  svnConfig?: SvnConfig;
}

/** Stored plan for an agent */
export interface AgentPlan {
  id: string;
  agentId: string;
  projectId: string;
  content: string;        // Markdown content
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  approvedAt?: string;
}

export type DocType = 'SA' | 'SD';

export interface Document {
  id: string;
  projectId: string;
  filename: string;
  filePath: string;
  fileType: string | null;
  docType: DocType | null;
  parsedText: string | null;
  source: 'upload' | 'svn';
  sourceUrl: string | null;
  svnLastModified: string | null;
  createdAt: string;
}

export interface Intervention {
  id: string;
  projectId: string;
  agentId: string;
  taskId: string | null;
  reason: string;
  contextJson: string | null;
  status: 'pending' | 'acknowledged' | 'resolved' | 'dismissed';
  userResponse: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
