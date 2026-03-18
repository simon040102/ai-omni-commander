import { getDb } from '../connection.js';

export function getGlobalConfig(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM global_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setGlobalConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO global_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, value, value);
}

export function deleteGlobalConfig(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM global_config WHERE key = ?').run(key);
}

export function getAllGlobalConfig(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM global_config').all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// =============================================
// SVN credential helpers
// =============================================

export interface SvnCredentials {
  username: string;
  password: string;
}

export function getSvnCredentials(): SvnCredentials {
  return {
    username: getGlobalConfig('svn.username') || '',
    password: getGlobalConfig('svn.password') || '',
  };
}

export function setSvnCredentials(creds: SvnCredentials): void {
  setGlobalConfig('svn.username', creds.username);
  setGlobalConfig('svn.password', creds.password);
}
