import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
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
  private client: Anthropic;

  constructor(dataDir: string) {
    this.flowsDir = path.join(dataDir, FLOWS_DIR_NAME);
    fs.mkdirSync(this.flowsDir, { recursive: true });
    this.client = new Anthropic();
  }

  /**
   * Analyze SA document and return Mermaid flow diagram.
   * Uses content hash as cache key — same content = skip re-generation.
   */
  async analyze(opts: {
    projectId: string;
    saContent: string;
    sourceFilename: string;
    taskType: string;
    taskDescription: string;
  }): Promise<SaFlowResult | null> {
    const { projectId, saContent, sourceFilename, taskType, taskDescription } = opts;

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
    } else {
      // Generate full flowchart via Claude API
      logger.info({ sourceFilename, hash }, 'Generating SA flow diagram');
      fullFlow = await this.generateFullFlow(saContent, sourceFilename);

      if (!fullFlow) return null;

      // Save to cache
      fs.writeFileSync(flowPath, fullFlow, 'utf-8');
      fs.writeFileSync(metaPath, JSON.stringify({
        hash,
        generatedAt: new Date().toISOString(),
        sourceFilename,
        projectId,
      }, null, 2), 'utf-8');

      logger.info({ flowPath }, 'SA flow saved to cache');
    }

    // Extract relevant subset based on taskType
    const relevantFlow = await this.extractRelevantFlow(fullFlow, taskType, taskDescription);

    return { fullFlow, relevantFlow, flowPath };
  }

  private async generateFullFlow(saContent: string, filename: string): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: 'claude-opus-4-5',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `你是 SA 規格分析師。請分析以下 SA（需求規格）文件，產出前端操作流程的 Mermaid flowchart。

**要求：**
- 只輸出 mermaid 程式碼，不要任何解釋文字
- 使用 \`flowchart TD\` 格式
- 涵蓋所有主要操作路徑（查詢、新增、編輯、刪除、送簽等）
- 包含條件分支（有/無資料、權限判斷、狀態判斷等）
- 節點標籤使用中文，簡潔描述動作
- 不超過 50 個節點

**SA 文件（${filename}）：**

${saContent.slice(0, 8000)}

請直接輸出 mermaid 程式碼：`,
        }],
      });

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

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
    try {
      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `以下是一份前端操作流程圖（Mermaid）。

任務類型：${taskType === 'bug' ? 'Bug 修復' : '測試'}
任務描述：${taskDescription}

請從流程圖中，只保留與此任務**直接相關**的路徑，其他節點移除。
只輸出 mermaid 程式碼，不要解釋。

完整流程圖：
\`\`\`mermaid
${fullFlow}
\`\`\``,
        }],
      });

      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { type: 'text'; text: string }).text)
        .join('');

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
  listProjectFlows(projectId: string): Array<{ hash: string; filename: string; generatedAt: string; flowPath: string }> {
    try {
      const files = fs.readdirSync(this.flowsDir);
      const results: Array<{ hash: string; filename: string; generatedAt: string; flowPath: string }> = [];
      for (const f of files) {
        if (!f.startsWith(projectId) || !f.endsWith('-meta.json')) continue;
        const meta = JSON.parse(fs.readFileSync(path.join(this.flowsDir, f), 'utf-8'));
        const flowFile = f.replace('-meta.json', '-flow.mmd');
        if (fs.existsSync(path.join(this.flowsDir, flowFile))) {
          results.push({ ...meta, flowPath: path.join(this.flowsDir, flowFile) });
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
