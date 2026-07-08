import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';
import { parseServerDate } from '../../lib/datetime';

export interface ComplianceRunSummary {
  id: string;
  runAt: string;
  source: 'engine' | 'ai_review';
  total: number;
  matched: number;
  missing: number;
  manual: number;
  waived: number;
}

export interface ComplianceTaskSummary {
  taskId: string;
  taskTitle: string | null;
  taskStatus: string | null;
  itemCount: number;
  waivedCount: number;
  hasAiReviewRun: boolean;
  latestRun: ComplianceRunSummary | null;
}

interface ChecklistItem {
  id: string;
  itemType: string;
  content: string;
  side: string;
  sourceRef: string | null;
  waived: boolean;
  waiveReason: string | null;
  createdAt: string;
}

interface RunItemResult {
  itemId: string;
  itemType: string;
  content: string;
  status: 'matched' | 'missing' | 'manual' | 'waived';
  evidence?: Array<{ file: string; line: number }>;
  note?: string;
}

interface TaskDetail {
  taskId: string;
  items: ChecklistItem[];
  hasAiReviewRun: boolean;
  latestRun: (ComplianceRunSummary & { results: RunItemResult[] }) | null;
}

const TYPE_LABELS: Record<string, string> = {
  ui_text: '文字',
  api: 'API',
  param: '參數',
  response_field: '回應欄位',
  db_field: 'DB 欄位',
  logic: '邏輯',
};

interface SpecCompliancePanelProps {
  taskSummaries: ComplianceTaskSummary[];
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
}

/**
 * 規格回對面板 — spec checklist items saved by MCP save_spec_checklist and
 * compliance runs from run_spec_compliance.
 * Summary data is fetched by SpecGovernanceSection (usePanelData) and passed in;
 * the per-task detail is fetched on demand here.
 */
