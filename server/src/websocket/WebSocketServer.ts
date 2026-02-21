import { WebSocketServer as WsServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { WsMessage } from '@omni/shared';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('WebSocketServer');

export type WsHandler = (msg: WsMessage, ws: WebSocket) => void | Promise<void>;

/**
 * WebSocket server that handles client connections, message routing, and broadcasting.
 */
export class OmniWebSocketServer {
  private wss: WsServer;
  private clients = new Set<WebSocket>();
  private handlers = new Map<string, WsHandler>();
  private initialStateProvider: (() => WsMessage) | null = null;
  private postConnectionHandler: ((ws: WebSocket) => void) | null = null;

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

  /** Broadcast a message to all connected clients */
  broadcast(msg: WsMessage): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
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

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    logger.info({ clients: this.clients.size }, 'Client connected');

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

    // Heartbeat
    const interval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clearInterval(interval);
      }
    }, 30000);

    ws.on('close', () => clearInterval(interval));
  }

  private async routeMessage(msg: WsMessage, ws: WebSocket): Promise<void> {
    const handler = this.handlers.get(msg.type);
    if (handler) {
      try {
        await handler(msg, ws);
      } catch (err) {
        logger.error({ type: msg.type, err }, 'Handler error');
        this.send(ws, {
          type: 'error',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { code: 'HANDLER_ERROR', message: String(err) },
        } as WsMessage);
      }
    } else {
      logger.warn({ type: msg.type }, 'No handler for message type');
    }
  }
}
