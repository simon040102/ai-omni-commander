import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';

interface MockupFile {
  filename: string;
  updatedAt: string;
}

export function MockupView() {
  const project = useProjectStore(s => s.projects.find(p => p.id === s.currentProjectId));
  const axureAgent = useProjectStore(s =>
    s.agents.find(a => a.projectId === s.currentProjectId && a.role === 'axure' && ['starting', 'running'].includes(a.status))
  );
  const erroredAxureAgent = useProjectStore(s =>
    s.agents.find(a => a.projectId === s.currentProjectId && a.role === 'axure' && a.status === 'error')
  );
  const client = useWsStore(s => s.client);

  const [files, setFiles] = useState<MockupFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [crawlingAll, setCrawlingAll] = useState(false);
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);
  const [omniRoot, setOmniRoot] = useState('');

  useEffect(() => {
    fetch('/api/health').then(r => r.json()).then(d => { if (d.projectRoot) setOmniRoot(d.projectRoot); }).catch(() => {});
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const axshareUrl: string = (() => {
    try { return JSON.parse(project?.configJson || '{}')?.axshareUrl || ''; } catch { return ''; }
  })();

  const fetchFiles = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/mockups`);
      const data = await res.json() as { files: MockupFile[] };
      const newFiles: MockupFile[] = data.files || [];
      setFiles(newFiles);
      // Collapse any newly appeared group codes by default
      setCollapsedGroups(prev => {
        const next = new Set(prev);
        newFiles.forEach(f => {
          const code = f.filename.match(/^([a-zA-Z0-9]+)-/)?.[1]?.toUpperCase() ?? f.filename;
          if (!next.has(code)) next.add(code);
        });
        return next;
      });
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  // Auto-refresh while axure agent is running
  useEffect(() => {
    if (!axureAgent) return;
    const interval = setInterval(fetchFiles, 5000);
    return () => clearInterval(interval);
  }, [axureAgent, fetchFiles]);

  const toggleSelect = (filename: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename); else next.add(filename);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === files.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map(f => f.filename)));
    }
  };

  const handleReload = () => {
    if (!project || selected.size === 0) return;
    if (!axshareUrl) { alert('請先在 Project Settings 設定 Axure Share URL'); return; }
    const fileList = [...selected].map(f => `- ${f}`).join('\n');
    setMcpCommand(`請使用 /crawl-axure-snapshots skill 重新爬取以下 Axure 原型頁面。

使用 Playwright MCP 工具（browser_navigate、browser_evaluate），不要用 browser_take_screenshot。

Axure Share URL: ${axshareUrl}
Project ID: ${project.id}
Output directory: ${omniRoot}/docs/axure-snapshots/${project.id}/

要重新爬取的頁面：
${fileList}

使用 Agent tool 派出 subagent 執行。`);
  };

  const previewUrl = previewFile && project
    ? `/api/projects/${project.id}/mockups/${encodeURIComponent(previewFile)}`
    : null;

  if (!project) return null;

  return (
    <div className="flex h-full gap-3">
      {/* Left: file list */}
      <div className="w-64 flex-shrink-0 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Axure 原型畫面</h2>
          <button
            onClick={fetchFiles}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="重新整理列表"
          >
            ↻
          </button>
        </div>

        {!axshareUrl && (
          <div className="text-sm text-yellow-500 bg-yellow-500/10 rounded px-2 py-1">
            尚未設定 Axure Share URL（Project Settings）
          </div>
        )}

        {loading ? (
          <div className="text-xs text-muted-foreground">載入中...</div>
        ) : files.length === 0 ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-muted-foreground">
              無 HTML 檔案<br />
              <span className="text-sm">docs/axure-snapshots/{project.id}/</span>
            </div>
            {axshareUrl && (
              axureAgent ? (
                <button
                  onClick={() => {
                    if (!client) return;
                    client.send({
                      type: 'agent.action',
                      id: crypto.randomUUID(),
                      timestamp: new Date().toISOString(),
                      payload: { action: 'stop', agentId: axureAgent.id },
                    });
                  }}
                  className="px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                >
                  停止爬取
                </button>
              ) : (
                <button
                  onClick={() => {
                    const skipSection = files.length > 0
                      ? `\n已爬取（跳過）：\n${files.map(f => `- ${f.filename}`).join('\n')}\n`
                      : '';
                    setMcpCommand(`請使用 /crawl-axure-snapshots skill 爬取 Axure Share 專案的所有頁面。

使用 Playwright MCP 工具（browser_navigate、browser_evaluate），不要用 browser_take_screenshot。

Axure Share URL: ${axshareUrl}
Project ID: ${project.id}
Output directory: ${omniRoot}/docs/axure-snapshots/${project.id}/${skipSection}
使用 Agent tool 派出 subagent 執行。完成後輸出 [TASK_COMPLETE]。`);
                  }}
                  className="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  爬取全部頁面
                </button>
              )
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground border-b border-border pb-1">
              <input
                type="checkbox"
                checked={selected.size === files.length && files.length > 0}
                onChange={toggleSelectAll}
                className="w-3 h-3"
              />
              <span>全選 ({files.length})</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {(() => {
                // Group by function code (leading alphanumeric prefix before first '-')
                const groups = new Map<string, MockupFile[]>();
                for (const f of files) {
                  const code = f.filename.match(/^([a-zA-Z0-9]+)-/)?.[1]?.toUpperCase() ?? '';
                  const key = code || f.filename;
                  if (!groups.has(key)) groups.set(key, []);
                  groups.get(key)!.push(f);
                }
                return [...groups.entries()].map(([code, groupFiles]) => {
                  const isCollapsed = collapsedGroups.has(code);
                  const toggleCollapse = () => setCollapsedGroups(prev => {
                    const next = new Set(prev);
                    next.has(code) ? next.delete(code) : next.add(code);
                    return next;
                  });
                  return (
                  <div key={code} className="mb-1">
                    {groups.size > 1 && (
                      <div className="flex items-center gap-1.5 px-2 py-0.5 select-none">
                        <span className="text-xs text-muted-foreground cursor-pointer" onClick={toggleCollapse}>{isCollapsed ? '▶' : '▼'}</span>
                        <input
                          type="checkbox"
                          checked={groupFiles.every(f => selected.has(f.filename))}
                          onChange={() => {
                            const allSelected = groupFiles.every(f => selected.has(f.filename));
                            setSelected(prev => {
                              const next = new Set(prev);
                              groupFiles.forEach(f => allSelected ? next.delete(f.filename) : next.add(f.filename));
                              return next;
                            });
                          }}
                          className="w-3 h-3 flex-shrink-0"
                        />
                        <div className="flex items-center gap-1 flex-1 cursor-pointer" onClick={toggleCollapse}>
                          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wide">{code}</span>
                          <span className="text-xs text-muted-foreground">({groupFiles.length})</span>
                        </div>
                      </div>
                    )}
                    {!isCollapsed && groupFiles.map(f => (
                      <div
                        key={f.filename}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-xs transition-colors ${
                          previewFile === f.filename ? 'bg-primary/10 text-primary' : 'hover:bg-muted text-foreground'
                        } ${groups.size > 1 ? 'pl-5' : ''}`}
                        onClick={() => setPreviewFile(f.filename)}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(f.filename)}
                          onChange={(e) => { e.stopPropagation(); toggleSelect(f.filename); }}
                          className="w-3 h-3 flex-shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="truncate font-mono">
                            {f.filename.replace(/^[a-zA-Z0-9]+-/, '')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )});
              })()}
            </div>
          </>
        )}

        {axureAgent ? (
          <button
            onClick={() => {
              if (!client) return;
              client.send({
                type: 'agent.action',
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                payload: { action: 'stop', agentId: axureAgent.id },
              });
            }}
            className="mt-auto px-3 py-1.5 text-xs rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
          >
            停止爬取
          </button>
        ) : erroredAxureAgent && axshareUrl ? (
          <button
            onClick={() => {
              const skipSection = files.length > 0
                ? `\n已爬取（跳過）：\n${files.map(f => `- ${f.filename}`).join('\n')}\n`
                : '';
              setMcpCommand(`請使用 /crawl-axure-snapshots skill 繼續爬取 Axure Share 專案（上次中斷）。

使用 Playwright MCP 工具（browser_navigate、browser_evaluate），不要用 browser_take_screenshot。

Axure Share URL: ${axshareUrl}
Project ID: ${project.id}
Output directory: ${omniRoot}/docs/axure-snapshots/${project.id}/${skipSection}
使用 Agent tool 派出 subagent 執行。完成後輸出 [TASK_COMPLETE]。`);
            }}
            className="mt-auto px-3 py-1.5 text-xs rounded bg-amber-600 text-white hover:bg-amber-700 transition-colors"
          >
            繼續爬取（上次中斷）
          </button>
        ) : selected.size > 0 ? (
          <button
            onClick={handleReload}
            disabled={!axshareUrl}
            className="mt-auto px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {`Reload (${selected.size})`}
          </button>
        ) : axshareUrl ? (
          <button
            onClick={() => {
              const skipSection = files.length > 0
                ? `\n已爬取（跳過）：\n${files.map(f => `- ${f.filename}`).join('\n')}\n`
                : '';
              setMcpCommand(`請使用 /crawl-axure-snapshots skill 爬取 Axure Share 專案的所有頁面。

使用 Playwright MCP 工具（browser_navigate、browser_evaluate），不要用 browser_take_screenshot。

Axure Share URL: ${axshareUrl}
Project ID: ${project.id}
Output directory: ${omniRoot}/docs/axure-snapshots/${project.id}/${skipSection}
使用 Agent tool 派出 subagent 執行。完成後輸出 [TASK_COMPLETE]。`);
            }}
            className="mt-auto px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            爬取全部頁面
          </button>
        ) : null}
      </div>

      {/* Right: preview */}
      <div className="flex-1 border border-border rounded overflow-hidden bg-white">
        {previewUrl ? (
          <iframe
            key={previewUrl}
            src={previewUrl}
            className="w-full h-full"
            title={previewFile || ''}
            sandbox="allow-same-origin"
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            點選左側檔案預覽
          </div>
        )}
      </div>

      {/* MCP Command Modal */}
      {mcpCommand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMcpCommand(null)}>
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[680px] max-w-[90vw] p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Crawl Axure via MCP</h3>
              <button onClick={() => setMcpCommand(null)} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground">&times;</button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">Copy this instruction and paste it into Claude Code:</p>
            <div className="relative">
              <pre className="bg-muted/50 border border-border rounded-lg p-4 text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed select-all max-h-[50vh] overflow-y-auto">{mcpCommand}</pre>
              <button
                onClick={() => { navigator.clipboard.writeText(mcpCommand); }}
                className="absolute top-2 right-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
              >Copy</button>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setMcpCommand(null)} className="px-4 py-2 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 text-sm transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
