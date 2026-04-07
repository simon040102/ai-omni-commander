import { create } from 'zustand';
import type { DbSchemaResult } from '@omni/shared';

interface SchemaStoreState {
  /** Active connection ID (selected card) */
  activeConnectionId: string | null;
  /** Cached schemas keyed by connectionId */
  schemas: Record<string, DbSchemaResult>;
  /** Selected table name */
  selectedTable: string | null;
  /** Loading state per connection */
  loading: Record<string, boolean>;
  /** Error state per connection */
  errors: Record<string, string>;

  setActiveConnection: (id: string | null) => void;
  setSelectedTable: (name: string | null) => void;
  setSchema: (connectionId: string, result: DbSchemaResult) => void;
  setLoading: (connectionId: string, loading: boolean) => void;
  setError: (connectionId: string, error: string) => void;
  clearError: (connectionId: string) => void;
}

export const useSchemaStore = create<SchemaStoreState>()((set) => ({
  activeConnectionId: null,
  schemas: {},
  selectedTable: null,
  loading: {},
  errors: {},

  setActiveConnection: (id) => set({ activeConnectionId: id, selectedTable: null }),
  setSelectedTable: (name) => set({ selectedTable: name }),
  setSchema: (connectionId, result) => set((state) => ({
    schemas: { ...state.schemas, [connectionId]: result },
  })),
  setLoading: (connectionId, loading) => set((state) => ({
    loading: { ...state.loading, [connectionId]: loading },
  })),
  setError: (connectionId, error) => set((state) => ({
    errors: { ...state.errors, [connectionId]: error },
  })),
  clearError: (connectionId) => set((state) => {
    const { [connectionId]: _, ...rest } = state.errors;
    return { errors: rest };
  }),
}));
