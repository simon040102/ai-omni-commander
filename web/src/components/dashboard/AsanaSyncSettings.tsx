import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { IconX } from '../ui/Icons';
import type { AsanaSyncConfig } from '@omni/shared';

interface AsanaSyncSettingsProps {
  open: boolean;
  onClose: () => void;
}

const DEFAULT_CONFIG: AsanaSyncConfig = {
  enabled: false,
  intervalMinutes: 15,
  autoExecuteRules: {
    bug: true,
    feature: false,
    refactor: false,
    other: false,
  },
  maxConcurrentAgents: 2,
};

export function AsanaSyncSettings({ open, onClose }: AsanaSyncSettingsProps) {
  const project = useProjectStore(s => s.projects.find(p => p.id === s.currentProjectId));
  const client = useWsStore(s => s.client);

  const [config, setConfig] = useState<AsanaSyncConfig>(DEFAULT_CONFIG);

  // Load config from project's configJson
  useEffect(() => {
    if (project?.configJson) {
      try {
        const parsed = JSON.parse(project.configJson) as { asanaSyncConfig?: AsanaSyncConfig };
        if (parsed.asanaSyncConfig) {
          setConfig(parsed.asanaSyncConfig);
        }
      } catch { /* ignore */ }
    }
  }, [project?.configJson]);

  // Listen for sync config updates from server
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId: string; config: AsanaSyncConfig };
      if (detail.projectId === project?.id) {
        setConfig(detail.config);
      }
    };
    window.addEventListener('omni:asana-sync-config', handler);
    return () => window.removeEventListener('omni:asana-sync-config', handler);
  }, [project?.id]);

  const saveConfig = useCallback(() => {
    if (!client || !project) return;
    client.send({
      type: 'asana.updateSyncConfig',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: project.id, config },
    });
    onClose();
  }, [client, project, config, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl p-4 w-[360px]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Asana Auto-Sync Settings</h3>
          <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground">
            <IconX className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Enable */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig({ ...config, enabled: e.target.checked })}
              className="rounded border-border accent-primary w-4 h-4"
            />
            <span className="text-xs font-medium">Enable auto-sync</span>
          </label>

          {/* Interval */}
          <div>
            <label className="block text-[10px] text-muted-foreground mb-1">Sync interval</label>
            <select
              value={config.intervalMinutes}
              onChange={(e) => setConfig({ ...config, intervalMinutes: Number(e.target.value) })}
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary"
              disabled={!config.enabled}
            >
              <option value={5}>Every 5 minutes</option>
              <option value={15}>Every 15 minutes</option>
              <option value={30}>Every 30 minutes</option>
              <option value={60}>Every hour</option>
            </select>
          </div>

          {/* Auto-execute rules — 已停用（legacy spawn 派工已移除，執行走外部 Claude Code session + MCP） */}
          <div>
            <label className="block text-[10px] text-muted-foreground mb-1.5">
              Auto-execute rules
              <span className="ml-1 text-yellow-500">（已停用——同步只匯入任務，執行請走外部 Claude Code session + MCP）</span>
            </label>
            <div className="space-y-1.5 opacity-50">
              {(['bug', 'feature', 'refactor', 'other'] as const).map(type => (
                <label key={type} className="flex items-center justify-between cursor-not-allowed select-none">
                  <span className="text-xs capitalize">{type}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground">import only</span>
                    <input
                      type="checkbox"
                      checked={config.autoExecuteRules[type]}
                      disabled
                      className="rounded border-border accent-primary w-3.5 h-3.5"
                    />
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Max concurrent agents — 已停用（僅供 auto-execute 使用，auto-execute 已移除） */}
          <div className="opacity-50">
            <label className="block text-[10px] text-muted-foreground mb-1">Max concurrent agents（已停用）</label>
            <select
              value={config.maxConcurrentAgents}
              disabled
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-primary cursor-not-allowed"
            >
              {[1, 2, 3, 4, 5].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={saveConfig}
            className="px-4 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
