import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import type { View } from './components/layout/AppShell';
import { Dashboard } from './components/dashboard/Dashboard';
import { ProjectSetup } from './components/project/ProjectSetup';
import { TaskBoard } from './components/tasks/TaskBoard';
import { EventLog } from './components/events/EventLog';
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
          case 'dashboard':
            return <Dashboard onViewChange={onViewChange} />;
          case 'setup':
            return <ProjectSetup onViewChange={onViewChange} />;
          case 'tasks':
            return <TaskBoard onViewChange={onViewChange} />;
          case 'events':
            return <EventLog />;
          default:
            return <Dashboard onViewChange={onViewChange} />;
        }
      }}
    </AppShell>
  );
}
