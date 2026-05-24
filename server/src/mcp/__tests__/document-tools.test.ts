import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDocumentTools } from '../tools/document-tools.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProject(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
}

function seedDocument(db: Database.Database, id: string, projectId: string, opts: { filename?: string; docType?: string; parsedText?: string; filePath?: string } = {}) {
  db.prepare(`INSERT INTO documents (id, project_id, filename, file_path, doc_type, parsed_text) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id, projectId,
    opts.filename || 'spec.md',
    opts.filePath || '/tmp/spec.md',
    opts.docType || 'SD',
    opts.parsedText || 'Document content here',
  );
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool.handler(args, {} as any);
}

describe('document-tools', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerDocumentTools(server);
  });

  describe('get_documents', () => {
    it('lists all project documents', async () => {
      seedProject(testDb);
      seedDocument(testDb, 'doc-1', 'proj-1', { filename: 'sa.md', docType: 'SA' });
      seedDocument(testDb, 'doc-2', 'proj-1', { filename: 'sd.md', docType: 'SD' });

      const result = await callTool(server, 'get_documents', { projectId: 'proj-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.count).toBe(2);
      expect(data.documents[0].filename).toBe('sa.md');
    });

    it('filters by docType', async () => {
      seedProject(testDb);
      seedDocument(testDb, 'doc-1', 'proj-1', { docType: 'SA' });
      seedDocument(testDb, 'doc-2', 'proj-1', { docType: 'SD' });

      const result = await callTool(server, 'get_documents', { projectId: 'proj-1', docType: 'SA' });
      const data = JSON.parse(result.content[0].text);

      expect(data.count).toBe(1);
      expect(data.documents[0].docType).toBe('SA');
    });

    it('filters by taskId', async () => {
      seedProject(testDb);
      seedDocument(testDb, 'doc-1', 'proj-1');

      // Create a task and bind the document
      testDb.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
        'task-1', 'proj-1', 'Task', 'backend', 'feature',
      );
      testDb.prepare(`INSERT INTO task_documents (task_id, document_id) VALUES (?, ?)`).run('task-1', 'doc-1');

      const result = await callTool(server, 'get_documents', { projectId: 'proj-1', taskId: 'task-1' });
      const data = JSON.parse(result.content[0].text);

      expect(data.count).toBe(1);
    });
  });

  describe('read_document', () => {
    it('returns parsed text content', async () => {
      seedProject(testDb);
      seedDocument(testDb, 'doc-1', 'proj-1', { parsedText: 'Hello world content' });

      const result = await callTool(server, 'read_document', { documentId: 'doc-1' });
      expect(result.content[0].text).toContain('Hello world content');
    });

    it('returns PDF path instruction', async () => {
      seedProject(testDb);
      seedDocument(testDb, 'doc-pdf', 'proj-1', {
        filename: 'spec.pdf',
        filePath: '/tmp/spec.pdf',
        parsedText: null as any,
      });

      const result = await callTool(server, 'read_document', { documentId: 'doc-pdf' });
      expect(result.content[0].text).toContain('PDF');
      expect(result.content[0].text).toContain('/tmp/spec.pdf');
    });

    it('returns error for non-existent document', async () => {
      const result = await callTool(server, 'read_document', { documentId: 'nope' });
      expect(result.isError).toBe(true);
    });
  });
});
