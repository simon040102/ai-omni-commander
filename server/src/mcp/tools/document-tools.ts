/**
 * MCP tools for document access.
 * get_documents, read_document
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import { getMcpDb } from '../db.js';

interface DocumentRow {
  id: string;
  project_id: string;
  filename: string;
  file_path: string;
  file_type: string | null;
  doc_type: string | null;
  parsed_text: string | null;
  source: string;
  source_url: string | null;
  created_at: string;
}

export function registerDocumentTools(server: McpServer): void {

  // ── get_documents ─────────────────────────────────────────
  server.tool(
    'get_documents',
    'List documents for a project, optionally filtered by task or document type',
    {
      projectId: z.string().describe('The project ID'),
      taskId: z.string().optional().describe('Optional: filter to documents bound to this task'),
      docType: z.enum(['SA', 'SD', 'other']).optional().describe('Optional: filter by document type'),
    },
    async ({ projectId, taskId, docType }) => {
      const db = getMcpDb();

      let docs: DocumentRow[];

      if (taskId) {
        // Get task-bound documents
        const query = docType
          ? `SELECT d.* FROM task_documents td JOIN documents d ON d.id = td.document_id WHERE td.task_id = ? AND d.doc_type = ?`
          : `SELECT d.* FROM task_documents td JOIN documents d ON d.id = td.document_id WHERE td.task_id = ?`;
        docs = (docType
          ? db.prepare(query).all(taskId, docType)
          : db.prepare(query).all(taskId)) as DocumentRow[];
      } else {
        const query = docType
          ? `SELECT * FROM documents WHERE project_id = ? AND doc_type = ? ORDER BY created_at ASC`
          : `SELECT * FROM documents WHERE project_id = ? ORDER BY created_at ASC`;
        docs = (docType
          ? db.prepare(query).all(projectId, docType)
          : db.prepare(query).all(projectId)) as DocumentRow[];
      }

      const result = docs.map(d => ({
        id: d.id,
        filename: d.filename,
        filePath: d.file_path,
        fileType: d.file_type,
        docType: d.doc_type,
        source: d.source,
        createdAt: d.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ projectId, count: result.length, documents: result }, null, 2),
        }],
      };
    },
  );

  // ── read_document ─────────────────────────────────────────
  server.tool(
    'read_document',
    'Read the content of a document. Returns markdown text for DOCX (already converted), text content for text files, or the file path for PDFs (use Read tool to read PDFs).',
    { documentId: z.string().describe('The document ID') },
    async ({ documentId }) => {
      const db = getMcpDb();
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as DocumentRow | undefined;
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Error: Document "${documentId}" not found` }], isError: true };
      }

      // DOCX → MD pointer
      if (doc.parsed_text?.startsWith('[Document saved at:')) {
        const pathMatch = doc.parsed_text.match(/\[Document saved at: (.+?)]/);
        const mdPath = pathMatch ? pathMatch[1] : null;

        if (mdPath && fs.existsSync(mdPath)) {
          const content = fs.readFileSync(mdPath, 'utf-8');
          return { content: [{ type: 'text' as const, text: `# ${doc.filename}\n\n${content}` }] };
        }
        // Fallback: return the pointer instruction
        return { content: [{ type: 'text' as const, text: `Document converted to markdown. Use Read tool to read: ${mdPath || doc.file_path}` }] };
      }

      // PDF — return path for Claude's Read tool
      if (doc.file_type === 'application/pdf' || doc.filename.endsWith('.pdf')) {
        return { content: [{ type: 'text' as const, text: `PDF document: ${doc.filename}\nFile path: ${doc.file_path}\n\nUse the Read tool to read this PDF file.` }] };
      }

      // Text content available
      if (doc.parsed_text) {
        return { content: [{ type: 'text' as const, text: `# ${doc.filename}\n\n${doc.parsed_text}` }] };
      }

      // Fallback: try to read the file directly
      if (fs.existsSync(doc.file_path)) {
        try {
          const content = fs.readFileSync(doc.file_path, 'utf-8');
          return { content: [{ type: 'text' as const, text: `# ${doc.filename}\n\n${content}` }] };
        } catch {
          return { content: [{ type: 'text' as const, text: `Could not read file. Path: ${doc.file_path}` }], isError: true };
        }
      }

      return { content: [{ type: 'text' as const, text: `File not found at: ${doc.file_path}` }], isError: true };
    },
  );
}
