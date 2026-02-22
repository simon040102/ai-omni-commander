import { AppShell } from './components/layout/AppShell';
import type { View } from './components/layout/AppShell';
import { Dashboard } from './components/dashboard/Dashboard';
import { ProjectSetup } from './components/project/ProjectSetup';
import { TaskBoard } from './components/tasks/TaskBoard';
import { EventLog } from './components/events/EventLog';

export function App() {
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
