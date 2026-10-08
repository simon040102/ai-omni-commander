import fs from 'node:fs';
import path from 'node:path';

const FLOWS_DIR_NAME = 'sa-flows';

/**
 * SA 操作流程圖（Mermaid）的快取目錄讀取。
 *
 * 流程圖現在由 MCP 的 save_task_flow／save_sa_flow 寫入（mcp/flow-gate.ts 沿用同一組
 * `{projectId}-{hash}-flow.mmd`／`-meta.json` 命名），這裡只負責查路徑與列出。
 * 原本「用 PTY 呼叫 Claude 產生流程圖」的部分已隨 legacy spawn 移除。
 */
export class SaFlowAnalyzer {
  private flowsDir: string;

  constructor(dataDir: string) {
    this.flowsDir = path.join(dataDir, FLOWS_DIR_NAME);
    fs.mkdirSync(this.flowsDir, { recursive: true });
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
