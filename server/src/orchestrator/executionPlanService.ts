/**
 * 執行計畫的組裝——Web Server 的 /api/execution-plan 與 MCP 的 get_execution_plan 共用這一份。
 *
 * 原本只有 Web Server 組得出計畫，MCP 要 HTTP 呼叫它：Web Server 沒開，開工第一步就失敗。
 * 現在兩邊呼叫同一個函式、用同一套服務建法（目錄、快取位置都由 config 從 repo root 推導，
 * 與 cwd 無關），產出的計畫保證一致；Web 端點保留給除錯用。
 */
import path from 'node:path';
import { getConfig } from '../config.js';
import { getProject } from '../db/queries/projects.js';
import { getTask } from '../db/queries/tasks.js';
import { DocumentParser } from '../documents/DocumentParser.js';
import { SvnSpecService } from '../svn/SvnSpecService.js';
import { ExecutionPipeline } from './ExecutionPipeline.js';

export type PlanTrack = 'light' | 'full';

export interface ExecutionPlanResponse {
  prompt: string;
  workingDir: string;
  model: string;
  frontendPath: string | null;
  backendPath: string | null;
}

/** 規格上傳／轉檔目錄（SpecModeHandler 與 MCP 同一處） */
export function defaultUploadDir(): string {
  return path.join(getConfig().projectRoot, 'data', 'uploads');
}

/** 建立組計畫需要的服務。目錄與 Web Server 啟動時完全相同（都在 DB 所在的 data 目錄下）。 */
export function createExecutionPlanServices(parser: DocumentParser = new DocumentParser(defaultUploadDir())): {
  parser: DocumentParser; pipeline: ExecutionPipeline; svnSpecService: SvnSpecService;
} {
  const dataDir = path.dirname(getConfig().dbPath);
  const pipeline = new ExecutionPipeline(parser, path.join(dataDir, 'spec-cache'));
  const svnSpecService = new SvnSpecService(parser, path.join(dataDir, 'svn-cache'));
  pipeline.setSvnSpecService(svnSpecService);
  return { parser, pipeline, svnSpecService };
}

/**
 * 組一份執行計畫（原 /api/execution-plan 端點的本體，逐行搬過來）。
 * role 為 frontend/backend 時取該角色的計畫；否則依任務 label。
 */
export async function buildExecutionPlanResponse(
  pipeline: ExecutionPipeline, taskId: string, role: string | undefined, track: PlanTrack,
): Promise<ExecutionPlanResponse> {
  let result: { prompt: string; workingDir: string; model: string };
  if (role && (role === 'frontend' || role === 'backend')) {
    result = await pipeline.preparePromptForRole(taskId, role, { track });
  } else {
    result = await pipeline.buildExecutionPlan(taskId, { track });
  }

  // Always include both paths for orchestrator
  const task = getTask(taskId);
  const project = task ? getProject(task.projectId) : null;

  return {
    prompt: result.prompt,
    workingDir: result.workingDir,
    model: result.model,
    frontendPath: project?.frontendPath || null,
    backendPath: project?.backendPath || null,
  };
}
