import { useState, useEffect, useCallback, useRef } from 'react';

interface FolderEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  current: string;
  parent: string;
  folders: FolderEntry[];
}

interface RecentPath {
  id: number;
  path: string;
  label: string | null;
  useCount: number;
  lastUsedAt: string;
}

interface FolderPickerProps {
  value: string;
  onChange: (path: string) => void;
}

export function FolderPicker({ value, onChange }: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [showRecent, setShowRecent] = useState(false);
  const [currentDir, setCurrentDir] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [recentPaths, setRecentPaths] = useState<RecentPath[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // Load recent paths
  const loadRecentPaths = useCallback(async () => {
    try {
      const resp = await fetch('/api/recent-paths?limit=10');
      if (resp.ok) {
        const data = await resp.json();
        setRecentPaths(data.paths || []);
      }
    } catch {
      // Ignore errors
    }
  }, []);

  // Add path to recent when selected
  const saveToRecent = useCallback(async (path: string) => {
    try {
      await fetch('/api/recent-paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      loadRecentPaths();
    } catch {
      // Ignore errors
    }
  }, [loadRecentPaths]);

  const browse = useCallback(async (dir?: string) => {
    setLoading(true);
    setError('');
    try {
      const params = dir ? `?path=${encodeURIComponent(dir)}` : '';
      const resp = await fetch(`/api/browse${params}`);
      if (!resp.ok) throw new Error('Failed to browse');
      const data: BrowseResult = await resp.json();
      setCurrentDir(data.current);
      setParentDir(data.parent);
      setFolders(data.folders);
    } catch (err) {
      setError('Cannot read this directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      browse(value || undefined);
    }
  }, [open]);

  // Load recent paths on mount
  useEffect(() => {
    loadRecentPaths();
  }, [loadRecentPaths]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowRecent(false);
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (folderPath: string) => {
    onChange(folderPath);
    saveToRecent(folderPath);
    setOpen(false);
    setShowRecent(false);
  };

  const handleRecentSelect = (path: string) => {
    onChange(path);
    saveToRecent(path); // This will update last_used_at
    setShowRecent(false);
  };

  const handleRemoveRecent = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    try {
      await fetch(`/api/recent-paths/${id}`, { method: 'DELETE' });
      setRecentPaths(recentPaths.filter(p => p.id !== id));
    } catch {
      // Ignore
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => recentPaths.length > 0 && setShowRecent(true)}
            placeholder="/path/to/folder"
            className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm pr-8"
          />
          {recentPaths.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRecent(!showRecent)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              title="Recent paths"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          )}

          {/* Recent paths dropdown */}
          {showRecent && recentPaths.length > 0 && (
            <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-card border border-border rounded-lg shadow-xl max-h-60 overflow-auto">
              <div className="px-3 py-1.5 border-b border-border text-xs text-muted-foreground flex items-center justify-between">
                <span>Recent Paths</span>
                <button
                  onClick={() => setShowRecent(false)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {recentPaths.map(rp => (
                <div
                  key={rp.id}
                  onClick={() => handleRecentSelect(rp.path)}
                  className="flex items-center justify-between px-3 py-2 hover:bg-muted/50 cursor-pointer text-sm group"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs truncate">{rp.path}</div>
                    {rp.label && (
                      <div className="text-xs text-muted-foreground">{rp.label}</div>
                    )}
                  </div>
                  <button
                    onClick={(e) => handleRemoveRecent(e, rp.id)}
                    className="shrink-0 ml-2 p-1 text-muted-foreground/50 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove from recent"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => { setOpen(!open); setShowRecent(false); }}
          className="px-3 py-2 bg-secondary text-secondary-foreground rounded-md text-sm hover:bg-secondary/80 whitespace-nowrap"
        >
          Browse
        </button>
      </div>

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-card border border-border rounded-lg shadow-xl max-h-80 flex flex-col">
          {/* Current path header */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs">
            <button
              onClick={() => browse(parentDir)}
              disabled={currentDir === parentDir}
              className="px-2 py-1 bg-muted rounded text-xs hover:bg-muted/80 disabled:opacity-30"
            >
              Up
            </button>
            <span className="font-mono text-muted-foreground truncate flex-1">{currentDir}</span>
            <button
              onClick={() => handleSelect(currentDir)}
              className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs"
            >
              Select This
            </button>
            <button
              onClick={() => setOpen(false)}
              className="px-2 py-1 text-muted-foreground hover:text-foreground text-xs"
            >
              Close
            </button>
          </div>

          {/* Folder list */}
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-4 text-center text-muted-foreground text-sm">Loading...</div>
            ) : error ? (
              <div className="p-4 text-center text-red-400 text-sm">{error}</div>
            ) : folders.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground text-sm">No subfolders</div>
            ) : (
              folders.map(folder => (
                <div
                  key={folder.path}
                  className="flex items-center justify-between px-3 py-1.5 hover:bg-muted/50 cursor-pointer text-sm group"
                >
                  <span
                    className="flex-1 truncate"
                    onClick={() => browse(folder.path)}
                  >
                    {folder.name}/
                  </span>
                  <button
                    onClick={() => handleSelect(folder.path)}
                    className="px-2 py-0.5 text-xs bg-primary/20 text-primary rounded opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    Select
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
