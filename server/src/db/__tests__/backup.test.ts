/**
 * backupDatabase — 啟動自動備份測試。
 * 真 temp DB 檔案（better-sqlite3 db.backup 需要真檔案），驗證：
 * 備份產生且內容可開、修剪只留 MAX_BACKUPS 份、目錄自動建立、失敗絕不 throw。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupDatabase, MAX_BACKUPS } from '../backup.js';

let tmpDir: string;
let dataDir: string;
let db: Database.Database;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-backup-'));
  dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'omni.db'));
  db.pragma('journal_mode = WAL');
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
  db.prepare("INSERT INTO notes (body) VALUES (?)").run('hello backup');
});

afterEach(() => {
  try { db.close(); } catch { /* already closed in some tests */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('backupDatabase', () => {
  it('creates a backup file whose content is a readable copy of the source DB', async () => {
    const result = await backupDatabase(db, dataDir);

    expect(result.ok).toBe(true);
    expect(result.backupPath).toBeTruthy();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    expect(path.dirname(result.backupPath!)).toBe(path.join(dataDir, 'backups'));
    expect(path.basename(result.backupPath!)).toMatch(/^omni-\d{8}-\d{6}(?:-\d+)?\.db$/);

    // Backup must be an openable, consistent SQLite copy
    const copy = new Database(result.backupPath!, { readonly: true });
    const row = copy.prepare('SELECT body FROM notes').get() as { body: string };
    copy.close();
    expect(row.body).toBe('hello backup');
  });

  it('auto-creates the backups directory when it does not exist', async () => {
    const backupsDir = path.join(dataDir, 'backups');
    expect(fs.existsSync(backupsDir)).toBe(false);

    const result = await backupDatabase(db, dataDir);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(backupsDir)).toBe(true);
  });

  it(`prunes old backups to keep only the newest ${MAX_BACKUPS}`, async () => {
    const backupsDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });

    // 12 pre-existing fake backups (zero-padded timestamps → lexicographic = chronological)
    const fakeNames: string[] = [];
    for (let i = 1; i <= 12; i++) {
      const name = `omni-20250101-${String(i).padStart(2, '0')}0000.db`;
      fs.writeFileSync(path.join(backupsDir, name), 'old');
      fakeNames.push(name);
    }
    // A non-backup file must never be touched by pruning
    fs.writeFileSync(path.join(backupsDir, 'keep-me.txt'), 'unrelated');

    const result = await backupDatabase(db, dataDir);
    expect(result.ok).toBe(true);

    const remaining = fs.readdirSync(backupsDir).filter(n => /^omni-.*\.db$/.test(n)).sort();
    expect(remaining.length).toBe(MAX_BACKUPS);
    // Oldest three fakes pruned (12 fakes + 1 new = 13 → remove 3 oldest)
    expect(remaining).not.toContain(fakeNames[0]);
    expect(remaining).not.toContain(fakeNames[1]);
    expect(remaining).not.toContain(fakeNames[2]);
    // Newest backup (just created) survives
    expect(remaining).toContain(path.basename(result.backupPath!));
    expect(result.prunedCount).toBe(3);
    // Unrelated file untouched
    expect(fs.existsSync(path.join(backupsDir, 'keep-me.txt'))).toBe(true);
  });

  it('never throws when the source DB is unusable (closed) — returns ok:false', async () => {
    db.close();
    const result = await backupDatabase(db, dataDir);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('never throws when db.backup rejects (busy/failed backup)', async () => {
    const fakeDb = {
      backup: () => Promise.reject(new Error('database is locked')),
    } as unknown as Database.Database;

    const result = await backupDatabase(fakeDb, dataDir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('database is locked');
  });
});
