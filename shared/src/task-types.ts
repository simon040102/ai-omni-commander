export const TASK_TYPES = ['bug', 'feature', 'refactor', 'testing', 'other'] as const;
export type TaskType = typeof TASK_TYPES[number];

export const TASK_SOURCES = ['manual', 'asana'] as const;
export type TaskSource = typeof TASK_SOURCES[number];

export const TASK_LABELS = ['backend', 'frontend', 'fullstack', 'devops', 'testing', 'review', 'architect'] as const;
export type TaskLabel = typeof TASK_LABELS[number];

export const TASK_STATUSES = ['pending', 'blocked', 'queued', 'assigned', 'in_progress', 'needs_review', 'needs_intervention', 'completed', 'failed'] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

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
  taskType: TaskType;
  source: TaskSource;
  sourceRef: string | null;
  branchName: string | null;
  specUrl: string | null;
  preferredModel: string | null;
  parentName: string | null;
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
