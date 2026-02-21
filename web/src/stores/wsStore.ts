import { create } from 'zustand';
import { WsClient } from '../lib/wsClient';

interface WsState {
  connected: boolean;
  client: WsClient | null;
  setConnected: (connected: boolean) => void;
  setClient: (client: WsClient) => void;
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  client: null,
  setConnected: (connected) => set({ connected }),
  setClient: (client) => set({ client }),
}));
