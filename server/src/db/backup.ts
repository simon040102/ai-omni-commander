/**
 * DB 啟動自動備份（Web Server 專用 — MCP entry 不掛，session spawn 太頻繁）。
 *
 * better-sqlite3 的 db.backup() 走 SQLite Online Backup API，WAL 模式下安全
 * （不需要停寫、備份出來的是一致的快照）。
 *
 * 鐵律：備份是 best-effort — 任何失敗只 log 警告，絕不擋啟動、絕不 throw。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('DbBackup');

/** 修剪後保留的備份份數（依檔名排序，刪最舊的）。 */
export const MAX_BACKUPS = 10;

/** 只有符合本命名規則的檔案會被列入修剪（絕不誤刪其他檔案）。 */
const BACKUP_NAME_RE = /^omni-\d{8}-\d{6}(?:-\d+)?\.db$/;

export interface BackupResult {
  ok: boolean;
  /** 成功時的備份檔絕對路徑 */
  backupPath?: string;
  /** 本次修剪刪除的舊備份數 */
  prunedCount?: number;
  /** 失敗原因（ok=false 時） */
  error?: string;
}

/** omni-YYYYMMDD-HHMMSS（本地時間）。 */
function timestampName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/**
 * 修剪 backups 目錄：只保留檔名排序最新的 MAX_BACKUPS 份。
 * 檔名內含零填補的時間戳，字典序即時間序。單檔刪除失敗只警告、繼續。
 */
function pruneBackups(backupsDir: string): number {
  const names = fs
    .readdirSync(backupsDir)
    .filter(n => BACKUP_NAME_RE.test(n))
    .sort(); // ascending → oldest first
  const excess = names.length - MAX_BACKUPS;
  if (excess <= 0) return 0;

  let pruned = 0;
  for (const name of names.slice(0, excess)) {
    try {
      fs.unlinkSync(path.join(backupsDir, name));
      pruned++;
    } catch (err) {
      logger.warn({ err, name }, 'Failed to prune old DB backup — skipping');
    }
  }
  return pruned;
}

/**
 * 備份資料庫到 {dataDir}/backups/omni-YYYYMMDD-HHMMSS.db，完成後修剪只留
 * 最近 MAX_BACKUPS 份。全程 try/catch — 失敗只回 ok:false + log 警告，絕不 throw。
 */
export async function backupDatabase(db: Database.Database, dataDir: string): Promise<BackupResult> {
  try {
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });

    // 同秒重複啟動時避免覆蓋既有備份：加 -1, -2… 序號
    const base = `omni-${timestampName(new Date())}`;
    let dest = path.join(backupsDir, `${base}.db`);
    for (let n = 1; fs.existsSync(dest); n++) {
      dest = path.join(backupsDir, `${base}-${n}.db`);
    }

    await db.backup(dest);
    const prunedCount = pruneBackups(backupsDir);

    logger.info({ backupPath: dest, prunedCount }, 'Database backed up');
    return { ok: true, backupPath: dest, prunedCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Database backup failed — continuing startup without backup');
    return { ok: false, error: message };
  }
}
