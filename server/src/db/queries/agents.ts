import type { Agent, AgentRole, AgentStatus } from '@omni/shared';
import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

export function createAgent(data: {
  projectId: string;
  id?: string; // Pre-generated ID (optional; auto-generated if not provided)
  role: AgentRole;
  title?: string;
  systemPrompt?: string;
  model?: string;
  allowedTools?: string[];
}): Agent {
  const db = getDb();
  const id = data.id || genId();
  db.prepare(`
    INSERT INTO agents (id, project_id, role, title, system_prompt, model, allowed_tools)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, data.projectId, data.role,
    data.title || null,
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
  title: string | null;
  model: string;
  totalCostUsd: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastHeartbeat: string;
  reviewResultJson: string | null;
  flowPlanJson: string | null;
}>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];

  if (data.status !== undefined) { sets.push('status = ?'); values.push(data.status); }
  if (data.sessionId !== undefined) { sets.push('session_id = ?'); values.push(data.sessionId); }
  if (data.pid !== undefined) { sets.push('pid = ?'); values.push(data.pid); }
  if (data.currentTaskId !== undefined) { sets.push('current_task_id = ?'); values.push(data.currentTaskId); }
  if (data.title !== undefined) { sets.push('title = ?'); values.push(data.title); }
  if (data.model !== undefined) { sets.push('model = ?'); values.push(data.model); }
  if (data.totalCostUsd !== undefined) { sets.push('total_cost_usd = ?'); values.push(data.totalCostUsd); }
  if (data.totalTurns !== undefined) { sets.push('total_turns = ?'); values.push(data.totalTurns); }
  if (data.totalInputTokens !== undefined) { sets.push('total_input_tokens = ?'); values.push(data.totalInputTokens); }
  if (data.totalOutputTokens !== undefined) { sets.push('total_output_tokens = ?'); values.push(data.totalOutputTokens); }
  if (data.lastHeartbeat !== undefined) { sets.push('last_heartbeat = ?'); values.push(data.lastHeartbeat); }
  if (data.reviewResultJson !== undefined) { sets.push('review_result_json = ?'); values.push(data.reviewResultJson); }
  if (data.flowPlanJson !== undefined) { sets.push('flow_plan_json = ?'); values.push(data.flowPlanJson); }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Return all agents whose status is still running/starting/reviewing (should have an active process) */
export function getRunningAgents(): Agent[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM agents WHERE status IN ('running', 'starting', 'reviewing')`,
  ).all() as Record<string, unknown>[];
  return rows.map(mapAgent);
}

export function deleteAgent(id: string): void {
  const db = getDb();
  const del = db.transaction(() => {
    // Reset tasks assigned to this agent back to pending so they can be re-executed
    db.prepare("UPDATE tasks SET assigned_agent_id = NULL, status = 'pending' WHERE assigned_agent_id = ? AND status IN ('in_progress', 'assigned')").run(id);
    db.prepare('UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?').run(id);
    db.prepare('DELETE FROM interventions WHERE agent_id = ?').run(id);
    // agent_outputs has ON DELETE CASCADE, so it's handled automatically
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  });
  del();
}

function mapAgent(row: Record<string, unknown>): Agent {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    title: (row['title'] as string) || null,
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
    totalInputTokens: (row['total_input_tokens'] as number) || 0,
    totalOutputTokens: (row['total_output_tokens'] as number) || 0,
    lastHeartbeat: row['last_heartbeat'] as string | null,
    flowPlanJson: (row['flow_plan_json'] as string) || null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}
