import type { AgentRole, SuperpowersFeature, TaskType, ProjectConfig } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { type SvnSpecService, extractFunctionCode } from '../svn/SvnSpecService.js';
import { SpecFetcher } from '../documents/SpecFetcher.js';
import type { SpecResult } from '../documents/SpecFetcher.js';
import { ModelRouter } from '../agent/ModelRouter.js';
import { getProject, updateProject } from '../db/queries/projects.js';
import { getTask, updateTask } from '../db/queries/tasks.js';
import { getDocumentsForTask } from '../db/queries/taskDocuments.js';
import { loadSuperpowersPrompt } from '../skills/superpowers/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ExecutionPipeline');

/**
 * Unified execution pipeline that replaces mode-specific handlers.
 * Handles both task-based execution and ad-hoc requirements.
 */
export class ExecutionPipeline {
  private specFetcher: SpecFetcher;
  private modelRouter = new ModelRouter();
  private svnSpecService: SvnSpecService | null = null;

  constructor(
    private agentManager: AgentManager,
    private eventBus: EventBus,
    private documentParser: DocumentParser,
    specCacheDir?: string,
  ) {
    this.specFetcher = new SpecFetcher(specCacheDir);
  }

  /** Inject SvnSpecService (optional, set after construction) */
  setSvnSpecService(svc: SvnSpecService): void {
    this.svnSpecService = svc;
  }

  /**
   * Execute a specific task from the task list.
   */
  async executeTask(taskId: string, model?: string): Promise<string> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const project = getProject(task.projectId);
    if (!project) throw new Error(`Project ${task.projectId} not found`);

    updateProject(task.projectId, { status: 'executing' });
    updateTask(taskId, { status: 'in_progress' });

    // Auto-select superpowers based on task type
    const superpowers = this.selectSuperpowers(task.taskType);

    // Parse project config (needed for SVN auth in spec fetch and auto-fetch)
    const projectConfig = project.configJson ? JSON.parse(project.configJson) as ProjectConfig : null;

    // Fetch spec content if available (pass svnConfig so SVN https:// URLs get auth)
    let specResult: SpecResult | null = null;
    if (task.specUrl) {
      try {
        specResult = await this.specFetcher.fetch(task.specUrl, projectConfig?.svnConfig);
        logger.info({ taskId, specUrl: task.specUrl, type: specResult.type }, 'Fetched spec');
      } catch (err) {
        logger.warn({ err, taskId, specUrl: task.specUrl }, 'Failed to fetch spec content');
      }
    }
    // Auto-fetch SVN spec documents:
    // Priority 1: use parentName (from Asana parent task, e.g. "OV0101")
    // Priority 2: extract function code from task title (e.g. "IC01 修改發票查詢" → "IC01")
    let svnDocIds: string[] = [];
    const functionCode = task.parentName || extractFunctionCode(task.title);
    if (functionCode && projectConfig?.svnConfig && this.svnSpecService) {
      try {
        svnDocIds = await this.svnSpecService.fetchSpecsForTask(
          task.projectId, taskId, functionCode, projectConfig.svnConfig, task.label,
        );
        logger.info({ taskId, functionCode, source: task.parentName ? 'parentName' : 'title', docCount: svnDocIds.length }, 'Fetched SVN specs');
      } catch (err) {
        logger.warn({ err, taskId, functionCode }, 'Failed to fetch SVN spec documents');
      }
    }

    // Find task-associated attachments (documents with [task:id] prefix)
    const taskAttachments = this.getTaskAttachments(task.projectId, taskId);

    // Get SVN-bound documents for this task, filtered by role:
    // Frontend agent → SA + SD, Backend agent → SD only
    const allSvnDocs = svnDocIds.length > 0 ? getDocumentsForTask(taskId).filter(d => d.source === 'svn') : [];
    const svnDocuments = task.label === 'backend'
      ? allSvnDocs.filter(d => d.docType === 'SD')
      : allSvnDocs;  // frontend / others get SA + SD

    // Assemble context
    const prompt = this.assembleContext({
      superpowers,
      projectId: task.projectId,
      role: task.label,
      taskTitle: task.title,
      taskDescription: task.description || '',
      taskType: task.taskType,
      specResult,
      dbConnectionString: project.dbConnectionString,
      taskAttachments,
      svnDocuments,
    });

    // Resolve working directory
    const workingDir = this.resolveWorkingDir(project, task.label);

