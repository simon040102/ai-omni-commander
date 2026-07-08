import { useState, useEffect, useRef } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../ui/ToastContainer';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { initTabNotification } from '../../lib/tabNotification';

function DisconnectBanner() {
  const connected = useWsStore(s => s.connected);
  const hasConnectedOnce = useWsStore(s => s.hasConnectedOnce);
  // Don't show on initial load (before first connection)
  if (!hasConnectedOnce || connected) return null;
  return (
    <div className="bg-red-600 text-white text-center py-1.5 px-4 text-sm font-medium shrink-0">
      Server 連線中斷，重新連線中... Agent 指令暫時無法使用。
    </div>
  );
}

export type View = 'home' | 'setup' | 'new-task' | 'tasks' | 'agents' | 'events' | 'db-explorer' | 'internal-db' | 'settings' | 'global-settings' | 'mockup' | 'spec-governance';

interface AppShellProps {
  children: (view: View, onViewChange: (v: View) => void) => React.ReactNode;
}

const VIEW_STORAGE_KEY = 'omni_current_view';

export function AppShell({ children }: AppShellProps) {
  const [currentView, setCurrentView] = useState<View>(() => {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY) as View | null;
    return saved ?? 'home';
  });
  const [sidebarPinned, setSidebarPinned] = useState(true); // true = open (default), false = collapsed with hover
  const agents = useProjectStore(s => s.agents);
  const hasAutoSwitched = useRef(false);
  const userHasNavigated = useRef(false);

  // Wrap setCurrentView to track user-initiated navigation
  const handleViewChange = (view: View) => {
    userHasNavigated.current = true;
    setCurrentView(view);
    localStorage.setItem(VIEW_STORAGE_KEY, view);
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
      <DisconnectBanner />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          currentView={currentView}
          onViewChange={handleViewChange}
          pinned={sidebarPinned}
          onTogglePin={() => setSidebarPinned(p => !p)}
        />
        <main className="flex-1 overflow-auto p-4">
          {children(currentView, handleViewChange)}
        </main>
      </div>
      <ToastContainer />
    </div>
  );
}
