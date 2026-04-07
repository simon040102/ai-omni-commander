/**
 * In-memory cache for fetched database schemas.
 * Keyed by `${projectId}:${connectionId}`.
 * No TTL — user manually re-fetches via button.
 */
import type { DbSchemaResult } from '@omni/shared';

const cache = new Map<string, DbSchemaResult>();

function key(projectId: string, connectionId: string): string {
  return `${projectId}:${connectionId}`;
}

export function getSchema(projectId: string, connectionId: string): DbSchemaResult | undefined {
  return cache.get(key(projectId, connectionId));
}

export function setSchema(projectId: string, connectionId: string, result: DbSchemaResult): void {
  cache.set(key(projectId, connectionId), result);
}

export function clearSchema(projectId: string, connectionId: string): void {
  cache.delete(key(projectId, connectionId));
}

export function clearAllForProject(projectId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${projectId}:`)) {
      cache.delete(k);
    }
  }
}
