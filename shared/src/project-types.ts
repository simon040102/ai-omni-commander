export type ProjectMode = 'spec' | 'creative' | 'quick';

export type QuickTaskType = 'bug' | 'change' | 'refactor' | 'other';

export type SuperpowersFeature = 'brainstorm' | 'tdd' | 'debugging';

export interface SuperpowersConfig {
  enabled: boolean;
  features: SuperpowersFeature[];
}

export type ProjectStatus =
  | 'setup'
  | 'interviewing'
  | 'planning'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed';

export interface Project {
  id: string;
  name: string;
  mode: ProjectMode;
  status: ProjectStatus;
  workingDir: string;
  configJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  label: string;       // e.g. "frontend", "backend", "shared"
  path: string;        // absolute path to this workspace folder
}

export interface ProjectConfig {
  workspaces?: Workspace[];
  maxConcurrentAgents?: number;
  defaultModel?: string;
  autoReview?: boolean;
  autoTest?: boolean;
  // Superpowers methodology
  superpowers?: SuperpowersConfig;
  // Quick Mode specific
  quickTask?: {
    type: QuickTaskType;
    description: string;
    errorLog?: string;
    relatedFiles?: string[];
  };
}

export type DocType = 'SA' | 'SD' | 'other';

export interface Document {
  id: string;
  projectId: string;
  filename: string;
  filePath: string;
  fileType: string | null;
  docType: DocType | null;
  parsedText: string | null;
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
