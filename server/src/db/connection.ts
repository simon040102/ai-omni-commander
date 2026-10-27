import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../config.js';
import { runMigrations } from './schema.js';

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;

  const config = getConfig();

  // Ensure data directory exists
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = new Database(config.dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 30000');

  // Run migrations
  runMigrations(instance);

  return instance;
}

/**
 * 讓 getDb() 改用呼叫端已開好的連線。MCP process 自己有連線（getMcpDb），在裡面組執行計畫時
 * 讓 db/queries/* 共用同一條，不在同一個 process 對同一個檔開兩條連線（也讓測試能換成測試 DB）。
 */
export function useDb(db: Database.Database): void {
  instance = db;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
