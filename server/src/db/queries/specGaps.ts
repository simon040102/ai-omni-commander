import { getDb } from '../connection.js';
import { listResolvedSpecGaps, type ResolvedSpecGap } from '../../utils/specGapResolution.js';

/**
 * 任務「已裁決且 note 非空」的規格缺口（使用者拍板紀錄）——注入派工 prompt 用。
 * 來源 SQL 與 MCP 端（resume_task / get_compliance_review_plan）共用
 * utils/specGapResolution.listResolvedSpecGaps，單一真相。
 */
export function getResolvedSpecGapsForTask(taskId: string): ResolvedSpecGap[] {
  return listResolvedSpecGaps(getDb(), taskId);
}
