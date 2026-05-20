import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAsanaStore } from '../../stores/asanaStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { IconX, IconRefresh, IconCheck, IconAsana } from '../ui/Icons';
import type { AsanaTask } from '@omni/shared';

interface AsanaImportDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function AsanaImportDrawer({ open, onClose }: AsanaImportDrawerProps) {
  const project = useProjectStore(s => s.projects.find(p => p.id === s.currentProjectId));
  const tasks = useProjectStore(s => s.tasks);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const asanaTasks = useAsanaStore(s => s.tasks);
  const asanaLoading = useAsanaStore(s => s.loading);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  // Already imported Asana GIDs
  const importedGids = new Set(
    tasks.filter(t => t.source === 'asana' && t.sourceRef).map(t => t.sourceRef!)
  );

  // Fetch all tasks for the bound Asana project (user picks which to import)
  const fetchTasks = useCallback(() => {
    if (!client || !project?.asanaProjectGid) return;
    client.send({
      type: 'asana.fetchTasks',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectGid: project.asanaProjectGid },
    });
  }, [client, project?.asanaProjectGid]);

  useEffect(() => {
    if (open && project?.asanaProjectGid) {
      fetchTasks();
      setSelected(new Set());
    }
  }, [open, project?.asanaProjectGid, fetchTasks]);

  const toggleSelect = (gid: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  const toggleAll = () => {
    const importable = asanaTasks.filter(t => !importedGids.has(t.gid));
    if (selected.size === importable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(importable.map(t => t.gid)));
    }
  };

  const handleImport = async () => {
    if (!client || !project) return;
    setImporting(true);

    const toImport = asanaTasks.filter(t => selected.has(t.gid));
    for (const asanaTask of toImport) {
      // Extract first URL from notes
      const urlMatch = asanaTask.notes.match(/https?:\/\/[^\s)>\]]+/);
      const specUrl = urlMatch ? urlMatch[0] : undefined;

      // Truncate description
      const description = asanaTask.notes.length > 2000
        ? asanaTask.notes.substring(0, 2000) + '...'
        : asanaTask.notes || undefined;

      client.send({
        type: 'task.create',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId: project.id,
          title: asanaTask.name,
          description,
          taskType: 'other' as const,
          label: (/前端|串接/.test(asanaTask.name) ? 'frontend' : /後端/.test(asanaTask.name) ? 'backend' : 'backend') as 'frontend' | 'backend',
          source: 'asana' as const,
          sourceRef: asanaTask.gid,
          specUrl,
        },
      });
    }

    addToast({ type: 'success', title: `Imported ${toImport.length} task(s)` });
    setSelected(new Set());
    setImporting(false);
    onClose();
  };

  if (!open) return null;

  const importableCount = asanaTasks.filter(t => !importedGids.has(t.gid)).length;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 z-50 w-[420px] bg-card border-l border-border shadow-2xl flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <IconAsana className="w-4 h-4 text-orange-400" />
            <h3 className="text-sm font-semibold">Import from Asana</h3>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={fetchTasks}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Refresh"
            >
              <IconRefresh className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <IconX className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {asanaLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-sm text-muted-foreground animate-pulse">Loading Asana tasks...</div>
            </div>
          ) : asanaTasks.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-muted-foreground">No tasks found in this Asana project</p>
            </div>
          ) : (
            <div className="space-y-1">
              {/* Select all */}
              {importableCount > 0 && (
                <button
                  onClick={toggleAll}
                  className="text-[10px] text-primary hover:underline mb-2"
                >
                  {selected.size === importableCount ? 'Deselect all' : `Select all (${importableCount})`}
                </button>
              )}

              {asanaTasks.map(task => {
                const isImported = importedGids.has(task.gid);
                const isSelected = selected.has(task.gid);

                return (
                  <div
                    key={task.gid}
                    className={`flex items-start gap-2.5 px-3 py-2 rounded-md transition-colors ${
                      isImported
                        ? 'opacity-50 cursor-not-allowed'
                        : isSelected
                          ? 'bg-primary/10 border border-primary/30'
                          : 'hover:bg-muted/50 border border-transparent cursor-pointer'
                    }`}
                    onClick={() => !isImported && toggleSelect(task.gid)}
                  >
                    {/* Checkbox */}
                    <div className={`w-4 h-4 mt-0.5 rounded border flex-shrink-0 flex items-center justify-center ${
                      isImported
                        ? 'border-muted-foreground/30 bg-muted'
                        : isSelected
                          ? 'border-primary bg-primary'
                          : 'border-border'
                    }`}>
                      {(isSelected || isImported) && (
                        <IconCheck className="w-2.5 h-2.5 text-white" />
                      )}
                    </div>

                    {/* Task info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground truncate">{task.name}</span>
                        {isImported && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0">
                            imported
                          </span>
                        )}
                      </div>
                      {task.dueOn && (
                        <span className="text-[10px] text-muted-foreground">Due: {task.dueOn}</span>
                      )}
                      {task.tags.length > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {task.tags.map(tag => (
                            <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {selected.size > 0 && (
          <div className="px-4 py-3 border-t border-border">
            <button
              onClick={handleImport}
              disabled={importing}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {importing ? 'Importing...' : `Import Selected (${selected.size})`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
