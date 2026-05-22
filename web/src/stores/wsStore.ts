import { create } from 'zustand';
import { WsClient } from '../lib/wsClient';

interface WsState {
  connected: boolean;
  hasConnectedOnce: boolean;
  client: WsClient | null;
  setConnected: (connected: boolean) => void;
  setClient: (client: WsClient) => void;
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  hasConnectedOnce: false,
  client: null,
  setConnected: (connected) => set((state) => ({
    connected,
    hasConnectedOnce: state.hasConnectedOnce || connected,
  })),
  setClient: (client) => set({ client }),
}));
