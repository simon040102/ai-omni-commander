import { getDb } from '../connection.js';

export interface RecentPath {
  id: number;
  path: string;
  label: string | null;
  useCount: number;
  lastUsedAt: string;
  createdAt: string;
}

interface DbRecentPath {
  id: number;
  path: string;
  label: string | null;
  use_count: number;
  last_used_at: string;
  created_at: string;
}

function mapRow(row: DbRecentPath): RecentPath {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/**
 * Get recent paths, ordered by last used (most recent first)
 */
export function getRecentPaths(limit = 10): RecentPath[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM recent_paths
    ORDER BY last_used_at DESC
    LIMIT ?
  `).all(limit) as DbRecentPath[];
  return rows.map(mapRow);
}

/**
 * Add or update a path (increments use_count, updates last_used_at)
 */
export function addRecentPath(path: string, label?: string): RecentPath {
  const db = getDb();
  const trimmed = path.trim();

  // Try to update existing
  const existing = db.prepare(`SELECT * FROM recent_paths WHERE path = ?`).get(trimmed) as DbRecentPath | undefined;

  if (existing) {
    db.prepare(`
      UPDATE recent_paths
      SET use_count = use_count + 1,
          last_used_at = datetime('now'),
          label = COALESCE(?, label)
      WHERE path = ?
    `).run(label ?? null, trimmed);

    return mapRow(db.prepare(`SELECT * FROM recent_paths WHERE path = ?`).get(trimmed) as DbRecentPath);
  }

  // Insert new
  const result = db.prepare(`
    INSERT INTO recent_paths (path, label)
    VALUES (?, ?)
  `).run(trimmed, label ?? null);

  return mapRow(db.prepare(`SELECT * FROM recent_paths WHERE id = ?`).get(result.lastInsertRowid) as DbRecentPath);
}

/**
 * Remove a path from recent list
 */
export function removeRecentPath(pathOrId: string | number): void {
  const db = getDb();
  if (typeof pathOrId === 'number') {
    db.prepare(`DELETE FROM recent_paths WHERE id = ?`).run(pathOrId);
  } else {
    db.prepare(`DELETE FROM recent_paths WHERE path = ?`).run(pathOrId);
  }
}

/**
 * Clear all recent paths
 */
export function clearRecentPaths(): void {
  const db = getDb();
  db.prepare(`DELETE FROM recent_paths`).run();
}
