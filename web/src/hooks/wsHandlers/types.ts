import type { WsClient } from '../../lib/wsClient';

export interface HandlerContext {
  client: WsClient;
  /** Full raw message (type/id/timestamp/payload) for handlers that need more than payload */
  msg: Record<string, unknown>;
}

export type WsMessageHandler = (payload: Record<string, unknown>, ctx: HandlerContext) => void;

export type HandlerMap = Record<string, WsMessageHandler>;
