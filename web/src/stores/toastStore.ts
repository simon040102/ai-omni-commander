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
      const newToasts = [...state.toasts, { ...toast, id }];
      // Keep only the latest 3 toasts
      return { toasts: newToasts.slice(-3) };
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
