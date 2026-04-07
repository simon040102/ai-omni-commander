import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useAsanaStore } from '../../stores/asanaStore';
import { useToastStore } from '../../stores/toastStore';
import type { DbConnectionConfig } from '@omni/shared';
import { FolderPicker } from '../project/FolderPicker';
import { AsanaSyncSettings } from '../dashboard/AsanaSyncSettings';
import { DbConnectionsEditor } from './DbConnectionsEditor';
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
  const [dbConnections, setDbConnections] = useState<DbConnectionConfig[]>([]);
  const [showSyncSettings, setShowSyncSettings] = useState(false);

  // SVN config state (per-project paths)
  const [svnFrontendPath, setSvnFrontendPath] = useState('');
  const [svnBackendPath, setSvnBackendPath] = useState('');

  // Axure Share URL
  const [axshareUrl, setAxshareUrl] = useState('');

  // Extra prompts per role
  const [frontendExtraPrompt, setFrontendExtraPrompt] = useState('');
  const [backendExtraPrompt, setBackendExtraPrompt] = useState('');

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
      // Load DB connections from configJson, with migration from legacy dbConnectionString
      const savedConns = existingConfig?.dbConnections as DbConnectionConfig[] | undefined;
      if (savedConns?.length) {
        setDbConnections(savedConns);
      } else if (project.dbConnectionString) {
        // Migrate legacy single connection string
        const dbType = project.dbConnectionString.startsWith('postgresql') ? 'postgresql'
          : project.dbConnectionString.startsWith('mysql') ? 'mysql' : 'mssql';
        setDbConnections([{
          id: crypto.randomUUID(),
          label: 'Default',
          connectionString: project.dbConnectionString,
          dbType: dbType as DbConnectionConfig['dbType'],
        }]);
      } else {
        setDbConnections([]);
      }

      const svn = existingConfig?.svnConfig as SvnConfig | undefined;
      setSvnFrontendPath(svn?.frontendSpecPath || '');
      setSvnBackendPath(svn?.backendSpecPath || '');
      setAxshareUrl(existingConfig?.axshareUrl || '');
      setFrontendExtraPrompt(existingConfig?.frontendExtraPrompt || '');
      setBackendExtraPrompt(existingConfig?.backendExtraPrompt || '');
    }
  }, [project, existingConfig]);

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

  const handleSaveProject = useCallback(() => {
    if (!client || !project) return;

    const hasSvn = svnFrontendPath.trim() || svnBackendPath.trim();
    const svnConfig: SvnConfig | undefined = hasSvn ? {
      frontendSpecPath: svnFrontendPath.trim(),
      backendSpecPath: svnBackendPath.trim(),
    } : undefined;

    const newConfig = {
      ...(existingConfig || {}),
      svnConfig,
      axshareUrl: axshareUrl.trim() || undefined,
      frontendExtraPrompt: frontendExtraPrompt.trim() || undefined,
      backendExtraPrompt: backendExtraPrompt.trim() || undefined,
      dbConnections: dbConnections.length > 0 ? dbConnections : undefined,
    };

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
        dbConnectionString: dbConnections[0]?.connectionString || null,
        configJson: JSON.stringify(newConfig),
      },
    });

    addToast({ type: 'success', title: 'Project settings saved' });
  }, [client, project, name, frontendPath, backendPath, asanaProjectGid, dbConnections,
    svnFrontendPath, svnBackendPath, axshareUrl, frontendExtraPrompt, backendExtraPrompt, existingConfig, addToast]);

  const handleGenSkills = useCallback((workspaceType: 'frontend' | 'backend') => {
    if (!client || !project) return;
    const p = workspaceType === 'frontend' ? frontendPath : backendPath;
    if (!p.trim()) return;
    client.send({
      type: 'workspace.generateSkills',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: project.id, path: p.trim(), workspaceType },
    });
    addToast({ type: 'success', title: `Gen Skills started for ${workspaceType}`, message: 'Opus agent is analyzing the codebase...' });
  }, [client, project, frontendPath, backendPath, addToast]);

  // Auto-save DB connections immediately when they change (so user doesn't need to click Save)
  const handleDbConnectionsChange = useCallback((updated: DbConnectionConfig[]) => {
    setDbConnections(updated);
    if (!client || !project) return;
    const newConfig = {
      ...(existingConfig || {}),
      dbConnections: updated.length > 0 ? updated : undefined,
    };
    client.send({
      type: 'project.update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: project.id,
        dbConnectionString: updated[0]?.connectionString || null,
        configJson: JSON.stringify(newConfig),
      },
    });
  }, [client, project, existingConfig]);

  if (!project) {
    return (
      <div className="max-w-2xl mx-auto">
        <h2 className="text-2xl font-bold mb-6">Project Settings</h2>
        <div className="border border-dashed border-border rounded-lg p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Select a project from <span className="text-foreground font-medium">Projects</span> to configure project-specific settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Project Settings</h2>

      <div className="space-y-6">
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
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium">
              Frontend Path
              <span className="text-xs text-muted-foreground ml-2 font-normal">optional</span>
            </label>
            {frontendPath.trim() && (
              <button
                onClick={() => handleGenSkills('frontend')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-violet-500/10 text-violet-600 border border-violet-500/30 hover:bg-violet-500/20 transition-colors"
                title="Spawn an Opus agent to analyze this codebase and generate/update CLAUDE.md + skills"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Gen Skills
              </button>
            )}
          </div>
          <FolderPicker value={frontendPath} onChange={setFrontendPath} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium">
              Backend Path
              <span className="text-xs text-muted-foreground ml-2 font-normal">optional</span>
            </label>
            {backendPath.trim() && (
              <button
                onClick={() => handleGenSkills('backend')}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-violet-500/10 text-violet-600 border border-violet-500/30 hover:bg-violet-500/20 transition-colors"
                title="Spawn an Opus agent to analyze this codebase and generate/update CLAUDE.md + skills"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                Gen Skills
              </button>
            )}
          </div>
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

        {/* Axure Share */}
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <h4 className="text-sm font-medium">Axure Share</h4>
          </div>
          <p className="text-xs text-muted-foreground">
            Axure Share 原型的 base URL，供 Axure Agent 重新爬取頁面快照。
          </p>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Axure Share URL</label>
            <input
              type="text"
              value={axshareUrl}
              onChange={(e) => setAxshareUrl(e.target.value)}
              placeholder="https://xxxxxx.axshare.com"
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
            />
          </div>
        </div>

        {/* Extra Prompts per Role */}
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <h4 className="text-sm font-medium">Extra Prompt（額外提示）</h4>
          </div>
          <p className="text-xs text-muted-foreground">
            附加到 Agent 提示的額外指令。例如：指定共用元件位置、禁止使用某些套件、指定 coding 規範等。
          </p>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Frontend Extra Prompt</label>
            <textarea
              value={frontendExtraPrompt}
              onChange={(e) => setFrontendExtraPrompt(e.target.value)}
              rows={4}
              placeholder={`例如：\n- 共用搜尋元件在 src/component/SearchModal/，使用前先確認是否已有對應元件\n- 禁止使用 moment.js，改用 date-fns`}
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 resize-y"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Backend Extra Prompt</label>
            <textarea
              value={backendExtraPrompt}
              onChange={(e) => setBackendExtraPrompt(e.target.value)}
              rows={4}
              placeholder={`例如：\n- API 路徑統一使用 /main/ 前綴\n- 所有 Entity 繼承 BaseEntity`}
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 resize-y"
            />
          </div>
        </div>

        {/* Database Connections */}
        <DbConnectionsEditor connections={dbConnections} onChange={handleDbConnectionsChange} />

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
              Configure Asana PAT in <span className="text-foreground font-medium">Global Settings</span> to enable Asana integration.
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
          Save Project Settings
        </button>
      </div>

      {/* Sync Settings Modal */}
      <AsanaSyncSettings open={showSyncSettings} onClose={() => setShowSyncSettings(false)} />
    </div>
  );
}
