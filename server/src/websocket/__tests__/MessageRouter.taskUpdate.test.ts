import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

// In-memory DB shared by all mocked getDb() callers (queries + flow-gate logTaskOutput)
let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDb: () => testDb,
}));

// Import after mock setup
import { registerHandlers } from '../MessageRouter.js';
import { createProject } from '../../db/queries/projects.js';
import { createTask, getTask } from '../../db/queries/tasks.js';
import type { WsMessage } from '@omni/shared';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

type Handler = (msg: WsMessage, ws: unknown) => void | Promise<void>;

/** Minimal fake WS server capturing registered handlers + broadcasts. */
function makeFakeWsServer() {
  const handlers = new Map<string, Handler>();
  const broadcasts: WsMessage[] = [];
  return {
    handlers,
    broadcasts,
    registerHandler: (type: string, h: Handler) => { handlers.set(type, h); },
    send: (_ws: unknown, _msg: WsMessage) => {},
    broadcast: (msg: WsMessage) => { broadcasts.push(msg); },
    setInitialStateProvider: () => {},
    setPostConnectionHandler: () => {},
  };
}

describe('task.update direct-completed [SKIP] audit', () => {
  let wsServer: ReturnType<typeof makeFakeWsServer>;
  let projectId: string;
  let taskId: string;

  beforeEach(() => {
    testDb = freshDb();
    wsServer = makeFakeWsServer();

    // Stubs — task.update touches none of these beyond type requirements
    const orchestrator = {
      getSpecHandler: () => ({ getDocumentParser: () => ({ getDocuments: () => [] }) }),
    };
    const agentManager = {};
    const workspaceScanner = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerHandlers(wsServer as any, orchestrator as any, agentManager as any, workspaceScanner as any);

    const project = createProject({ name: 'P', workingDir: '/tmp/p' });
    projectId = project.id;
    const task = createTask({ projectId, title: 'T', taskType: 'bug', label: 'backend' });
    taskId = task.id;
  });

  function sendTaskUpdate(payload: Record<string, unknown>): void {
    const handler = wsServer.handlers.get('task.update');
    expect(handler).toBeTruthy();
    handler!({ type: 'task.update', id: 'x', timestamp: new Date().toISOString(), payload } as unknown as WsMessage, {});
  }

  function skipAuditRows(): Array<{ content: string; agent_id: string }> {
    return testDb.prepare(
      "SELECT content, agent_id FROM agent_outputs WHERE task_id = ? AND content LIKE '[SKIP]%'"
    ).all(taskId) as Array<{ content: string; agent_id: string }>;
  }

  it('writes a [SKIP] audit row when status is set directly to completed', () => {
    sendTaskUpdate({ taskId, projectId, status: 'completed' });

    expect(getTask(taskId)?.status).toBe('completed');
    const rows = skipAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('Web UI 直接標記 completed');
    expect(rows[0]!.content).toContain('未經閘門');
    // Same agent convention as the MCP [SKIP] mechanism (mcp-<taskId>)
    expect(rows[0]!.agent_id).toBe(`mcp-${taskId}`);
  });

  it('does not write an audit row for non-completed status updates', () => {
    sendTaskUpdate({ taskId, projectId, status: 'in_progress' });
    expect(getTask(taskId)?.status).toBe('in_progress');
    expect(skipAuditRows()).toHaveLength(0);
  });

  it('does not write an audit row for field-only updates (no status)', () => {
    sendTaskUpdate({ taskId, projectId, title: 'renamed' });
    expect(getTask(taskId)?.title).toBe('renamed');
    expect(skipAuditRows()).toHaveLength(0);
  });

  it('does not duplicate the audit when the task is already completed', () => {
    sendTaskUpdate({ taskId, projectId, status: 'completed' });
    sendTaskUpdate({ taskId, projectId, status: 'completed' });
    expect(skipAuditRows()).toHaveLength(1);
  });
});
