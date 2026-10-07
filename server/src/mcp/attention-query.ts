/**
 * 「該注意什麼」的資料蒐集——MCP 工具 get_attention_summary 與 Web Server 每日推送共用。
 * 只做 SELECT；判斷邏輯全在純函式 attention.ts。
 */
import type Database from 'better-sqlite3';
import { listStalledTasks, DEFAULT_STALE_THRESHOLD_HOURS } from './stale-tasks.js';
import { localTodayYmd, describeDueDate } from '../utils/dueDate.js';
import { buildAttention, type AttentionGap, type StalledEntry, type OverdueEntry, type AttentionSummary } from './attention.js';

export interface CollectOptions {
  projectId?: string;
  staleGapDays?: number;
  stalledHours?: number;
  now?: Date;
}

export interface CollectResult {
  summary: AttentionSummary;
  /** 顯示用範圍名稱（「全部專案」／「專案 X」） */
  scope: string;
}

/** 專案不存在時回 null。 */
export function collectAttention(db: Database.Database, opts: CollectOptions = {}): CollectResult | null {
  const { projectId, staleGapDays, stalledHours } = opts;
  const now = opts.now ?? new Date();
  const projects = (projectId
    ? db.prepare('SELECT id, name FROM projects WHERE id = ?').all(projectId)
    : db.prepare('SELECT id, name FROM projects').all()) as Array<{ id: string; name: string }>;
  if (projectId && projects.length === 0) return null;
  const nameOf = new Map(projects.map(p => [p.id, p.name]));

  // 子任務標題常只有「前端」「後端」，單看不知道是哪支功能 → 帶上母任務名
  const withParent = (title: string | null, parent: string | null) =>
    title && parent ? `${parent} / ${title}` : title;

  const gapRows = db.prepare(`
    SELECT g.id, g.category, g.description, g.created_at, g.task_id, g.project_id,
           t.title AS task_title, t.parent_name AS parent_name, t.status AS task_status
      FROM spec_gaps g LEFT JOIN tasks t ON t.id = g.task_id
     WHERE g.status = 'open' ${projectId ? 'AND g.project_id = ?' : ''}
  `).all(...(projectId ? [projectId] : [])) as Array<{
    id: string; category: string; description: string; created_at: string; task_id: string | null;
    project_id: string; task_title: string | null; parent_name: string | null; task_status: string | null;
  }>;
  const gaps: AttentionGap[] = gapRows.map(g => ({
    id: g.id, category: g.category, description: g.description, createdAt: g.created_at,
    taskId: g.task_id, taskTitle: withParent(g.task_title, g.parent_name), taskStatus: g.task_status,
    projectName: nameOf.get(g.project_id) ?? g.project_id,
  }));

  const parentOf = db.prepare('SELECT parent_name FROM tasks WHERE id = ?');
  const stalled: StalledEntry[] = projects.flatMap(p =>
    listStalledTasks(db, p.id, stalledHours ?? DEFAULT_STALE_THRESHOLD_HOURS)
      .map(s => ({
        taskId: s.taskId,
        title: withParent(s.title, (parentOf.get(s.taskId) as { parent_name: string | null } | undefined)?.parent_name ?? null) ?? s.title,
        projectName: p.name,
        stalledHours: s.stalledHours,
      })));

  const today = localTodayYmd(now);
  const overdueRows = db.prepare(`
    SELECT id, title, parent_name, project_id, due_date FROM tasks
     WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('completed', 'failed')
     ${projectId ? 'AND project_id = ?' : ''}
  `).all(...(projectId ? [today, projectId] : [today])) as Array<{ id: string; title: string; parent_name: string | null; project_id: string; due_date: string }>;
  const overdue: OverdueEntry[] = overdueRows.map(r => ({
    taskId: r.id, title: withParent(r.title, r.parent_name) ?? r.title, projectName: nameOf.get(r.project_id) ?? r.project_id,
    dueDate: r.due_date, dueText: describeDueDate(r.due_date, today) ?? r.due_date,
  }));

  return {
    summary: buildAttention({ gaps, stalled, overdue, nowIso: now.toISOString(), staleGapDays }),
    scope: projectId ? `專案 ${nameOf.get(projectId)}` : '全部專案',
  };
}
