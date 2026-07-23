import { useCallback, useState } from 'react';
import { useToastStore } from '../../stores/toastStore';
import { parseServerDate } from '../../lib/datetime';

export interface SpecGap {
  id: string;
  taskId: string;
  taskTitle: string | null;
  functionCode: string | null;
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
  sa_sd_mismatch: 'SA/SD 矛盾',
  ambiguous_spec: '規格模糊',
};

interface SpecGapsPanelProps {
  gaps: SpecGap[];
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
}

/**
 * 待補規格清單 — spec gaps reported by MCP report_spec_gap.
 * Data is fetched by SpecGovernanceView (usePanelData) and passed in.
 */
export function SpecGapsPanel({ gaps, loading, error, refetch }: SpecGapsPanelProps) {
  const addToast = useToastStore(s => s.addToast);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

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
        await refetch();
      } else {
        addToast({ type: 'error', title: '標記失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '標記失敗', message: '無法連線到伺服器' });
    } finally {
      setResolvingId(null);
    }
  }, [addToast, refetch]);

  const openGaps = gaps.filter(g => g.status === 'open');
  const resolvedGaps = gaps.filter(g => g.status === 'resolved');
  const visible = showResolved ? gaps : openGaps;

  return (
    <div>
      {resolvedGaps.length > 0 && (
        <div className="flex items-center mb-1.5">
          <button
            onClick={() => setShowResolved(v => !v)}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showResolved ? '隱藏已解決' : `已解決 (${resolvedGaps.length})`}
          </button>
        </div>
      )}
      {error ? (
        <button
          onClick={() => void refetch()}
          className="text-[11px] text-muted-foreground/70 hover:text-foreground py-1 transition-colors"
        >
          載入失敗（重試）
        </button>
      ) : loading && gaps.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60 py-1 animate-pulse">載入中…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">尚無資料</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {visible.map(gap => (
            <li key={gap.id} className="py-2.5 flex items-start gap-3">
              <span className={`w-24 px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 mt-0.5 text-center ${
                gap.status === 'open' ? 'bg-amber-500/15 text-amber-400' : 'bg-green-500/15 text-green-400'
              }`}>
                {CATEGORY_LABELS[gap.category] || gap.category}
              </span>
              <div className="flex-1 min-w-0">
                <p className={`text-sm leading-relaxed break-words ${gap.status === 'resolved' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                  {gap.description}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {gap.taskTitle || gap.taskId}
                  {' · '}
                  {parseServerDate(gap.createdAt).toLocaleString()}
                  {gap.status === 'resolved' && gap.resolutionNote ? ` · ${gap.resolutionNote}` : ''}
                </p>
              </div>
              {gap.status === 'open' && (
                <button
                  onClick={() => void handleResolve(gap.id)}
                  disabled={resolvingId === gap.id}
                  className="flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 transition-colors disabled:opacity-50"
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
