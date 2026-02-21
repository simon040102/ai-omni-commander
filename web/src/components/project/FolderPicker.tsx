import { useState, useEffect, useCallback } from 'react';

interface FolderEntry {
  name: string;
  path: string;
}

interface BrowseResult {
  current: string;
  parent: string;
  folders: FolderEntry[];
}

interface FolderPickerProps {
  value: string;
  onChange: (path: string) => void;
}

export function FolderPicker({ value, onChange }: FolderPickerProps) {
  const [open, setOpen] = useState(false);
  const [currentDir, setCurrentDir] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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

  const handleSelect = (folderPath: string) => {
    onChange(folderPath);
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="/path/to/folder"
          className="flex-1 bg-muted border border-border rounded-md px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => setOpen(!open)}
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
