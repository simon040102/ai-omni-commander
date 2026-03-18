import { getDb } from '../connection.js';

export interface WorkspaceSkillRecord {
  id: number;
  projectId: string;
  workspaceType: 'frontend' | 'backend';
  path: string;
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
  skills: Array<{ name: string; filename: string; path: string }>;
  scannedAt: string;
}

export function upsertWorkspaceSkills(
  projectId: string,
  workspaceType: 'frontend' | 'backend',
  scanResult: {
    path: string;
    hasClaudeMd: boolean;
    hasClaudeDir: boolean;
    skills: Array<{ name: string; filename: string; path: string }>;
  }
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO workspace_skills (project_id, workspace_type, path, has_claude_md, has_claude_dir, skills_json, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id, workspace_type) DO UPDATE SET
      path = excluded.path,
      has_claude_md = excluded.has_claude_md,
      has_claude_dir = excluded.has_claude_dir,
      skills_json = excluded.skills_json,
      scanned_at = datetime('now')
  `).run(
    projectId,
    workspaceType,
    scanResult.path,
    scanResult.hasClaudeMd ? 1 : 0,
    scanResult.hasClaudeDir ? 1 : 0,
    JSON.stringify(scanResult.skills),
  );
}

export function getWorkspaceSkills(projectId: string): WorkspaceSkillRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workspace_skills WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: row['id'] as number,
    projectId: row['project_id'] as string,
    workspaceType: row['workspace_type'] as 'frontend' | 'backend',
    path: row['path'] as string,
    hasClaudeMd: (row['has_claude_md'] as number) === 1,
    hasClaudeDir: (row['has_claude_dir'] as number) === 1,
    skills: JSON.parse((row['skills_json'] as string) || '[]'),
    scannedAt: row['scanned_at'] as string,
  }));
}
