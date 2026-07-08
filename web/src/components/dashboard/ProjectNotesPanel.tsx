import { useCallback, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';
import { parseServerDate } from '../../lib/datetime';

export interface ProjectNote {
  id: string;
  projectId: string;
  category: string | null;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ProjectNotesPanelProps {
  notes: ProjectNote[];
  loading: boolean;
  error: boolean;
  refetch: () => Promise<void>;
}

/**
 * 專案筆記 — experience notes (前人踩坑教訓) saved via MCP save_project_note or this panel.
 * Data is fetched by SpecGovernanceView (usePanelData) and passed in.
 */
export function ProjectNotesPanel({ notes, loading, error, refetch }: ProjectNotesPanelProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const addToast = useToastStore(s => s.addToast);
  const [showArchived, setShowArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!currentProjectId || !content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/project-notes/${encodeURIComponent(currentProjectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim(), category: category.trim() || undefined }),
      });
      if (res.ok) {
        setContent('');
        setCategory('');
        setShowForm(false);
        await refetch();
      } else {
        addToast({ type: 'error', title: '筆記儲存失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '筆記儲存失敗', message: '無法連線到伺服器' });
    } finally {
      setSaving(false);
    }
  }, [currentProjectId, content, category, addToast, refetch]);

  const handleArchive = useCallback(async (noteId: string) => {
    setArchivingId(noteId);
    try {
      const res = await fetch(`/api/project-notes/${encodeURIComponent(noteId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        await refetch();
      } else {
        addToast({ type: 'error', title: '封存失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '封存失敗', message: '無法連線到伺服器' });
    } finally {
      setArchivingId(null);
    }
  }, [addToast, refetch]);

  const activeNotes = notes.filter(n => n.active);
  const archivedNotes = notes.filter(n => !n.active);
  const visible = showArchived ? notes : activeNotes;

  return (
    <div>
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={() => setShowForm(v => !v)}
          className="text-xs font-medium text-sky-400 hover:text-sky-300 transition-colors"
        >
          {showForm ? '取消' : '+ 新增筆記'}
        </button>
        {archivedNotes.length > 0 && (
          <button
            onClick={() => setShowArchived(v => !v)}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showArchived ? '隱藏已封存' : `已封存 (${archivedNotes.length})`}
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-3 space-y-2">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={3}
            placeholder="筆記內容：具體描述坑/慣例與正確做法（一則筆記一個重點）"
            className="w-full px-3 py-2 text-sm bg-muted/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50 resize-y"
          />
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={category}
              onChange={e => setCategory(e.target.value)}
              placeholder="分類（選填，如 ui / db / build）"
              className="flex-1 px-3 py-1.5 text-xs bg-muted/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50"
            />
            <button
              onClick={() => void handleSave()}
              disabled={saving || !content.trim()}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 transition-colors disabled:opacity-50"
            >
              {saving ? '...' : '儲存'}
            </button>
          </div>
        </div>
      )}

      {error ? (
        <button
          onClick={() => void refetch()}
          className="text-[11px] text-muted-foreground/70 hover:text-foreground py-1 transition-colors"
        >
          載入失敗（重試）
        </button>
      ) : loading && notes.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/60 py-1 animate-pulse">載入中…</p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">尚無資料</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {visible.map(note => (
            <li key={note.id} className="py-2.5 flex items-start gap-3">
              {note.category ? (
                <span className={`w-24 px-2 py-0.5 rounded text-xs font-medium flex-shrink-0 mt-0.5 text-center truncate ${
                  note.active ? 'bg-sky-500/15 text-sky-400' : 'bg-muted text-muted-foreground'
                }`}>
                  {note.category}
                </span>
              ) : (
                <span className="w-24 flex-shrink-0" aria-hidden />
              )}
              <div className="flex-1 min-w-0">
                <p className={`text-sm leading-relaxed break-words whitespace-pre-wrap ${note.active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                  {note.content}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {parseServerDate(note.createdAt).toLocaleString()}
                </p>
              </div>
              {note.active && (
                <button
                  onClick={() => void handleArchive(note.id)}
                  disabled={archivingId === note.id}
                  className="flex-shrink-0 px-2.5 py-1 text-xs font-medium rounded bg-muted/50 text-muted-foreground border border-border hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {archivingId === note.id ? '...' : '封存'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
