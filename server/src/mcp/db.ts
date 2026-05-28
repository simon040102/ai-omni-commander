/**
 * Standalone SQLite connection for the MCP Server process.
 * Reads DB_PATH from environment (set via .mcp.json env config).
 * Reuses the same schema/migrations as the main web server.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../db/schema.js';

let instance: Database.Database | null = null;

export function getMcpDb(): Database.Database {
  if (instance) return instance;

  const dbPath = process.env['DB_PATH'];
  if (!dbPath) {
    throw new Error('DB_PATH environment variable is required for MCP Server');
  }

  const resolvedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);

  // Ensure data directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  instance = new Database(resolvedPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 30000');

  // Run migrations to ensure schema is up to date
  runMigrations(instance);

  return instance;
}

export function closeMcpDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
