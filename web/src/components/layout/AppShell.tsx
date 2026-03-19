import { useState, useEffect, useRef } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../ui/ToastContainer';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useProjectStore } from '../../stores/projectStore';
import { initTabNotification } from '../../lib/tabNotification';

export type View = 'home' | 'setup' | 'new-task' | 'tasks' | 'agents' | 'events' | 'db-explorer' | 'settings' | 'global-settings';

interface AppShellProps {
  children: (view: View, onViewChange: (v: View) => void) => React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [currentView, setCurrentView] = useState<View>('home');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const agents = useProjectStore(s => s.agents);
  const hasAutoSwitched = useRef(false);
  const userHasNavigated = useRef(false);

  // Wrap setCurrentView to track user-initiated navigation
  const handleViewChange = (view: View) => {
    userHasNavigated.current = true;
    setCurrentView(view);
  };

  // Initialize WebSocket connection
  useWebSocket();

  // Initialize tab notification (once)
  useEffect(() => {
    initTabNotification();
  }, []);

  // Auto-switch to dashboard when agents appear (only on initial load, not after user navigation)
  useEffect(() => {
    if (agents.length > 0 && !hasAutoSwitched.current && !userHasNavigated.current && (currentView === 'home' || currentView === 'setup')) {
      hasAutoSwitched.current = true;
      setCurrentView('agents');
    }
  }, [agents.length, currentView]);

  return (
    <div className="h-screen flex flex-col bg-background">
      <Header
        currentView={currentView}
        onViewChange={handleViewChange}
      />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          currentView={currentView}
          onViewChange={handleViewChange}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        />
        <main className="flex-1 overflow-auto p-4">
          {children(currentView, handleViewChange)}
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
