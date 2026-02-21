import fs from 'node:fs/promises';
import path from 'node:path';

/** Ensure a directory exists, creating it recursively if needed */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/** Safely write a JSON file, creating parent directories as needed */
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** Safely read a JSON file, returning null if not found */
export async function safeReadJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/** List files in a directory matching a filter */
export async function listFiles(dirPath: string, filter?: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath);
    return filter ? entries.filter(filter) : entries;
  } catch {
    return [];
  }
}
