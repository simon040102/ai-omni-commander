import { useMemo, useState, useRef, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import {
  IconPlus, IconGrid, IconClock, IconLightning,
  IconPanelLeft,
} from '../ui/Icons';
import type { View } from './AppShell';

interface SidebarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  pinned: boolean;      // true = locked open, false = auto-collapse on mouse leave
  onTogglePin: () => void;
}

/* ─── Icon components for sidebar nav ─── */
function IconTasks({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  );
}

function IconDatabase({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
    </svg>
  );
}

function IconSettings({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function IconMockup({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 9h6M9 12h3" />
    </svg>
  );
}

function IconBack({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function IconRobot({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

export function Sidebar({ currentView, onViewChange, pinned, onTogglePin }: SidebarProps) {
  const [hovered, setHovered] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expanded = pinned open OR hovering
  const collapsed = !pinned && !hovered;

  const handleMouseEnter = useCallback(() => {
    if (pinned) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHovered(true);
  }, [pinned]);

  const handleMouseLeave = useCallback(() => {
    if (pinned) return;
    // Small delay to prevent flicker
    hoverTimer.current = setTimeout(() => setHovered(false), 200);
  }, [pinned]);
  const rawProjects = useProjectStore(s => s.projects);
  const currentProjectId = useProjectStore(s => s.currentProjectId);

  const projects = useMemo(() => {
    return [...rawProjects].sort((a, b) => {
      const dateA = new Date(a.createdAt.endsWith('Z') ? a.createdAt : a.createdAt + 'Z').getTime();
      const dateB = new Date(b.createdAt.endsWith('Z') ? b.createdAt : b.createdAt + 'Z').getTime();
      return dateB - dateA;
    });
  }, [rawProjects]);
  const setCurrentProject = useProjectStore(s => s.setCurrentProject);
  const allAgents = useProjectStore(s => s.agents);
  const allTasks = useProjectStore(s => s.tasks);
  const allInterventions = useProjectStore(s => s.interventions);
  const client = useWsStore(s => s.client);

  const currentProject = projects.find(p => p.id === currentProjectId);
  const isProjectMode = !!currentProjectId && !!currentProject;

  // Filter by current project for stats
  const agents = currentProjectId ? allAgents.filter(a => a.projectId === currentProjectId) : allAgents;
  const tasks = allTasks;
  const interventions = allInterventions;

  const pendingInterventions = interventions.filter(i => i.status === 'pending').length;
  const runningAgents = agents.filter(a => a.status === 'running').length;
  const globalRunningAgents = allAgents.filter(a => a.status === 'running').length;
  const completedTasks = tasks.filter(t => t.status === 'completed').length;
  const failedTasks = tasks.filter(t => t.status === 'failed').length;

  const handleBackToHome = () => {
    setCurrentProject(null);
    onViewChange('home');
  };

  /* ─── Nav items for Mode A (no project) ─── */
  const homeNavItems: { view: View; label: string; Icon: React.FC<{ className?: string }>; badge?: number }[] = [
    { view: 'home', label: 'Projects', Icon: IconGrid },
    { view: 'setup', label: 'New Project', Icon: IconPlus },
    { view: 'new-task', label: 'Quick Run', Icon: IconLightning },
  ];

  /* ─── Nav items for Mode B (project selected) ─── */
  const projectNavItems: { view: View; label: string; Icon: React.FC<{ className?: string }>; badge?: number; pulse?: boolean }[] = [
    { view: 'tasks', label: 'Tasks', Icon: IconTasks },
    { view: 'agents', label: 'Agents', Icon: IconRobot, pulse: runningAgents > 0 },
    { view: 'events', label: 'Events', Icon: IconClock },
    { view: 'mockup', label: 'Mockup', Icon: IconMockup },
    { view: 'db-explorer', label: 'DB Schema', Icon: IconDatabase },
    { view: 'settings', label: 'Settings', Icon: IconSettings },
  ];

  const navItems = isProjectMode ? projectNavItems : homeNavItems;

  return (
    <aside
      className={`${collapsed ? 'w-14' : 'w-56'} border-r border-border bg-card flex flex-col transition-all duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] overflow-hidden`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Pin toggle */}
      <div className={`flex items-center border-b border-border ${collapsed ? 'justify-center py-2' : 'justify-end px-3 py-2'}`}>
        <button
          onClick={onTogglePin}
          className={`p-1 rounded-md transition-colors ${
            pinned
              ? 'text-primary bg-primary/10 hover:bg-primary/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          title={pinned ? 'Unpin sidebar (auto-collapse)' : 'Pin sidebar open'}
        >
          <IconPanelLeft className="w-4 h-4" />
        </button>
      </div>

      {/* Back to Home (Mode B only) */}
      {isProjectMode && !collapsed && (
        <button
          onClick={handleBackToHome}
          className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border-b border-border"
        >
          <IconBack className="w-3.5 h-3.5" />
          All Projects
        </button>
      )}
      {isProjectMode && collapsed && (
        <button
          onClick={handleBackToHome}
          className="flex items-center justify-center py-2 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border-b border-border"
          title="All Projects"
        >
          <IconBack className="w-4 h-4" />
        </button>
      )}

      {/* Project info (Mode B only) */}
      {isProjectMode && !collapsed && currentProject && (
        <div className="px-3 py-2.5 border-b border-border">
          <div className="text-xs font-bold text-foreground truncate" title={currentProject.name}>
            {currentProject.name}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`text-[9px] px-1 py-0.5 rounded ${
              currentProject.status === 'executing' ? 'bg-green-500/15 text-green-400' :
              currentProject.status === 'completed' ? 'bg-blue-500/15 text-blue-400' :
              currentProject.status === 'failed' ? 'bg-red-500/15 text-red-400' :
              'bg-muted text-muted-foreground'
            }`}>
              {currentProject.status}
            </span>
          </div>
          {currentProject.frontendPath && (
            <div className="text-xs text-muted-foreground mt-1 truncate" title={currentProject.frontendPath}>
              <span className="text-blue-400 font-medium">FE</span> {currentProject.frontendPath}
            </div>
          )}
          {currentProject.backendPath && (
            <div className="text-xs text-muted-foreground mt-0.5 truncate" title={currentProject.backendPath}>
              <span className="text-purple-400 font-medium">BE</span> {currentProject.backendPath}
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <nav className={`${collapsed ? 'p-1' : 'p-2'} overflow-y-auto flex-1 min-h-0`}>
        {navItems.map(item => {
          const isActive = currentView === item.view;
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
              <span className="relative flex-shrink-0">
                <item.Icon className="w-4 h-4" />
                {('pulse' in item && (item as { pulse?: boolean }).pulse) ? (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                ) : null}
              </span>
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">{item.label}</span>
                  {('badge' in item && ((item as { badge?: number }).badge ?? 0) > 0) ? (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-primary/20 text-primary">
                      {(item as { badge?: number }).badge}
                    </span>
                  ) : null}
                </>
              )}
            </button>
          );
        })}
      </nav>

      {/* Spacer removed — nav is now flex-1 and scrollable */}

      {/* Bottom items - pinned */}
      <div className={`${collapsed ? 'p-1' : 'px-2 pb-1'} border-t border-border`}>
        <button
          onClick={() => onViewChange('internal-db')}
          className={`w-full flex items-center gap-2 rounded-md text-sm mb-0.5 transition-colors ${
            collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
          } ${
            currentView === 'internal-db'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title={collapsed ? 'Internal DB' : undefined}
        >
          <IconDatabase className="w-4 h-4" />
          {!collapsed && <span className="flex-1 text-left">Internal DB</span>}
        </button>
        <button
          onClick={() => onViewChange('global-settings')}
          className={`w-full flex items-center gap-2 rounded-md text-sm mb-0.5 transition-colors ${
            collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
          } ${
            currentView === 'global-settings'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          title={collapsed ? 'Global Settings' : undefined}
        >
          <IconSettings className="w-4 h-4" />
          {!collapsed && <span className="flex-1 text-left">Global Settings</span>}
        </button>
      </div>

      {/* Status summary - pinned at bottom */}
      {!collapsed && (
        <div className="shrink-0 px-3 py-2.5 border-t border-border">
          <div className="text-xs text-muted-foreground space-y-1">
            <div className="flex justify-between">
              <span>Agents</span>
              <span className={runningAgents > 0 || globalRunningAgents > 0 ? 'text-green-400 font-medium' : ''}>
                {isProjectMode ? `${runningAgents} running` : `${globalRunningAgents} running`}
              </span>
            </div>
            {isProjectMode && (
              <div className="flex justify-between">
                <span>Tasks</span>
                <span>
                  {completedTasks} done
                  {failedTasks > 0 && <span className="text-red-400 ml-1">/ {failedTasks} failed</span>}
                </span>
              </div>
            )}
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
