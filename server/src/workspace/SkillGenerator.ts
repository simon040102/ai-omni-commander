import type { AgentManager } from '../agent/AgentManager.js';
import { WorkspaceScanner } from './WorkspaceScanner.js';
import { upsertWorkspaceSkills } from '../db/queries/workspaceSkills.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SkillGenerator');

/**
 * Generates CLAUDE.md for a workspace by spawning an architect agent
 * that analyzes the codebase and writes project-specific instructions.
 */
export class SkillGenerator {
  private scanner = new WorkspaceScanner();

  constructor(private agentManager: AgentManager) {}

  /**
   * Generate CLAUDE.md for a workspace by spawning an architect agent.
   * Returns the agent ID for tracking.
   */
  async generate(
    projectId: string,
    workspacePath: string,
    workspaceType: 'frontend' | 'backend',
  ): Promise<string> {
    const prompt = this.buildPrompt(workspaceType);

    logger.info({ projectId, workspacePath, workspaceType }, 'Generating CLAUDE.md via architect agent');

    const agentId = await this.agentManager.startAgent({
      projectId,
      role: 'architect',
      prompt,
      model: 'sonnet',
      workingDir: workspacePath,
      useWorkspaceSkills: false, // Don't load existing skills since we're generating them
    });

    // Set up a listener to re-scan when the agent completes
    // The agent completion is handled by AgentManager which emits events
    // We do the re-scan in a post-completion hook
    this.schedulePostScan(projectId, workspacePath, workspaceType, agentId);

    return agentId;
  }

  private schedulePostScan(
    projectId: string,
    workspacePath: string,
    workspaceType: 'frontend' | 'backend',
    agentId: string,
  ): void {
    // Poll for agent completion (simple approach - could be event-driven later)
    const check = setInterval(() => {
      try {
        const { getAgent } = require('../db/queries/agents.js') as typeof import('../db/queries/agents.js');
        const agent = getAgent(agentId);
        if (agent && (agent.status === 'stopped' || agent.status === 'error')) {
          clearInterval(check);
          // Re-scan workspace after agent finishes
          try {
            const result = this.scanner.scan(workspacePath);
            upsertWorkspaceSkills(projectId, workspaceType, {
              path: workspacePath,
              hasClaudeMd: result.hasClaudeMd,
              hasClaudeDir: result.hasClaudeDir,
              skills: result.skills,
            });
            logger.info({ projectId, workspaceType, hasClaudeMd: result.hasClaudeMd }, 'Post-generation scan complete');
          } catch (err) {
            logger.error({ err, projectId, workspaceType }, 'Post-generation scan failed');
          }
        }
      } catch {
        clearInterval(check);
      }
    }, 5000);

    // Safety: stop checking after 10 minutes
    setTimeout(() => clearInterval(check), 600000);
  }

  private buildPrompt(workspaceType: 'frontend' | 'backend'): string {
    if (workspaceType === 'frontend') {
      return `你是一位前端架構分析師。請分析此工作目錄的前端程式碼，然後建立或更新 CLAUDE.md 檔案。

## 分析重點

1. **專案結構**：資料夾結構、主要進入點
2. **框架與工具**：使用的框架（React/Vue/Angular/etc）、CSS 方案、狀態管理
3. **共用元件**：可重用的 UI 元件清單和用法
4. **路由結構**：頁面路由設定
5. **API 串接**：如何呼叫後端 API（fetch/axios/react-query etc）
6. **CSS 規則**：Tailwind config、CSS modules、或其他 CSS 方案的規則
7. **建置與開發**：dev server、build 指令、環境變數

## 輸出要求

請將分析結果寫入 CLAUDE.md，格式如下：
- 使用清晰的 Markdown 標題結構
- 包含具體的程式碼範例和檔案路徑
- 標明開發規範和注意事項
- 標明常用指令（dev、build、test、lint）

完成後在回應末尾加上 [TASK_COMPLETE]`;
    }

    return `你是一位後端架構分析師。請分析此工作目錄的後端程式碼，然後建立或更新 CLAUDE.md 檔案。

## 分析重點

1. **專案結構**：資料夾結構、主要進入點
2. **框架與工具**：使用的框架（Express/NestJS/Fastify/etc）、ORM、驗證庫
3. **資料庫架構**：Schema 定義、Migration 機制、查詢模式
4. **API 架構**：路由設計、Middleware 串接、認證/授權
5. **資料存取模式**：Repository pattern、Query builder、Raw SQL
6. **錯誤處理**：錯誤處理策略、自訂錯誤類別
7. **建置與開發**：dev server、build 指令、環境變數

## 輸出要求

請將分析結果寫入 CLAUDE.md，格式如下：
- 使用清晰的 Markdown 標題結構
- 包含具體的程式碼範例和檔案路徑
- 標明開發規範和注意事項
- 標明常用指令（dev、build、test、lint）
- 特別標注資料庫相關操作的安全注意事項

完成後在回應末尾加上 [TASK_COMPLETE]`;
  }
}
