import type { DocType, Workspace, AgentRole } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import type { TaskDispatcher } from './TaskDispatcher.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { DocumentParser, type ParsedDocument } from '../documents/DocumentParser.js';
import { updateProject, getProject } from '../db/queries/projects.js';
import { getConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';
import path from 'node:path';

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

  /** Upload a document for a project */
  async uploadDocument(
    projectId: string,
    filename: string,
    content: string,
    fileType: string,
    docType?: DocType,
  ): Promise<void> {
    await this.documentParser.saveAndParse(projectId, filename, content, fileType, docType || 'other');
    logger.info({ projectId, filename, docType: docType || 'other' }, 'Document uploaded');
  }

  /** Start execution: spawn one agent per workspace with appropriate documents */
  async execute(projectId: string, requirement?: string): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // Get all uploaded documents
    const docs = this.documentParser.getDocuments(projectId);
    if (docs.length === 0) {
      throw new Error('No documents uploaded for this project');
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
      throw new Error('No workspaces configured for this project');
    }

    updateProject(projectId, { status: 'executing' });

    // Initialize .ai_context directory
    await this.contextSync.init();

    // Spawn one agent per workspace
    for (const ws of workspaces) {
      const role = ws.label.toLowerCase() as AgentRole;
      const allowedDocTypes = DOC_ROUTING[role] || ['SA', 'SD', 'other'];

      // Filter documents for this workspace
      const wsDocs = docs.filter(d => allowedDocTypes.includes(d.docType));

      // If no matching docs and there are untyped docs, include 'other' docs as fallback
      const finalDocs = wsDocs.length > 0 ? wsDocs : docs.filter(d => d.docType === 'other');

      if (finalDocs.length === 0) {
        logger.warn({ projectId, workspace: ws.label }, 'No matching documents for workspace, skipping');
        continue;
      }

      const prompt = this.buildWorkspacePrompt(ws, finalDocs, role, requirement);

      logger.info(
        { projectId, workspace: ws.label, role, docCount: finalDocs.length },
        'Starting workspace agent',
      );

      await this.agentManager.startAgent({
        projectId,
        role: this.resolveRole(role),
        prompt,
        model: 'sonnet',
      });
    }

    logger.info({ projectId, workspaceCount: workspaces.length }, 'All workspace agents started');
  }

  /** Build the prompt for a workspace agent */
  private buildWorkspacePrompt(workspace: Workspace, docs: ParsedDocument[], role: string, requirement?: string): string {
    const docLines = docs.map(d => {
      const typeTag = d.docType !== 'other' ? `[${d.docType}] ` : '';
      const isPdf = d.filename.toLowerCase().endsWith('.pdf');
      if (isPdf) {
        return `- ${typeTag}${d.filename}: 請用 Read tool 讀取 "${d.filePath}"（PDF 包含文字與圖片）`;
      }
      return `- ${typeTag}${d.filename}:\n${d.content}`;
    });

    const requirementSection = requirement?.trim()
      ? `\n## 本次需求說明\n\n${requirement.trim()}\n`
      : '';

    return `你的工作目錄是 "${workspace.path}"（${workspace.label}）。
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

${this.getCompletionCriteria(role)}

- 如需人工協助請加上 [NEEDS_HUMAN]`;
  }

  /** Get role-specific completion criteria */
  private getCompletionCriteria(role: string): string {
    if (role === 'frontend') {
      return `### 完成標準（前端）
- 開發完成後，執行專案的 build 指令（例如 npm run build / pnpm build）
- 確保 build 成功、零錯誤
- 你**不需要**撰寫或執行測試，只需確保能成功 build
- Build 成功後請在回應末尾加上 [TASK_COMPLETE]`;
    }
    if (role === 'backend') {
      return `### 完成標準（後端）
- 開發完成後，撰寫每個端點/模組的單元測試
- 執行所有測試（例如 npm test / pnpm test）
- 確保所有測試通過、零失敗
- 在所有測試通過之前，**不要**標記 [TASK_COMPLETE]
- 所有測試通過後請在回應末尾加上 [TASK_COMPLETE]`;
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

  getDocumentParser(): DocumentParser {
    return this.documentParser;
  }
}
