import { create } from 'zustand';
import type { AsanaTask, AsanaConnectionStatus } from '@omni/shared';

interface AsanaState {
  /** List of tasks fetched from Asana */
  tasks: AsanaTask[];
  /** Whether tasks are being fetched */
  loading: boolean;
  /** Error message if fetch failed */
  error: string | null;
  /** MCP connection status */
  connectionStatus: AsanaConnectionStatus;
  /** Currently selected task GID */
  selectedTaskGid: string | null;

  // Actions
  setTasks: (tasks: AsanaTask[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setConnectionStatus: (status: AsanaConnectionStatus) => void;
  selectTask: (gid: string | null) => void;
  getSelectedTask: () => AsanaTask | null;
  clearTasks: () => void;
}

export const useAsanaStore = create<AsanaState>((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  connectionStatus: {
    connected: false,
    configured: false,
    lastChecked: null,
    error: null,
  },
  selectedTaskGid: null,

  setTasks: (tasks) => set({ tasks, loading: false, error: null }),

  setLoading: (loading) => set({ loading }),

  setError: (error) => set({ error, loading: false }),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  selectTask: (gid) => set({ selectedTaskGid: gid }),

  getSelectedTask: () => {
    const { tasks, selectedTaskGid } = get();
    return tasks.find((t) => t.gid === selectedTaskGid) || null;
  },

  clearTasks: () => set({ tasks: [], selectedTaskGid: null }),
}));
