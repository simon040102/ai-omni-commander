import type { BusEvent } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

type EventHandler = (event: BusEvent) => void | Promise<void>;

const logger = createChildLogger('EventBus');

/**
 * In-process pub/sub event bus with wildcard pattern matching.
 * Patterns: 'agent.started' (exact), 'agent.*' (wildcard), '*' (all)
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /** Subscribe to events matching a pattern. Returns an unsubscribe function. */
  on(pattern: string, handler: EventHandler): () => void {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)!.add(handler);

    return () => {
      this.handlers.get(pattern)?.delete(handler);
      if (this.handlers.get(pattern)?.size === 0) {
        this.handlers.delete(pattern);
      }
    };
  }

  /** Emit an event to all matching handlers */
  async emit(event: BusEvent): Promise<void> {
    const matchingHandlers: EventHandler[] = [];

    for (const [pattern, handlers] of this.handlers) {
      if (this.matches(pattern, event.type)) {
        for (const handler of handlers) {
          matchingHandlers.push(handler);
        }
      }
    }

    if (matchingHandlers.length === 0) {
      logger.debug({ type: event.type }, 'No handlers for event');
      return;
    }

    const results = await Promise.allSettled(
      matchingHandlers.map(handler => handler(event))
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error({ type: event.type, err: result.reason }, 'Event handler error');
      }
    }
  }

  /** Check if a pattern matches an event type */
  private matches(pattern: string, eventType: string): boolean {
    if (pattern === '*') return true;
    if (pattern === eventType) return true;

    // Wildcard: 'agent.*' matches 'agent.started', 'agent.error', etc.
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return eventType.startsWith(prefix + '.');
    }

    return false;
  }

  /** Remove all handlers */
  clear(): void {
    this.handlers.clear();
  }
}
