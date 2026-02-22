import { getDb } from '../connection.js';
import { genId } from '../../utils/uuid.js';

export interface EventRow {
  id: string;
  projectId: string;
  eventType: string;
  source: string | null;
  target: string | null;
  payloadJson: string | null;
  createdAt: string;
}

export function logEvent(data: {
  projectId: string;
  eventType: string;
  source?: string;
  target?: string;
  payload?: Record<string, unknown>;
}): EventRow {
  const db = getDb();
  const id = genId();
  db.prepare(`
    INSERT INTO events (id, project_id, event_type, source, target, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id, data.projectId, data.eventType,
    data.source || null, data.target || null,
    data.payload ? JSON.stringify(data.payload) : null,
  );
  return getEvent(id)!;
}

export function getEvent(id: string): EventRow | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapEvent(row);
}

export function getEvents(projectId: string, limit = 100): EventRow[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM events WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(projectId, limit) as Record<string, unknown>[];
  return rows.map(mapEvent);
}

export function getEventsByType(projectId: string, eventType: string, limit = 50): EventRow[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM events WHERE project_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?'
  ).all(projectId, eventType, limit) as Record<string, unknown>[];
  return rows.map(mapEvent);
}

export function logAgentOutput(data: {
  agentId: string;
  taskId?: string;
  streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
    VALUES (?, ?, ?, ?)
  `).run(data.agentId, data.taskId || null, data.streamType, data.content);
}

export function getAgentOutputs(agentId: string, limit = 500): Array<{
  streamType: string;
  content: string;
  timestamp: string;
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT stream_type, content, timestamp FROM agent_outputs WHERE agent_id = ? ORDER BY id DESC LIMIT ?'
  ).all(agentId, limit) as Array<{ stream_type: string; content: string; timestamp: string }>;
  return rows.map(r => ({
    streamType: r.stream_type,
    content: r.content,
    timestamp: r.timestamp,
  }));
}

export function clearAgentOutputs(agentId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM agent_outputs WHERE agent_id = ?').run(agentId);
}

export function createIntervention(data: {
  projectId: string;
  agentId: string;
  taskId?: string;
  reason: string;
  contextJson?: string;
}): { id: string } {
  const db = getDb();
  const id = genId();
  db.prepare(`
    INSERT INTO interventions (id, project_id, agent_id, task_id, reason, context_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, data.projectId, data.agentId, data.taskId || null, data.reason, data.contextJson || null);
  return { id };
}

export function resolveIntervention(id: string, userResponse: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE interventions SET status = 'resolved', user_response = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(userResponse, id);
}

function mapEvent(row: Record<string, unknown>): EventRow {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    eventType: row['event_type'] as string,
    source: row['source'] as string | null,
    target: row['target'] as string | null,
    payloadJson: row['payload_json'] as string | null,
    createdAt: row['created_at'] as string,
  };
}
