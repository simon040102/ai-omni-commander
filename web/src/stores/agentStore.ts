import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';

export interface AgentOutput {
  streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  toolName?: string;
  timestamp: string;
}

interface AgentStoreState {
  /** Map of agentId -> output lines */
  outputs: Record<string, AgentOutput[]>;

  /** Map of agentId -> command input draft (persisted across project switches) */
  commandInputs: Record<string, string>;

  /** Append output to an agent's buffer */
  appendOutput: (agentId: string, output: AgentOutput) => void;

  /** Set bulk outputs for an agent (used when loading from DB) */
  setOutputsBulk: (agentId: string, outputs: AgentOutput[]) => void;

  /** Clear all outputs for an agent */
  clearOutputs: (agentId: string) => void;

  /** Set command input for an agent */
  setCommandInput: (agentId: string, value: string) => void;

  /** Clear everything */
  clearAll: () => void;
}

const MAX_OUTPUT_LINES = 2000;

// IndexedDB storage adapter for zustand persist
const indexedDBStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    return (await get(name)) ?? null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await set(name, value);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

export const useAgentStore = create<AgentStoreState>()(
  persist(
    (set) => ({
      outputs: {},
      commandInputs: {},

      appendOutput: (agentId, output) => set((state) => {
        const existing = state.outputs[agentId] || [];
        const updated = [...existing, output];
        // Trim to max lines
        const trimmed = updated.length > MAX_OUTPUT_LINES
          ? updated.slice(-MAX_OUTPUT_LINES)
          : updated;
        return {
          outputs: { ...state.outputs, [agentId]: trimmed },
        };
      }),

      setOutputsBulk: (agentId, outputs) => set((state) => {
        const trimmed = outputs.length > MAX_OUTPUT_LINES
          ? outputs.slice(-MAX_OUTPUT_LINES)
          : outputs;
        return {
          outputs: { ...state.outputs, [agentId]: trimmed },
        };
      }),

      clearOutputs: (agentId) => set((state) => ({
        outputs: { ...state.outputs, [agentId]: [] },
      })),

      setCommandInput: (agentId, value) => set((state) => ({
        commandInputs: { ...state.commandInputs, [agentId]: value },
      })),

      clearAll: () => set({ outputs: {}, commandInputs: {} }),
    }),
    {
      name: 'omni-agent-store',
      storage: createJSONStorage(() => indexedDBStorage),
      // Only persist outputs and commandInputs (not functions)
      partialize: (state) => ({
        outputs: state.outputs,
        commandInputs: state.commandInputs,
      }),
    }
  )
);
