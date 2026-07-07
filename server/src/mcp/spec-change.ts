/**
 * Reusable spec change detection — the core of check_spec_changes, also
 * triggered automatically after sync_asana_tasks.
 *
 * Given a set of tasks: read task_spec_versions → compare against SVN
 * last-modified → on change create a spec_changed gap + notify Web UI +
 * bump the recorded version.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { notifyWebServer } from './notify.js';
import { ensureMcpAgent } from './helpers.js';
import { getSvnCredentials, isSvnCliAvailable, fetchRemoteLastModified } from './svn-status.js';

export interface SpecChangeTarget {
  id: string;
  project_id: string;
  title: string;
}

export interface SpecChangedFile {
  fileRef: string;
  filename: string;
  recorded: string | null;
  current: string;
  gapId: string;
}

export interface SpecChangeTaskReport {
  taskId: string;
  title: string;
  filesChecked: number;
  changed: SpecChangedFile[];
  unknown?: string[];
  unknownNote?: string;
}

export interface SpecChangeCheckResult {
  tasksChecked: number;
  filesChecked: number;
  changedTotal: number;
  tasks: SpecChangeTaskReport[];
}

/** Decode the display name of a spec file_ref (SVN URL or plain filename). */
export function specFileName(fileRef: string): string {
  const last = fileRef.split('/').pop() || fileRef;
  try { return decodeURIComponent(last); } catch { return last; }
}

/**
 * Run the spec change check for the given tasks.
 *
 * - Tasks without task_spec_versions records cost nothing (SVN is never touched
 *   when no task has recorded versions).
 * - Throws when the svn CLI is unavailable but files need checking — callers
 *   must never interpret that as "no changes".
 */
export async function runSpecChangeCheck(
  db: Database.Database,
  targets: SpecChangeTarget[],
): Promise<SpecChangeCheckResult> {
  // Collect recorded versions per task
  const perTask = targets.map(t => ({
    task: t,
    versions: db.prepare('SELECT file_ref, last_modified FROM task_spec_versions WHERE task_id = ?')
      .all(t.id) as Array<{ file_ref: string; last_modified: string | null }>,
  }));
  const totalFiles = perTask.reduce((n, p) => n + p.versions.length, 0);
  if (totalFiles === 0) {
    return { tasksChecked: targets.length, filesChecked: 0, changedTotal: 0, tasks: [] };
  }

  // SVN availability — fail loudly, never pretend "no changes"
  if (!isSvnCliAvailable()) {
    throw new Error('找不到可用的 svn CLI，無法檢查規格變更。請安裝 svn（或確認 PATH）後重試——本次結果不代表「規格沒變」。');
  }
  const creds = getSvnCredentials(db);

  const report: SpecChangeTaskReport[] = [];
  let changedTotal = 0;

  for (const { task, versions } of perTask) {
    const changed: SpecChangedFile[] = [];
    const unknown: string[] = [];

    for (const v of versions) {
      let current: string | null = null;
      try {
        current = fetchRemoteLastModified(v.file_ref, creds);
      } catch { /* treated as unknown below */ }

      if (!current) {
        unknown.push(v.file_ref);
        continue;
      }
      if (current === v.last_modified) continue;

      // Spec changed → create a spec gap + notify + update the recorded version
      const filename = specFileName(v.file_ref);
      const gapId = randomUUID();
      const description = `規格檔案已更新：${filename}（記錄版本 ${v.last_modified ?? '(未知)'} → SVN 最新 ${current}）。請重新 fetch_svn_specs 取得最新版，並確認已完成的實作是否需調整。`;
      db.prepare(`
        INSERT INTO spec_gaps (id, task_id, project_id, category, description)
        VALUES (?, ?, ?, 'spec_changed', ?)
      `).run(gapId, task.id, task.project_id, description);

      const { agentId, created, role, title } = ensureMcpAgent(db, task.id, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: task.project_id, taskId: task.id, role, title, model: 'external (MCP)' },
        });
      }
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, task.id, `[SPEC_GAP][spec_changed] ${description}`);

      await notifyWebServer({
        event: 'task.specGap',
        data: { gapId, taskId: task.id, projectId: task.project_id, category: 'spec_changed', description, status: 'open', action: 'reported' },
      });

      db.prepare(`
        UPDATE task_spec_versions SET last_modified = ?, recorded_at = datetime('now')
        WHERE task_id = ? AND file_ref = ?
      `).run(current, task.id, v.file_ref);

      changed.push({ fileRef: v.file_ref, filename, recorded: v.last_modified, current, gapId });
      changedTotal++;
    }

    report.push({
      taskId: task.id,
      title: task.title,
      filesChecked: versions.length,
      changed,
      ...(unknown.length > 0 && { unknown: unknown.map(specFileName), unknownNote: '無法取得 SVN 最新日期（檔案可能已被移動/刪除，或認證失敗）——不視為未變更，請人工確認。' }),
    });
  }

  return { tasksChecked: targets.length, filesChecked: totalFiles, changedTotal, tasks: report };
}
