import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
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
 * DOCX files are converted to Markdown with images extracted as separate PNGs,
 * so agents can re-read them after context compression via Read tool.
 */
export class DocumentParser {
  constructor(private uploadDir: string) {}

  getUploadDir(): string { return this.uploadDir; }

  /**
   * Convert a .docx buffer to a Markdown file, extracting images as separate files.
   * Returns the absolute path to the saved .md file.
   */
  private async extractDocxToMarkdown(
    buffer: Buffer,
    docId: string,
    projectId: string,
    filename: string,
    targetDir?: string,  // optional override; defaults to {uploadDir}/{projectId}
  ): Promise<string> {
    const outDir = targetDir ?? path.join(this.uploadDir, projectId);
    await fs.mkdir(outDir, { recursive: true });

    const images: string[] = [];
    let imgIdx = 0;

    const result = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const imageBuffer = await image.read();
          const ext = (image.contentType?.split('/')[1] || 'png').replace('jpeg', 'jpg');
          const imgFilename = `${docId}-img-${imgIdx++}.${ext}`;
          const imgPath = path.join(outDir, imgFilename);
          await fs.writeFile(imgPath, imageBuffer);
          images.push(imgPath);
          return { src: imgFilename }; // relative name first, replaced below
        }),
      },
    );

    // HTML → Markdown via turndown + GFM tables plugin
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TurndownService = ((await import('turndown')) as any).default ?? (await import('turndown'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gfm = ((await import('turndown-plugin-gfm')) as any).gfm ?? (await import('turndown-plugin-gfm'));
    const td = new TurndownService({ headingStyle: 'atx' });
    td.use(gfm);

    // Mammoth wraps cell content in <p> tags; strip them so GFM table plugin can parse cells
    const cleanedHtml = result.value.replace(
      /(<(?:td|th)[^>]*>)([\s\S]*?)(<\/(?:td|th)>)/gi,
      (_match, open: string, content: string, close: string) => {
        const cleaned = content
          .replace(/<p>([\s\S]*?)<\/p>/gi, '$1 ')
          .replace(/<br\s*\/?>/gi, ' ')
          .trim();
        return `${open}${cleaned}${close}`;
      },
    );

    let markdown = td.turndown(cleanedHtml);

    // Compress 3+ consecutive blank lines to 1
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    // Replace relative image names with absolute paths so agent can Read them
    for (const absPath of images) {
      const relName = path.basename(absPath);
      markdown = markdown.replaceAll(relName, absPath.replace(/\\/g, '/'));
    }

    // Save .md file
    const mdFilename = `${docId}-${path.parse(filename).name}.md`;
    const mdPath = path.join(outDir, mdFilename);
    await fs.writeFile(mdPath, markdown, 'utf-8');

    logger.info({ docId, mdPath, imageCount: images.length }, 'DOCX converted to Markdown');
    return mdPath;
  }

  /** Save an uploaded file */
  async saveAndParse(
    projectId: string,
    filename: string,
    content: string,
    fileType: string,
    docType: DocType = 'SD',
    opts?: { source?: 'upload' | 'svn'; sourceUrl?: string; svnLastModified?: string; subFolder?: string },
  ): Promise<ParsedDocument> {
    const id = genId();
    const source = opts?.source || 'upload';

    // Ensure target directory exists (optionally in a task subfolder)
    const targetDir = opts?.subFolder
      ? path.join(this.uploadDir, projectId, opts.subFolder)
      : path.join(this.uploadDir, projectId);
    await fs.mkdir(targetDir, { recursive: true });

    // Save file into target directory
    const filePath = path.join(targetDir, `${id}-${filename}`);

    let textContent: string;
    if (fileType === 'base64') {
      const buffer = Buffer.from(content, 'base64');
      await fs.writeFile(filePath, buffer);

      if (filename.toLowerCase().endsWith('.pdf')) {
        // For PDFs, just store a placeholder — Claude agent will read the file directly
        textContent = `[PDF file saved at: ${filePath}]`;
      } else if (filename.toLowerCase().endsWith('.docx')) {
        // Convert to Markdown + extract images — agent reads .md file via Read tool
        try {
          const mdPath = await this.extractDocxToMarkdown(buffer, id, projectId, filename, targetDir);
          textContent = `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`;
        } catch (err) {
          logger.warn({ err, filename }, 'Failed to convert DOCX to Markdown, falling back to text extraction');
          try {
            const result = await mammoth.extractRawText({ buffer });
            textContent = result.value
              .replace(/\n{3,}/g, '\n\n')
              .replace(/[ \t]+\n/g, '\n')
              .trim() || `[DOCX file - text extraction returned empty, file saved at: ${filePath}]`;
          } catch {
            textContent = `[DOCX file saved at: ${filePath}]`;
          }
        }
      } else {
        textContent = buffer.toString('utf-8')
          .replace(/\0/g, '')
          .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
      }
    } else if (fileType.startsWith('image/')) {
      // Content is base64-encoded image — decode and save as binary
      const buffer = Buffer.from(content, 'base64');
      await fs.writeFile(filePath, buffer);
      textContent = `[Image saved at: ${filePath.replace(/\\/g, '/')}]`;
    } else {
      // Already text
      textContent = content.replace(/\0/g, '');
      await fs.writeFile(filePath, content, 'utf-8');
    }

    // Store in DB
    const db = getDb();
    db.prepare(`
      INSERT INTO documents (id, project_id, filename, file_path, file_type, doc_type, parsed_text, source, source_url, svn_last_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, filename, filePath, fileType, docType, textContent,
      source, opts?.sourceUrl || null, opts?.svnLastModified || null);

    logger.info({ id, filename, fileType, docType, filePath, source }, 'Document saved');

    return { id, filename, filePath, content: textContent, fileType, docType };
  }

  /** Save a pre-downloaded binary file (for SVN exports) */
  async saveFromBuffer(
    projectId: string,
    filename: string,
    buffer: Buffer,
    docType: DocType = 'SD',
    opts?: { source?: 'upload' | 'svn'; sourceUrl?: string; svnLastModified?: string; parsedText?: string; subFolder?: string },
  ): Promise<ParsedDocument> {
    const id = genId();
    const source = opts?.source || 'upload';

    const targetDir = opts?.subFolder
      ? path.join(this.uploadDir, projectId, opts.subFolder)
      : path.join(this.uploadDir, projectId);
    await fs.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, `${id}-${filename}`);
    await fs.writeFile(filePath, buffer);

    let textContent: string;

    if (filename.toLowerCase().endsWith('.docx')) {
      // Always convert DOCX to Markdown regardless of caller-supplied parsedText
      try {
        const mdPath = await this.extractDocxToMarkdown(buffer, id, projectId, filename, targetDir);
        textContent = `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`;
      } catch (err) {
        logger.warn({ err, filename }, 'Failed to convert DOCX to Markdown in saveFromBuffer');
        textContent = opts?.parsedText || `[DOCX file saved at: ${filePath}]`;
      }
    } else {
      textContent = opts?.parsedText || `[Binary file saved at: ${filePath}]`;
    }

    const db = getDb();
    db.prepare(`
      INSERT INTO documents (id, project_id, filename, file_path, file_type, doc_type, parsed_text, source, source_url, svn_last_modified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, filename, filePath, 'binary', docType, textContent,
      source, opts?.sourceUrl || null, opts?.svnLastModified || null);

    logger.info({ id, filename, filePath, source }, 'Document saved from buffer');

    return { id, filename, filePath, content: textContent, fileType: 'binary', docType };
  }

  /** Find a document by its SVN source URL */
  findBySourceUrl(projectId: string, sourceUrl: string): {
    id: string; filename: string; filePath: string; svnLastModified: string | null;
  } | null {
    const db = getDb();
    const row = db.prepare(
      "SELECT id, filename, file_path, svn_last_modified FROM documents WHERE project_id = ? AND source_url = ?"
    ).get(projectId, sourceUrl) as { id: string; filename: string; file_path: string; svn_last_modified: string | null } | undefined;
    if (!row) return null;
    return { id: row.id, filename: row.filename, filePath: row.file_path, svnLastModified: row.svn_last_modified };
  }

  /** Update SVN last modified date and re-save file content */
  async updateSvnDocument(documentId: string, buffer: Buffer, svnLastModified: string, parsedText?: string): Promise<void> {
    const db = getDb();
    const row = db.prepare('SELECT file_path, filename, project_id FROM documents WHERE id = ?').get(documentId) as { file_path: string; filename: string; project_id: string } | undefined;
    if (!row) return;

    await fs.writeFile(row.file_path, buffer);

    let text: string;
    if (row.filename.toLowerCase().endsWith('.docx')) {
      try {
        const mdPath = await this.extractDocxToMarkdown(buffer, documentId, row.project_id, row.filename);
        text = `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`;
      } catch {
        text = parsedText || `[DOCX file saved at: ${row.file_path}]`;
      }
    } else {
      text = parsedText || `[Binary file saved at: ${row.file_path}]`;
    }

    db.prepare(
      "UPDATE documents SET svn_last_modified = ?, parsed_text = ?, created_at = datetime('now') WHERE id = ?"
    ).run(svnLastModified, text, documentId);

    logger.info({ documentId, svnLastModified }, 'SVN document updated');
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
      docType: (r.doc_type as DocType) || 'SD',
    }));
  }

  /** Delete all documents stored in a per-agent subfolder (uploads/{projectId}/{agentId}/) */
  async deleteByAgent(agentId: string, projectId: string): Promise<void> {
    const agentDir = path.join(this.uploadDir, projectId, agentId);
    try {
      await fs.rm(agentDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    // Remove DB rows whose file_path starts with the agent dir
    const db = getDb();
    const rows = db.prepare('SELECT id FROM documents WHERE project_id = ?').all(projectId) as Array<{ id: string }>;
    const prefix = agentDir.replace(/\\/g, '/');
    for (const row of rows) {
      const docRow = db.prepare('SELECT file_path FROM documents WHERE id = ?').get(row.id) as { file_path: string } | undefined;
      if (docRow && docRow.file_path.replace(/\\/g, '/').startsWith(prefix)) {
        db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
      }
    }
    logger.info({ agentId, projectId }, 'Per-agent documents cleaned up');
  }

  /**
   * Delete the SVN subfolder for a task by looking up bound documents from task_documents.
   * This approach is reliable regardless of how the folder was named.
   * Call this before deleteTask() so files are cleaned up from disk.
   */
  async deleteTaskFolder(projectId: string, _parentName: string | null, taskId: string): Promise<void> {
    const db = getDb();

    // Find all documents bound to this task
    const boundRows = db.prepare(`
      SELECT d.id, d.file_path FROM documents d
      JOIN task_documents td ON td.document_id = d.id
      WHERE td.task_id = ?
    `).all(taskId) as Array<{ id: string; file_path: string }>;

    // Collect unique subdirectories inside uploadDir/{projectId}/ to delete
    const projectDir = path.join(this.uploadDir, projectId).replace(/\\/g, '/');
    const dirsToDelete = new Set<string>();

    for (const row of boundRows) {
      const fileDir = path.dirname(row.file_path).replace(/\\/g, '/');
      // Only delete subdirectories (not the project root itself)
      if (fileDir.startsWith(projectDir + '/') && fileDir !== projectDir) {
        dirsToDelete.add(fileDir);
      }
      db.prepare('DELETE FROM task_documents WHERE document_id = ?').run(row.id);
      db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
    }

    // Also clean up task_documents rows for this task (in case any remain)
    db.prepare('DELETE FROM task_documents WHERE task_id = ?').run(taskId);

    // Delete subdirectories on disk
    for (const dir of dirsToDelete) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        logger.info({ taskId, dir }, 'Task folder deleted');
      } catch { /* ignore */ }
    }
  }

  /** Delete all documents for a project (DB rows + entire project upload folder) */
  async deleteByProject(projectId: string): Promise<number> {
    const db = getDb();
    const result = db.prepare('DELETE FROM documents WHERE project_id = ?').run(projectId);

    // Remove the entire per-project upload directory
    const projectDir = path.join(this.uploadDir, projectId);
    try {
      await fs.rm(projectDir, { recursive: true, force: true });
    } catch {
      // Directory may not exist — ignore
    }

    logger.info({ projectId, count: result.changes }, 'Documents cleared');
    return result.changes;
  }

  /** Get documents filtered by doc type */
  getDocumentsByType(projectId: string, docTypes: DocType[]): ParsedDocument[] {
    const docs = this.getDocuments(projectId);
    return docs.filter(d => docTypes.includes(d.docType));
  }

  /**
   * Clean up execution run folders where the agent has been deleted.
   * Scans task folders and removes execution run subfolders (executionRunId UUIDs)
   * that have no corresponding agent records.
   */
  async cleanupExecutionRunsWithoutAgents(projectId: string): Promise<number> {
    const db = getDb();
    const projectDir = path.join(this.uploadDir, projectId);

    // Get all task subdirectories (folders like SM27_xxx_taskid or task_xxx_taskid)
    let taskDirs: string[] = [];
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      taskDirs = entries
        .filter(e => e.isDirectory() && /[0-9a-f]{8}/.test(e.name)) // Has taskid-like suffix
        .map(e => path.join(projectDir, e.name).replace(/\\/g, '/'));
    } catch {
      return 0;
    }

    let deletedCount = 0;

    // For each task directory, check execution run subfolders
    for (const taskDir of taskDirs) {
      try {
        const entries = await fs.readdir(taskDir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const runId = entry.name;

            // Check if this runId has any corresponding agent
            const agentCount = db.prepare(
              'SELECT COUNT(*) as cnt FROM agents WHERE execution_run_id = ?'
            ).get(runId) as { cnt: number };

            if (agentCount.cnt === 0) {
              // No agents for this run — delete it
              const runDir = path.join(taskDir, runId);
              try {
                await fs.rm(runDir, { recursive: true, force: true });
                logger.info({ projectId, runId }, 'Execution run folder cleaned up (no agents)');
                deletedCount++;
              } catch (err) {
                logger.warn({ err, runId }, 'Failed to cleanup execution run folder');
              }
            }
          }
        }
      } catch (err) {
        logger.warn({ err, taskDir }, 'Failed to scan task directory');
      }
    }

    return deletedCount;
  }

  /**
   * Clean up orphaned task folders (folders with no bound documents).
   * Scans uploads/{projectId}/ for subdirectories where all files are unbound.
   * Call this periodically or after bulk task deletions.
   */
  async cleanupOrphanedFolders(projectId: string): Promise<number> {
    const db = getDb();
    const projectDir = path.join(this.uploadDir, projectId);

    // Scan all subdirectories in projectDir (not the root)
    const subdirs = new Set<string>();
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          subdirs.add(path.join(projectDir, entry.name).replace(/\\/g, '/'));
        }
      }
    } catch {
      // Directory doesn't exist
      return 0;
    }

    if (subdirs.size === 0) return 0;

    // For each subdirectory, check if ANY file in it is bound to a task
    let deletedCount = 0;
    for (const subdir of subdirs) {
      // Get all documents in this subtree
      const docRows = db.prepare(`
        SELECT id FROM documents
        WHERE project_id = ? AND file_path LIKE ?
      `).all(projectId, `${subdir}%`) as Array<{ id: string }>;

      if (docRows.length === 0) {
        // No documents at all in this folder — skip (folder is empty)
        continue;
      }

      // Check if ANY document is bound to a task
      const boundCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM task_documents
        WHERE document_id IN (${docRows.map(() => '?').join(',')})
      `).get(...docRows.map(r => r.id)) as { cnt: number };

      if (boundCount.cnt === 0) {
        // All documents are orphaned — delete folder and records
        try {
          await fs.rm(subdir, { recursive: true, force: true });
          for (const doc of docRows) {
            db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
          }
          logger.info({ projectId, folder: subdir }, 'Orphaned folder cleaned up');
          deletedCount++;
        } catch (err) {
          logger.warn({ err, projectId, folder: subdir }, 'Failed to cleanup orphaned folder');
        }
      }
    }

    return deletedCount;
  }

  /** Delete a single document by ID (DB row + physical file + associated .md and images) */
  async deleteDocument(documentId: string): Promise<{ filename: string; docType: DocType } | null> {
    const db = getDb();
    const row = db.prepare(
      'SELECT file_path, filename, doc_type FROM documents WHERE id = ?'
    ).get(documentId) as { file_path: string; filename: string; doc_type: string | null } | undefined;

    if (!row) {
      logger.warn({ documentId }, 'Document not found for deletion');
      return null;
    }

    // Delete DB row
    db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);

    const dir = path.dirname(row.file_path);

    // Delete original file
    try { await fs.unlink(row.file_path); } catch { /* ignore */ }

    // Delete associated .md file and extracted images (docId prefix)
    try {
      const entries = await fs.readdir(dir);
      const prefix = documentId + '-';
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          try { await fs.unlink(path.join(dir, entry)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore — dir may not exist */ }

    logger.info({ documentId }, 'Document deleted');
    return {
      filename: row.filename,
      docType: (row.doc_type as DocType) || 'SD',
    };
  }
}
