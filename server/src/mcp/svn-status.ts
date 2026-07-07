/**
 * Thin SVN status layer for check_spec_changes — wraps the document-tools SVN
 * command helpers (svn info with --password-from-stdin + curl NTLM fallback)
 * behind a small mockable surface so tests never hit a real SVN server.
 */
import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { detectSvnBinary, svnInfoLastModified } from './tools/document-tools.js';

export interface SvnCreds {
  username: string;
  password: string;
}

/** Read SVN credentials from global_config (same keys as fetch_svn_specs). */
export function getSvnCredentials(db: Database.Database): SvnCreds {
  const svnUser = db.prepare("SELECT value FROM global_config WHERE key = 'svn.username'").get() as { value: string } | undefined;
  const svnPass = db.prepare("SELECT value FROM global_config WHERE key = 'svn.password'").get() as { value: string } | undefined;
  return { username: svnUser?.value || '', password: svnPass?.value || '' };
}

/** Whether the svn CLI is runnable on this machine. */
export function isSvnCliAvailable(): boolean {
  try {
    const result = spawnSync(detectSvnBinary(), ['--version', '--quiet'], { encoding: 'utf-8', timeout: 5000 });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

/**
 * Query the current SVN last-modified date of a file URL.
 * Returns null when the info could not be fetched (deleted file / auth failure).
 */
export function fetchRemoteLastModified(fileRef: string, creds: SvnCreds): string | null {
  return svnInfoLastModified(detectSvnBinary(), fileRef, creds, false);
}
