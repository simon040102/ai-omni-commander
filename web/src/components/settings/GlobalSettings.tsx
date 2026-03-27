import { useState, useEffect, useCallback } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { IconAsana } from '../ui/Icons';

export function GlobalSettings() {
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const [svnUsername, setSvnUsername] = useState('');
  const [svnPassword, setSvnPassword] = useState('');
  const [asanaPat, setAsanaPat] = useState('');
  const [asanaPatSource, setAsanaPatSource] = useState<'none' | 'env' | 'db'>('none');
  const [playwrightEnabled, setPlaywrightEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Test states
  const [svnTesting, setSvnTesting] = useState(false);
  const [asanaTesting, setAsanaTesting] = useState(false);

  // Load global credentials
  useEffect(() => {
    if (!client || loaded) return;
    const unsub = client.addMessageListener((msg) => {
      if (msg.type === 'config.state') {
        const p = msg.payload as { svnUsername: string; hasSvnPassword: boolean; hasAsanaPat: boolean; asanaPatSource: string; globalMcpServers?: Record<string, unknown> };
        setSvnUsername(p.svnUsername || '');
        if (!loaded) {
          setSvnPassword(p.hasSvnPassword ? '••••••••' : '');
          setAsanaPat(p.hasAsanaPat ? '••••••••' : '');
          setAsanaPatSource((p.asanaPatSource as 'none' | 'env' | 'db') || 'none');
          setPlaywrightEnabled(!!(p.globalMcpServers && 'playwright' in p.globalMcpServers));
        }
        setLoaded(true);
      }
    });
    client.send({
      type: 'config.get',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {},
    });
    return unsub;
  }, [client, loaded]);

  // Listen for test results
  useEffect(() => {
    if (!client) return;
    const unsub = client.addMessageListener((msg) => {
      if (msg.type === 'config.testResult') {
        const p = msg.payload as { service: string; success: boolean; message: string };
        if (p.service === 'svn') setSvnTesting(false);
        if (p.service === 'asana') setAsanaTesting(false);
        addToast({
          type: p.success ? 'success' : 'error',
          title: `${p.service.toUpperCase()} ${p.success ? 'OK' : 'Failed'}`,
          message: p.message,
          duration: p.success ? 3000 : 8000,
        });
      }
    });
    return unsub;
  }, [client, addToast]);

  const handleSave = useCallback(() => {
    if (!client) return;
    client.send({
      type: 'config.setSvnCredentials',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        username: svnUsername.trim(),
        password: svnPassword === '••••••••' ? '' : svnPassword,
      },
    });
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

  const handleTestSvn = useCallback(() => {
    if (!client) return;
    setSvnTesting(true);
    client.send({
      type: 'config.testSvn',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {},
    });
  }, [client]);

  const handleTestAsana = useCallback(() => {
    if (!client) return;
    setAsanaTesting(true);
    client.send({
      type: 'config.testAsana',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {},
    });
  }, [client]);

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">Global Settings</h2>

      <div className="space-y-6">
        {/* SVN Credentials */}
        <div className="border border-border rounded-lg p-4 space-y-4">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <h4 className="text-sm font-medium">SVN Credentials</h4>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">All projects</span>
            <div className="flex-1" />
            <button
              onClick={handleTestSvn}
              disabled={svnTesting || (!svnUsername && !svnPassword)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {svnTesting ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93" />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              Test
            </button>
          </div>

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
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <IconAsana className="w-4 h-4 text-orange-400" />
            <h4 className="text-sm font-medium">Asana Personal Access Token</h4>
            {asanaPatSource === 'env' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400">from ENV</span>
            )}
            {asanaPatSource === 'db' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400">saved</span>
            )}
            <div className="flex-1" />
            <button
              onClick={handleTestAsana}
              disabled={asanaTesting || (!asanaPat && asanaPatSource === 'none')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {asanaTesting ? (
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93" />
                </svg>
              ) : (
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              Test
            </button>
          </div>
          <input
            type="password"
            value={asanaPat}
            onChange={(e) => setAsanaPat(e.target.value)}
            placeholder={asanaPatSource === 'env' ? 'Using ASANA_PAT from environment' : 'Paste your Asana PAT here'}
            className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
          />
          <p className="text-[10px] text-muted-foreground">
            Get your token from <span className="text-foreground/70">Asana &rarr; My Settings &rarr; Apps &rarr; Personal Access Tokens</span>
          </p>
        </div>

        {/* Global MCP Servers */}
        <div className="border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
            </svg>
            <h4 className="text-sm font-medium">Global MCP Servers</h4>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">All agents</span>
          </div>
          <p className="text-xs text-muted-foreground">全域啟用的 MCP servers，所有 agent 啟動時自動注入（無需 .mcp.json 授權）</p>

          {/* Playwright toggle */}
          <div className="flex items-center justify-between py-2 px-3 rounded-md border border-border/60 bg-muted/20">
            <div>
              <div className="text-sm font-medium">Playwright MCP</div>
              <div className="text-[11px] text-muted-foreground">瀏覽器自動化 — smoke test / E2E</div>
            </div>
            <button
              onClick={() => {
                const next = !playwrightEnabled;
                setPlaywrightEnabled(next);
                if (!client) return;
                client.send({
                  type: 'config.setGlobalMcpServers',
                  id: crypto.randomUUID(),
                  timestamp: new Date().toISOString(),
                  payload: {
                    servers: next
                      ? { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } }
                      : {},
                  },
                });
                addToast({ type: 'success', title: `Playwright MCP ${next ? 'enabled' : 'disabled'} globally` });
              }}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                playwrightEnabled ? 'bg-purple-500' : 'bg-muted-foreground/30'
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                playwrightEnabled ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
        >
          Save Global Settings
        </button>
      </div>
    </div>
  );
}
