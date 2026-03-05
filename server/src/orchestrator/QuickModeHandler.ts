import type { Workspace, QuickTaskType } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { updateProject, getProject } from '../db/queries/projects.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('QuickModeHandler');

export interface QuickTask {
  type: QuickTaskType;
  description: string;
  errorLog?: string;
  relatedFiles?: string[];
}

const TASK_TYPE_LABELS: Record<QuickTaskType, string> = {
  bug: 'Bug Fix',
  change: 'Small Change',
  refactor: 'Refactor',
  other: 'Task',
};

/**
 * Handles the Quick Mode workflow:
 * 1. User describes a quick task (bug fix, small change, etc.)
 * 2. Single agent is spawned with a focused prompt
 * 3. Agent works on the task directly without spec documents
 */
export class QuickModeHandler {
  constructor(
    private agentManager: AgentManager,
    private eventBus: EventBus,
  ) {}

  /** Start execution for a quick task */
  async execute(projectId: string, quickTask: QuickTask, model?: string): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    // Parse workspace from project config
    let workspace: Workspace | undefined;
    if (project.configJson) {
      try {
        const cfg = JSON.parse(project.configJson) as { workspaces?: Workspace[] };
        workspace = cfg.workspaces?.[0];
      } catch { /* ignore */ }
    }

    if (!workspace) {
      throw new Error('No workspace configured for this project');
    }

    updateProject(projectId, { status: 'executing' });

    const prompt = this.buildQuickPrompt(workspace, quickTask);

    logger.info(
      { projectId, workspace: workspace.label, taskType: quickTask.type, model: model || 'sonnet' },
      'Starting quick task agent',
    );

    await this.agentManager.startAgent({
      projectId,
      role: 'backend', // Use a generic role for quick tasks
      prompt,
      model: model || 'sonnet',
    });

    logger.info({ projectId }, 'Quick task agent started');
  }

  /** Build the prompt for a quick task */
  private buildQuickPrompt(workspace: Workspace, task: QuickTask): string {
    const taskTypeLabel = TASK_TYPE_LABELS[task.type];

    let contextSection = '';

    if (task.errorLog) {
      contextSection += `\n## 錯誤訊息 / Stack Trace

\`\`\`
${task.errorLog}
\`\`\`
`;
    }

    if (task.relatedFiles && task.relatedFiles.length > 0) {
      contextSection += `\n## 可能相關的檔案

以下檔案可能與此任務相關，請優先檢查：
${task.relatedFiles.map(f => `- ${f}`).join('\n')}
`;
    }

    const strategyByType: Record<QuickTaskType, string> = {
      bug: `## 修復策略

1. **分析問題**：根據描述和錯誤訊息，定位問題的根本原因
2. **找到相關程式碼**：使用 Grep/Glob 找到相關檔案
3. **理解現有邏輯**：閱讀相關程式碼，理解其運作方式
4. **制定修復方案**：確定最小改動的修復方式
5. **實作修復**：修改程式碼
6. **驗證修復**：如果有測試，執行測試確認修復成功`,

      change: `## 修改策略

1. **理解需求**：確認要做什麼改動
2. **找到相關程式碼**：使用 Grep/Glob 找到需要修改的檔案
3. **理解現有結構**：閱讀現有程式碼，理解其架構和風格
4. **制定修改方案**：規劃改動內容，確保符合現有風格
5. **實作修改**：修改程式碼
6. **驗證改動**：確保改動不會破壞現有功能`,

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

    return `你的工作目錄是 "${workspace.path}"。

# Quick Task: ${taskTypeLabel}

## 任務描述

${task.description}
${contextSection}
## 第一步：讀取專案設定

請先檢查工作目錄中是否有 CLAUDE.md 或 .claude/ 設定，如果有請讀取並遵循其中的指示和技能定義。

${strategyByType[task.type]}

## 完成標準

- 完成任務後，如果專案有測試，請執行測試確保通過
- 如果是前端專案，請執行 build 確保成功
- 確認完成後，在回應末尾加上 [TASK_COMPLETE]
- 如果遇到需要人工決策的問題，請加上 [NEEDS_HUMAN] 並說明原因`;
  }
}
