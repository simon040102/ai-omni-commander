import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';

export interface AgentOutput {
  /** Monotonic client-side id, assigned by the store — stable React key even after trimming */
  id?: number;
  streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  toolName?: string;
  timestamp: string;
}

/** Monotonic id for AgentOutput React keys (client-session scope) */
let nextOutputId = 1;
function withId(output: AgentOutput): AgentOutput {
  return output.id != null ? output : { ...output, id: nextOutputId++ };
}

export interface AgentProgress {
  agentId: string;
  completedSteps: number;
  totalSteps: number;
  currentPhase: string;
  fileWrites: number;
  toolUses: number;
  percentage: number;
}

interface AgentStoreState {
  /** Map of agentId -> output lines */
  outputs: Record<string, AgentOutput[]>;

  /** Map of agentId -> command input draft (persisted across project switches) */
  commandInputs: Record<string, string>;

  /** Map of agentId -> current streaming text buffer (not persisted) */
  streamingBuffers: Record<string, { text: string; thinking: string }>;

  /** Map of agentId -> progress info */
  progress: Record<string, AgentProgress>;

  /** Map of agentId -> context usage info */
  contextUsage: Record<string, { totalTokens: number; maxTokens: number; percentage: number }>;

  /** Update context usage for an agent */
  setContextUsage: (agentId: string, usage: { totalTokens: number; maxTokens: number; percentage: number }) => void;

  /** Append output to an agent's buffer */
  appendOutput: (agentId: string, output: AgentOutput) => void;

  /** Append streaming text (accumulates until flushed) */
  appendStreaming: (agentId: string, type: 'text' | 'thinking', content: string) => void;

  /** Flush streaming buffer to output */
  flushStreaming: (agentId: string) => void;

  /** Clear streaming buffer without adding to outputs (when server already saved) */
  clearStreamingBuffer: (agentId: string) => void;

  /** Set bulk outputs for an agent (used when loading from DB) */
  setOutputsBulk: (agentId: string, outputs: AgentOutput[]) => void;

  /** Clear all outputs for an agent */
  clearOutputs: (agentId: string) => void;

  /** Set command input for an agent */
  setCommandInput: (agentId: string, value: string) => void;

  /** Set progress for an agent */
  setProgress: (agentId: string, progress: AgentProgress) => void;

  /** Clear progress for an agent */
  clearProgress: (agentId: string) => void;

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
      streamingBuffers: {},
      progress: {},
      contextUsage: {},

      setContextUsage: (agentId, usage) => set((state) => ({
        contextUsage: { ...state.contextUsage, [agentId]: usage },
      })),

      appendOutput: (agentId, output) => set((state) => {
        const existing = state.outputs[agentId] || [];
        const updated = [...existing, withId(output)];
        const trimmed = updated.length > MAX_OUTPUT_LINES
          ? updated.slice(-MAX_OUTPUT_LINES)
          : updated;
        return {
          outputs: { ...state.outputs, [agentId]: trimmed },
        };
      }),

      appendStreaming: (agentId, type, content) => set((state) => {
        const buffer = state.streamingBuffers[agentId] || { text: '', thinking: '' };
        return {
          streamingBuffers: {
            ...state.streamingBuffers,
            [agentId]: {
              ...buffer,
              [type]: buffer[type] + content,
            },
          },
        };
      }),

      flushStreaming: (agentId) => set((state) => {
        const buffer = state.streamingBuffers[agentId];
        if (!buffer) return state;

        const newOutputs: AgentOutput[] = [];
        const timestamp = new Date().toISOString();

        if (buffer.thinking.trim()) {
          newOutputs.push(withId({
            streamType: 'system',
            content: `[thinking] ${buffer.thinking.trim()}`,
            timestamp,
          }));
        }
        if (buffer.text.trim()) {
          newOutputs.push(withId({
            streamType: 'text',
            content: buffer.text.trim(),
            timestamp,
          }));
        }

        if (newOutputs.length === 0) {
          return {
            streamingBuffers: { ...state.streamingBuffers, [agentId]: { text: '', thinking: '' } },
          };
        }

        const existing = state.outputs[agentId] || [];
        const updated = [...existing, ...newOutputs];
        const trimmed = updated.length > MAX_OUTPUT_LINES
          ? updated.slice(-MAX_OUTPUT_LINES)
          : updated;

        return {
          outputs: { ...state.outputs, [agentId]: trimmed },
          streamingBuffers: { ...state.streamingBuffers, [agentId]: { text: '', thinking: '' } },
        };
      }),

      clearStreamingBuffer: (agentId) => set((state) => ({
        streamingBuffers: { ...state.streamingBuffers, [agentId]: { text: '', thinking: '' } },
      })),

      setOutputsBulk: (agentId, outputs) => set((state) => {
        const withIds = outputs.map(withId);
        const trimmed = withIds.length > MAX_OUTPUT_LINES
          ? withIds.slice(-MAX_OUTPUT_LINES)
          : withIds;
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

      setProgress: (agentId, progress) => set((state) => ({
        progress: { ...state.progress, [agentId]: progress },
      })),

      clearProgress: (agentId) => set((state) => {
        const { [agentId]: _, ...rest } = state.progress;
        return { progress: rest };
      }),

      clearAll: () => set({ outputs: {}, commandInputs: {}, streamingBuffers: {}, progress: {}, contextUsage: {} }),
    }),
    {
      name: 'omni-agent-store',
      storage: createJSONStorage(() => indexedDBStorage),
      // Only persist commandInputs (not outputs or streaming buffers)
      // Outputs are always loaded fresh from server when switching projects
      // to avoid stale IndexedDB data overriding server data
      partialize: (state) => ({
        commandInputs: state.commandInputs,
      }),
    }
  )
);
