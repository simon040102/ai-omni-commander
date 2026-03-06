import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import type { View } from './components/layout/AppShell';
import { Dashboard } from './components/dashboard/Dashboard';
import { ProjectSetup } from './components/project/ProjectSetup';
import { TaskBoard } from './components/tasks/TaskBoard';
import { EventLog } from './components/events/EventLog';
import { AsanaTaskPanel } from './components/asana/AsanaTaskPanel';
import { useThemeStore } from './stores/themeStore';
import type { AsanaTask, ProjectMode } from '@omni/shared';

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
        // Handler for using an Asana task
        const handleUseAsanaTask = (task: AsanaTask, mode: ProjectMode) => {
          // Store task info and switch to setup view
          // The ProjectSetup will pick up the imported task
          sessionStorage.setItem('asana_import_task', JSON.stringify({
            name: task.name,
            notes: task.notes,
            gid: task.gid,
            mode,
          }));
          onViewChange('setup');
        };

        switch (view) {
          case 'dashboard':
            return <Dashboard onViewChange={onViewChange} />;
          case 'setup':
            return <ProjectSetup onViewChange={onViewChange} />;
          case 'tasks':
            return <TaskBoard onViewChange={onViewChange} />;
          case 'events':
            return <EventLog />;
          case 'asana':
            return <AsanaTaskPanel onUseTask={handleUseAsanaTask} />;
          default:
            return <Dashboard onViewChange={onViewChange} />;
        }
      }}
    </AppShell>
  );
}
