import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import type { View } from './components/layout/AppShell';
import { ProjectList } from './components/home/ProjectList';
import { Dashboard } from './components/dashboard/Dashboard';
import { ProjectSetup } from './components/project/ProjectSetup';
import { NewTaskView } from './components/task/NewTaskView';
import { DbExplorer } from './components/db/DbExplorer';
import { DbSchemaExplorer } from './components/db/DbSchemaExplorer';
import { ProjectSettings } from './components/settings/ProjectSettings';
import { GlobalSettings } from './components/settings/GlobalSettings';
import { MockupView } from './components/mockup/MockupView';
import { SpecGovernanceView } from './components/dashboard/SpecGovernanceView';
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
          case 'new-task':
            return <NewTaskView onViewChange={onViewChange} />;
          case 'db-explorer':
            return <DbSchemaExplorer />;
          case 'internal-db':
            return <DbExplorer />;
          case 'settings':
            return <ProjectSettings />;
          case 'global-settings':
            return <GlobalSettings />;
          case 'mockup':
            return <MockupView />;
          case 'spec-governance':
            return <SpecGovernanceView />;
          default:
            return <ProjectList onViewChange={onViewChange} />;
        }
      }}
    </AppShell>
  );
}
