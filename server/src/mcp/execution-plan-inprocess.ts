/**
 * get_execution_plan 在 MCP 自己的 process 組計畫——不再 HTTP 呼叫 Web Server（沒開就開不了工）。
 *
 * 組法與 Web 端點同一個函式（orchestrator/executionPlanService.ts），產出一致。
 * - 動態載入：SVN／docx 轉檔等模組只在真的要組計畫時才載入，不拖慢 MCP 啟動。
 * - 共用連線：每次組計畫前讓 db/queries/* 用 MCP 目前的連線（useDb），同一個 process
 *   不對同一個檔開兩條；每次都綁（不只第一次），連線被換掉（測試）也不會用到舊的。
 * - log 走 stderr：stdio-guard 在入口已設；這裡再保險設一次（例如被測試直接載入時）。
 */
import { getMcpDb } from './db.js';
import type { ExecutionPlanResponse, PlanTrack } from '../orchestrator/executionPlanService.js';

type Loaded = {
  useDb: typeof import('../db/connection.js')['useDb'];
  pipeline: import('../orchestrator/ExecutionPipeline.js').ExecutionPipeline;
  build: typeof import('../orchestrator/executionPlanService.js')['buildExecutionPlanResponse'];
};
let loading: Promise<Loaded> | null = null;

async function load(): Promise<Loaded> {
  process.env['OMNI_LOG_STDERR'] = '1';
  const { useDb } = await import('../db/connection.js');
  useDb(getMcpDb()); // 建服務前就綁好（建構時可能就會查 DB）
  const svc = await import('../orchestrator/executionPlanService.js');
  const { pipeline } = svc.createExecutionPlanServices();
  return { useDb, pipeline, build: svc.buildExecutionPlanResponse };
}

export async function buildExecutionPlanInProcess(taskId: string, role: string | undefined, track: PlanTrack): Promise<ExecutionPlanResponse> {
  // 載入失敗不快取：下次呼叫重新載入
  loading ??= load().catch((err) => { loading = null; throw err; });
  const { useDb, pipeline, build } = await loading;
  useDb(getMcpDb());
  return build(pipeline, taskId, role, track);
}
