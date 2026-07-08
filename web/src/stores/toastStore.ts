import { create } from 'zustand';

export interface Toast {
  id: string;
  type: 'info' | 'success' | 'error' | 'warning';
  title: string;
  message?: string;
  duration?: number; // ms, 0 = persistent
}

interface ToastState {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = crypto.randomUUID();
    set((state) => {
      const all = [...state.toasts, { ...toast, id }];
      // Persistent toasts (duration: 0) are never pushed out by transient ones;
      // only cap the transient toasts at the latest 3.
      const persistent = all.filter((t) => t.duration === 0);
      const transient = all.filter((t) => t.duration !== 0).slice(-3);
      // Preserve original insertion order
      const capped = new Set([...persistent, ...transient]);
      return { toasts: all.filter((t) => capped.has(t)) };
    });

    // Auto-remove after duration (default 5s)
    const duration = toast.duration ?? 5000;
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, duration);
    }
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
}));
