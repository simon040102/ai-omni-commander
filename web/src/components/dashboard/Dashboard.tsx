import { useState, useCallback, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { TaskList } from './TaskList';
import { AsanaSyncSettings } from './AsanaSyncSettings';
import { PlanPanel } from './PlanPanel';
import { IconPlay, IconGrid, IconRefresh, IconLightning } from '../ui/Icons';
import type { View } from '../layout/AppShell';

interface DashboardProps {
  onViewChange: (view: View) => void;
}

/**
 * Tasks View — the default view when a project is selected.
 * Contains: Ad-hoc bar, Plan panel, Task list, Sync controls.
 */
export function Dashboard({ onViewChange }: DashboardProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const plans = useProjectStore(s => s.plans);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const [selectedModel, setSelectedModel] = useState('sonnet');
  const [showPlanPanel, setShowPlanPanel] = useState(true);
  const [showSyncSettings, setShowSyncSettings] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [adHocInput, setAdHocInput] = useState('');
  const [adHocTarget, setAdHocTarget] = useState<'frontend' | 'backend'>('backend');

  const project = projects.find(p => p.id === currentProjectId);

  // Auto-select target based on available paths
  useEffect(() => {
    if (!project) return;
    if (project.backendPath && !project.frontendPath) setAdHocTarget('backend');
    else if (project.frontendPath && !project.backendPath) setAdHocTarget('frontend');
  }, [project]);

  // Listen for sync results
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { lastSyncAt: string };
      setLastSyncAt(detail.lastSyncAt);
      setIsSyncing(false);
    };
    const errorHandler = () => setIsSyncing(false);
    window.addEventListener('omni:asana-sync', handler);
    window.addEventListener('omni:asana-error', errorHandler);
    return () => {
      window.removeEventListener('omni:asana-sync', handler);
      window.removeEventListener('omni:asana-error', errorHandler);
    };
  }, []);

  const handleSyncNow = useCallback(() => {
    if (!currentProjectId || !client || isSyncing) return;
    setIsSyncing(true);
    client.send({
      type: 'asana.syncNow',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: currentProjectId },
    });
  }, [currentProjectId, client, isSyncing]);

  const handleAdHocExecute = useCallback(() => {
    if (!currentProjectId || !client || !adHocInput.trim()) return;
    client.send({
      type: 'project.startExecution',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        requirement: adHocInput.trim(),
        model: selectedModel,
        role: adHocTarget,
      },
    });
    addToast({ type: 'info', title: 'Ad-hoc task started', message: `${adHocTarget} / ${selectedModel}` });
    setAdHocInput('');
  }, [currentProjectId, client, adHocInput, selectedModel, adHocTarget, addToast]);

  /* ─── Empty state ─── */
  if (!currentProjectId || !project) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-muted/50 flex items-center justify-center">
            <IconGrid className="w-10 h-10 text-muted-foreground/40" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">No Project Selected</h3>
          <p className="text-sm text-muted-foreground mb-6">
            Select a project from the sidebar to manage tasks.
          </p>
        </div>
      </div>
    );
  }

  const hasBothPaths = !!project.frontendPath && !!project.backendPath;

  return (
    <div className="flex flex-col gap-3 h-full overflow-auto">
      {/* ─── Ad-hoc execution bar ─── */}
      <div className="bg-card border border-border rounded-lg px-3 py-2 flex items-center gap-2 flex-shrink-0">
        <IconLightning className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
        <input
          type="text"
          value={adHocInput}
          onChange={(e) => setAdHocInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && adHocInput.trim()) handleAdHocExecute(); }}
          placeholder="Quick task... (press Enter)"
          className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
        />
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* FE/BE target toggle */}
          {hasBothPaths && (
            <div className="flex items-center gap-0.5 mr-1">
              <button
                onClick={() => setAdHocTarget('frontend')}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                  adHocTarget === 'frontend'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                FE
              </button>
              <button
                onClick={() => setAdHocTarget('backend')}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                  adHocTarget === 'backend'
                    ? 'bg-purple-500/20 text-purple-400'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                BE
              </button>
            </div>
          )}
          {/* Model selector */}
          {(['sonnet', 'opus', 'haiku'] as const).map((model) => (
            <button
              key={model}
              onClick={() => setSelectedModel(model)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                selectedModel === model
                  ? model === 'opus'
                    ? 'bg-purple-500/20 text-purple-400'
                    : model === 'haiku'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-blue-500/20 text-blue-400'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {model.charAt(0).toUpperCase() + model.slice(1)}
            </button>
          ))}
          <button
            onClick={handleAdHocExecute}
            disabled={!adHocInput.trim()}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-green-600 hover:bg-green-500 text-white rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <IconPlay className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* ─── Plan approval panel ─── */}
      {plans.length > 0 && showPlanPanel && (
        <PlanPanel onClose={() => setShowPlanPanel(false)} />
      )}
      {plans.length > 0 && !showPlanPanel && (
        <button
          onClick={() => setShowPlanPanel(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 hover:bg-muted border border-border rounded-lg text-sm transition-colors flex-shrink-0"
        >
          <span className="font-medium">Show Plans</span>
          {plans.filter(p => p.status === 'pending').length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-400 animate-pulse">
              {plans.filter(p => p.status === 'pending').length}
            </span>
          )}
        </button>
      )}

      {/* ─── Task list ─── */}
      <TaskList selectedModel={selectedModel} />

      {/* ─── Asana Sync controls (bottom) ─── */}
      {project?.asanaProjectGid && (
        <div className="flex items-center gap-2 px-3 py-2 bg-card border border-border rounded-lg flex-shrink-0">
          <button
            onClick={handleSyncNow}
            disabled={isSyncing}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-orange-500/10 text-orange-400 border border-orange-500/20 rounded-lg hover:bg-orange-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <IconRefresh className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
            {isSyncing ? 'Syncing...' : 'Sync Now'}
          </button>
          <button
            onClick={() => setShowSyncSettings(true)}
            className="px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            Sync Settings
          </button>
          {lastSyncAt && (
            <span className="text-[9px] text-muted-foreground ml-auto">
              Last sync: {new Date(lastSyncAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}

      {/* Asana sync settings modal */}
      <AsanaSyncSettings open={showSyncSettings} onClose={() => setShowSyncSettings(false)} />
    </div>
  );
}
