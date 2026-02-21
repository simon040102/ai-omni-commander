export type TaskLabel =
  | 'backend'
  | 'frontend'
  | 'devops'
  | 'testing'
  | 'review'
  | 'architect';

export type TaskStatus =
  | 'pending'
  | 'blocked'
  | 'queued'
  | 'assigned'
  | 'in_progress'
  | 'needs_review'
  | 'needs_intervention'
  | 'completed'
  | 'failed';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  label: TaskLabel;
  status: TaskStatus;
  assignedAgentId: string | null;
  priority: number;
  prompt: string | null;
  resultSummary: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface DependencyEdge {
  taskId: string;
  dependsOnId: string;
}

export interface TaskPlan {
  tasks: TaskPlanItem[];
  apiContracts: import('./contracts.js').ApiContract[];
  dbSchema: import('./contracts.js').SchemaSnapshot;
}

export interface TaskPlanItem {
  title: string;
  description: string;
  label: TaskLabel;
  prompt: string;
  dependencies: string[];
  priority?: number;
}

export interface TaskSummary {
  title: string;
  label: TaskLabel;
  description: string;
}
