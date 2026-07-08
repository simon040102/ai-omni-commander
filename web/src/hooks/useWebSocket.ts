import { useEffect } from 'react';
import { WsClient } from '../lib/wsClient';
import { useWsStore } from '../stores/wsStore';
import { useToastStore } from '../stores/toastStore';
import { projectHandlers } from './wsHandlers/project';
import { agentHandlers } from './wsHandlers/agent';
import { taskHandlers } from './wsHandlers/task';
import { asanaHandlers } from './wsHandlers/asana';
import { miscHandlers } from './wsHandlers/misc';
import type { HandlerMap } from './wsHandlers/types';

/** Message-type → handler lookup table (split by domain under ./wsHandlers/) */
const handlers: HandlerMap = {
  ...projectHandlers,
  ...agentHandlers,
  ...taskHandlers,
  ...asanaHandlers,
  ...miscHandlers,
};

/**
 * Connect to the server WebSocket and dispatch incoming messages to stores.
 */
export function useWebSocket() {
  const setConnected = useWsStore(s => s.setConnected);
  const setClient = useWsStore(s => s.setClient);
  const addToast = useToastStore(s => s.addToast);

  useEffect(() => {
    const wsUrl = `ws://${window.location.host}/omni-ws`;

    const client = new WsClient(
      wsUrl,
      (msg: Record<string, unknown>) => {
        const type = msg['type'] as string;
        const payload = msg['payload'] as Record<string, unknown>;

        const handler = handlers[type];
        if (handler) {
          handler(payload, { client, msg });
        } else {
          // Log unhandled message types for debugging
          console.log('[WS] unhandled message type:', type, payload);
        }
      },
      (connected) => {
        setConnected(connected);
        // Connected state is shown by the sidebar indicator / DisconnectBanner — no success toast
        if (!connected) {
          addToast({ type: 'warning', title: '連線中斷', message: '重新連線中...', duration: 3000 });
        }
      },
    );

    client.connect();
    setClient(client);

    return () => {
      client.disconnect();
    };
  }, []);
}
