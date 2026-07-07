import { useCallback, useEffect, useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useToastStore } from '../../stores/toastStore';

interface ProjectNote {
  id: string;
  projectId: string;
  category: string | null;
  content: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 專案筆記 — experience notes (前人踩坑教訓) saved via MCP save_project_note or this panel.
 * Refetches on project change and on the omni:project-note event (project.noteSaved WS message).
 */
export function ProjectNotesPanel() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const addToast = useToastStore(s => s.addToast);
  const [notes, setNotes] = useState<ProjectNote[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const fetchNotes = useCallback(async () => {
    if (!currentProjectId) { setNotes([]); return; }
    try {
      const res = await fetch(`/api/project-notes/${encodeURIComponent(currentProjectId)}`);
      if (!res.ok) return;
      const data = await res.json() as { notes: ProjectNote[] };
      setNotes(data.notes || []);
    } catch { /* server unreachable — keep last known state */ }
  }, [currentProjectId]);

  useEffect(() => { void fetchNotes(); }, [fetchNotes]);

  // Refetch when a note is saved/archived elsewhere (MCP → WS → useWebSocket dispatches this)
  useEffect(() => {
    const handler = () => { void fetchNotes(); };
    window.addEventListener('omni:project-note', handler);
    return () => window.removeEventListener('omni:project-note', handler);
  }, [fetchNotes]);

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
        await fetchNotes();
      } else {
        addToast({ type: 'error', title: '筆記儲存失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '筆記儲存失敗', message: '無法連線到伺服器' });
    } finally {
      setSaving(false);
    }
  }, [currentProjectId, content, category, addToast, fetchNotes]);

  const handleArchive = useCallback(async (noteId: string) => {
    setArchivingId(noteId);
    try {
      const res = await fetch(`/api/project-notes/${encodeURIComponent(noteId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        await fetchNotes();
      } else {
        addToast({ type: 'error', title: '封存失敗', message: `HTTP ${res.status}` });
      }
    } catch {
      addToast({ type: 'error', title: '封存失敗', message: '無法連線到伺服器' });
    } finally {
      setArchivingId(null);
    }
  }, [addToast, fetchNotes]);

  if (!currentProjectId) return null;

  const activeNotes = notes.filter(n => n.active);
  const archivedNotes = notes.filter(n => !n.active);
  const visible = showArchived ? notes : activeNotes;

  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 flex-shrink-0">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-foreground">專案筆記</span>
        {activeNotes.length > 0 && (
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-400">
            {activeNotes.length}
          </span>
        )}
        <button
          onClick={() => setShowForm(v => !v)}
          className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showForm ? '取消' : '+ 新增'}
        </button>
        {archivedNotes.length > 0 && (
          <button
            onClick={() => setShowArchived(v => !v)}
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showArchived ? '隱藏已封存' : `已封存 (${archivedNotes.length})`}
          </button>
        )}
      </div>

      {showForm && (
        <div className="mb-2 space-y-1.5">
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={2}
            placeholder="筆記內容：具體描述坑/慣例與正確做法（一則筆記一個重點）"
            className="w-full px-2 py-1.5 text-xs bg-muted/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50 resize-y"
          />
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={category}
              onChange={e => setCategory(e.target.value)}
              placeholder="分類（選填，如 ui / db / build）"
              className="flex-1 px-2 py-1 text-[11px] bg-muted/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sky-500/50"
            />
            <button
              onClick={() => void handleSave()}
              disabled={saving || !content.trim()}
              className="flex-shrink-0 px-2.5 py-1 text-[11px] font-medium rounded bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 transition-colors disabled:opacity-50"
            >
              {saving ? '...' : '儲存'}
            </button>
          </div>
        </div>
      )}

      {visible.length === 0 ? (
        <p className="text-[11px] text-muted-foreground py-1">還沒有專案筆記。</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {visible.map(note => (
            <li key={note.id} className="py-1.5 flex items-start gap-2">
              {note.category && (
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 mt-0.5 ${
                  note.active ? 'bg-sky-500/15 text-sky-400' : 'bg-muted text-muted-foreground'
                }`}>
                  {note.category}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <p className={`text-xs break-words whitespace-pre-wrap ${note.active ? 'text-foreground' : 'text-muted-foreground line-through'}`}>
                  {note.content}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(note.createdAt.endsWith('Z') ? note.createdAt : note.createdAt + 'Z').toLocaleString()}
                </p>
              </div>
              {note.active && (
                <button
                  onClick={() => void handleArchive(note.id)}
                  disabled={archivingId === note.id}
                  className="flex-shrink-0 px-2 py-0.5 text-[10px] font-medium rounded bg-muted/50 text-muted-foreground border border-border hover:bg-muted hover:text-foreground transition-colors disabled:opacity-50"
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
