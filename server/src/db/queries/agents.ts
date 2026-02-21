import type { Agent, AgentRole, AgentStatus } from '@omni/shared';
import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

export function createAgent(data: {
  projectId: string;
  role: AgentRole;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
}): Agent {
  const db = getDb();
  const id = genId();
  db.prepare(`
    INSERT INTO agents (id, project_id, role, system_prompt, model, allowed_tools)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, data.projectId, data.role,
    data.systemPrompt || null,
    data.model || 'sonnet',
    data.allowedTools ? JSON.stringify(data.allowedTools) : null,
  );
  return getAgent(id)!;
}

export function getAgent(id: string): Agent | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapAgent(row);
}

export function getAgentsByProject(projectId: string): Agent[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM agents WHERE project_id = ? ORDER BY created_at ASC'
  ).all(projectId) as Record<string, unknown>[];
  return rows.map(mapAgent);
}

export function getAgentsByRole(projectId: string, role: AgentRole): Agent[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM agents WHERE project_id = ? AND role = ?'
  ).all(projectId, role) as Record<string, unknown>[];
  return rows.map(mapAgent);
}

export function updateAgent(id: string, data: Partial<{
  status: AgentStatus;
  sessionId: string | null;
  pid: number | null;
  currentTaskId: string | null;
  totalCostUsd: number;
  totalTurns: number;
  lastHeartbeat: string;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
  if (data.sessionId !== undefined) { sets.push('session_id = ?'); values.push(data.sessionId); }
  if (data.pid !== undefined) { sets.push('pid = ?'); values.push(data.pid); }
  if (data.currentTaskId !== undefined) { sets.push('current_task_id = ?'); values.push(data.currentTaskId); }
  if (data.totalCostUsd !== undefined) { sets.push('total_cost_usd = ?'); values.push(data.totalCostUsd); }
  if (data.totalTurns !== undefined) { sets.push('total_turns = ?'); values.push(data.totalTurns); }
  if (data.lastHeartbeat !== undefined) { sets.push('last_heartbeat = ?'); values.push(data.lastHeartbeat); }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteAgent(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgent(row: Record<string, unknown>): Agent {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    role: row['role'] as AgentRole,
    status: row['status'] as AgentStatus,
    sessionId: row['session_id'] as string | null,
    pid: row['pid'] as number | null,
    currentTaskId: row['current_task_id'] as string | null,
    systemPrompt: row['system_prompt'] as string | null,
    model: row['model'] as string,
    allowedTools: row['allowed_tools'] as string | null,
    totalCostUsd: row['total_cost_usd'] as number,
    totalTurns: row['total_turns'] as number,
    lastHeartbeat: row['last_heartbeat'] as string | null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
