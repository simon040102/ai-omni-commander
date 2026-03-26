import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { get, set, del } from 'idb-keyval';

export interface AgentOutput {
  streamType: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  toolName?: string;
  timestamp: string;
}

export interface FlowStep {
  n: number;
  label: string;
  status: 'pending' | 'active' | 'done';
}

export interface AgentFlowPlan {
  steps: FlowStep[];
}

/** Parse flow markers from a text chunk and return updated plan */
function applyFlowMarkers(text: string, current: AgentFlowPlan | null): AgentFlowPlan | null {
  let plan = current;

  // [FLOW_PLAN]\n1. ...\n2. ...\n[/FLOW_PLAN]
  const planMatch = /\[FLOW_PLAN\]([\s\S]*?)\[\/FLOW_PLAN\]/g.exec(text);
  if (planMatch) {
    const lines = planMatch[1].trim().split('\n');
    const steps: FlowStep[] = [];
    for (const line of lines) {
      const m = /^\s*(\d+)[.)]\s+(.+)/.exec(line.trim());
      if (m) steps.push({ n: parseInt(m[1]), label: m[2].trim(), status: 'pending' });
    }
    if (steps.length > 0) plan = { steps };
  }

  if (!plan) return null;

  // [STEP:N] — mark step N active, previous steps done
  const stepMatches = [...text.matchAll(/\[STEP:(\d+)\]/g)];
  for (const m of stepMatches) {
    const n = parseInt(m[1]);
    plan = {
      steps: plan.steps.map(s =>
        s.n === n ? { ...s, status: 'active' }
        : s.n < n ? { ...s, status: 'done' }
        : s
      ),
    };
  }

  // [STEP_DONE:N] — mark step N done
  const doneMatches = [...text.matchAll(/\[STEP_DONE:(\d+)\]/g)];
  for (const m of doneMatches) {
    const n = parseInt(m[1]);
    plan = {
      steps: plan.steps.map(s => s.n === n ? { ...s, status: 'done' } : s),
    };
  }

  // [TASK_COMPLETE] — mark all steps done
  if (text.includes('[TASK_COMPLETE]')) {
    plan = { steps: plan.steps.map(s => ({ ...s, status: 'done' })) };
  }

  return plan;
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

  /** Map of agentId -> parsed flow plan from [FLOW_PLAN] markers */
  flowPlans: Record<string, AgentFlowPlan>;

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
      flowPlans: {},

      appendOutput: (agentId, output) => set((state) => {
        const existing = state.outputs[agentId] || [];
        const updated = [...existing, output];
        const trimmed = updated.length > MAX_OUTPUT_LINES
          ? updated.slice(-MAX_OUTPUT_LINES)
          : updated;
        // Parse flow markers from text output
        const updatedFlow = output.streamType === 'text'
          ? applyFlowMarkers(output.content, state.flowPlans[agentId] ?? null)
          : null;
        return {
          outputs: { ...state.outputs, [agentId]: trimmed },
          ...(updatedFlow && { flowPlans: { ...state.flowPlans, [agentId]: updatedFlow } }),
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
          newOutputs.push({
            streamType: 'system',
            content: `[thinking] ${buffer.thinking.trim()}`,
            timestamp,
          });
        }
        if (buffer.text.trim()) {
          newOutputs.push({
            streamType: 'text',
            content: buffer.text.trim(),
            timestamp,
          });
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
        const trimmed = outputs.length > MAX_OUTPUT_LINES
          ? outputs.slice(-MAX_OUTPUT_LINES)
          : outputs;
        // Re-parse flow plan from all historical outputs
        let flow: AgentFlowPlan | null = null;
        for (const o of trimmed) {
          if (o.streamType === 'text') flow = applyFlowMarkers(o.content, flow);
        }
        return {
          outputs: { ...state.outputs, [agentId]: trimmed },
          ...(flow && { flowPlans: { ...state.flowPlans, [agentId]: flow } }),
        };
      }),

      clearOutputs: (agentId) => set((state) => {
        const { [agentId]: _f, ...restFlow } = state.flowPlans;
        return {
          outputs: { ...state.outputs, [agentId]: [] },
          flowPlans: restFlow,
        };
      }),

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

      clearAll: () => set({ outputs: {}, commandInputs: {}, streamingBuffers: {}, progress: {}, flowPlans: {} }),
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
