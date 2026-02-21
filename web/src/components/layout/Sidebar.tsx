import { useState, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';

type View = 'dashboard' | 'tasks' | 'setup' | 'events';

interface SidebarProps {
  currentView: View;
  onViewChange: (view: View) => void;
}

const STATUS_COLORS: Record<string, string> = {
  setup: 'bg-gray-500',
  planning: 'bg-yellow-500',
  executing: 'bg-green-500 animate-pulse',
  paused: 'bg-orange-500',
  completed: 'bg-blue-500',
  failed: 'bg-red-500',
};

export function Sidebar({ currentView, onViewChange }: SidebarProps) {
  const projects = useProjectStore(s => s.projects);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const setCurrentProject = useProjectStore(s => s.setCurrentProject);
  const agents = useProjectStore(s => s.agents);
  const tasks = useProjectStore(s => s.tasks);
  const interventions = useProjectStore(s => s.interventions);
  const connected = useWsStore(s => s.connected);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const pendingInterventions = interventions.filter(i => i.status === 'pending').length;
  const runningAgents = agents.filter(a => a.status === 'running').length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const totalCost = agents.reduce((sum, a) => sum + a.totalCostUsd, 0);

  const navItems: { view: View; label: string; icon: string; badge?: number }[] = [
    { view: 'setup', label: 'New Project', icon: '+' },
    { view: 'dashboard', label: 'Dashboard', icon: '>' },
    { view: 'tasks', label: 'Tasks', icon: '#', badge: tasks.filter(t => t.status === 'failed').length || undefined },
    { view: 'events', label: 'Events', icon: '~' },
  ];

  const handleDelete = useCallback((projectId: string) => {
    client?.send({
      type: 'project.delete',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId },
    });
    // If we just deleted the current project, clear selection
    if (projectId === currentProjectId) {
      setCurrentProject(null);
    }
    setConfirmDeleteId(null);
    addToast({ type: 'success', title: 'Project deleted' });
  }, [client, currentProjectId, setCurrentProject, addToast]);

  const handleEditSave = useCallback((projectId: string) => {
    if (!editName.trim()) return;
    client?.send({
      type: 'project.update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId, name: editName.trim() },
    });
    setEditingId(null);
    addToast({ type: 'success', title: 'Project renamed' });
  }, [client, editName, addToast]);

  const startEditing = (p: { id: string; name: string }) => {
    setEditingId(p.id);
    setEditName(p.name);
    setConfirmDeleteId(null);
  };

  return (
    <aside className="w-56 border-r border-border bg-card flex flex-col">
      {/* Connection status */}
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          <span className={connected ? 'text-green-400' : 'text-red-400'}>
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <nav className="flex-1 p-2">
        {navItems.map(item => (
          <button
            key={item.view}
            onClick={() => onViewChange(item.view)}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm mb-1 transition-colors ${
              currentView === item.view
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <span className="w-4 text-center font-mono">{item.icon}</span>
            <span>{item.label}</span>
            {item.badge ? (
              <span className="ml-auto text-xs bg-red-500 text-white px-1.5 rounded-full">
                {item.badge}
              </span>
            ) : null}
          </button>
        ))}
      </nav>

      {/* Status summary */}
      <div className="p-3 border-t border-border">
        <div className="text-xs text-muted-foreground space-y-1.5">
          <div className="flex justify-between">
            <span>Agents</span>
            <span className={runningAgents > 0 ? 'text-green-400' : 'text-foreground'}>
              {runningAgents > 0 ? `${runningAgents} running` : `${agents.length} total`}
            </span>
          </div>
          <div className="flex justify-between">
            <span>Tasks</span>
            <span className="text-foreground">{completedTasks}/{tasks.length}</span>
          </div>
          {totalCost > 0 && (
            <div className="flex justify-between">
              <span>Total Cost</span>
              <span className="text-foreground font-mono">${totalCost.toFixed(4)}</span>
            </div>
          )}
          {pendingInterventions > 0 && (
            <div className="flex justify-between text-yellow-400">
              <span>Needs Attention</span>
              <span>{pendingInterventions}</span>
            </div>
          )}
        </div>
      </div>

      {/* Project list */}
      {projects.length > 0 && (
        <div className="p-3 border-t border-border overflow-y-auto">
          <div className="text-xs font-medium text-muted-foreground mb-2">Projects</div>
          {projects.map(p => (
            <div key={p.id} className="mb-0.5">
              {/* Inline rename */}
              {editingId === p.id ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleEditSave(p.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                    className="flex-1 bg-muted border border-border rounded px-1.5 py-0.5 text-xs min-w-0"
                    autoFocus
                  />
                  <button
                    onClick={() => handleEditSave(p.id)}
                    className="text-[10px] text-green-400 hover:text-green-300 px-1"
                    title="Save"
                  >
                    OK
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground px-1"
                    title="Cancel"
                  >
                    x
                  </button>
                </div>
              ) : confirmDeleteId === p.id ? (
                /* Delete confirmation */
                <div className="flex items-center gap-1 px-2 py-1 bg-red-500/10 rounded">
                  <span className="text-[10px] text-red-400 flex-1">Delete?</span>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-[10px] text-red-400 hover:text-red-300 font-medium px-1"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground px-1"
                  >
                    No
                  </button>
                </div>
              ) : (
                /* Normal project row */
                <div className="group flex items-center">
                  <button
                    onClick={() => {
                      setCurrentProject(p.id);
                      client?.send({
                        type: 'project.getState',
                        id: crypto.randomUUID(),
                        timestamp: new Date().toISOString(),
                        payload: { projectId: p.id },
                      });
                      onViewChange('dashboard');
                    }}
                    className={`flex-1 flex items-center gap-2 text-xs px-2 py-1.5 rounded-l ${
                      p.id === currentProjectId
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLORS[p.status] || 'bg-gray-500'}`} />
                    <span className="truncate">{p.name}</span>
                  </button>
                  {/* Edit / Delete actions — visible on hover */}
                  <div className="hidden group-hover:flex items-center gap-0.5 pr-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); startEditing(p); }}
                      className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5"
                      title="Rename"
                    >
                      E
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(p.id); setEditingId(null); }}
                      className="text-[10px] text-muted-foreground hover:text-red-400 px-1 py-0.5"
                      title="Delete"
                    >
                      D
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
