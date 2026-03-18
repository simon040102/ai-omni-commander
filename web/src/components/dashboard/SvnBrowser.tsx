import { useState, useEffect, useCallback, useRef } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useProjectStore } from '../../stores/projectStore';
import { IconChevronDown } from '../ui/Icons';

interface SvnEntry {
  name: string;
  isDir: boolean;
  fullUrl: string;
}

interface SvnBrowserProps {
  onSelect: (svnUrl: string) => void;
  onClose: () => void;
  /** Lock to a specific spec type (hides the tab switcher) */
  lockedSpecType?: 'frontend' | 'backend';
}

/**
 * SVN file browser modal. Lists files/folders from the project's configured SVN paths.
 * User can navigate folders and select a file to use as spec source.
 */
export function SvnBrowser({ onSelect, onClose, lockedSpecType }: SvnBrowserProps) {
  const client = useWsStore(s => s.client);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const project = useProjectStore(s => s.projects.find(p => p.id === s.currentProjectId));

  const [specType, setSpecType] = useState<'frontend' | 'backend'>('frontend');
  const [entries, setEntries] = useState<SvnEntry[]>([]);
  const [currentUrl, setCurrentUrl] = useState('');
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ label: string; url: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef('');

  // Parse project config for SVN paths
  const svnConfig = (() => {
    if (!project?.configJson) return null;
    try {
      const config = JSON.parse(project.configJson);
      return config?.svnConfig || null;
    } catch { return null; }
  })();

  const hasFrontend = !!svnConfig?.frontendSpecPath;
  const hasBackend = !!svnConfig?.backendSpecPath;

  // Listen for svn.browseResult messages
  useEffect(() => {
    if (!client) return;

    return client.addMessageListener((msg) => {
      if (msg.type === 'svn.browseResult') {
        const payload = msg.payload as { svnUrl?: string; entries?: SvnEntry[]; error?: string };
        setLoading(false);
        if (payload.error) {
          setError(payload.error);
          setEntries([]);
        } else {
          setError('');
          setEntries(payload.entries || []);
          if (payload.svnUrl) setCurrentUrl(payload.svnUrl);
        }
      }
    });
  }, [client]);

  const browse = useCallback((svnUrl?: string, newSpecType?: 'frontend' | 'backend') => {
    if (!client || !currentProjectId) return;

    setLoading(true);
    setError('');
    const id = crypto.randomUUID();
    requestIdRef.current = id;

    client.send({
      type: 'svn.browse',
      id,
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        svnUrl: svnUrl || undefined,
        specType: newSpecType || specType,
      },
    });
  }, [client, currentProjectId, specType]);

  // Initial browse on mount
  useEffect(() => {
    if (svnConfig) {
      const type = lockedSpecType || (hasFrontend ? 'frontend' : 'backend');
      setSpecType(type);
      browse(undefined, type);
      // Set initial breadcrumb
      const rootUrl = type === 'frontend' ? svnConfig.frontendSpecPath : svnConfig.backendSpecPath;
      if (rootUrl) {
        setBreadcrumbs([{ label: type === 'frontend' ? '前端 Specs' : '後端 Specs', url: rootUrl }]);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNavigate = (entry: SvnEntry) => {
    if (entry.isDir) {
      setBreadcrumbs(prev => [...prev, { label: entry.name, url: entry.fullUrl }]);
      browse(entry.fullUrl);
    } else {
      // Select file — return full SVN URL
      onSelect(entry.fullUrl);
    }
  };

  const handleBreadcrumbClick = (index: number) => {
    const crumb = breadcrumbs[index]!;
    setBreadcrumbs(prev => prev.slice(0, index + 1));
    browse(crumb.url);
  };

  const handleSwitchType = (type: 'frontend' | 'backend') => {
    setSpecType(type);
    const rootUrl = type === 'frontend' ? svnConfig?.frontendSpecPath : svnConfig?.backendSpecPath;
    if (rootUrl) {
      setBreadcrumbs([{ label: type === 'frontend' ? 'Frontend Specs' : 'Backend Specs', url: rootUrl }]);
      browse(rootUrl, type);
    }
  };

  if (!svnConfig) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
        <div className="bg-card border border-border rounded-lg p-6 max-w-md" onClick={e => e.stopPropagation()}>
          <p className="text-sm text-muted-foreground">
            No SVN paths configured. Go to Project Settings to set up SVN Specification Paths.
          </p>
          <button onClick={onClose} className="mt-4 px-4 py-2 text-xs font-medium rounded bg-muted border border-border hover:bg-muted/80">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-[600px] max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">
            SVN Spec Browser
            {lockedSpecType && (
              <span className={`ml-2 text-xs font-normal ${lockedSpecType === 'frontend' ? 'text-blue-400' : 'text-orange-400'}`}>
                ({lockedSpecType === 'frontend' ? '前端' : '後端'})
              </span>
            )}
          </h3>
          {!lockedSpecType && (hasFrontend || hasBackend) && (
            <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5 border border-border/50">
              {hasFrontend && (
                <button
                  onClick={() => handleSwitchType('frontend')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${specType === 'frontend' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  前端 Spec
                </button>
              )}
              {hasBackend && (
                <button
                  onClick={() => handleSwitchType('backend')}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${specType === 'backend' ? 'bg-orange-500/20 text-orange-400 border border-orange-500/30 shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  後端 Spec
                </button>
              )}
            </div>
          )}
        </div>

        {/* Breadcrumbs */}
        <div className="flex items-center gap-1 px-4 py-2 text-xs text-muted-foreground overflow-x-auto border-b border-border/50 flex-shrink-0">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1 flex-shrink-0">
              {i > 0 && <span className="text-muted-foreground/50">/</span>}
              <button
                onClick={() => handleBreadcrumbClick(i)}
                className="hover:text-foreground transition-colors truncate max-w-[150px]"
                title={crumb.label}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <span className="ml-2 text-xs text-muted-foreground">Loading...</span>
            </div>
          ) : error ? (
            <div className="p-4">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="p-4 text-center">
              <p className="text-xs text-muted-foreground">No files found</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {/* Sort: dirs first, then files */}
              {[...entries].sort((a, b) => {
                if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                return a.name.localeCompare(b.name);
              }).map((entry, i) => (
                <button
                  key={i}
                  onClick={() => handleNavigate(entry)}
                  className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                >
                  {entry.isDir ? (
                    <svg className="w-4 h-4 text-yellow-400 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-blue-400 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                  )}
                  <span className={`truncate ${entry.isDir ? 'text-foreground' : 'text-foreground/80'}`}>
                    {entry.name}
                  </span>
                  {entry.isDir && (
                    <IconChevronDown className="w-3 h-3 -rotate-90 text-muted-foreground ml-auto flex-shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <span className="text-[10px] text-muted-foreground">
            {entries.length} items {currentUrl && `• ${currentUrl.split('/').slice(-2).join('/')}`}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium rounded border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
