import type { DocType, Workspace, AgentRole, SuperpowersConfig, SuperpowersFeature, TestOptions } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import type { TaskDispatcher } from './TaskDispatcher.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { DocumentParser, type ParsedDocument } from '../documents/DocumentParser.js';
import { updateProject, getProject } from '../db/queries/projects.js';
import { getAgentsByRole } from '../db/queries/agents.js';
import { getTask } from '../db/queries/tasks.js';
import { getConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import { loadSuperpowersPrompt } from '../skills/superpowers/index.js';
import path from 'node:path';
import fs from 'node:fs/promises';

const logger = createChildLogger('SpecModeHandler');

/** Document routing rules per workspace role */
const DOC_ROUTING: Record<string, DocType[]> = {
  frontend: ['SA', 'SD'],
  backend: ['SD'],
};

/**
 * Handles the Spec Mode workflow:
 * 1. User uploads SA/SD documents with type tags
 * 2. On execute, spawn one agent per workspace with appropriate documents
 * 3. Each agent uses its own CLAUDE.md / .claude/ skills to decompose and implement
 */
export class SpecModeHandler {
  private documentParser: DocumentParser;

  constructor(
    private agentManager: AgentManager,
    private dispatcher: TaskDispatcher,
    private contextSync: ContextSync,
    private eventBus: EventBus,
  ) {
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
    let subFolder: string | undefined;
    if (agentId) {
      subFolder = agentId;
    } else if (taskId) {
      const task = getTask(taskId);
      const code = task?.parentName || null;
      const taskBase = code ? `${code}_${taskId.slice(0, 8)}` : `task_${taskId.slice(0, 8)}`;
      subFolder = executionRunId ? `${taskBase}/${executionRunId}` : taskBase;
    }
    await this.documentParser.saveAndParse(projectId, filename, content, fileType, docType || 'SD', { subFolder });
    logger.info({ projectId, filename, docType: docType || 'SD', subFolder }, 'Document uploaded');
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

  /** Start execution: spawn one agent per workspace with appropriate documents */
  async execute(projectId: string, requirement?: string, model?: string, debugMode?: boolean, testOptions?: TestOptions): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // Get all uploaded documents — exclude task-specific attachments (files in subfolders)
    const allDocs = this.documentParser.getDocuments(projectId);
    const projectUploadsDir = path.join(this.documentParser.getUploadDir(), projectId);
    const docs = allDocs.filter(d => path.dirname(d.filePath) === projectUploadsDir);
    if (docs.length === 0) {
      throw new Error('No documents uploaded for this project');
    }

    // Parse workspaces and superpowers from project config
    let workspaces: Workspace[] = [];
    let superpowers: SuperpowersConfig | undefined;
    if (project.configJson) {
      try {
        const cfg = JSON.parse(project.configJson) as { workspaces?: Workspace[]; superpowers?: SuperpowersConfig };
        workspaces = cfg.workspaces || [];
        superpowers = cfg.superpowers;
      } catch { /* ignore */ }
    }

    // Log Superpowers status
    if (superpowers?.enabled && superpowers.features.length > 0) {
      logger.info({ features: superpowers.features }, 'Superpowers methodology enabled');
    }

    if (workspaces.length === 0) {
      throw new Error('No workspaces configured for this project');
    }

    updateProject(projectId, { status: 'executing' });

    // Initialize .ai_context directory
    await this.contextSync.init();

    // Spawn or reuse one agent per workspace
    for (const ws of workspaces) {
      const role = ws.label.toLowerCase() as AgentRole;
      const resolvedRole = this.resolveRole(role);
      const allowedDocTypes = DOC_ROUTING[role] || ['SA', 'SD'];

      // Filter documents for this workspace
      const wsDocs = docs.filter(d => allowedDocTypes.includes(d.docType));

      // Use all docs if no role-specific match
      const finalDocs = wsDocs.length > 0 ? wsDocs : docs;

      if (finalDocs.length === 0) {
        logger.warn({ projectId, workspace: ws.label }, 'No matching documents for workspace, skipping');
        continue;
      }

      // Inject specs to workspace before starting agent (long-term memory)
      await this.injectSpecsToWorkspace(ws, finalDocs);

      const prompt = this.buildWorkspacePrompt(ws, finalDocs, role, requirement, superpowers, debugMode, testOptions);

      // Reuse existing agent for this role if available, otherwise create new
      const existingAgents = getAgentsByRole(projectId, resolvedRole);
      if (existingAgents.length > 0) {
        const agent = existingAgents[0];
        logger.info(
          { projectId, workspace: ws.label, role: resolvedRole, agentId: agent.id, docCount: finalDocs.length },
          'Rerunning existing agent with new prompt',
        );
        await this.agentManager.rerunAgent(agent.id, prompt);
      } else {
        logger.info(
          { projectId, workspace: ws.label, role: resolvedRole, model: model || 'sonnet', docCount: finalDocs.length },
          'Starting new workspace agent',
        );
        await this.agentManager.startAgent({
          projectId,
          role: resolvedRole,
          prompt,
          model: model || 'sonnet',
        });
      }
    }

    logger.info({ projectId, workspaceCount: workspaces.length }, 'All workspace agents started');
  }

  /** Build the prompt for a workspace agent */
  private buildWorkspacePrompt(workspace: Workspace, docs: ParsedDocument[], role: string, requirement?: string, superpowers?: SuperpowersConfig, debugMode?: boolean, testOptions?: TestOptions): string {
    const docLines = docs.map(d => {
      const typeTag = `[${d.docType}] `;
      const isPdf = d.filename.toLowerCase().endsWith('.pdf');
      const mdMatch = d.content.match(/^\[Document saved at: (.+)\]/);
      const imgMatch = d.content.match(/^\[Image saved at: (.+)\]/);
      if (isPdf) {
        return `- ${typeTag}${d.filename}: 請用 Read tool 讀取 "${d.filePath}"（PDF 包含文字與圖片）`;
      }
      if (mdMatch) {
        return `- ${typeTag}${d.filename}: 請用 Read tool 讀取 "${mdMatch[1]}"（Markdown 含文字與圖片路徑）`;
      }
      if (imgMatch) {
        return `- ${typeTag}${d.filename}: 請用 Read tool 讀取 "${imgMatch[1]}"（截圖圖片）`;
      }
      return `- ${typeTag}${d.filename}:\n${d.content}`;
    });

    const requirementSection = requirement?.trim()
      ? `\n## 本次需求說明\n\n${requirement.trim()}\n`
      : '';

    // Build Superpowers methodology prefix if enabled
    let superpowersPrefix = '';
    if (superpowers?.enabled && superpowers.features.length > 0) {
      superpowersPrefix = loadSuperpowersPrompt(superpowers.features as SuperpowersFeature[]) + '\n\n---\n\n';
    }

    // Debug mode: work with existing codebase
    if (debugMode) {
      return `${superpowersPrefix}你的工作目錄是 "${workspace.path}"（${workspace.label}）。
${requirementSection}
## 模式：Debug / 修改現有程式碼

這是一個**現有的程式碼專案**，你的任務是根據需求修改或擴充現有功能，而不是從零開始建立。

## 第一步：探索現有程式碼庫

先使用 Glob、Grep、Read 等工具瀏覽專案結構，了解：
- 專案架構和檔案組織
- 主要程式碼模組和元件
- 相關的現有實作

## 第二步：讀取專案技能設定

檢查工作目錄中是否有 CLAUDE.md 或 .claude/ 設定，如果有請讀取並遵循其中的指示。
這些設定定義了此專案的技術規範、程式碼風格和框架慣例，你必須完整遵守。

## 第三步：讀取規格文件

以下是本次需求相關的規格文件：
${docLines.join('\n')}

重要提示：
- PDF 檔案請使用 Read tool 來讀取，它們可能包含重要的圖片、表格和流程圖
- 如果 PDF 頁數過多，Read tool 會要求你分批讀取，請依照指示分頁讀取

## 第四步：產出修改計劃書（必須先完成才能動手修改程式碼）

在理解現有程式碼和規格文件後，你必須先產出一份詳細的修改計劃書，包含：

1. **現況分析**：說明相關的現有實作和程式碼位置
2. **需求摘要**：根據規格文件${requirement?.trim() ? '和上方的需求說明' : ''}歸納出需要修改或新增的功能
3. **任務拆解**：將修改需求拆解為具體的實作任務（每個任務要明確、可執行）
4. **影響範圍**：列出需要修改的檔案和可能受影響的模組
5. **技術方案**：每個任務的修改方案，需符合現有專案的架構和 CLAUDE.md / skills 中定義的規範

請將計劃書以 Markdown 格式輸出，並在計劃書末尾加上 **[PLAN_READY]** 標記。

## 第五步：執行修改計劃

計劃書產出後，按照計劃逐步修改程式碼。嚴格遵循現有專案的架構風格和技能設定中的規範。

${this.getCompletionCriteria(role, testOptions)}

- 如需人工協助請加上 [NEEDS_HUMAN]`;
    }

    // New build mode (default)
    return `${superpowersPrefix}你的工作目錄是 "${workspace.path}"（${workspace.label}）。
${requirementSection}
## 第一步：讀取專案技能設定

請先檢查工作目錄中是否有 CLAUDE.md 或 .claude/ 設定，如果有請讀取並遵循其中的指示和技能定義。
這些設定定義了此專案的技術規範、程式碼風格、框架慣例和可用的技能（skills），你必須完整遵守。

## 第二步：讀取規格文件

以下是本次需求相關的規格文件：
${docLines.join('\n')}

重要提示：
- PDF 檔案請使用 Read tool 來讀取，它們可能包含重要的圖片、表格和流程圖
- 如果 PDF 頁數過多，Read tool 會要求你分批讀取，請依照指示分頁讀取

## 第三步：產出計劃書（必須先完成才能動手寫程式）

在讀取完所有技能設定和規格文件後，你必須先產出一份詳細的實作計劃書，包含：

1. **需求摘要**：根據規格文件${requirement?.trim() ? '和上方的需求說明' : ''}歸納出你負責的功能需求
2. **任務拆解**：將需求拆解為具體的實作任務（每個任務要明確、可執行）
3. **實作順序**：按照依賴關係排出執行順序
4. **技術方案**：每個任務使用的技術方案，需符合 CLAUDE.md / skills 中定義的框架和慣例
5. **檔案清單**：預計需要建立或修改的檔案路徑

請將計劃書以 Markdown 格式輸出，並在計劃書末尾加上 **[PLAN_READY]** 標記。

## 第四步：執行計劃

計劃書產出後，按照計劃逐步實作。嚴格遵循技能設定中的規範（程式碼風格、框架慣例、檔案結構等）。

${this.getCompletionCriteria(role, testOptions)}

- 如需人工協助請加上 [NEEDS_HUMAN]`;
  }

  /** Get role-specific completion criteria */
  private getCompletionCriteria(role: string, testOptions?: TestOptions): string {
    if (role === 'frontend') {
      const opts = testOptions?.frontend;
      const lines: string[] = [
        '### 完成標準（前端）',
        '- 開發完成後，執行 build 指令（例如 npm run build / pnpm build），確保零錯誤',
      ];
      const apiMode = opts?.useRealApi ? '真實後端 API' : 'mock 資料（USE_MOCK=true）';
      if (opts?.smokeTest) {
        lines.push(
          `- Build 成功後，若工作目錄有\`.claude/skills/validate-output/SKILL.md\`，` +
          `**必須**呼叫該 skill 執行 playwright-mcp smoke test（使用 ${apiMode}），確認頁面渲染正常、無 JS 錯誤`,
          '- validate-output 失敗時，嘗試修復錯誤後重新執行；無法修復則加上 [NEEDS_HUMAN]',
        );
      }
      if (opts?.e2eSpec) {
        const mockNote = opts?.useRealApi
          ? '測試使用真實 API（USE_MOCK=false），確認後端服務已啟動'
          : '測試使用 mock 資料（USE_MOCK=true），不需要後端服務';
        lines.push(
          `- ${opts?.smokeTest ? 'Smoke test 通過後，' : ''}若 \`e2e/templates/\` 存在，` +
          `依照 \`e2e/templates/module-spec.template.ts\` 格式，為本次開發的模組在 \`e2e/\` 目錄撰寫 E2E spec 檔案（同時建立對應的 mock-data JSON）`,
          `- E2E spec 預設執行方式：${mockNote}`,
        );
      }
      lines.push('- 所有步驟完成後，在回應末尾加上 [TASK_COMPLETE]');
      return lines.join('\n');
    }
    if (role === 'backend') {
      const opts = testOptions?.backend;
      const lines: string[] = [
        '### 完成標準（後端）',
        '- 開發完成後，執行 build 指令，確保零錯誤',
      ];
      if (opts?.unitTests) {
        lines.push(
          '- 撰寫每個端點/模組的單元測試，執行所有測試（例如 npm test / pnpm test），確保全數通過',
          '- 在所有測試通過之前，**不要**標記 [TASK_COMPLETE]',
        );
      }
      if (opts?.apiSmokeTest) {
        lines.push(
          '- Build 成功後，若工作目錄有 `.claude/skills/validate-api/SKILL.md`，' +
          '**必須**呼叫該 skill 執行 API smoke test，確認端點回應正常',
          '- validate-api 失敗時，嘗試修復錯誤後重新執行；無法修復則加上 [NEEDS_HUMAN]',
        );
      }
      if (opts?.apiContract) {
        lines.push(
          '- 將本次開發的端點合約寫入 `.ai_context/api-contracts/{module}.json`（如目錄不存在請建立）',
        );
      }
      lines.push('- 所有步驟完成後，在回應末尾加上 [TASK_COMPLETE]');
      return lines.join('\n');
    }
    // Default for other roles
    return `- 完成後請在回應末尾加上 [TASK_COMPLETE]`;
  }

  /** Resolve workspace label to a valid AgentRole */
  private resolveRole(label: string): AgentRole {
    const validRoles: AgentRole[] = ['master', 'architect', 'backend', 'frontend', 'devops', 'testing', 'review'];
    if (validRoles.includes(label as AgentRole)) {
      return label as AgentRole;
    }
    // Default to 'backend' for unknown labels
    return 'backend';
  }

  /** Process the master agent's output into a task plan (kept for backward compat) */
  async processAgentResult(projectId: string, resultText: string): Promise<void> {
    // No longer used in the new direct-workspace flow
    logger.warn({ projectId }, 'processAgentResult called but no longer used in direct-workspace mode');
  }

  /** Clear all documents for a project */
  async clearDocuments(projectId: string): Promise<number> {
    return this.documentParser.deleteByProject(projectId);
  }

  /** Copy spec documents to workspace .ai_specs/ directory */
  private async copySpecsToWorkspace(workspace: Workspace, docs: ParsedDocument[]): Promise<string[]> {
    const specsDir = path.join(workspace.path, '.ai_specs');
    await fs.mkdir(specsDir, { recursive: true });

    const copiedFiles: string[] = [];

    for (const doc of docs) {
      const destFilename = `${doc.docType}_${doc.filename}`;
      const destPath = path.join(specsDir, destFilename);

      try {
        await fs.copyFile(doc.filePath, destPath);
        copiedFiles.push(destFilename);
        logger.info({ workspace: workspace.label, file: destFilename }, 'Spec file copied to workspace');
      } catch (err) {
        logger.error({ workspace: workspace.label, file: destFilename, err }, 'Failed to copy spec file');
      }
    }

    return copiedFiles;
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

  /** Inject specs into workspace before starting agent */
  private async injectSpecsToWorkspace(workspace: Workspace, docs: ParsedDocument[]): Promise<void> {
    if (docs.length === 0) return;

    // Step 1: Copy files to .ai_specs/
    const copiedFiles = await this.copySpecsToWorkspace(workspace, docs);

    // Step 2: Append index to CLAUDE.md
    if (copiedFiles.length > 0) {
      await this.appendSpecIndexToClaudeMd(workspace, copiedFiles);
    }
  }

  getDocumentParser(): DocumentParser {
    return this.documentParser;
  }

  /** Remove a deleted document from all workspaces (.ai_specs/ + CLAUDE.md index) */
  async removeDocumentFromWorkspaces(projectId: string, filename: string, docType: DocType): Promise<void> {
    const project = getProject(projectId);
    if (!project) {
      logger.warn({ projectId }, 'Cannot remove document from workspaces: project not found');
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
      return;
    }

    const destFilename = `${docType}_${filename}`;

    for (const ws of workspaces) {
      const role = ws.label.toLowerCase();
      const allowedDocTypes = DOC_ROUTING[role] || ['SA', 'SD'];

      // Only process if this doc type was applicable to this workspace
      if (!allowedDocTypes.includes(docType)) {
        continue;
      }

      // Delete the file from .ai_specs/
      const specsDir = path.join(ws.path, '.ai_specs');
      const destPath = path.join(specsDir, destFilename);

      try {
        await fs.unlink(destPath);
        logger.info({ workspace: ws.label, file: destFilename }, 'Spec file removed from workspace');
      } catch {
        // File may not exist — ignore
      }

      // Update CLAUDE.md with remaining docs
      const remainingDocs = this.documentParser.getDocuments(projectId);
      const wsDocs = remainingDocs.filter(d => allowedDocTypes.includes(d.docType));
      const remainingFiles = wsDocs.map(d => `${d.docType}_${d.filename}`);

      if (remainingFiles.length > 0) {
        await this.appendSpecIndexToClaudeMd(ws, remainingFiles);
      } else {
        // No docs left — remove the index section from CLAUDE.md
        await this.removeSpecIndexFromClaudeMd(ws);
      }
    }
  }

  /** Remove the spec index section from CLAUDE.md when no docs remain */
  private async removeSpecIndexFromClaudeMd(workspace: Workspace): Promise<void> {
    const claudeMdPath = path.join(workspace.path, 'CLAUDE.md');
    const marker = '<!-- AI_SPECS_INDEX -->';
    const endMarker = '<!-- END_AI_SPECS_INDEX -->';

    try {
      const content = await fs.readFile(claudeMdPath, 'utf-8');
      if (content.includes(marker)) {
        const regex = new RegExp(`\\n?${marker}[\\s\\S]*?${endMarker}\\n?`, 'g');
        const updatedContent = content.replace(regex, '');
        await fs.writeFile(claudeMdPath, updatedContent, 'utf-8');
        logger.info({ workspace: workspace.label }, 'Spec index removed from CLAUDE.md');
      }
    } catch {
      // File doesn't exist or other error — ignore
    }
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
