import { useCallback, useEffect, useState } from 'react';

export interface PanelData<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
}

/**
 * Shared fetch + loading/error state + CustomEvent-triggered refetch for
 * dashboard governance panels (SpecGaps / SpecCompliance / ProjectNotes).
 *
 * - `url === null` → clears data (e.g. no project selected)
 * - `refetchEventName` → window CustomEvent that triggers a refetch
 *   (dispatched by useWebSocket when the server pushes a change)
 */
export function usePanelData<T>(url: string | null, refetchEventName?: string): PanelData<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refetch = useCallback(async () => {
    if (!url) {
      setData(null);
      setError(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        setError(true);
        return;
      }
      setData(await res.json() as T);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => { void refetch(); }, [refetch]);

  useEffect(() => {
    if (!refetchEventName) return;
    const handler = () => { void refetch(); };
    window.addEventListener(refetchEventName, handler);
    return () => window.removeEventListener(refetchEventName, handler);
  }, [refetchEventName, refetch]);

  return { data, loading, error, refetch };
}
