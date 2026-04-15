import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SaFlowAnalyzer');

const FLOWS_DIR_NAME = 'sa-flows';

export interface SaFlowResult {
  /** Full Mermaid flowchart content */
  fullFlow: string;
  /** Subset relevant to the taskType/description */
  relevantFlow: string;
  /** Path to the cached .mmd file */
  flowPath: string;
}

export class SaFlowAnalyzer {
  private flowsDir: string;

  constructor(dataDir: string) {
    this.flowsDir = path.join(dataDir, FLOWS_DIR_NAME);
    fs.mkdirSync(this.flowsDir, { recursive: true });
  }

  private async callClaude(prompt: string, model = 'claude-sonnet-4-6'): Promise<string> {
    let text = '';
    const q = query({
      prompt,
      options: { model, permissionMode: 'bypassPermissions' },
    });
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const m = msg as SDKAssistantMessage;
        for (const block of m.message.content) {
          if (block.type === 'text') text += block.text;
        }
      }
    }
    return text;
  }

  /**
   * Analyze SA document and return Mermaid flow diagram.
   * Uses content hash as cache key — same content = skip re-generation.
   */
  async analyze(opts: {
    projectId: string;
    taskId?: string;
    saContent: string;
    sourceFilename: string;
    taskType: string;
    taskDescription: string;
  }): Promise<SaFlowResult | null> {
    const { projectId, taskId, saContent, sourceFilename, taskType, taskDescription } = opts;

    if (!saContent || saContent.trim().length < 100) {
      logger.warn({ sourceFilename }, 'SA content too short, skipping flow analysis');
      return null;
    }

    // Compute hash of SA content
    const hash = crypto.createHash('sha256').update(saContent).digest('hex').slice(0, 16);
    const flowPath = path.join(this.flowsDir, `${projectId}-${hash}-flow.mmd`);
    const metaPath = path.join(this.flowsDir, `${projectId}-${hash}-meta.json`);

    let fullFlow: string;

    // Check cache
    if (fs.existsSync(flowPath)) {
      fullFlow = fs.readFileSync(flowPath, 'utf-8');
      logger.info({ sourceFilename, hash }, 'SA flow cache hit');
      // Update taskIds in existing meta if taskId not already recorded
      if (taskId && fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          if (!meta.taskIds) meta.taskIds = [];
          if (!meta.taskIds.includes(taskId)) {
            meta.taskIds.push(taskId);
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
          }
        } catch { /* ignore */ }
      }
    } else {
      // Generate full flowchart via Claude
      logger.info({ sourceFilename, hash }, 'Generating SA flow diagram');
      fullFlow = await this.generateFullFlow(saContent, sourceFilename);

      if (!fullFlow) return null;

      // Save to cache
      fs.writeFileSync(flowPath, fullFlow, 'utf-8');
      fs.writeFileSync(metaPath, JSON.stringify({
        hash,
        generatedAt: new Date().toISOString(),
        filename: sourceFilename,
        projectId,
        taskIds: taskId ? [taskId] : [],
      }, null, 2), 'utf-8');
      logger.info({ flowPath }, 'SA flow saved to cache');
    }

    // Extract relevant subset based on taskType
    const relevantFlow = await this.extractRelevantFlow(fullFlow, taskType, taskDescription);

    return { fullFlow, relevantFlow, flowPath };
  }

  private async generateFullFlow(saContent: string, filename: string): Promise<string> {
    const prompt = `你是 SA 規格分析師。請分析以下 SA（需求規格）文件，產出前端操作流程的 Mermaid flowchart。

**要求：**
- 只輸出 mermaid 程式碼，不要任何解釋文字
- 使用 \`flowchart TD\` 格式
- 涵蓋所有主要操作路徑（查詢、新增、編輯、刪除、送簽等）
- 包含條件分支（有/無資料、權限判斷、狀態判斷等）
- 節點標籤使用中文，簡潔描述動作
- 不超過 50 個節點

**SA 文件（${filename}）：**

${saContent.slice(0, 8000)}

請直接輸出 mermaid 程式碼：`;

    try {
      const text = await this.callClaude(prompt);

      // Extract mermaid block
      const mmdMatch = text.match(/```(?:mermaid)?\s*([\s\S]+?)```/);
      if (mmdMatch) return mmdMatch[1].trim();

      // If no code block, check if it starts with flowchart directly
      if (text.trim().startsWith('flowchart')) return text.trim();

      logger.warn({ filename }, 'Could not extract mermaid block from response');
      return '';
    } catch (err) {
      logger.error({ err, filename }, 'Failed to generate SA flow diagram');
      return '';
    }
  }

  private async extractRelevantFlow(fullFlow: string, taskType: string, taskDescription: string): Promise<string> {
    // For feature tasks, use the full flow
    if (taskType === 'feature' || !taskDescription.trim()) {
      return fullFlow;
    }

    // For bug/testing, extract relevant paths only
    const prompt = `以下是一份前端操作流程圖（Mermaid）。

任務類型：${taskType === 'bug' ? 'Bug 修復' : '測試'}
任務描述：${taskDescription}

請從流程圖中，只保留與此任務**直接相關**的路徑，其他節點移除。
只輸出 mermaid 程式碼，不要解釋。

完整流程圖：
\`\`\`mermaid
${fullFlow}
\`\`\``;

    try {
      const text = await this.callClaude(prompt, 'claude-haiku-4-5-20251001');

      const mmdMatch = text.match(/```(?:mermaid)?\s*([\s\S]+?)```/);
      if (mmdMatch) return mmdMatch[1].trim();
      if (text.trim().startsWith('flowchart')) return text.trim();
    } catch (err) {
      logger.warn({ err }, 'Failed to extract relevant flow, using full flow');
    }

    return fullFlow;
  }

  /** Return path to cached flow file for a given projectId + SA content hash */
  getFlowPath(projectId: string, saContentHash: string): string {
    return path.join(this.flowsDir, `${projectId}-${saContentHash}-flow.mmd`);
  }

  /** List all cached flows for a project */
  listProjectFlows(projectId: string): Array<{ hash: string; filename: string; generatedAt: string; flowPath: string; taskIds: string[] }> {
    try {
      const files = fs.readdirSync(this.flowsDir);
      const results: Array<{ hash: string; filename: string; generatedAt: string; flowPath: string; taskIds: string[] }> = [];
      for (const f of files) {
        if (!f.startsWith(projectId) || !f.endsWith('-meta.json')) continue;
        const meta = JSON.parse(fs.readFileSync(path.join(this.flowsDir, f), 'utf-8'));
        const flowFile = f.replace('-meta.json', '-flow.mmd');
        if (fs.existsSync(path.join(this.flowsDir, flowFile))) {
          results.push({
            hash: meta.hash,
            filename: meta.filename || meta.sourceFilename || '',
            generatedAt: meta.generatedAt,
            flowPath: path.join(this.flowsDir, flowFile),
            taskIds: meta.taskIds || [],
          });
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
