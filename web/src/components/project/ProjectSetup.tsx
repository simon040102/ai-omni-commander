import { useState, useCallback, useEffect, useRef } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { useAsanaStore } from '../../stores/asanaStore';
import { useProjectStore } from '../../stores/projectStore';
import { FolderPicker } from './FolderPicker';
import { IconArrowRight, IconAsana, IconRefresh, IconChevronDown } from '../ui/Icons';
import type { View } from '../layout/AppShell';

interface ProjectSetupProps {
  onViewChange: (view: View) => void;
}

export function ProjectSetup({ onViewChange }: ProjectSetupProps) {
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const setCurrentProject = useProjectStore(s => s.setCurrentProject);
  const asanaConnected = useAsanaStore(s => s.connectionStatus.connected);
  const asanaProjects = useAsanaStore(s => s.projects);

  const [name, setName] = useState('');
  const [frontendPath, setFrontendPath] = useState('');
  const [backendPath, setBackendPath] = useState('');
  const [asanaProjectGid, setAsanaProjectGid] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Workspace scan results
  const [feScanResult, setFeScanResult] = useState<{ hasClaudeMd: boolean; skills: { name: string }[] } | null>(null);
  const [beScanResult, setBeScanResult] = useState<{ hasClaudeMd: boolean; skills: { name: string }[] } | null>(null);

  // Asana import (from AsanaTaskPanel "Import to Project")
  const hasCheckedAsanaImport = useRef(false);
  useEffect(() => {
    if (hasCheckedAsanaImport.current) return;
    hasCheckedAsanaImport.current = true;
    const stored = sessionStorage.getItem('asana_import_task');
    if (stored) {
      try {
        const task = JSON.parse(stored);
        if (task.name) setName(task.name.slice(0, 50));
        sessionStorage.removeItem('asana_import_task');
        addToast({ type: 'info', title: 'Asana Task Imported', message: `Task: ${task.name}` });
      } catch { /* ignore */ }
    }
  }, [addToast]);

  // Auto-check Asana connection on mount
  const hasCheckedAsana = useRef(false);
  useEffect(() => {
    if (hasCheckedAsana.current || !client) return;
    hasCheckedAsana.current = true;
    client.send({
      type: 'asana.checkConnection',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {},
    });
  }, [client]);

  // Fetch Asana projects when connected
  const hasFetchedAsanaProjects = useRef(false);
  useEffect(() => {
    if (asanaConnected && !hasFetchedAsanaProjects.current && client) {
      hasFetchedAsanaProjects.current = true;
      client.send({
        type: 'asana.fetchProjects',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {},
      });
    }
  }, [asanaConnected, client]);

  // Auto-scan workspace when path changes
  useEffect(() => {
    if (!frontendPath.trim()) { setFeScanResult(null); return; }
    fetch(`/api/workspace/scan?path=${encodeURIComponent(frontendPath)}`)
      .then(r => r.json())
      .then(data => setFeScanResult({ hasClaudeMd: data.hasClaudeMd, skills: data.skills || [] }))
      .catch(() => setFeScanResult(null));
  }, [frontendPath]);

  useEffect(() => {
    if (!backendPath.trim()) { setBeScanResult(null); return; }
    fetch(`/api/workspace/scan?path=${encodeURIComponent(backendPath)}`)
      .then(r => r.json())
      .then(data => setBeScanResult({ hasClaudeMd: data.hasClaudeMd, skills: data.skills || [] }))
      .catch(() => setBeScanResult(null));
  }, [backendPath]);

  const hasAtLeastOnePath = frontendPath.trim() !== '' || backendPath.trim() !== '';
  const isValid = name.trim() !== '' && hasAtLeastOnePath;

  const handleCreate = useCallback(() => {
    setTouched({ name: true });
    if (!isValid) return;

    const id = crypto.randomUUID();
    setCurrentProject(id);

    client?.send({
      type: 'project.create',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: id,
        name,
        workingDir: frontendPath.trim() || backendPath.trim(),
        frontendPath: frontendPath.trim() || null,
        backendPath: backendPath.trim() || null,
        asanaProjectGid: asanaProjectGid.trim() || undefined,
      },
    });

    // Fetch project state
    client?.send({
      type: 'project.getState',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: id },
    });

    // Save paths to recent
    for (const p of [frontendPath, backendPath]) {
      if (p.trim()) {
        fetch('/api/recent-paths', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p.trim() }),
        }).catch(() => {});
      }
    }

    addToast({ type: 'success', title: 'Project created', message: `"${name}"` });
    onViewChange('tasks');
  }, [name, frontendPath, backendPath, asanaProjectGid, client, isValid, setCurrentProject, addToast, onViewChange]);

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">New Project</h2>

      <div className="space-y-6">
        {/* Project Name */}
        <div>
          <label className="block text-sm font-medium mb-1">Project Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched(prev => ({ ...prev, name: true }))}
            placeholder="My Awesome Project"
            className={`w-full bg-muted border rounded-md px-3 py-2 text-sm outline-none transition-colors ${
              touched.name && !name.trim()
                ? 'border-red-500/50 focus:border-red-500 focus:ring-1 focus:ring-red-500/30'
                : 'border-border focus:border-primary focus:ring-1 focus:ring-primary/30'
            }`}
          />
          {touched.name && !name.trim() && (
            <p className="text-xs text-red-400 mt-1">Project name is required</p>
          )}
        </div>

        {/* Frontend Path */}
        <div>
          <label className="block text-sm font-medium mb-1">
            Frontend Path
            <span className="text-xs text-muted-foreground ml-2 font-normal">optional</span>
          </label>
          <FolderPicker value={frontendPath} onChange={setFrontendPath} />
          {feScanResult && <WorkspaceScanBadge result={feScanResult} />}
        </div>

        {/* Backend Path */}
        <div>
          <label className="block text-sm font-medium mb-1">
            Backend Path
            <span className="text-xs text-muted-foreground ml-2 font-normal">optional</span>
          </label>
          <FolderPicker value={backendPath} onChange={setBackendPath} />
          {beScanResult && <WorkspaceScanBadge result={beScanResult} />}
        </div>

        {!hasAtLeastOnePath && touched.name && (
          <p className="text-xs text-red-400">At least one path (frontend or backend) is required</p>
        )}

        {/* Asana Project Binding */}
        <div className="border border-border rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2">
            <IconAsana className="w-4 h-4 text-orange-400" />
            <h4 className="text-sm font-medium">Asana Integration</h4>
            {asanaConnected ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">Connected</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">Not connected</span>
            )}
          </div>

          {asanaConnected && asanaProjects.length > 0 ? (
            <>
              <p className="text-xs text-muted-foreground">
                Select an Asana project to bind to this project.
              </p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <select
                    value={asanaProjectGid}
                    onChange={(e) => setAsanaProjectGid(e.target.value)}
                    className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm appearance-none outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 pr-8"
                  >
                    <option value="">— None —</option>
                    {asanaProjects.map(p => (
                      <option key={p.gid} value={p.gid}>{p.name}</option>
                    ))}
                  </select>
                  <IconChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                </div>
                <button
                  onClick={() => {
                    hasFetchedAsanaProjects.current = false;
                    client?.send({
                      type: 'asana.fetchProjects',
                      id: crypto.randomUUID(),
                      timestamp: new Date().toISOString(),
                      payload: {},
                    });
                  }}
                  className="p-2 rounded-md bg-muted border border-border hover:bg-muted/80 transition-colors"
                  title="Refresh project list"
                >
                  <IconRefresh className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </>
          ) : asanaConnected ? (
            <>
              <p className="text-xs text-muted-foreground">
                Loading Asana projects...
              </p>
              <input
                type="text"
                value={asanaProjectGid}
                onChange={(e) => setAsanaProjectGid(e.target.value)}
                placeholder="Asana Project GID (optional)"
                className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              />
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Connect Asana in the Asana panel to bind a project.
            </p>
          )}
        </div>

        {/* Create Button */}
        <button
          onClick={handleCreate}
          disabled={!isValid}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
        >
          Create Project & Go to Dashboard
          <IconArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/* Helper: workspace scan badge */
function WorkspaceScanBadge({ result }: { result: { hasClaudeMd: boolean; skills: { name: string }[] } }) {
  return (
    <div className="flex items-center gap-2 mt-1.5 text-[10px]">
      <span className={result.hasClaudeMd ? 'text-green-400' : 'text-muted-foreground'}>
        {result.hasClaudeMd ? '✓ CLAUDE.md' : '✗ No CLAUDE.md'}
      </span>
      {result.skills.length > 0 && (
        <span className="text-blue-400">{result.skills.length} skills</span>
      )}
    </div>
  );
}