    const agentRole: AgentRole = task.label as AgentRole;

    // Auto-route model based on task characteristics
    const { model: autoModel, reasoning } = this.modelRouter.selectModel(task);
    const finalModel = model || autoModel;

    logger.info({
      taskId, projectId: task.projectId, taskType: task.taskType,
      role: agentRole, superpowers, model: finalModel, modelReasoning: reasoning,
    }, 'Executing task');

    const agentId = await this.agentManager.startAgent({
      projectId: task.projectId,
      role: agentRole,
      taskId,
      prompt,
      model: finalModel,
      workingDir,
      useWorkspaceSkills: true,
    });

    return agentId;
  }

  /**
   * Execute an ad-hoc requirement (not tied to a task record).
   * Backward-compatible with v1 execution flow.
   */
  async executeAdHoc(
    projectId: string,
    requirement: string,
    model?: string,
    role?: string,
  ): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    updateProject(projectId, { status: 'executing' });

    // Classify the requirement to auto-select superpowers
    const taskType = this.classifyTask(requirement);
    const superpowers = this.selectSuperpowers(taskType);

    const agentRole: AgentRole = (role || 'backend') as AgentRole;

    const prompt = this.assembleContext({
      superpowers,
      projectId,
      role: agentRole,
      taskTitle: 'Ad-hoc Task',
      taskDescription: requirement,
      taskType,
      dbConnectionString: project.dbConnectionString,
    });

    const workingDir = this.resolveWorkingDir(project, agentRole);

    logger.info({
      projectId, taskType, role: agentRole, superpowers, model,
    }, 'Executing ad-hoc requirement');

    await this.agentManager.startAgent({
      projectId,
      role: agentRole,
      prompt,
      model: model || 'sonnet',
      workingDir,
      useWorkspaceSkills: true,
    });
  }

  /**
   * Classify a task description into a TaskType.
   */
  classifyTask(description: string): TaskType {
    const lower = description.toLowerCase();

    // Bug indicators
    if (/\b(bug|fix|error|crash|broken|fail|issue|problem|wrong|incorrect)\b/.test(lower)) {
      return 'bug';
    }

    // Refactor indicators
    if (/\b(refactor|restructure|reorganize|consolidate|simplify|clean\s*up|extract|decouple)\b/.test(lower)) {
      return 'refactor';
    }

    // Feature indicators
    if (/\b(add|create|implement|build|new|feature|support|enable|introduce)\b/.test(lower)) {
      return 'feature';
    }

    return 'other';
  }

  /**
   * Select superpowers methodology based on task type.
   * Superpowers are now always-on (standard) in v2.
   */
  selectSuperpowers(taskType: TaskType): SuperpowersFeature[] {
    switch (taskType) {
      case 'bug':
        return ['debugging'];
      case 'feature':
        return ['brainstorm', 'tdd'];
      case 'refactor':
        return ['brainstorm'];
      default:
        return [];
    }
  }

  /**
   * Assemble the full agent prompt with layered context.
   */
  assembleContext(opts: {
    superpowers: SuperpowersFeature[];
    projectId: string;
    role: string;
    taskTitle: string;
    taskDescription: string;
    taskType: TaskType;
    specResult?: SpecResult | null;
    dbConnectionString?: string | null;
    taskAttachments?: Array<{ filename: string; filePath: string }>;
    svnDocuments?: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null }>;
  }): string {
    const parts: string[] = [];

    // Layer 1: Superpowers methodology
    if (opts.superpowers.length > 0) {
      const spPrompt = loadSuperpowersPrompt(opts.superpowers);
      if (spPrompt) parts.push(spPrompt);
    }

    // Layer 2: Project documents (SA/SD routed by role)
    const docContext = this.getDocumentContext(opts.projectId, opts.role);
    if (docContext) parts.push(docContext);

    // Layer 2.5: Spec content (if available)
    if (opts.specResult) {
      parts.push(this.buildSpecSection(opts.specResult));
    }

    // Layer 2.6: SVN specification documents (auto-fetched)
    if (opts.svnDocuments && opts.svnDocuments.length > 0) {
      parts.push(this.buildSvnDocsSection(opts.svnDocuments));
    }

    // Layer 2.7: Database connection info (primarily for backend)
    if (opts.dbConnectionString) {
      parts.push(this.buildDbSection(opts.dbConnectionString));
    }

    // Layer 2.8: Task attachments (images, documents uploaded per task)
    if (opts.taskAttachments && opts.taskAttachments.length > 0) {
      parts.push(this.buildAttachmentsSection(opts.taskAttachments));
    }

    // Layer 3: Task prompt
    const taskPrompt = this.buildTaskPrompt(opts.taskTitle, opts.taskDescription, opts.taskType);
    parts.push(taskPrompt);

    return parts.join('\n\n---\n\n');
  }

  /**
   * Get documents/images associated with a specific task via filename prefix convention.
   */
  private getTaskAttachments(projectId: string, taskId: string): Array<{ filename: string; filePath: string }> {
    const prefix = `[task:${taskId}]`;
    const docs = this.documentParser.getDocuments(projectId);
    return docs
      .filter(d => d.filename.startsWith(prefix))
      .map(d => ({ filename: d.filename, filePath: d.filePath }));
  }

  /**
   * Build the task attachments section (images, documents uploaded per task).
   */
  private buildAttachmentsSection(attachments: Array<{ filename: string; filePath: string }>): string {
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const images = attachments.filter(a => IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)));
    const docs = attachments.filter(a => !IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)));

    const lines: string[] = ['## 任務附件'];

    if (images.length > 0) {
      lines.push('');
      lines.push('### 截圖 / 圖片');
      lines.push('');
      lines.push('以下圖片與本次任務相關，請使用 Read 工具閱讀以了解視覺上下文：');
      lines.push('');
      for (const img of images) {
        const cleanName = img.filename.replace(/\[task:[^\]]+\]\s*/, '');
        lines.push(`- **${cleanName}**: \`${img.filePath}\``);
      }
    }

    if (docs.length > 0) {
      lines.push('');
      lines.push('### 附件文件');
      lines.push('');
      for (const doc of docs) {
        const cleanName = doc.filename.replace(/\[task:[^\]]+\]\s*/, '');
        lines.push(`- **${cleanName}**: \`${doc.filePath}\``);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build the database connection info section for agents.
   */
  private buildDbSection(connectionString: string): string {
    return `## 資料庫連線資訊

以下是本專案的資料庫連線字串，可用於查詢或操作資料庫：

\`\`\`
${connectionString}
\`\`\`

**注意**：請謹慎使用此連線資訊。在執行任何 DDL 或資料修改操作前，請先確認操作的正確性。`;
  }

  /**
   * Build the spec section based on the type of spec result.
   */
  private buildSpecSection(spec: SpecResult): string {
    switch (spec.type) {
      case 'content':
        return `## 規格文件\n\n以下是本次任務的參考規格（來源：${spec.path}）：\n\n---\n${spec.content}\n---`;

      case 'file':
        return `## 規格文件\n\n規格文件已下載到本地（來源：${spec.path}）：\n\n文件路徑：\`${spec.filePath}\`\n\n**指示**：請使用 Read 工具讀取此文件。`;

      case 'directory':
        return `## 規格文件目錄\n\n以下是規格文件的根目錄：${spec.path}\n\n目錄中找到的規格相關文件：\n${spec.content}\n\n**指示**：請使用 Read 工具讀取上述目錄中與本次任務相關的文件。根據任務名稱和描述，選擇最可能相關的文件來閱讀。`;

      case 'svn-root':
        return `## 規格文件目錄 (SVN)\n\nSVN 規格根目錄：${spec.path}\n\n目錄中找到的規格相關文件：\n${spec.content}\n\n**指示**：請使用 \`svn cat "${spec.path}/<filename>"\` 命令來讀取上述目錄中與本次任務相關的文件。根據任務名稱和描述，選擇最可能相關的文件來閱讀。`;
    }
  }

  /**
   * Build prompt section for SVN-fetched specification documents.
   */
  private buildSvnDocsSection(docs: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null }>): string {
    const lines: string[] = ['## SVN 規格文件（自動取得）', ''];
    lines.push('以下規格文件已從 SVN 自動下載，與本次任務相關：');
    lines.push('');

    for (const doc of docs) {
      const ext = doc.filename.split('.').pop()?.toLowerCase();

      if (ext === 'pdf') {
        lines.push(`### ${doc.filename}`);
        lines.push(`PDF 文件路徑：\`${doc.filePath}\``);
        lines.push('請使用 Read 工具讀取此 PDF 文件。');
        lines.push('');
      } else if (doc.parsedText && !doc.parsedText.startsWith('[')) {
        // Has extracted text content
        const truncated = doc.parsedText.length > 30000
          ? doc.parsedText.substring(0, 30000) + '\n\n... (內容過長，已截斷)'
          : doc.parsedText;
        lines.push(`### ${doc.filename}`);
        lines.push('');
        lines.push(truncated);
        lines.push('');
      } else {
        // Binary or no content — point to file
        lines.push(`### ${doc.filename}`);
        lines.push(`文件路徑：\`${doc.filePath}\``);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Get document context for an agent based on its role.
   * Frontend gets SA+SD, Backend gets SD only, others get SA+SD.
   */
  private getDocumentContext(projectId: string, role: string): string | null {
    const docs = this.documentParser.getDocuments(projectId);
    if (docs.length === 0) return null;

    const filteredDocs = docs.filter(d => {
      if (role === 'backend') return d.docType === 'SD';
      return true; // frontend and others get all docs
    });

    if (filteredDocs.length === 0) return null;

    const sections = filteredDocs.map(d => {
      if (d.fileType === 'application/pdf' || d.filename.endsWith('.pdf')) {
        return `### ${d.docType || 'Document'}: ${d.filename}\n\nPDF file at: ${d.filePath}\n(Use the Read tool to read this file)`;
      }
      const text = d.content || '(no content)';
      return `### ${d.docType || 'Document'}: ${d.filename}\n\n${text}`;
    });

    return `# Project Documents\n\n${sections.join('\n\n---\n\n')}`;
  }

  /**
   * Build the task-specific prompt section.
   */
  private buildTaskPrompt(title: string, description: string, taskType: TaskType): string {
    const typeLabels: Record<TaskType, string> = {
      bug: 'Bug Fix',
      feature: 'New Feature',
      refactor: 'Refactor',
      other: 'Task',
    };

    const strategies: Record<TaskType, string> = {
      bug: `## 修復策略

1. **分析問題**：根據描述和錯誤訊息，定位問題的根本原因
2. **找到相關程式碼**：使用 Grep/Glob 找到相關檔案
3. **理解現有邏輯**：閱讀相關程式碼，理解其運作方式
4. **制定修復方案**：確定最小改動的修復方式
5. **實作修復**：修改程式碼
6. **驗證修復**：如果有測試，執行測試確認修復成功`,

      feature: `## 開發策略

1. **理解需求**：確認要做什麼功能
2. **設計方案**：在寫程式之前先思考設計
3. **找到相關程式碼**：使用 Grep/Glob 找到相關檔案，理解現有架構
4. **寫測試**：先寫失敗測試（如果適用）
5. **實作功能**：按設計方案實作
6. **驗證功能**：執行測試和 build 確認成功`,

      refactor: `## 重構策略

1. **理解現有程式碼**：閱讀需要重構的程式碼
2. **識別問題**：找出程式碼中的問題（重複、複雜度、耦合等）
3. **制定重構計劃**：規劃重構步驟，確保每步都可驗證
4. **逐步重構**：按計劃進行重構，每步都確保功能正常
5. **驗證重構**：執行測試或手動驗證，確保行為不變`,

      other: `## 執行策略

1. **理解任務**：確認需要完成什麼
2. **搜尋相關程式碼**：找到相關的檔案和模組
3. **制定計劃**：規劃實作步驟
4. **執行任務**：按計劃實作
5. **驗證完成**：確認任務已正確完成`,
    };

    return `# ${typeLabels[taskType]}: ${title}

## 任務描述

${description}

## 第一步：讀取專案設定

請先檢查工作目錄中是否有 CLAUDE.md 或 .claude/ 設定，如果有請讀取並遵循其中的指示和技能定義。

${strategies[taskType]}

## 完成標準

- 完成任務後，如果專案有測試，請執行測試確保通過
- 如果是前端專案，請執行 build 確保成功
- 確認完成後，在回應末尾加上 [TASK_COMPLETE]
- 如果遇到需要人工決策的問題，請加上 [NEEDS_HUMAN] 並說明原因`;
  }

  /**
   * Resolve the working directory for an agent based on project config and role.
   */
  resolveWorkingDir(
    project: { workingDir: string; frontendPath: string | null; backendPath: string | null },
    label: string,
  ): string {
    if (label === 'frontend' && project.frontendPath) {
      return project.frontendPath;
    }
    if (label === 'backend' && project.backendPath) {
      return project.backendPath;
    }
    return project.workingDir;
  }
}
