import type { Task, TaskLabel, TaskStatus, TaskType, TaskSource, DependencyEdge } from '@omni/shared';
import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

export function createTask(data: {
  projectId: string;
  title: string;
  description?: string;
  label: TaskLabel;
  prompt?: string;
  priority?: number;
  taskType?: TaskType;
  source?: TaskSource;
  sourceRef?: string;
  specUrl?: string;
  preferredModel?: string;
  parentName?: string;
}): Task {
  const db = getDb();
  const id = genId();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, label, prompt, priority, task_type, source, source_ref, spec_url, preferred_model, parent_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.projectId, data.title, data.description || null,
    data.label, data.prompt || null, data.priority || 0,
    data.taskType || 'other', data.source || 'manual', data.sourceRef || null,
    data.specUrl || null, data.preferredModel || null, data.parentName || null);
  return getTask(id)!;
}

export function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapTask(row);
}

export function getTasksByProject(projectId: string): Task[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at ASC'
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(mapTask);
}

export function getReadyTasks(projectId: string): Task[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.project_id = ? AND t.status = 'queued'
    AND NOT EXISTS (
      SELECT 1 FROM task_dependencies td
      JOIN tasks dep ON dep.id = td.depends_on_id
      WHERE td.task_id = t.id AND dep.status != 'completed'
    )
    ORDER BY t.priority DESC
  `).all(projectId) as Record<string, unknown>[];
  return rows.map(mapTask);
}

export function getBlockedTasks(projectId: string): Task[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.project_id = ? AND t.status = 'blocked'
  `).all(projectId) as Record<string, unknown>[];
  return rows.map(mapTask);
}

export function updateTask(id: string, data: Partial<{
  status: TaskStatus;
  assignedAgentId: string | null;
  prompt: string;
  resultSummary: string;
  retryCount: number;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
  if (data.assignedAgentId !== undefined) { sets.push('assigned_agent_id = ?'); values.push(data.assignedAgentId); }
  if (data.prompt !== undefined) { sets.push('prompt = ?'); values.push(data.prompt); }
  if (data.resultSummary !== undefined) { sets.push('result_summary = ?'); values.push(data.resultSummary); }
  if (data.retryCount !== undefined) { sets.push('retry_count = ?'); values.push(data.retryCount); }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function addDependency(taskId: string, dependsOnId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id)
    VALUES (?, ?)
  `).run(taskId, dependsOnId);
}

export function getDependencies(projectId: string): DependencyEdge[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT td.task_id, td.depends_on_id FROM task_dependencies td
    JOIN tasks t ON t.id = td.task_id
    WHERE t.project_id = ?
  `).all(projectId) as Record<string, unknown>[];
  return rows.map(r => ({
    taskId: r['task_id'] as string,
    dependsOnId: r['depends_on_id'] as string,
  }));
}

export function updateTaskFields(id: string, data: Partial<{
  title: string;
  description: string | null;
  specUrl: string | null;
  label: TaskLabel;
  taskType: TaskType;
  status: TaskStatus;
  preferredModel: string | null;
  parentName: string | null;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.title !== undefined) { sets.push('title = ?'); values.push(data.title); }
  if (data.description !== undefined) { sets.push('description = ?'); values.push(data.description); }
  if (data.specUrl !== undefined) { sets.push('spec_url = ?'); values.push(data.specUrl); }
  if (data.label !== undefined) { sets.push('label = ?'); values.push(data.label); }
  if (data.taskType !== undefined) { sets.push('task_type = ?'); values.push(data.taskType); }
  if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
  if (data.preferredModel !== undefined) { sets.push('preferred_model = ?'); values.push(data.preferredModel); }
  if (data.parentName !== undefined) { sets.push('parent_name = ?'); values.push(data.parentName); }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTasksBySource(projectId: string, source: string): number {
  const db = getDb();
  // Clear FK references before deleting
  const taskIds = db.prepare('SELECT id FROM tasks WHERE project_id = ? AND source = ?').all(projectId, source) as { id: string }[];
  for (const { id } of taskIds) {
    clearTaskReferences(db, id);
  }
  const result = db.prepare('DELETE FROM tasks WHERE project_id = ? AND source = ?').run(projectId, source);
  return result.changes;
}

export function deleteTask(id: string): void {
  const db = getDb();
  clearTaskReferences(db, id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

/** Nullify or delete FK references to a task before deletion */
function clearTaskReferences(db: ReturnType<typeof getDb>, taskId: string): void {
  db.prepare('UPDATE agent_outputs SET task_id = NULL WHERE task_id = ?').run(taskId);
  db.prepare('UPDATE interventions SET task_id = NULL WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?').run(taskId, taskId);
  db.prepare('DELETE FROM task_documents WHERE task_id = ?').run(taskId);
}

function mapTask(row: Record<string, unknown>): Task {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    title: row['title'] as string,
    description: row['description'] as string | null,
    label: row['label'] as TaskLabel,
    status: row['status'] as TaskStatus,
    assignedAgentId: row['assigned_agent_id'] as string | null,
    priority: row['priority'] as number,
    prompt: row['prompt'] as string | null,
    resultSummary: row['result_summary'] as string | null,
    retryCount: row['retry_count'] as number,
    maxRetries: row['max_retries'] as number,
    taskType: (row['task_type'] as TaskType) || 'other',
    source: (row['source'] as TaskSource) || 'manual',
    sourceRef: (row['source_ref'] as string | null) ?? null,
    branchName: (row['branch_name'] as string | null) ?? null,
    specUrl: (row['spec_url'] as string | null) ?? null,
    preferredModel: (row['preferred_model'] as string | null) ?? null,
    parentName: (row['parent_name'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
