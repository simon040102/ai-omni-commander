import { randomUUID } from 'node:crypto';

export function genId(): string {
  return randomUUID();
}