export function SpecCompliancePanel({ taskSummaries, loading, error, refetch }: SpecCompliancePanelProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const addToast = useToastStore(s => s.addToast);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [waivingId, setWaivingId] = useState<string | null>(null);

  const fetchDetail = useCallback(async (taskId: string) => {
    try {
      const res = await fetch(`/api/spec-compliance/${encodeURIComponent(taskId)}`);
      if (!res.ok) return;
      const data = await res.json() as TaskDetail;
      setDetail(data);
    } catch { /* server unreachable */ }
  }, []);

  useEffect(() => { setSelectedTaskId(null); setDetail(null); }, [currentProjectId]);
  useEffect(() => {
    if (selectedTaskId) void fetchDetail(selectedTaskId);
    else setDetail(null);
  }, [selectedTaskId, fetchDetail]);

  // Refresh the open detail when a checklist is saved/waived or a run completes elsewhere
  // (summary refetch is handled by SpecGovernanceSection's usePanelData)
  useEffect(() => {
    const handler = () => {
      if (selectedTaskId) void fetchDetail(selectedTaskId);
    };
    window.addEventListener('omni:spec-compliance', handler);
    return () => window.removeEventListener('omni:spec-compliance', handler);
  }, [fetchDetail, selectedTaskId]);

  const handleWaive = useCallback(async (item: ChecklistItem) => {
    const reason = window.prompt(`豁免理由（必填）：\n[${TYPE_LABELS[item.itemType] || item.itemType}] ${item.content}`);
    if (reason === null) return;
    if (!reason.trim()) {
      addToast({ type: 'error', title: '豁免失敗', message: '理由必填' });
      return;
    }
    setWaivingId(item.id);
    try {
      const res = await fetch(`/api/checklist-items/${encodeURIComponent(item.id)}/waive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (res.ok) {
        addToast({ type: 'success', title: '已豁免', message: '重跑 run_spec_compliance 後比對結果才會更新' });
        await refetch();
        if (selectedTaskId) await fetchDetail(selectedTaskId);
      } else {
        addToast({ type: 'error', title: '豁免失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '豁免失敗', message: '無法連線到伺服器' });
    } finally {
      setWaivingId(null);
    }
  }, [addToast, refetch, fetchDetail, selectedTaskId]);

  const resultByItemId = new Map<string, RunItemResult>();
  if (detail?.latestRun) {
    for (const r of detail.latestRun.results) resultByItemId.set(r.itemId, r);
  }

  const statusOf = (item: ChecklistItem): RunItemResult['status'] | 'pending' => {
    if (item.waived) return 'waived';
    const r = resultByItemId.get(item.id);
    return r ? r.status : 'pending';
  };

  const statusBadge = (status: RunItemResult['status'] | 'pending') => {
    switch (status) {
      case 'matched': return <span className="text-green-400">✅</span>;
      case 'missing': return <span className="text-red-400">❌</span>;
      case 'manual': return <span className="text-amber-400">⚠</span>;
      case 'waived': return <span className="text-muted-foreground">—</span>;
      default: return <span className="text-muted-foreground">·</span>;
    }
  };

  const scoreLabel = (run: ComplianceRunSummary | null, itemCount: number) => {
    if (!run) return `未回對（${itemCount} 項）`;
    const autoTotal = run.total - run.manual - run.waived;
    return `${run.matched}/${autoTotal}${run.missing > 0 ? ` · missing ${run.missing}` : ' ✓'}`;
  };

  const sortRank: Record<string, number> = { missing: 0, pending: 1, manual: 2, matched: 3, waived: 4 };
  const sortedItems = detail
    ? [...detail.items].sort((a, b) => (sortRank[statusOf(a)] ?? 9) - (sortRank[statusOf(b)] ?? 9))
    : [];

  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-foreground">規格回對</span>
      </div>

      {error ? (
        <button
          onClick={() => void refetch()}
          className="text-[11px] text-muted-foreground/70 hover:text-foreground py-1 transition-colors"
        >
          載入失敗（重試）
        </button>
      ) : loading && taskSummaries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60 py-1 animate-pulse">載入中…</p>
      ) : taskSummaries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">尚無資料</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {taskSummaries.map(t => (
            <li key={t.taskId}>
              <button
                onClick={() => setSelectedTaskId(prev => prev === t.taskId ? null : t.taskId)}
                className="w-full py-1.5 flex items-center gap-2 text-left hover:bg-muted/30 rounded transition-colors"
              >
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                  !t.latestRun ? 'bg-muted text-muted-foreground'
                    : t.latestRun.missing > 0 ? 'bg-red-500/15 text-red-400'
                      : 'bg-green-500/15 text-green-400'
                }`}>
                  {scoreLabel(t.latestRun, t.itemCount)}
                </span>
                {t.latestRun && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                    t.latestRun.source === 'ai_review'
                      ? 'bg-blue-500/15 text-blue-400'
                      : 'bg-muted text-muted-foreground'
                  }`}>
                    {t.latestRun.source === 'ai_review' ? 'AI 回對' : '程式預檢'}
                  </span>
                )}
                {t.latestRun && !t.hasAiReviewRun && (
                  <span className="text-[10px] text-amber-400 flex-shrink-0">尚未 AI 回對（結案閘門未解鎖）</span>
                )}
                <span className="text-xs text-foreground truncate flex-1">{t.taskTitle || t.taskId}</span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">{selectedTaskId === t.taskId ? '收合' : '展開'}</span>
              </button>

              {/* detail */}
              {selectedTaskId === t.taskId && detail && (
                <div className="pb-2 pl-1">
                  {detail.latestRun && (
                    <p className="text-[10px] text-muted-foreground mb-1">
                      最後回對（{detail.latestRun.source === 'ai_review' ? 'AI 回對' : '程式預檢'}）：{parseServerDate(detail.latestRun.runAt).toLocaleString()}
                    </p>
                  )}
                  <ul className="space-y-0.5">
                    {sortedItems.map(item => {
                      const status = statusOf(item);
                      const r = resultByItemId.get(item.id);
                      return (
                        <li key={item.id} className="flex items-start gap-1.5 text-[11px]">
                          <span className="flex-shrink-0 mt-px">{statusBadge(status)}</span>
                          <span className="px-1 rounded bg-muted/60 text-muted-foreground text-[10px] flex-shrink-0 mt-px">
                            {TYPE_LABELS[item.itemType] || item.itemType}
                          </span>
                          <div className="flex-1 min-w-0">
                            <span className={`break-words ${status === 'missing' ? 'text-red-400' : status === 'waived' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                              {item.content}
                            </span>
                            {status === 'matched' && r?.evidence && r.evidence.length > 0 && (
                              <span className="text-[10px] text-muted-foreground ml-1">
                                {r.evidence.map(e => `${e.file}:${e.line}`).join(', ')}
                              </span>
                            )}
                            {r?.note && status !== 'matched' && (
                              <span className="text-[10px] text-muted-foreground ml-1">{r.note}</span>
                            )}
                            {item.waived && item.waiveReason && (
                              <span className="text-[10px] text-muted-foreground ml-1">豁免：{item.waiveReason}</span>
                            )}
                          </div>
                          {!item.waived && status === 'missing' && (
                            <button
                              onClick={() => void handleWaive(item)}
                              disabled={waivingId === item.id}
                              className="flex-shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors disabled:opacity-50"
                            >
                              {waivingId === item.id ? '...' : '豁免'}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
