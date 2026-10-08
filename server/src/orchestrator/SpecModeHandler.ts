import type { DocType, Workspace } from '@omni/shared';
import { DocumentParser, type ParsedDocument } from '../documents/DocumentParser.js';
import { getProject } from '../db/queries/projects.js';
import { getTask } from '../db/queries/tasks.js';
import { getDb } from '../db/connection.js';
import { getConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const logger = createChildLogger('SpecModeHandler');

/** Document routing rules per workspace role */
const DOC_ROUTING: Record<string, DocType[]> = {
  frontend: ['SA', 'SD'],
  backend: ['SD'],
};

/**
 * 規格文件上傳與 DocumentParser 的持有者（Web 的 project.uploadDocument／文件清單用）。
 * 原本的「依 workspace spawn agent 執行」流程已隨 legacy spawn 一起移除。
 */
export class SpecModeHandler {
  private documentParser: DocumentParser;

  constructor() {
    const config = getConfig();
    this.documentParser = new DocumentParser(
      path.join(config.projectRoot, 'data', 'uploads'),
    );
  }

  /** Upload a document for a project, optionally scoped to a task subfolder */
  async uploadDocument(
    projectId: string,
    filename: string,
    content: string,
    fileType: string,
    docType?: DocType,
    taskId?: string,
    agentId?: string,
    executionRunId?: string,
  ): Promise<void> {
    // Note: we no longer clear all bindings on each upload.
    // Documents accumulate per task. User can delete individual docs via UI.

    let subFolder: string | undefined;
    if (agentId) {
      subFolder = agentId;
    } else if (taskId) {
      const task = getTask(taskId);
      const code = task?.parentName || null;
      const taskBase = code ? `${code}_${taskId.slice(0, 8)}` : `task_${taskId.slice(0, 8)}`;
      subFolder = executionRunId ? `${taskBase}/${executionRunId}` : taskBase;
    }
    const doc = await this.documentParser.saveAndParse(projectId, filename, content, fileType, docType || 'SD', { subFolder });

    // Bind document to task if taskId is provided
    if (taskId) {
      const db = getDb();
      db.prepare('INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, doc.id);
    }

    logger.info({ projectId, filename, docType: docType || 'SD', subFolder, taskId: taskId || null }, 'Document uploaded');
  }

  /**
   * Build a document context string for a given project and role.
   * Used by the agent.add handler to prepend document info to manually added agents.
   */
  getDocumentContext(projectId: string, role?: string): string {
    const allDocs = this.documentParser.getDocuments(projectId);
    // Exclude task-specific attachments (files in subfolders)
    const projectUploadsDir = path.join(this.documentParser.getUploadDir(), projectId);
    const docs = allDocs.filter(d => path.dirname(d.filePath) === projectUploadsDir);
    if (docs.length === 0) return '';

    // Filter by role if applicable
    const allowedDocTypes = role ? (DOC_ROUTING[role.toLowerCase()] || ['SA', 'SD']) : ['SA', 'SD'];
    const filtered = docs.filter(d => allowedDocTypes.includes(d.docType));
    const finalDocs = filtered.length > 0 ? filtered : docs;

    const docLines = finalDocs.map(d => {
      const typeTag = `[${d.docType}] `;
      const isPdf = d.filename.toLowerCase().endsWith('.pdf');
      const mdMatch = d.content.match(/^\[Document saved at: (.+)\]/);

      if (isPdf) {
        return `- ${typeTag}${d.filename}: 請用 Read tool 讀取 "${d.filePath}"（PDF 包含文字與圖片）`;
      }
      if (mdMatch) {
        const mdPath = mdMatch[1];
        return `- ${typeTag}${d.filename}: 請用 Read tool 讀取 "${mdPath}"（Markdown 含文字與圖片路徑）`;
      }
      return `- ${typeTag}${d.filename}:\n${d.content}`;
    });

    return `\n## Project Documents\n\n${docLines.join('\n\n')}\n`;
  }

  /** Append spec index to workspace CLAUDE.md (safely, without overwriting) */
  private async appendSpecIndexToClaudeMd(workspace: Workspace, copiedFiles: string[]): Promise<void> {
    const claudeMdPath = path.join(workspace.path, 'CLAUDE.md');
    const marker = '<!-- AI_SPECS_INDEX -->';
    const endMarker = '<!-- END_AI_SPECS_INDEX -->';

    // Build the spec index section
    const fileList = copiedFiles.map(f => `- \`.ai_specs/${f}\``).join('\n');
    const indexSection = `
${marker}
## Imported Spec Documents

The following specification documents have been imported for this project:

${fileList}

**Important:** When making implementation decisions, always read these spec files first.
If unsure about requirements, re-read the specs - do not guess.
${endMarker}
`;

    try {
      // Check if CLAUDE.md exists
      let existingContent = '';
      try {
        existingContent = await fs.readFile(claudeMdPath, 'utf-8');
      } catch {
        // File doesn't exist, will create new
      }

      // Check if marker already exists (from previous execution)
      if (existingContent.includes(marker)) {
        // Replace old spec index with new one
        const regex = new RegExp(`${marker}[\\s\\S]*?${endMarker}`, 'g');
        const updatedContent = existingContent.replace(regex, indexSection.trim());
        await fs.writeFile(claudeMdPath, updatedContent, 'utf-8');
        logger.info({ workspace: workspace.label }, 'Spec index updated in CLAUDE.md');
      } else {
        // Append to existing file (or create new)
        const newContent = existingContent + '\n' + indexSection;
        await fs.writeFile(claudeMdPath, newContent, 'utf-8');
        logger.info({ workspace: workspace.label }, 'Spec index appended to CLAUDE.md');
      }
    } catch (err) {
      logger.error({ workspace: workspace.label, err }, 'Failed to update CLAUDE.md');
      // Don't throw - spec injection failure shouldn't block agent execution
    }
  }

  getDocumentParser(): DocumentParser {
    return this.documentParser;
  }

  /** Inject a newly uploaded document to all workspaces (for adding docs to existing project) */
  async injectNewDocument(projectId: string, doc: ParsedDocument): Promise<void> {
    const project = getProject(projectId);
    if (!project) {
      logger.warn({ projectId }, 'Cannot inject document: project not found');
      return;
    }

    // Parse workspaces from project config
    let workspaces: Workspace[] = [];
    if (project.configJson) {
      try {
        const cfg = JSON.parse(project.configJson) as { workspaces?: Workspace[] };
        workspaces = cfg.workspaces || [];
      } catch { /* ignore */ }
    }

    if (workspaces.length === 0) {
      logger.warn({ projectId }, 'No workspaces configured, skipping document injection');
      return;
    }

    // Inject to each workspace based on doc routing rules
    for (const ws of workspaces) {
      const role = ws.label.toLowerCase();
      const allowedDocTypes = DOC_ROUTING[role] || ['SA', 'SD'];

      // Check if this doc type is allowed for this workspace
      if (!allowedDocTypes.includes(doc.docType)) {
        logger.info({ workspace: ws.label, docType: doc.docType }, 'Skipping doc injection (not in routing rules)');
        continue;
      }

      // Copy single file to workspace
      const specsDir = path.join(ws.path, '.ai_specs');
      await fs.mkdir(specsDir, { recursive: true });

      const destFilename = `${doc.docType}_${doc.filename}`;
      const destPath = path.join(specsDir, destFilename);

      try {
        await fs.copyFile(doc.filePath, destPath);
        logger.info({ workspace: ws.label, file: destFilename }, 'New spec file injected to workspace');

        // Update CLAUDE.md with all current docs
        const allDocs = this.documentParser.getDocuments(projectId);
        const wsDocs = allDocs.filter(d => allowedDocTypes.includes(d.docType));
        const allCopiedFiles = wsDocs.map(d => `${d.docType}_${d.filename}`);
        await this.appendSpecIndexToClaudeMd(ws, allCopiedFiles);
      } catch (err) {
        logger.error({ workspace: ws.label, file: destFilename, err }, 'Failed to inject new spec file');
      }
    }
  }
}
