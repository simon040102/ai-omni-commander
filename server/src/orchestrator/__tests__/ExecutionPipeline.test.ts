import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

// Create in-memory DB for tests
let testDb: Database.Database;

vi.mock('../../db/connection.js', () => ({
  getDb: () => testDb,
}));

// Mock AgentManager
const mockStartAgent = vi.fn().mockResolvedValue('agent-123');
const mockAgentManager = {
  startAgent: mockStartAgent,
};

// Mock EventBus
const mockEventBus = {
  emit: vi.fn(),
  on: vi.fn(),
};

// Mock DocumentParser
const mockDocumentParser = {
  getDocuments: vi.fn().mockReturnValue([]),
  getUploadDir: vi.fn().mockReturnValue('/tmp/uploads'),
};

import { ExecutionPipeline } from '../ExecutionPipeline.js';
import { createProject } from '../../db/queries/projects.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('ExecutionPipeline', () => {
  let pipeline: ExecutionPipeline;

  beforeEach(() => {
    testDb = freshDb();
    vi.clearAllMocks();
    pipeline = new ExecutionPipeline(
      mockAgentManager as any,
      mockEventBus as any,
      mockDocumentParser as any,
    );
  });

  describe('classifyTask()', () => {
    // Access private method through any cast
    const classify = (desc: string) => (pipeline as any).classifyTask(desc);

    it('classifies bug-related descriptions', () => {
      expect(classify('fix login bug')).toBe('bug');
      expect(classify('Fix the crash on submit')).toBe('bug');
      expect(classify('debug authentication error')).toBe('bug');
      expect(classify('hotfix for payment issue')).toBe('bug');
    });

    it('classifies refactor-related descriptions', () => {
      expect(classify('refactor auth module')).toBe('refactor');
      expect(classify('reorganize the utils folder')).toBe('refactor');
      expect(classify('clean up database queries')).toBe('refactor');
    });

    it('classifies feature-related descriptions', () => {
      expect(classify('add user profile page')).toBe('feature');
      expect(classify('implement dark mode')).toBe('feature');
      expect(classify('create new endpoint for orders')).toBe('feature');
      expect(classify('build the notification system')).toBe('feature');
    });

    it('defaults to other for ambiguous descriptions', () => {
      expect(classify('update documentation')).toBe('other');
      expect(classify('misc changes')).toBe('other');
    });
  });

  describe('selectSuperpowers()', () => {
    const select = (type: string) => (pipeline as any).selectSuperpowers(type);

    it('bug → debugging', () => {
      expect(select('bug')).toEqual(['debugging']);
    });

    it('feature → brainstorm + tdd', () => {
      expect(select('feature')).toEqual(['brainstorm', 'tdd']);
    });

    it('refactor → brainstorm', () => {
      expect(select('refactor')).toEqual(['brainstorm']);
    });

    it('other → empty', () => {
      expect(select('other')).toEqual([]);
    });
  });

  describe('resolveWorkingDir()', () => {
    const resolve = (project: any, label: string) => (pipeline as any).resolveWorkingDir(project, label);

    it('frontend label → frontendPath', () => {
      expect(resolve({ frontendPath: '/fe', backendPath: '/be', workingDir: '/root' }, 'frontend')).toBe('/fe');
    });

    it('backend label → backendPath', () => {
      expect(resolve({ frontendPath: '/fe', backendPath: '/be', workingDir: '/root' }, 'backend')).toBe('/be');
    });

    it('fallback to workingDir when frontendPath is null', () => {
      expect(resolve({ frontendPath: null, backendPath: null, workingDir: '/root' }, 'frontend')).toBe('/root');
    });

    it('unknown label → workingDir', () => {
      expect(resolve({ frontendPath: '/fe', backendPath: '/be', workingDir: '/root' }, 'devops')).toBe('/root');
    });
  });

  describe('executeAdHoc()', () => {
    it('spawns an agent via agentManager', async () => {
      createProject({ id: 'p-adhoc', name: 'AdHoc', workingDir: '/tmp/adhoc' });

      await pipeline.executeAdHoc('p-adhoc', 'Build a login page');

      expect(mockStartAgent).toHaveBeenCalledTimes(1);
      const call = mockStartAgent.mock.calls[0][0];
      expect(call.projectId).toBe('p-adhoc');
      expect(call.prompt).toContain('Build a login page');
    });

    it('uses specified model', async () => {
      createProject({ id: 'p-model', name: 'Model Test', workingDir: '/tmp/model' });

      await pipeline.executeAdHoc('p-model', 'test', 'opus');

      const call = mockStartAgent.mock.calls[0][0];
      expect(call.model).toBe('opus');
    });
  });

  describe('executeTask()', () => {
    it('creates a task-based execution', async () => {
      createProject({ id: 'p-task', name: 'Task Test', workingDir: '/tmp/task' });

      // Create a task in the DB
      testDb.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type)
        VALUES ('t1', 'p-task', 'Fix Login', 'The login form crashes', 'frontend', 'bug')
      `).run();

      await pipeline.executeTask('t1');

      expect(mockStartAgent).toHaveBeenCalledTimes(1);
      const call = mockStartAgent.mock.calls[0][0];
      expect(call.projectId).toBe('p-task');
      expect(call.taskId).toBe('t1');
      expect(call.prompt).toContain('Fix Login');
    });
  });
});
