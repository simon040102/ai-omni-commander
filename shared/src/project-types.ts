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

/**
 * A local folder spec source (parallel to SVN).
 * path must be an absolute path (local disk or UNC share).
 * gitPull=true → when the folder is a git repo, run a safe `git pull --ff-only`
 * before scanning (dirty tree → skip pull; failure → warn + use existing content).
 */
export interface SpecFolderConfig {
  path: string;
  gitPull?: boolean;
}

/** SVN credentials stored in global config (not per-project) */
export interface SvnCredentials {
  username: string;
  password: string;
}

export interface ProjectConfig {
  /**
   * @deprecated Legacy plan-approval gate — only read by AgentManager's spawn
   * path (legacy, gated by ALLOW_LEGACY_SPAWN). Kept for old config_json rows.
   */
  planConfig?: PlanConfig;
  asanaSyncConfig?: AsanaSyncConfig;
  svnConfig?: SvnConfig;
  specFolders?: SpecFolderConfig[];
  axshareUrl?: string;
  dbConnections?: import('./schema-types.js').DbConnectionConfig[];
  /** 前端 subagent 額外指示（原封不動注入 prompt） */
  frontendExtraPrompt?: string;
  /** 後端 subagent 額外指示（原封不動注入 prompt） */
  backendExtraPrompt?: string;
  /**
   * 前端單元測試指令（如 "pnpm vitest run"）。設定後會：
   * 1) 注入 execution plan 的「單元測試（強制流程）」區塊；
   * 2) get_verification_plan 自動前置「單元測試全數通過」驗收項。
   */
  frontendTestCommand?: string;
  /** 後端單元測試指令（如 "mvn test"）——行為同 frontendTestCommand */
  backendTestCommand?: string;
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

// 'other' 已是 documents.doc_type CHECK 的合法值（DEFAULT 'other'）與 get_documents 列舉值；
// HTML 原型（Axure）一律歸 'other'，不新增 doc_type、零 schema migration。
export type DocType = 'SA' | 'SD' | 'other';

export interface Document {
  id: string;
  projectId: string;
  filename: string;
  filePath: string;
  fileType: string | null;
  docType: DocType | null;
  parsedText: string | null;
  source: 'upload' | 'svn' | 'folder';
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
