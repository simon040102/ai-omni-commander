import type { Task, TaskLabel, TaskStatus, DependencyEdge } from '@omni/shared';
import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

export function createTask(data: {
  projectId: string;
  title: string;
  description?: string;
  label: TaskLabel;
  prompt?: string;
  priority?: number;
}): Task {
  const db = getDb();
  const id = genId();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, label, prompt, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.projectId, data.title, data.description || null,
    data.label, data.prompt || null, data.priority || 0);
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

export function deleteTask(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
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
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
