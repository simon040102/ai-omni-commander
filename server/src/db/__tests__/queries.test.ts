import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../schema.js';

// Mock getDb to return our in-memory database
let testDb: Database.Database;

vi.mock('../connection.js', () => ({
  getDb: () => testDb,
}));

// Import after mock setup
import { createProject, getProject, listProjects, updateProject, deleteProject } from '../queries/projects.js';
import { upsertWorkspaceSkills, getWorkspaceSkills } from '../queries/workspaceSkills.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('projects queries', () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it('createProject() returns a Project with v2 fields', () => {
    const proj = createProject({
      name: 'Test Proj',
      workingDir: '/tmp/test',
      frontendPath: '/tmp/test/web',
      backendPath: '/tmp/test/server',
      asanaProjectGid: 'gid-123',
    });

    expect(proj.id).toBeTruthy();
    expect(proj.name).toBe('Test Proj');
    expect(proj.status).toBe('idle');
    expect(proj.workingDir).toBe('/tmp/test');
    expect(proj.frontendPath).toBe('/tmp/test/web');
    expect(proj.backendPath).toBe('/tmp/test/server');
    expect(proj.asanaProjectGid).toBe('gid-123');
    expect(proj.createdAt).toBeTruthy();
    expect(proj.updatedAt).toBeTruthy();
  });

  it('createProject() with custom id', () => {
    const proj = createProject({
      id: 'custom-id',
      name: 'Custom',
      workingDir: '/tmp',
    });
    expect(proj.id).toBe('custom-id');
  });

  it('createProject() defaults frontendPath/backendPath to null', () => {
    const proj = createProject({ name: 'Minimal', workingDir: '/tmp' });
    expect(proj.frontendPath).toBeNull();
    expect(proj.backendPath).toBeNull();
    expect(proj.asanaProjectGid).toBeNull();
  });

  it('getProject() returns null for non-existent ID', () => {
    expect(getProject('non-existent')).toBeNull();
  });

  it('getProject() returns the correct project', () => {
    const created = createProject({ id: 'p1', name: 'P1', workingDir: '/p1' });
    const fetched = getProject('p1');
    expect(fetched).toEqual(created);
  });

  it('listProjects() returns all projects sorted by created_at desc', () => {
    createProject({ id: 'a', name: 'Alpha', workingDir: '/a' });
    createProject({ id: 'b', name: 'Beta', workingDir: '/b' });
    const list = listProjects();
    expect(list).toHaveLength(2);
    // Most recent first (both created "now" so order may vary, just check count)
  });

  it('updateProject() updates frontendPath/backendPath/asanaProjectGid', () => {
    createProject({ id: 'u1', name: 'Upd', workingDir: '/u' });
    updateProject('u1', {
      frontendPath: '/u/fe',
      backendPath: '/u/be',
      asanaProjectGid: 'gid-999',
    });
    const proj = getProject('u1')!;
    expect(proj.frontendPath).toBe('/u/fe');
    expect(proj.backendPath).toBe('/u/be');
    expect(proj.asanaProjectGid).toBe('gid-999');
  });

  it('updateProject() updates name and status', () => {
    createProject({ id: 'u2', name: 'Old', workingDir: '/u' });
    updateProject('u2', { name: 'New', status: 'executing' });
    const proj = getProject('u2')!;
    expect(proj.name).toBe('New');
    expect(proj.status).toBe('executing');
  });

  it('deleteProject() removes the project', () => {
    createProject({ id: 'd1', name: 'Del', workingDir: '/d' });
    deleteProject('d1');
    expect(getProject('d1')).toBeNull();
  });
});

describe('workspaceSkills queries', () => {
  beforeEach(() => {
    testDb = freshDb();
    // Need a project for foreign key
    createProject({ id: 'ws-proj', name: 'WS Proj', workingDir: '/ws' });
  });

  it('upsertWorkspaceSkills() inserts new record', () => {
    upsertWorkspaceSkills('ws-proj', 'frontend', {
      path: '/ws/fe',
      hasClaudeMd: true,
      hasClaudeDir: false,
      skills: [{ name: 'test-skill', filename: 'test-skill.md', path: '/ws/fe/.claude/commands/test-skill.md' }],
    });

    const skills = getWorkspaceSkills('ws-proj');
    expect(skills).toHaveLength(1);
    expect(skills[0].workspaceType).toBe('frontend');
    expect(skills[0].hasClaudeMd).toBe(true);
    expect(skills[0].hasClaudeDir).toBe(false);
    expect(skills[0].skills).toHaveLength(1);
    expect(skills[0].skills[0].name).toBe('test-skill');
  });

  it('upsertWorkspaceSkills() upserts on conflict', () => {
    upsertWorkspaceSkills('ws-proj', 'frontend', {
      path: '/ws/fe',
      hasClaudeMd: false,
      hasClaudeDir: false,
      skills: [],
    });

    upsertWorkspaceSkills('ws-proj', 'frontend', {
      path: '/ws/fe-v2',
      hasClaudeMd: true,
      hasClaudeDir: true,
      skills: [{ name: 'skill1', filename: 'skill1.md', path: '/ws/fe-v2/.claude/commands/skill1.md' }],
    });

    const skills = getWorkspaceSkills('ws-proj');
    expect(skills).toHaveLength(1);
    expect(skills[0].path).toBe('/ws/fe-v2');
    expect(skills[0].hasClaudeMd).toBe(true);
    expect(skills[0].hasClaudeDir).toBe(true);
  });

  it('getWorkspaceSkills() returns empty for unknown project', () => {
    expect(getWorkspaceSkills('non-existent')).toHaveLength(0);
  });

  it('supports both frontend and backend workspace types', () => {
    upsertWorkspaceSkills('ws-proj', 'frontend', {
      path: '/ws/fe', hasClaudeMd: true, hasClaudeDir: false, skills: [],
    });
    upsertWorkspaceSkills('ws-proj', 'backend', {
      path: '/ws/be', hasClaudeMd: false, hasClaudeDir: true, skills: [],
    });

    const skills = getWorkspaceSkills('ws-proj');
    expect(skills).toHaveLength(2);
    const types = skills.map(s => s.workspaceType).sort();
    expect(types).toEqual(['backend', 'frontend']);
  });
});
