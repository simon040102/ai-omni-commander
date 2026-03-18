import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useAsanaStore } from '../../stores/asanaStore';
import { useToastStore } from '../../stores/toastStore';
import { FolderPicker } from '../project/FolderPicker';
import { AsanaSyncSettings } from '../dashboard/AsanaSyncSettings';
import { IconRefresh, IconChevronDown, IconAsana } from '../ui/Icons';

interface SvnConfig {
  frontendSpecPath: string;
  backendSpecPath: string;
}

export function ProjectSettings() {
  const project = useProjectStore(s => s.projects.find(p => p.id === s.currentProjectId));
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const asanaConnected = useAsanaStore(s => s.connectionStatus.connected);
  const asanaProjects = useAsanaStore(s => s.projects);

  // Project-specific state
  const [name, setName] = useState('');
  const [frontendPath, setFrontendPath] = useState('');
  const [backendPath, setBackendPath] = useState('');
  const [asanaProjectGid, setAsanaProjectGid] = useState('');
  const [dbConnectionString, setDbConnectionString] = useState('');
  const [showSyncSettings, setShowSyncSettings] = useState(false);

  // SVN config state (per-project paths)
  const [svnFrontendPath, setSvnFrontendPath] = useState('');
  const [svnBackendPath, setSvnBackendPath] = useState('');
  // Global credentials
  const [svnUsername, setSvnUsername] = useState('');
  const [svnPassword, setSvnPassword] = useState('');
  const [asanaPat, setAsanaPat] = useState('');
  const [asanaPatSource, setAsanaPatSource] = useState<'none' | 'env' | 'db'>('none');
  const [globalCredsLoaded, setGlobalCredsLoaded] = useState(false);

  // Parse existing config
  const existingConfig = useMemo(() => {
    if (!project?.configJson) return null;
    try { return JSON.parse(project.configJson); } catch { return null; }
  }, [project?.configJson]);

  // Load project data
  useEffect(() => {
    if (project) {
      setName(project.name);
      setFrontendPath(project.frontendPath || '');
      setBackendPath(project.backendPath || '');
      setAsanaProjectGid(project.asanaProjectGid || '');
      setDbConnectionString(project.dbConnectionString || '');

      // Load SVN paths from configJson (per-project)
      const svn = existingConfig?.svnConfig as SvnConfig | undefined;
      setSvnFrontendPath(svn?.frontendSpecPath || '');
      setSvnBackendPath(svn?.backendSpecPath || '');
    }
  }, [project, existingConfig]);

  // Load global credentials (always, even without project)
  useEffect(() => {
    if (!client || globalCredsLoaded) return;
    const unsub = client.addMessageListener((msg) => {
      if (msg.type === 'config.state') {
        const p = msg.payload as { svnUsername: string; hasSvnPassword: boolean; hasAsanaPat: boolean; asanaPatSource: string };
        setSvnUsername(p.svnUsername || '');
        if (!globalCredsLoaded) {
          setSvnPassword(p.hasSvnPassword ? '••••••••' : '');
          setAsanaPat(p.hasAsanaPat ? '••••••••' : '');
          setAsanaPatSource((p.asanaPatSource as 'none' | 'env' | 'db') || 'none');
        }
        setGlobalCredsLoaded(true);
      }
    });
    client.send({
      type: 'config.get',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {},
    });
    return unsub;
  }, [client, globalCredsLoaded]);

  // Fetch Asana projects if connected
  const hasFetchedProjects = useRef(false);
  useEffect(() => {
    if (asanaConnected && !hasFetchedProjects.current && client) {
      hasFetchedProjects.current = true;
      client.send({
        type: 'asana.fetchProjects',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {},
      });
    }
  }, [asanaConnected, client]);

  const handleSaveGlobal = useCallback(() => {
    if (!client) return;
    // Save SVN credentials globally
    client.send({
      type: 'config.setSvnCredentials',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        username: svnUsername.trim(),
        password: svnPassword === '••••••••' ? '' : svnPassword,
      },
    });
    // Save Asana PAT if changed
    if (asanaPat && asanaPat !== '••••••••') {
      client.send({
        type: 'config.setAsanaPat',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: { pat: asanaPat.trim() },
      });
    }
    addToast({ type: 'success', title: 'Global settings saved' });
  }, [client, svnUsername, svnPassword, asanaPat, addToast]);

  const handleSaveProject = useCallback(() => {
    if (!client || !project) return;

    // Build updated configJson with svnConfig (paths only, no credentials)
    const hasSvn = svnFrontendPath.trim() || svnBackendPath.trim();
    const svnConfig: SvnConfig | undefined = hasSvn ? {
      frontendSpecPath: svnFrontendPath.trim(),
      backendSpecPath: svnBackendPath.trim(),
    } : undefined;

    const newConfig = {
      ...(existingConfig || {}),
      svnConfig,
    };

    // Save project settings
    client.send({
      type: 'project.update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: project.id,
        name: name.trim() || undefined,
        frontendPath: frontendPath.trim() || null,
        backendPath: backendPath.trim() || null,
        asanaProjectGid: asanaProjectGid.trim() || null,
        dbConnectionString: dbConnectionString.trim() || null,
        configJson: JSON.stringify(newConfig),
      },
    });

    // Also save SVN credentials if changed
    if (svnUsername.trim() || (svnPassword && svnPassword !== '••••••••')) {
      client.send({
        type: 'config.setSvnCredentials',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          username: svnUsername.trim(),
          password: svnPassword === '••••••••' ? '' : svnPassword,
        },
      });
    }

    addToast({ type: 'success', title: 'Settings saved' });
  }, [client, project, name, frontendPath, backendPath, asanaProjectGid, dbConnectionString,
    svnFrontendPath, svnBackendPath, svnUsername, svnPassword, existingConfig, addToast]);

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="space-y-6">
        {/* ═══ Global Settings ═══ */}
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <h4 className="text-sm font-medium">Global Credentials</h4>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">所有專案共用</span>
          </div>

          {/* SVN */}
          <div className="space-y-2">
            <h5 className="text-xs font-medium text-muted-foreground">SVN</h5>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Username</label>
                <input
                  type="text"
                  value={svnUsername}
                  onChange={(e) => setSvnUsername(e.target.value)}
                  placeholder="username"
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Password</label>
                <input
                  type="password"
                  value={svnPassword}
                  onChange={(e) => setSvnPassword(e.target.value)}
                  placeholder="password"
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>
            </div>
          </div>

          {/* Asana PAT */}
          <div className="space-y-2 border-t border-border/50 pt-3">
            <div className="flex items-center gap-2">
              <IconAsana className="w-3.5 h-3.5 text-orange-400" />
              <h5 className="text-xs font-medium text-muted-foreground">Asana Personal Access Token</h5>
              {asanaPatSource === 'env' && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">from ENV</span>
              )}
              {asanaPatSource === 'db' && (
                <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400">saved</span>
              )}
            </div>
            <input
              type="password"
              value={asanaPat}
              onChange={(e) => setAsanaPat(e.target.value)}
              placeholder={asanaPatSource === 'env' ? 'Using ASANA_PAT from environment' : 'Paste your Asana PAT here'}
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
            />
            <p className="text-[10px] text-muted-foreground">
              Get your token from <span className="text-foreground/70">Asana → My Settings → Apps → Personal Access Tokens</span>
            </p>
          </div>

          <button
            onClick={handleSaveGlobal}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-xs font-semibold hover:bg-primary/90 transition-colors"
          >
            Save
          </button>
        </div>

        {/* ═══ Project Settings (only when a project is selected) ═══ */}
        {project ? (
          <>
            {/* Project Name */}
            <div>
              <label className="block text-sm font-medium mb-1">Project Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              />
            </div>

            {/* Workspace Paths */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Frontend Path
                <span className="text-xs text-muted-foreground ml-2 font-normal">optional</span>
              </label>
              <FolderPicker value={frontendPath} onChange={setFrontendPath} />
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                Backend Path
                <span className="text-xs text-muted-foreground ml-2 font-normal">optional</span>
              </label>
              <FolderPicker value={backendPath} onChange={setBackendPath} />
            </div>

            {/* SVN Specification Paths (per-project) */}
            <div className="border border-border rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                </svg>
                <h4 className="text-sm font-medium">SVN Specification Paths</h4>
              </div>
              <p className="text-xs text-muted-foreground">
                SVN root directories containing spec documents. Agent will auto-fetch matching files based on Asana parent task name (function code).
              </p>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Frontend Spec SVN Path</label>
                <input
                  type="text"
                  value={svnFrontendPath}
                  onChange={(e) => setSvnFrontendPath(e.target.value)}
                  placeholder="https://svn01.example.com/svn/Project/2-SA/6-需求規格書(前端SPEC)"
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Backend Spec SVN Path</label>
                <input
                  type="text"
                  value={svnBackendPath}
                  onChange={(e) => setSvnBackendPath(e.target.value)}
                  placeholder="https://svn01.example.com/svn/Project/2-SA/5-需求規格書(後端SPEC)"
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>
            </div>

            {/* Database Connection */}
            <div className="border border-border rounded-lg p-4 space-y-3">
              <h4 className="text-sm font-medium">Database Connection</h4>
              <p className="text-xs text-muted-foreground">
                Connection string for the project's database. This will be provided to backend agents for DB operations.
              </p>
              <input
                type="text"
                value={dbConnectionString}
                onChange={(e) => setDbConnectionString(e.target.value)}
                placeholder="e.g. postgresql://user:pass@host:5432/dbname or mysql://..."
                className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              />
            </div>

            {/* Asana Integration */}
            <div className="border border-border rounded-lg p-4 space-y-3">
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
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <select
                      value={asanaProjectGid}
                      onChange={(e) => setAsanaProjectGid(e.target.value)}
                      className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm appearance-none outline-none focus:border-primary pr-8"
                    >
                      <option value="">-- None --</option>
                      {asanaProjects.map(p => (
                        <option key={p.gid} value={p.gid}>{p.name}</option>
                      ))}
                    </select>
                    <IconChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  </div>
                  <button
                    onClick={() => {
                      hasFetchedProjects.current = false;
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
              ) : asanaConnected ? (
                <input
                  type="text"
                  value={asanaProjectGid}
                  onChange={(e) => setAsanaProjectGid(e.target.value)}
                  placeholder="Asana Project GID"
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary"
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Set ASANA_PAT environment variable to enable Asana integration.
                </p>
              )}

              {/* Sync Settings */}
              {asanaConnected && asanaProjectGid && (
                <button
                  onClick={() => setShowSyncSettings(true)}
                  className="text-xs text-primary hover:underline"
                >
                  Auto-Sync Configuration
                </button>
              )}
            </div>

            {/* Project Info (read-only) */}
            <div className="border border-border rounded-lg p-4 space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Project Info</h4>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <span className="text-muted-foreground">ID:</span>
                <span className="font-mono text-foreground/70 truncate">{project.id}</span>
                <span className="text-muted-foreground">Status:</span>
                <span className="text-foreground/70">{project.status}</span>
                <span className="text-muted-foreground">Working Dir:</span>
                <span className="text-foreground/70 truncate">{project.workingDir}</span>
                <span className="text-muted-foreground">Created:</span>
                <span className="text-foreground/70">{project.createdAt}</span>
              </div>
            </div>

            {/* Save Button */}
            <button
              onClick={handleSaveProject}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
            >
              Save Settings
            </button>
          </>
        ) : (
          <div className="border border-dashed border-border rounded-lg p-6 text-center">
            <p className="text-sm text-muted-foreground">
              Select a project from <span className="text-foreground font-medium">Projects</span> to configure project-specific settings.
            </p>
          </div>
        )}
      </div>

      {/* Sync Settings Modal */}
      <AsanaSyncSettings open={showSyncSettings} onClose={() => setShowSyncSettings(false)} />
    </div>
  );
}
