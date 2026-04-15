/**
 * Persistent cache for fetched database schemas.
 * Keyed by `${projectId}:${connectionId}`.
 * Stored as JSON files in data/schemas/ — survives server restarts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DbSchemaResult } from '@omni/shared';

const SCHEMAS_DIR = path.join(process.cwd(), 'data', 'schemas');
fs.mkdirSync(SCHEMAS_DIR, { recursive: true });

function filePath(projectId: string, connectionId: string): string {
  return path.join(SCHEMAS_DIR, `${projectId}-${connectionId}.json`);
}

export function getSchema(projectId: string, connectionId: string): DbSchemaResult | undefined {
  const fp = filePath(projectId, connectionId);
  if (!fs.existsSync(fp)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as DbSchemaResult;
  } catch {
    return undefined;
  }
}

export function setSchema(projectId: string, connectionId: string, result: DbSchemaResult): void {
  fs.writeFileSync(filePath(projectId, connectionId), JSON.stringify(result), 'utf-8');
}

export function clearSchema(projectId: string, connectionId: string): void {
  const fp = filePath(projectId, connectionId);
  if (fs.existsSync(fp)) fs.rmSync(fp);
}

export function clearAllForProject(projectId: string): void {
  for (const f of fs.readdirSync(SCHEMAS_DIR)) {
    if (f.startsWith(`${projectId}-`)) {
      fs.rmSync(path.join(SCHEMAS_DIR, f));
    }
  }
}
