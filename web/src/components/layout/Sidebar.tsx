import { useState, useCallback, useRef, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import {
  IconPlus, IconGrid, IconChecklist, IconClock,
  IconEdit, IconTrash, IconMoreVertical, IconPanelLeft,
} from '../ui/Icons';
import type { View } from './AppShell';

interface SidebarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  setup: 'bg-gray-500',
  interviewing: 'bg-yellow-500',
  planning: 'bg-yellow-500',
  executing: 'bg-green-500 animate-breathe',
  paused: 'bg-orange-500',
  completed: 'bg-blue-500',
  failed: 'bg-red-500',
};

const NAV_ITEMS: { view: View; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { view: 'setup', label: 'New Project', Icon: IconPlus },
  { view: 'dashboard', label: 'Dashboard', Icon: IconGrid },
  { view: 'tasks', label: 'Tasks', Icon: IconChecklist },
  { view: 'events', label: 'Events', Icon: IconClock },
];

export function Sidebar({ currentView, onViewChange, collapsed, onToggleCollapse }: SidebarProps) {
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
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuDropUp, setMenuDropUp] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const kebabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const pendingInterventions = interventions.filter(i => i.status === 'pending').length;
  const runningAgents = agents.filter(a => a.status === 'running').length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;
  const totalCost = agents.reduce((sum, a) => sum + a.totalCostUsd, 0);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
      }
    }
    if (menuOpenId) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpenId]);

  const handleDelete = useCallback((projectId: string) => {
    client?.send({
      type: 'project.delete',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId },
    });
    if (projectId === currentProjectId) {
      setCurrentProject(null);
    }
    setConfirmDeleteId(null);
    setMenuOpenId(null);
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
    setMenuOpenId(null);
  };

  return (
    <aside className={`${collapsed ? 'w-14' : 'w-56'} border-r border-border bg-card flex flex-col transition-all duration-200 ease-in-out`}>
      {/* Collapse toggle */}
      <div className={`flex items-center border-b border-border ${collapsed ? 'justify-center py-2' : 'justify-between px-3 py-2'}`}>
        {!collapsed && (
          <div className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
            <span className={connected ? 'text-green-400' : 'text-red-400'}>
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        )}
        <button
          onClick={onToggleCollapse}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <IconPanelLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className={`${collapsed ? 'p-1' : 'p-2'}`}>
        {NAV_ITEMS.map(item => {
          const isActive = currentView === item.view;
          const badge = item.view === 'tasks' ? failedTasks || undefined : undefined;
          return (
            <button
              key={item.view}
              onClick={() => onViewChange(item.view)}
              className={`w-full flex items-center gap-2 rounded-md text-sm mb-0.5 transition-colors ${
                collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
              } ${
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
              title={collapsed ? item.label : undefined}
            >
              <item.Icon className="w-4 h-4 flex-shrink-0" />
              {!collapsed && (
                <>
                  <span>{item.label}</span>
                  {badge ? (
                    <span className="ml-auto text-[10px] bg-red-500 text-white w-4 h-4 rounded-full flex items-center justify-center">
                      {badge}
                    </span>
                  ) : null}
                </>
              )}
            </button>
          );
        })}
      </nav>

      {/* Project list - hidden when collapsed, takes remaining space */}
      {!collapsed && projects.length > 0 && (
        <div className="flex-1 min-h-0 px-2 py-2 border-t border-border overflow-y-auto">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5 px-1">
            Projects
          </div>
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
                    className="flex-1 bg-muted border border-border rounded px-1.5 py-0.5 text-xs min-w-0 focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
                    autoFocus
                  />
                  <button
                    onClick={() => handleEditSave(p.id)}
                    className="text-[10px] text-green-400 hover:text-green-300 px-1 font-medium"
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
                <div className="flex items-center gap-1 px-2 py-1.5 bg-red-500/10 rounded-md animate-fade-in">
                  <span className="text-[10px] text-red-400 flex-1">Delete this project?</span>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="text-[10px] text-red-400 hover:text-red-300 font-semibold px-1.5 py-0.5 bg-red-500/20 rounded"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmDeleteId(null)}
                    className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5"
                  >
                    No
                  </button>
                </div>
              ) : (
                /* Normal project row */
                <div className="group relative flex items-center">
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
                    className={`flex-1 flex items-center gap-2 text-xs px-2 py-1.5 rounded-md transition-colors ${
                      p.id === currentProjectId
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLORS[p.status] || 'bg-gray-500'}`} />
                    <span className="truncate">{p.name}</span>
                  </button>
                  {/* Kebab menu button */}
                  <button
                    ref={(el) => { if (el) kebabRefs.current.set(p.id, el); }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (menuOpenId === p.id) {
                        setMenuOpenId(null);
                      } else {
                        // Determine if menu should open upward
                        const btn = kebabRefs.current.get(p.id);
                        if (btn) {
                          const rect = btn.getBoundingClientRect();
                          const spaceBelow = window.innerHeight - rect.bottom;
                          setMenuDropUp(spaceBelow < 90);
                        }
                        setMenuOpenId(p.id);
                      }
                    }}
                    className={`absolute right-1 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-all ${
                      p.id === currentProjectId || menuOpenId === p.id
                        ? 'opacity-50 hover:opacity-100'
                        : 'opacity-0 group-hover:opacity-50 hover:!opacity-100'
                    }`}
                    title="More actions"
                  >
                    <IconMoreVertical className="w-3.5 h-3.5" />
                  </button>
                  {/* Dropdown menu */}
                  {menuOpenId === p.id && (
                    <div
                      ref={menuRef}
                      className={`absolute right-0 z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[110px] animate-fade-in ${
                        menuDropUp ? 'bottom-full mb-0.5' : 'top-full mt-0.5'
                      }`}
                    >
                      <button
                        onClick={() => startEditing(p)}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <IconEdit className="w-3 h-3" /> Rename
                      </button>
                      <button
                        onClick={() => { setConfirmDeleteId(p.id); setMenuOpenId(null); }}
                        className="w-full text-left px-3 py-1.5 text-xs hover:bg-red-500/10 flex items-center gap-2 text-red-400 transition-colors"
                      >
                        <IconTrash className="w-3 h-3" /> Delete
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Status summary - pinned at bottom */}
      {!collapsed && (
        <div className="shrink-0 px-3 py-2.5 border-t border-border">
          <div className="text-xs text-muted-foreground space-y-1">
            <div className="flex justify-between">
              <span>Agents</span>
              <span className={runningAgents > 0 ? 'text-green-400 font-medium' : ''}>{runningAgents} running</span>
            </div>
            <div className="flex justify-between">
              <span>Tasks</span>
              <span>
                {completedTasks} done
                {failedTasks > 0 && <span className="text-red-400 ml-1">/ {failedTasks} failed</span>}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Cost</span>
              <span>${totalCost.toFixed(2)}</span>
            </div>
            {pendingInterventions > 0 && (
              <div className="flex justify-between text-yellow-400">
                <span>Attention</span>
                <span className="font-medium">{pendingInterventions} pending</span>
              </div>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
