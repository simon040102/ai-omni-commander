import path from 'node:path';
import fs from 'node:fs';
import type { AgentRole, SuperpowersFeature, TaskType, ProjectConfig, TestOptions } from '@omni/shared';
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
  async executeTask(taskId: string, model?: string, mockupFiles?: string[], testOptions?: TestOptions): Promise<string> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Guard: prevent duplicate spawning if already running
    if (task.status === 'in_progress' || task.status === 'assigned') {
      logger.warn({ taskId, status: task.status }, 'Task already running — skipping duplicate spawn');
      return '';
    }

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
      taskId,
      role: task.label,
      taskTitle: task.title,
      taskDescription: task.description || '',
      taskType: task.taskType,
      specResult,
      dbConnectionString: project.dbConnectionString,
      taskAttachments,
      svnDocuments,
      mockupFiles,
      testOptions,
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
    taskId?: string;
    role: string;
    taskTitle: string;
    taskDescription: string;
    taskType: TaskType;
    specResult?: SpecResult | null;
    dbConnectionString?: string | null;
    taskAttachments?: Array<{ filename: string; filePath: string; docType?: string }>;
    svnDocuments?: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null; docType: string | null }>;
    mockupFiles?: string[];
    testOptions?: TestOptions;
  }): string {
    const parts: string[] = [];

    // Layer 1: Superpowers methodology
    if (opts.superpowers.length > 0) {
      const spPrompt = loadSuperpowersPrompt(opts.superpowers);
      if (spPrompt) parts.push(spPrompt);
    }

    // Layer 2: Task-bound documents (SA/SD uploaded and bound to this specific task)
    const docContext = opts.taskId
      ? this.getDocumentContext(opts.taskId, opts.role)
      : null;
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

    // Layer 2.9: Mockup / Axure HTML snapshots
    if (opts.mockupFiles && opts.mockupFiles.length > 0) {
      parts.push(this.buildMockupSection(opts.mockupFiles));
    }

    // Layer 3: Task prompt
    const taskPrompt = this.buildTaskPrompt(opts.taskTitle, opts.taskDescription, opts.taskType, opts.role, opts.testOptions);
    parts.push(taskPrompt);

    return parts.join('\n\n---\n\n');
  }

  /**
   * Get documents/images associated with a specific task.
   * Checks the task's dedicated subfolder first, then falls back to legacy [task:id] prefix.
   */
  private getTaskAttachments(projectId: string, taskId: string): Array<{ filename: string; filePath: string; docType?: string }> {
    const task = getTask(taskId);
    const uploadDir = this.documentParser.getUploadDir();

    // Build a lookup map from filePath → docType using DB records
    const allDocs = this.documentParser.getDocuments(projectId);
    const docTypeByPath = new Map(allDocs.map(d => [d.filePath, d.docType]));

    // New: read from {uploadDir}/{projectId}/{functionCode}_{taskId8}/ subfolder
    const code = task?.parentName || null;
    const subFolder = code ? `${code}_${taskId.slice(0, 8)}` : `task_${taskId.slice(0, 8)}`;
    const taskDir = path.join(uploadDir, projectId, subFolder);
    if (fs.existsSync(taskDir)) {
      try {
        const entries = fs.readdirSync(taskDir);
        return entries
          .filter(e => !fs.statSync(path.join(taskDir, e)).isDirectory())
          .map(e => {
            const filePath = path.join(taskDir, e);
            return { filename: e, filePath, docType: docTypeByPath.get(filePath) };
          });
      } catch { /* fall through */ }
    }

    // Fallback: legacy [task:id] prefix in flat project folder
    const prefix = `[task:${taskId}]`;
    return allDocs
      .filter(d => d.filename.startsWith(prefix))
      .map(d => ({ filename: d.filename, filePath: d.filePath, docType: d.docType }));
  }

  /**
   * Build the task attachments section (images, documents uploaded per task).
   * Documents with SA/SD docType are shown as spec files, not generic attachments.
   */
  private buildAttachmentsSection(attachments: Array<{ filename: string; filePath: string; docType?: string }>): string {
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const images = attachments.filter(a => IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)));
    const specDocs = attachments.filter(a =>
      !IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)) &&
      (a.docType === 'SA' || a.docType === 'SD')
    );
    const otherDocs = attachments.filter(a =>
      !IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)) &&
      a.docType !== 'SA' && a.docType !== 'SD'
    );

    const lines: string[] = ['## 任務附件'];

    if (specDocs.length > 0) {
      lines.push('');
      lines.push('### 規格文件（手動上傳）');
      lines.push('');
      lines.push('以下規格文件由使用者指定，請使用 Read 工具閱讀，**這是主要的實作依據**：');
      lines.push('');
      for (const doc of specDocs) {
        const cleanName = doc.filename.replace(/\[task:[^\]]+\]\s*/, '').replace(/^[a-f0-9-]+-/, '');
        const tag = doc.docType === 'SA' ? '[SA 前端規格]' : '[SD 後端規格]';
        lines.push(`- **${tag} ${cleanName}**: 請用 Read tool 讀取 \`${doc.filePath.replace(/\\/g, '/')}\``);
      }
    }

    if (images.length > 0) {
      lines.push('');
      lines.push('### 截圖 / 圖片');
      lines.push('');
      lines.push('以下圖片與本次任務相關，請使用 Read 工具閱讀以了解視覺上下文：');
      lines.push('');
      for (const img of images) {
        const cleanName = img.filename.replace(/\[task:[^\]]+\]\s*/, '');
        lines.push(`- **${cleanName}**: \`${img.filePath.replace(/\\/g, '/')}\``);
      }
    }

    if (otherDocs.length > 0) {
      lines.push('');
      lines.push('### 其他附件');
      lines.push('');
      for (const doc of otherDocs) {
        const cleanName = doc.filename.replace(/\[task:[^\]]+\]\s*/, '');
        lines.push(`- **${cleanName}**: \`${doc.filePath.replace(/\\/g, '/')}\``);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build prompt section for Axure mockup HTML snapshots selected by the user.
   */
  private buildMockupSection(filePaths: string[]): string {
    const lines: string[] = ['## Mockup 參考畫面（Axure 原型，僅供參考）', ''];
    lines.push('以下是本次任務對應的 UI Mockup HTML 截圖，**僅供視覺參考，實作依據以 SA 規格文件為準**。');
    lines.push('必要時才使用 Read 工具閱讀這些檔案（例如需要確認欄位名稱、按鈕位置等畫面細節）：');
    lines.push('');
    for (const fp of filePaths) {
      const filename = fp.split(/[\\/]/).pop() || fp;
      lines.push(`- **${filename}**: \`${fp.replace(/\\/g, '/')}\``);
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
   * Only provides file paths — agent must use Read tool to access content.
   * This prevents spec content from being lost when conversation is compressed.
   */
  private buildSvnDocsSection(docs: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null; docType: string | null }>): string {
    const lines: string[] = ['## SVN 規格文件（自動取得）', ''];
    lines.push('以下規格文件已從 SVN 自動下載，與本次任務相關。');
    lines.push('**重要**：請使用 Read 工具讀取這些文件。如果對話被壓縮導致你忘記規格內容，請重新讀取這些檔案。');
    lines.push('');

    for (const doc of docs) {
      const typeLabel = doc.docType === 'SA' ? '(SA 需求規格)' : doc.docType === 'SD' ? '(SD 系統設計)' : '';
      const isPdf = doc.filename.toLowerCase().endsWith('.pdf');
      const mdMatch = doc.parsedText?.match(/^\[Document saved at: (.+)\]/);
      const hasText = doc.parsedText && !doc.parsedText.startsWith('[') && doc.parsedText.length > 50;
      lines.push(`### ${doc.filename} ${typeLabel}`);
      if (isPdf) {
        lines.push(`路徑：\`${doc.filePath}\`（請用 Read tool 讀取，PDF 包含文字與圖片）`);
      } else if (mdMatch) {
        lines.push(`路徑：\`${mdMatch[1]}\`（請用 Read tool 讀取 Markdown，含文字與圖片路徑）`);
      } else if (hasText) {
        lines.push('');
        lines.push(doc.parsedText!);
      } else {
        lines.push(`路徑：\`${doc.filePath}\``);
      }
      lines.push('');
    }

    lines.push('請理解以上所有規格文件內容後再開始開發。');

    return lines.join('\n');
  }

  /**
   * Get document context for an agent based on task binding.
   * Only returns documents explicitly bound to this task (via task_documents table).
   * Frontend gets SA+SD, Backend gets SD only.
   * SVN documents are excluded here — they are handled separately in Layer 2.6.
   */
  private getDocumentContext(taskId: string, role: string): string | null {
    const allTaskDocs = getDocumentsForTask(taskId).filter(d => d.source !== 'svn');
    if (allTaskDocs.length === 0) return null;

    const filteredDocs = allTaskDocs.filter(d => {
      if (role === 'backend') return d.docType === 'SD';
      return true;
    });

    // Remap to match the shape used below
    const docs = filteredDocs.map(d => ({
      docType: d.docType,
      filename: d.filename,
      filePath: d.filePath,
      content: d.parsedText,
    }));

    if (docs.length === 0) return null;

    const sections = docs.map(d => {
      const typeLabel = d.docType || 'Document';
      const isPdf = d.filename.toLowerCase().endsWith('.pdf');
      const mdMatch = d.content?.match(/^\[Document saved at: (.+)\]/);
      const imgMatch = d.content?.match(/^\[Image saved at: (.+)\]/);
      const hasText = d.content && !d.content.startsWith('[') && d.content.length > 50;

      if (isPdf) {
        return `- **${typeLabel}: ${d.filename}**: 請用 Read tool 讀取 "${d.filePath}"（PDF 包含文字與圖片）`;
      }
      if (mdMatch) {
        return `- **${typeLabel}: ${d.filename}**: 請用 Read tool 讀取 "${mdMatch[1]}"（Markdown 含文字與圖片路徑）`;
      }
      if (imgMatch) {
        return `- **${typeLabel}: ${d.filename}**: 請用 Read tool 讀取 "${imgMatch[1]}"（截圖圖片）`;
      }
      if (hasText) {
        return `### ${typeLabel}: ${d.filename}\n\n${d.content}`;
      }
      return `- **${typeLabel}: ${d.filename}**\n  路徑：\`${d.filePath}\``;
    });

    const hasInlineText = docs.some(d => {
      const hasText = d.content && !d.content.startsWith('[') && d.content.length > 50;
      return hasText;
    });

    const header = hasInlineText
      ? `# Project Documents\n\n以下是本次任務的相關文件內容：`
      : `# Project Documents\n\n以下文件與本次任務相關。**請使用 Read 工具讀取這些文件**。`;

    return `${header}\n\n${sections.join('\n\n')}\n\n請理解以上文件內容後再開始開發。`;
  }

  /**
   * Build the task-specific prompt section.
   */
  private buildTaskPrompt(title: string, description: string, taskType: TaskType, role?: string, testOptions?: TestOptions): string {
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

${this.buildCompletionCriteria(role, testOptions)}
- 如果遇到需要人工決策的問題，請加上 [NEEDS_HUMAN] 並說明原因`;
  }

  private buildCompletionCriteria(role?: string, testOptions?: TestOptions): string {
    if (role === 'frontend') {
      const opts = testOptions?.frontend;
      const lines: string[] = [
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
    return `- 完成任務後，如果專案有測試，請執行測試確保通過
- 如果是前端專案，請執行 build 確保成功
- 確認完成後，在回應末尾加上 [TASK_COMPLETE]`;
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
