import fs from 'node:fs/promises';
import path from 'node:path';
import type { DocType } from '@omni/shared';
import { genId } from '../utils/uuid.js';
import { getDb } from '../db/connection.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('DocumentParser');

export interface ParsedDocument {
  id: string;
  filename: string;
  filePath: string;
  content: string;
  fileType: string;
  docType: DocType;
}

/**
 * Saves uploaded documents and makes them available for Claude agents to read.
 * PDF files are saved as-is so Claude Code can read them directly (including images).
 * Text files have their content extracted for quick access.
 */
export class DocumentParser {
  constructor(private uploadDir: string) {}

  /** Save an uploaded file */
  async saveAndParse(
    projectId: string,
    filename: string,
    content: string,
    fileType: string,
    docType: DocType = 'other',
  ): Promise<ParsedDocument> {
    const id = genId();

    // Ensure upload directory exists
    await fs.mkdir(this.uploadDir, { recursive: true });

    // Save file
    const filePath = path.join(this.uploadDir, `${id}-${filename}`);

    let textContent: string;
    if (fileType === 'base64') {
      const buffer = Buffer.from(content, 'base64');
      await fs.writeFile(filePath, buffer);

      if (filename.toLowerCase().endsWith('.pdf')) {
        // For PDFs, just store a placeholder — Claude agent will read the file directly
        textContent = `[PDF file saved at: ${filePath}]`;
      } else {
        textContent = buffer.toString('utf-8')
          .replace(/\0/g, '')
          .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
      }
    } else {
      // Already text
      textContent = content.replace(/\0/g, '');
      await fs.writeFile(filePath, content, 'utf-8');
    }

    // Store in DB
    const db = getDb();
    db.prepare(`
      INSERT INTO documents (id, project_id, filename, file_path, file_type, doc_type, parsed_text)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, filename, filePath, fileType, docType, textContent);

    logger.info({ id, filename, fileType, docType, filePath }, 'Document saved');

    return { id, filename, filePath, content: textContent, fileType, docType };
  }

  /** Get all documents for a project */
  getDocuments(projectId: string): ParsedDocument[] {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, filename, file_path, parsed_text, file_type, doc_type FROM documents WHERE project_id = ?'
    ).all(projectId) as Array<{ id: string; filename: string; file_path: string; parsed_text: string; file_type: string; doc_type: string | null }>;
    return rows.map(r => ({
      id: r.id,
      filename: r.filename,
      filePath: r.file_path,
      content: r.parsed_text,
      fileType: r.file_type,
      docType: (r.doc_type as DocType) || 'other',
    }));
  }

  /** Get documents filtered by doc type */
  getDocumentsByType(projectId: string, docTypes: DocType[]): ParsedDocument[] {
    const docs = this.getDocuments(projectId);
    return docs.filter(d => docTypes.includes(d.docType));
  }
}
