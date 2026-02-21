import { create } from 'zustand';

export interface AgentOutput {
  streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  toolName?: string;
  timestamp: string;
}

interface AgentStoreState {
  /** Map of agentId -> output lines */
  outputs: Record<string, AgentOutput[]>;

  /** Append output to an agent's buffer */
  appendOutput: (agentId: string, output: AgentOutput) => void;

  /** Set bulk outputs for an agent (used when loading from DB) */
  setOutputsBulk: (agentId: string, outputs: AgentOutput[]) => void;

  /** Clear all outputs for an agent */
  clearOutputs: (agentId: string) => void;

  /** Clear everything */
  clearAll: () => void;
}

const MAX_OUTPUT_LINES = 2000;

export const useAgentStore = create<AgentStoreState>((set) => ({
  outputs: {},

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

  clearAll: () => set({ outputs: {} }),
}));
