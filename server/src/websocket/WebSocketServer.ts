import { WebSocketServer as WsServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { WsMessage } from '@omni/shared';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('WebSocketServer');

export type WsHandler = (msg: WsMessage, ws: WebSocket) => void | Promise<void>;

interface AliveWebSocket extends WebSocket {
  isAlive?: boolean;
}

/** Skip streaming messages for clients whose send buffer exceeds this (backpressure) */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Merge consecutive streaming text deltas per agent for this long before broadcasting */
const DELTA_FLUSH_INTERVAL_MS = 150;

/**
 * WebSocket server that handles client connections, message routing, and broadcasting.
 */
export class OmniWebSocketServer {
  private wss: WsServer;
  private clients = new Set<WebSocket>();
  private handlers = new Map<string, WsHandler>();
  private initialStateProvider: (() => WsMessage) | null = null;
  private postConnectionHandler: ((ws: WebSocket) => void) | null = null;
  /** Buffered streaming deltas keyed by `${agentId}|${streamType}` — merged before broadcast */
  private deltaBuffers = new Map<string, { msg: WsMessage; content: string }>();
  private deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(httpServer: HttpServer) {
    this.wss = new WsServer({ server: httpServer });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    logger.info('WebSocket server initialized');
  }

  /** Register a handler for a specific message type */
  registerHandler(type: string, handler: WsHandler): void {
    this.handlers.set(type, handler);
  }

  /** Set a function that provides initial state on client connection */
  setInitialStateProvider(provider: () => WsMessage): void {
    this.initialStateProvider = provider;
  }

  /** Set a handler called after a new client connects (for sending additional state) */
  setPostConnectionHandler(handler: (ws: WebSocket) => void): void {
    this.postConnectionHandler = handler;
  }

  /** Broadcast a message to all connected clients.
   * Streaming text deltas (agent.output with isStreaming) are batched for
   * DELTA_FLUSH_INTERVAL_MS and merged per agent — same message schema, merged content.
   * Any non-streaming broadcast first flushes pending deltas to preserve ordering. */
  broadcast(msg: WsMessage): void {
    const payload = (msg as { payload?: Record<string, unknown> }).payload;
    if (
      msg.type === 'agent.output' &&
      payload?.['isStreaming'] === true &&
      typeof payload['content'] === 'string'
    ) {
      const key = `${payload['agentId']}|${payload['streamType']}`;
      const existing = this.deltaBuffers.get(key);
      if (existing) {
        existing.content += payload['content'];
      } else {
        this.deltaBuffers.set(key, { msg, content: payload['content'] });
      }
      this.deltaFlushTimer ??= setTimeout(() => this.flushDeltaBuffers(), DELTA_FLUSH_INTERVAL_MS);
      return;
    }

    // Non-streaming message: flush buffered deltas first so ordering is preserved
    // (this also guarantees the tail of streaming output is flushed on agent
    // completion/status events, which always arrive as non-streaming broadcasts)
    this.flushDeltaBuffers();
    this.sendToAll(msg, this.isStreamingType(msg));
  }

  /** True for high-frequency streaming messages that may be skipped under backpressure */
  private isStreamingType(msg: WsMessage): boolean {
    const payload = (msg as { payload?: Record<string, unknown> }).payload;
    return msg.type === 'agent.output' && payload?.['isStreaming'] === true;
  }

  private flushDeltaBuffers(): void {
    if (this.deltaFlushTimer) {
      clearTimeout(this.deltaFlushTimer);
      this.deltaFlushTimer = null;
    }
    if (this.deltaBuffers.size === 0) return;
    const buffered = Array.from(this.deltaBuffers.values());
    this.deltaBuffers.clear();
    for (const { msg, content } of buffered) {
      const payload = (msg as { payload?: Record<string, unknown> }).payload;
      const merged = { ...msg, payload: { ...payload, content } } as WsMessage;
      this.sendToAll(merged, true);
    }
  }

  private sendToAll(msg: WsMessage, isStreaming: boolean): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN) continue;
      // Backpressure: skip high-frequency streaming messages for slow clients;
      // full state messages are always sent
      if (isStreaming && client.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      client.send(data);
    }
  }

  /** Send a message to a specific client */
  send(ws: WebSocket, msg: WsMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /** Get the number of connected clients */
  getClientCount(): number {
    return this.clients.size;
  }

  private handleConnection(ws: AliveWebSocket): void {
    this.clients.add(ws);
    logger.info({ clients: this.clients.size }, 'Client connected');

    // Heartbeat liveness tracking (standard isAlive pattern)
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Send initial state
    if (this.initialStateProvider) {
      this.send(ws, this.initialStateProvider());
    }

    // Send additional state (e.g., active project details)
    if (this.postConnectionHandler) {
      this.postConnectionHandler(ws);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsMessage;
        this.routeMessage(msg, ws);
      } catch (err) {
        logger.warn({ err }, 'Invalid WebSocket message');
        this.send(ws, {
          type: 'error',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { code: 'INVALID_MESSAGE', message: 'Invalid JSON message' },
        } as WsMessage);
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      logger.info({ clients: this.clients.size }, 'Client disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
      this.clients.delete(ws);
    });

    // Heartbeat: terminate connections that failed to answer the previous ping
    const interval = setInterval(() => {
      if (ws.readyState !== ws.OPEN) {
        clearInterval(interval);
        return;
      }
      if (ws.isAlive === false) {
        logger.warn('Client failed heartbeat — terminating connection');
        clearInterval(interval);
        this.clients.delete(ws);
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    }, 30000);

    ws.on('close', () => clearInterval(interval));
  }

  private async routeMessage(msg: WsMessage, ws: WebSocket): Promise<void> {
    // Validate basic message structure
    if (!msg.type || typeof msg.type !== 'string') {
      this.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'INVALID_MESSAGE', message: 'Missing or invalid "type" field' },
      } as WsMessage);
      return;
    }

    if (!('payload' in msg) || (msg as Record<string, unknown>).payload == null) {
      this.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'INVALID_MESSAGE', message: 'Missing "payload" field' },
      } as WsMessage);
      return;
    }

    const handler = this.handlers.get(msg.type);
    if (handler) {
      try {
        await handler(msg, ws);
      } catch (err) {
        logger.error({ type: msg.type, err }, 'Handler error');
        const errMsg = err instanceof Error ? err.message : String(err);
        // Don't leak internal details like SQL errors
        const safeMsg = errMsg.includes('SqliteError') || errMsg.includes('SQLITE')
          ? 'Invalid request: missing or invalid required fields'
          : errMsg;
        this.send(ws, {
          type: 'error',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { code: 'HANDLER_ERROR', message: safeMsg },
        } as WsMessage);
      }
    } else {
      logger.warn({ type: msg.type }, 'No handler for message type');
      this.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'UNKNOWN_TYPE', message: `Unknown message type: ${msg.type}` },
      } as WsMessage);
    }
  }
}
