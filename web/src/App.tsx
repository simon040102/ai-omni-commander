import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import type { View } from './components/layout/AppShell';
import { ProjectList } from './components/home/ProjectList';
import { Dashboard } from './components/dashboard/Dashboard';
import { ProjectSetup } from './components/project/ProjectSetup';
import { EventLog } from './components/events/EventLog';
import { AgentsView } from './components/agents/AgentsView';
import { NewTaskView } from './components/task/NewTaskView';
import { DbExplorer } from './components/db/DbExplorer';
import { ProjectSettings } from './components/settings/ProjectSettings';
import { useThemeStore } from './stores/themeStore';

export function App() {
  const theme = useThemeStore(s => s.theme);

  // Apply theme class to document root
  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(theme);
  }, [theme]);

  return (
    <AppShell>
      {(view: View, onViewChange: (v: View) => void) => {
        switch (view) {
          case 'home':
            return <ProjectList onViewChange={onViewChange} />;
          case 'tasks':
            return <Dashboard onViewChange={onViewChange} />;
          case 'setup':
            return <ProjectSetup onViewChange={onViewChange} />;
          case 'agents':
            return <AgentsView onViewChange={onViewChange} />;
          case 'events':
            return <EventLog />;
          case 'new-task':
            return <NewTaskView onViewChange={onViewChange} />;
          case 'db-explorer':
            return <DbExplorer />;
          case 'settings':
            return <ProjectSettings />;
          default:
            return <ProjectList onViewChange={onViewChange} />;
        }
      }}
    </AppShell>
  );
}
