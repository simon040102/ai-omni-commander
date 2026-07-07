import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

vi.mock('../notify.js', () => ({
  notifyWebServer: vi.fn().mockResolvedValue(true),
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkspaceTools } from '../tools/workspace-tools.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('workspace-tools', () => {
  let server: McpServer;
  let tmpDirs: string[];

  function makeTmpWorkspace(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ws-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  function insertProject(id: string, frontendPath: string, backendPath?: string): void {
    testDb.prepare(`
      INSERT INTO projects (id, name, working_dir, frontend_path, backend_path)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 'Test Project', frontendPath, frontendPath, backendPath || null);
  }

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerWorkspaceTools(server);
    tmpDirs = [];
  });

  afterEach(() => {
    for (const dir of tmpDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  describe('get_skill_gen_plan', () => {
    it('returns isError for non-existent project', async () => {
      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'nope', workspaceType: 'frontend' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('create mode: empty workspace produces plan with task lifecycle, SKILL.md format, pre-dev checklist and evidence requirements', async () => {
      const ws = makeTmpWorkspace();
      insertProject('p1', ws);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'frontend' });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text as string;

      // Mode detection
      expect(text).toContain('**Mode:** create');

      // H1: full create_task → in_progress → dispatch → completed flow for the orchestrator
      expect(text).toContain('create_task(projectId="p1"');
      expect(text).toContain('Skill 產生：frontend workspace');
      expect(text).toContain('update_task_status(taskId, "in_progress")');
      expect(text).toContain('update_task_status(taskId, "completed"');
      expect(text).toContain('"failed"');

      // H2: official folder skill format
      expect(text).toContain('.claude/skills/<skill-name>/SKILL.md');
      expect(text).not.toContain('type: reference');

      // H5: pre-development reading checklist section is mandatory
      expect(text).toContain('開發前必讀');

      // H4: every rule needs file-path evidence
      expect(text).toContain('實際檔案路徑');
      expect(text).toContain('找不到程式碼佐證的規則不要寫');
    });

    it('enhance mode: workspace with existing CLAUDE.md is detected', async () => {
      const ws = makeTmpWorkspace();
      fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# existing');
      insertProject('p1', ws);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'frontend' });
      const text = result.content[0].text as string;
      expect(text).toContain('**Mode:** enhance');
      expect(text).toContain('增強現有內容');
    });

    it('enhance mode: legacy flat .md skill files are detected and migration is instructed', async () => {
      const ws = makeTmpWorkspace();
      const skillsDir = path.join(ws, '.claude', 'skills');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'legacy-skill.md'), '---\nname: legacy\n---\ncontent');
      insertProject('p1', ws);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'frontend' });
      const text = result.content[0].text as string;
      expect(text).toContain('**Mode:** enhance');
      // Migration instruction for flat .md files
      expect(text).toContain('平面 .md skill 檔');
      expect(text).toContain('遷移');
    });

    it('enhance mode: official folder SKILL.md format is detected', async () => {
      const ws = makeTmpWorkspace();
      const skillDir = path.join(ws, '.claude', 'skills', 'my-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\ncontent');
      insertProject('p1', ws);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'frontend' });
      const text = result.content[0].text as string;
      expect(text).toContain('**Mode:** enhance');
    });

    it('create mode: skills dir with only non-skill folders (no SKILL.md) stays create', async () => {
      const ws = makeTmpWorkspace();
      const skillDir = path.join(ws, '.claude', 'skills', 'empty-folder');
      fs.mkdirSync(skillDir, { recursive: true });
      insertProject('p1', ws);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'frontend' });
      const text = result.content[0].text as string;
      expect(text).toContain('**Mode:** create');
    });

    it('injects active project notes into the prompt', async () => {
      const ws = makeTmpWorkspace();
      insertProject('p1', ws);
      testDb.prepare(`
        INSERT INTO project_notes (id, project_id, category, content) VALUES (?, ?, ?, ?)
      `).run('n1', 'p1', 'build', 'build 必須用 JDK 17，不能用 21');
      testDb.prepare(`
        INSERT INTO project_notes (id, project_id, category, content) VALUES (?, ?, ?, ?)
      `).run('n2', 'p1', null, '表單欄位一行最多兩個');
      // archived note must NOT appear
      testDb.prepare(`
        INSERT INTO project_notes (id, project_id, category, content, active) VALUES (?, ?, ?, ?, 0)
      `).run('n3', 'p1', 'old', '已封存的筆記');

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'backend' });
      const text = result.content[0].text as string;

      expect(text).toContain('專案經驗筆記');
      expect(text).toContain('[build] build 必須用 JDK 17，不能用 21');
      expect(text).toContain('表單欄位一行最多兩個');
      expect(text).not.toContain('已封存的筆記');
    });

    it('omits the notes section entirely when there are no active notes', async () => {
      const ws = makeTmpWorkspace();
      insertProject('p1', ws);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'frontend' });
      const text = result.content[0].text as string;
      expect(text).not.toContain('專案經驗筆記');
    });

    it('backend workspaceType uses backend_path and backend label', async () => {
      const wsFe = makeTmpWorkspace();
      const wsBe = makeTmpWorkspace();
      insertProject('p1', wsFe, wsBe);

      const result = await callTool(server, 'get_skill_gen_plan', { projectId: 'p1', workspaceType: 'backend' });
      const text = result.content[0].text as string;
      expect(text).toContain(wsBe);
      expect(text).toContain('label="backend"');
      expect(text).toContain('Skill 產生：backend workspace');
    });
  });
});
