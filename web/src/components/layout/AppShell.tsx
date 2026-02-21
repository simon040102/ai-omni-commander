import { useState, useEffect, useRef } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../ui/ToastContainer';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useProjectStore } from '../../stores/projectStore';

type View = 'dashboard' | 'tasks' | 'setup' | 'events';

interface AppShellProps {
  children: (view: View) => React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [currentView, setCurrentView] = useState<View>('setup');
  const agents = useProjectStore(s => s.agents);
  const hasAutoSwitched = useRef(false);

  // Initialize WebSocket connection
  useWebSocket();

  // Auto-switch to dashboard when agents appear
  useEffect(() => {
    if (agents.length > 0 && !hasAutoSwitched.current && currentView === 'setup') {
      hasAutoSwitched.current = true;
      setCurrentView('dashboard');
    }
  }, [agents.length, currentView]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar currentView={currentView} onViewChange={setCurrentView} />
        <main className="flex-1 overflow-auto p-4">
          {children(currentView)}
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
