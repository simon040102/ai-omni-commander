import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useThemeStore } from '../../stores/themeStore';
import { InterventionBell } from '../dashboard/InterventionBell';
import { IconChevronRight, IconSun, IconMoon } from '../ui/Icons';
import type { View } from './AppShell';

const VIEW_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  setup: 'New Project',
  tasks: 'Tasks',
  events: 'Events',
};

interface HeaderProps {
  currentView: View;
  onViewChange: (view: View) => void;
}

export function Header({ currentView, onViewChange }: HeaderProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const connected = useWsStore(s => s.connected);
  const theme = useThemeStore(s => s.theme);
  const toggleTheme = useThemeStore(s => s.toggleTheme);
  const currentProject = projects.find(p => p.id === currentProjectId);

  return (
    <header className="h-14 border-b border-border flex items-center justify-between px-4 bg-card">
      {/* Left: Breadcrumb */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          onClick={() => onViewChange('dashboard')}
          className="text-lg font-bold text-primary hover:text-primary/80 transition-colors whitespace-nowrap"
        >
          AI-OmniCommander
        </button>

        {currentProject && (
          <>
            <IconChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />
            <button
              onClick={() => onViewChange('dashboard')}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors truncate max-w-[200px]"
            >
              {currentProject.name}
            </button>

            {/* Mode badge */}
            <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${
              currentProject.mode === 'spec'
                ? 'bg-blue-500/15 text-blue-400'
                : 'bg-purple-500/15 text-purple-400'
            }`}>
              {currentProject.mode === 'spec' ? 'Spec' : 'Creative'}
            </span>

            {/* Status badge */}
            <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${
              currentProject.status === 'executing'
                ? 'bg-green-500/15 text-green-400'
                : currentProject.status === 'completed'
                  ? 'bg-blue-500/15 text-blue-400'
                  : currentProject.status === 'failed'
                    ? 'bg-red-500/15 text-red-400'
                    : 'bg-yellow-500/15 text-yellow-400'
            }`}>
              {currentProject.status}
            </span>
          </>
        )}

        {/* Current view label (if not dashboard) */}
        {currentView !== 'dashboard' && currentView !== 'setup' && (
          <>
            <IconChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />
            <span className="text-sm text-foreground font-medium whitespace-nowrap">
              {VIEW_LABELS[currentView]}
            </span>
          </>
        )}
        {currentView === 'setup' && !currentProject && (
          <>
            <IconChevronRight className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />
            <span className="text-sm text-foreground font-medium whitespace-nowrap">
              New Project
            </span>
          </>
        )}
      </div>

      {/* Right: Theme toggle + Intervention bell + Connection status */}
      <div className="flex items-center gap-2">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <IconSun className="w-4 h-4" /> : <IconMoon className="w-4 h-4" />}
        </button>

        <div className="h-5 w-px bg-border" />

        <InterventionBell />

        <div className="h-5 w-px bg-border" />

        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs transition-colors ${
          connected
            ? 'bg-green-500/10 text-green-400'
            : 'bg-red-500/10 text-red-400 animate-pulse'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
          {connected ? 'Connected' : 'Reconnecting...'}
        </div>
      </div>
    </header>
  );
}
