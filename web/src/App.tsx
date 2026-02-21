import { AppShell } from './components/layout/AppShell';
import { Dashboard } from './components/dashboard/Dashboard';
import { ProjectSetup } from './components/project/ProjectSetup';
import { TaskBoard } from './components/tasks/TaskBoard';
import { EventLog } from './components/events/EventLog';

export function App() {
  return (
    <AppShell>
      {(view) => {
        switch (view) {
          case 'dashboard':
            return <Dashboard />;
          case 'setup':
            return <ProjectSetup />;
          case 'tasks':
            return <TaskBoard />;
          case 'events':
            return <EventLog />;
          default:
            return <Dashboard />;
        }
      }}
    </AppShell>
  );
}
