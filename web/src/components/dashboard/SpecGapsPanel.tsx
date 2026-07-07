import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';

interface SpecGap {
  id: string;
  taskId: string;
  taskTitle: string | null;
  category: string;
  description: string;
  status: 'open' | 'resolved';
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  sa_missing: 'SA 缺失',
  sd_missing: 'SD 缺失',
  field_undefined: '欄位未定義',
  api_undefined: 'API 未定義',
  logic_unclear: '邏輯不明',
  other: '其他',
  spec_changed: '規格已變更',
};

/**
 * 待補規格清單 — spec gaps reported by MCP report_spec_gap.
 * Refetches on project change and on the omni:spec-gap event (task.specGap WS message).
 */
export function SpecGapsPanel() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const addToast = useToastStore(s => s.addToast);
  const [gaps, setGaps] = useState<SpecGap[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const fetchGaps = useCallback(async () => {
    if (!currentProjectId) { setGaps([]); return; }
    try {
      const res = await fetch(`/api/spec-gaps/${encodeURIComponent(currentProjectId)}`);
      if (!res.ok) return;
      const data = await res.json() as { gaps: SpecGap[] };
      setGaps(data.gaps || []);
    } catch { /* server unreachable — keep last known state */ }
  }, [currentProjectId]);

  useEffect(() => { void fetchGaps(); }, [fetchGaps]);

  // Refetch when a gap is reported/resolved elsewhere (MCP → WS → useWebSocket dispatches this)
  useEffect(() => {
    const handler = () => { void fetchGaps(); };
    window.addEventListener('omni:spec-gap', handler);
    return () => window.removeEventListener('omni:spec-gap', handler);
  }, [fetchGaps]);

  const handleResolve = useCallback(async (gapId: string) => {
    setResolvingId(gapId);
    try {
      const res = await fetch(`/api/spec-gaps/${encodeURIComponent(gapId)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        addToast({ type: 'success', title: '已標記解決' });
        await fetchGaps();
      } else {
        addToast({ type: 'error', title: '標記失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '標記失敗', message: '無法連線到伺服器' });
    } finally {
      setResolvingId(null);
    }
  }, [addToast, fetchGaps]);

  const openGaps = gaps.filter(g => g.status === 'open');
  const resolvedGaps = gaps.filter(g => g.status === 'resolved');
  if (gaps.length === 0) return null;

  const visible = showResolved ? gaps : openGaps;

  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 flex-shrink-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-foreground">待補規格</span>
        {openGaps.length > 0 && (
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400">
            {openGaps.length}
          </span>
        )}
        {resolvedGaps.length > 0 && (
          <button
            onClick={() => setShowResolved(v => !v)}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showResolved ? '隱藏已解決' : `已解決 (${resolvedGaps.length})`}
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">沒有待補的規格缺口。</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {visible.map(gap => (
            <li key={gap.id} className="py-1.5 flex items-start gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 mt-0.5 ${
                gap.status === 'open' ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'
              }`}>
                {CATEGORY_LABELS[gap.category] || gap.category}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-xs break-words ${gap.status === 'resolved' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  {gap.description}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {gap.taskTitle || gap.taskId}
                  {' · '}
                  {new Date(gap.createdAt.endsWith('Z') ? gap.createdAt : gap.createdAt + 'Z').toLocaleString()}
                  {gap.status === 'resolved' && gap.resolutionNote ? ` · ${gap.resolutionNote}` : ''}
                </p>
              </div>
              {gap.status === 'open' && (
                <button
                  onClick={() => void handleResolve(gap.id)}
                  disabled={resolvingId === gap.id}
                  className="flex-shrink-0 px-2 py-0.5 text-[10px] font-medium rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors disabled:opacity-50"
                >
                  {resolvingId === gap.id ? '...' : '解決'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
