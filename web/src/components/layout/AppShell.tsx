import { useState, useEffect } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ToastContainer } from '../ui/ToastContainer';
import { useWebSocket } from '../../hooks/useWebSocket';
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

export type View = 'home' | 'setup' | 'new-task' | 'tasks' | 'db-explorer' | 'internal-db' | 'settings' | 'global-settings' | 'mockup' | 'spec-governance';

interface AppShellProps {
  children: (view: View, onViewChange: (v: View) => void) => React.ReactNode;
}

const VIEW_STORAGE_KEY = 'omni_current_view';

/** 已移除的舊畫面（Agents／Events，legacy spawn 時代）——舊 session 存在 localStorage 的值
 *  仍可能是它們，還原時導回儀表板（tasks），不要把人丟到首頁或一個不存在的畫面。 */
const REMOVED_VIEWS: readonly string[] = ['agents', 'events'];

const ALL_VIEWS: readonly View[] = [
  'home', 'setup', 'new-task', 'tasks', 'db-explorer',
  'internal-db', 'settings', 'global-settings', 'mockup', 'spec-governance',
];

/** Resolve the initial view from the persisted value: hidden views fall back
 *  to the dashboard (tasks); unknown/corrupted values and nothing persisted →
 *  home. Exported for tests. */
export function resolveInitialView(saved: string | null): View {
  if (saved && REMOVED_VIEWS.includes(saved)) return 'tasks';
  if (!saved || !ALL_VIEWS.includes(saved as View)) return 'home';
  return saved as View;
}

export function AppShell({ children }: AppShellProps) {
  const [currentView, setCurrentView] = useState<View>(() =>
    resolveInitialView(localStorage.getItem(VIEW_STORAGE_KEY)),
  );
  const [sidebarPinned, setSidebarPinned] = useState(true); // true = open (default), false = collapsed with hover

  const handleViewChange = (view: View) => {
    setCurrentView(view);
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  };

  // Initialize WebSocket connection
  useWebSocket();

  // Initialize tab notification (once)
  useEffect(() => {
    initTabNotification();
  }, []);

  // NOTE: legacy auto-switch to the (now hidden) agents view was removed —
  // agents only appear via external MCP sessions, so no auto-navigation.

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
