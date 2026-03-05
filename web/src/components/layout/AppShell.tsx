import { useState, useEffect, useRef } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../ui/ToastContainer';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useProjectStore } from '../../stores/projectStore';
import { initTabNotification } from '../../lib/tabNotification';

export type View = 'dashboard' | 'tasks' | 'setup' | 'events';

interface AppShellProps {
  children: (view: View, onViewChange: (v: View) => void) => React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [currentView, setCurrentView] = useState<View>('setup');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const agents = useProjectStore(s => s.agents);
  const hasAutoSwitched = useRef(false);

  // Initialize WebSocket connection
  useWebSocket();

  // Initialize tab notification (once)
  useEffect(() => {
    initTabNotification();
  }, []);

  // Auto-switch to dashboard when agents appear
  useEffect(() => {
    if (agents.length > 0 && !hasAutoSwitched.current && currentView === 'setup') {
      hasAutoSwitched.current = true;
      setCurrentView('dashboard');
    }
  }, [agents.length, currentView]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header
        currentView={currentView}
        onViewChange={setCurrentView}
      />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          currentView={currentView}
          onViewChange={setCurrentView}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        />
        <main className="flex-1 overflow-auto p-4">
          {children(currentView, setCurrentView)}
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
