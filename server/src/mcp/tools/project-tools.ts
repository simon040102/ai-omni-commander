/**
 * MCP tools for project management (secondary).
 * list_projects, get_project, create_project, create_task
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';

function genId(): string {
  return crypto.randomUUID();
}

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  working_dir: string;
  frontend_path: string | null;
  backend_path: string | null;
  config_json: string | null;
  created_at: string;
  updated_at: string;
}

export function registerProjectTools(server: McpServer): void {

  // ── list_projects ─────────────────────────────────────────
  server.tool(
    'list_projects',
    'List all projects',
    {},
    async () => {
      const db = getMcpDb();
      const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];

      const result = projects.map(p => ({
        id: p.id,
        name: p.name,
        status: p.status,
        workingDir: p.working_dir,
        frontendPath: p.frontend_path,
        backendPath: p.backend_path,
        createdAt: p.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ count: result.length, projects: result }, null, 2),
        }],
      };
    },
  );

  // ── get_project ───────────────────────────────────────────
  server.tool(
    'get_project',
    'Get detailed information about a project including task counts',
    { projectId: z.string().describe('The project ID') },
    async ({ projectId }) => {
      const db = getMcpDb();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      // Task stats
      const taskStats = db.prepare(`
        SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status
      `).all(projectId) as Array<{ status: string; count: number }>;

      const docCount = (db.prepare('SELECT COUNT(*) as count FROM documents WHERE project_id = ?').get(projectId) as { count: number }).count;

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: project.id,
            name: project.name,
            status: project.status,
            workingDir: project.working_dir,
            frontendPath: project.frontend_path,
            backendPath: project.backend_path,
            configJson: project.config_json ? JSON.parse(project.config_json) : null,
            taskStats: Object.fromEntries(taskStats.map(s => [s.status, s.count])),
            documentCount: docCount,
            createdAt: project.created_at,
          }, null, 2),
        }],
      };
    },
  );

  // ── create_project ────────────────────────────────────────
  server.tool(
    'create_project',
    'Create a new project',
    {
      name: z.string().describe('Project name'),
      workingDir: z.string().describe('Absolute path to the working directory'),
      frontendPath: z.string().optional().describe('Optional: absolute path to frontend workspace'),
      backendPath: z.string().optional().describe('Optional: absolute path to backend workspace'),
    },
    async ({ name, workingDir, frontendPath, backendPath }) => {
      const db = getMcpDb();
      const id = genId();

      db.prepare(`
        INSERT INTO projects (id, name, working_dir, frontend_path, backend_path)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, name, workingDir, frontendPath || null, backendPath || null);

      await notifyWebServer({
        event: 'project.created',
        data: { projectId: id, name },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ id, name, workingDir, frontendPath: frontendPath || null, backendPath: backendPath || null }, null, 2),
        }],
      };
    },
  );

  // ── update_project ────────────────────────────────────────
  server.tool(
    'update_project',
    'Update an existing project (name, paths, config, etc.)',
    {
      projectId: z.string().describe('The project ID'),
      name: z.string().optional().describe('New project name'),
      frontendPath: z.string().optional().describe('Absolute path to frontend workspace'),
      backendPath: z.string().optional().describe('Absolute path to backend workspace'),
      workingDir: z.string().optional().describe('Absolute path to the main working directory'),
      asanaProjectGid: z.string().optional().describe('Asana project GID'),
      dbConnectionString: z.string().optional().describe('Database connection string'),
      configJson: z.string().optional().describe('Project config as JSON string'),
    },
    async ({ projectId, name, frontendPath, backendPath, workingDir, asanaProjectGid, dbConnectionString, configJson }) => {
      const db = getMcpDb();
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      // Build SET clause dynamically from provided fields
      const updates: string[] = [];
      const values: unknown[] = [];

      if (name !== undefined) { updates.push('name = ?'); values.push(name); }
      if (frontendPath !== undefined) { updates.push('frontend_path = ?'); values.push(frontendPath); }
      if (backendPath !== undefined) { updates.push('backend_path = ?'); values.push(backendPath); }
      if (workingDir !== undefined) { updates.push('working_dir = ?'); values.push(workingDir); }
      if (asanaProjectGid !== undefined) { updates.push('asana_project_gid = ?'); values.push(asanaProjectGid); }
      if (dbConnectionString !== undefined) { updates.push('db_connection_string = ?'); values.push(dbConnectionString); }
      if (configJson !== undefined) { updates.push('config_json = ?'); values.push(configJson); }

      if (updates.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: No fields to update' }], isError: true };
      }

      updates.push("updated_at = datetime('now')");
      values.push(projectId);

      db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);

      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;

      await notifyWebServer({
        event: 'project.updated',
        data: { projectId, name: updated.name },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: updated.id,
            name: updated.name,
            workingDir: updated.working_dir,
            frontendPath: updated.frontend_path,
            backendPath: updated.backend_path,
          }, null, 2),
        }],
      };
    },
  );

  // ── create_task ───────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a new task in a project',
    {
      projectId: z.string().describe('The project ID'),
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      label: z.enum(['frontend', 'backend', 'fullstack', 'devops', 'testing', 'review', 'architect']).describe('Task label (determines workspace)'),
      taskType: z.enum(['bug', 'feature', 'refactor', 'testing', 'other']).optional().describe('Task type (default: other)'),
      priority: z.number().optional().describe('Priority (higher = more important, default: 0)'),
      prompt: z.string().optional().describe('Custom execution prompt'),
      preferredModel: z.string().optional().describe('Preferred Claude model'),
    },
    async ({ projectId, title, description, label, taskType, priority, prompt, preferredModel }) => {
      const db = getMcpDb();

      // Verify project exists
      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      const id = genId();
      db.prepare(`
        INSERT INTO tasks (id, project_id, title, description, label, task_type, priority, prompt, preferred_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, title, description || null, label, taskType || 'other', priority || 0, prompt || null, preferredModel || null);

      await notifyWebServer({
        event: 'task.created',
        data: { taskId: id, projectId, title, label },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ id, projectId, title, label, taskType: taskType || 'other', status: 'pending' }, null, 2),
        }],
      };
    },
  );
}
