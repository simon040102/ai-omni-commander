import type { AgentPlan } from '@omni/shared';
import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

interface CreatePlanInput {
  agentId: string;
  projectId: string;
  content: string;
}

export function createPlan(input: CreatePlanInput): AgentPlan {
  const db = getDb();
  const id = genId();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO agent_plans (id, agent_id, project_id, content, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(id, input.agentId, input.projectId, input.content, now);

  return {
    id,
    agentId: input.agentId,
    projectId: input.projectId,
    content: input.content,
    status: 'pending',
    createdAt: now,
  };
}

export function getPlan(id: string): AgentPlan | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, agent_id, project_id, content, status, created_at, approved_at FROM agent_plans WHERE id = ?'
  ).get(id) as {
    id: string;
    agent_id: string;
    project_id: string;
    content: string;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
    approved_at: string | null;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? undefined,
  };
}

export function getPlansByProject(projectId: string): AgentPlan[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, agent_id, project_id, content, status, created_at, approved_at FROM agent_plans WHERE project_id = ? ORDER BY created_at DESC'
  ).all(projectId) as Array<{
    id: string;
    agent_id: string;
    project_id: string;
    content: string;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
    approved_at: string | null;
  }>;

  return rows.map(row => ({
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? undefined,
  }));
}

export function getPlanByAgent(agentId: string): AgentPlan | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT id, agent_id, project_id, content, status, created_at, approved_at FROM agent_plans WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(agentId) as {
    id: string;
    agent_id: string;
    project_id: string;
    content: string;
    status: 'pending' | 'approved' | 'rejected';
    created_at: string;
    approved_at: string | null;
  } | undefined;

  if (!row) return null;

  return {
    id: row.id,
    agentId: row.agent_id,
    projectId: row.project_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at ?? undefined,
  };
}

export function updatePlanStatus(id: string, status: 'approved' | 'rejected'): void {
  const db = getDb();
  const approvedAt = status === 'approved' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE agent_plans SET status = ?, approved_at = ? WHERE id = ?'
  ).run(status, approvedAt, id);
}

export function deletePlansByAgent(agentId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM agent_plans WHERE agent_id = ?').run(agentId);
}
