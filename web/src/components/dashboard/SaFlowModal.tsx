import { useEffect, useState } from 'react';
import { IconX } from '../ui/Icons';
import MermaidRenderer from '../db/MermaidRenderer';
import { parseServerDate } from '../../lib/datetime';

interface SaFlowModalProps {
  projectId: string;
  taskId?: string;
  onClose: () => void;
}

interface FlowEntry {
  hash: string;
  filename: string;
  generatedAt: string;
  flowPath: string;
  taskIds: string[];
}

export function SaFlowModal({ projectId, taskId, onClose }: SaFlowModalProps) {
  const [flows, setFlows] = useState<FlowEntry[]>([]);
  const [selected, setSelected] = useState<FlowEntry | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/sa-flow/${projectId}`)
      .then(r => r.json())
      .then(data => {
        const list: FlowEntry[] = data.flows ?? [];
        setFlows(list);
        // Prefer flow that belongs to current task, fallback to first
        const taskFlow = taskId ? list.find(f => f.taskIds?.includes(taskId)) : null;
        setSelected(taskFlow ?? list[0] ?? null);
      })
      .catch(() => setError('無法載入 SA 流程圖'))
      .finally(() => setLoading(false));
  }, [projectId, taskId]);

  useEffect(() => {
    if (!selected) return;
    setContent('');
    fetch(`/api/sa-flow/${projectId}/file?path=${encodeURIComponent(selected.flowPath)}`)
      .then(r => r.text())
      .then(setContent)
      .catch(() => setError('無法載入流程圖內容'));
  }, [selected, projectId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl shadow-xl flex flex-col overflow-hidden"
        style={{ width: '85vw', height: '80vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">SA 操作流程圖</span>
            {flows.length > 1 && (
              <select
                value={selected?.hash ?? ''}
                onChange={e => setSelected(flows.find(f => f.hash === e.target.value) ?? null)}
                className="text-xs bg-muted border border-border rounded px-2 py-1 outline-none"
              >
                {flows.map(f => (
                  <option key={f.hash} value={f.hash}>{f.filename}</option>
                ))}
              </select>
            )}
            {selected && (
              <span className="text-xs text-muted-foreground">
                {selected.filename} · {parseServerDate(selected.generatedAt).toLocaleDateString('zh-TW')}
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-muted transition-colors">
            <IconX className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 p-2">
          {loading && (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              載入中...
            </div>
          )}
          {error && (
            <div className="h-full flex items-center justify-center text-red-500 text-sm">
              {error}
            </div>
          )}
          {!loading && !error && flows.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-2">
              <span className="text-muted-foreground text-sm">尚無 SA 流程圖</span>
              <span className="text-muted-foreground text-xs">執行前端任務後會自動分析 SA 文件產生流程圖</span>
            </div>
          )}
          {!loading && !error && content && (
            <MermaidRenderer
              content={content}
              height="100%"
              filename={`${selected?.filename ?? 'sa-flow'}.png`}
            />
          )}
        </div>
      </div>
    </div>
  );
}
