import { useState, useCallback, useEffect, useRef } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { TerminalOutput } from '../dashboard/TerminalOutput';
import { FolderPicker } from '../project/FolderPicker';
import { IconStop, IconPlay, IconPlus, IconX, IconGrid, IconTrash, IconUpload, IconDocument, IconExternalLink } from '../ui/Icons';
import { SvnBrowser } from '../dashboard/SvnBrowser';
import { ProgressRing } from '../ui/ProgressRing';
import type { SuperpowersFeature } from '@omni/shared';
import type { View } from '../layout/AppShell';

/* ─── Role accent colors ─── */
const ROLE_DOT: Record<string, string> = {
  frontend: 'bg-blue-500',
  backend: 'bg-purple-500',
  master: 'bg-yellow-500',
  architect: 'bg-orange-500',
  devops: 'bg-green-500',
  testing: 'bg-teal-500',
  review: 'bg-gray-500',
  quick: 'bg-amber-500',
};

const ROLE_BG: Record<string, string> = {
  frontend: 'bg-blue-500/10 text-blue-400',
  backend: 'bg-purple-500/10 text-purple-400',
  master: 'bg-yellow-500/10 text-yellow-400',
  architect: 'bg-orange-500/10 text-orange-400',
  devops: 'bg-green-500/10 text-green-400',
  testing: 'bg-teal-500/10 text-teal-400',
  review: 'bg-gray-500/10 text-gray-400',
  quick: 'bg-amber-500/10 text-amber-400',
};

const ROLE_BUTTON: Record<string, string> = {
  frontend: 'bg-blue-500/15 text-blue-400 ring-blue-400/40',
  backend: 'bg-purple-500/15 text-purple-400 ring-purple-400/40',
  devops: 'bg-green-500/15 text-green-400 ring-green-400/40',
  testing: 'bg-teal-500/15 text-teal-400 ring-teal-400/40',
  review: 'bg-gray-500/15 text-gray-400 ring-gray-400/40',
  quick: 'bg-amber-500/15 text-amber-400 ring-amber-400/40',
};

interface AgentsViewProps {
  onViewChange: (view: View) => void;
}

type RightPanel = { mode: 'terminal'; agentId: string } | { mode: 'add-agent' } | { mode: 'empty' };

export function AgentsView({ onViewChange }: AgentsViewProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const allAgents = useProjectStore(s => s.agents);
  const tasks = useProjectStore(s => s.tasks);
  const outputs = useAgentStore(s => s.outputs);
  const progress = useAgentStore(s => s.progress);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const agents = (currentProjectId
    ? allAgents.filter(a => a.projectId === currentProjectId)
    : allAgents
  ).slice().reverse(); // newest agents appended last → reverse = newest first

  const project = projects.find(p => p.id === currentProjectId);

  // View mode: list (sidebar + single terminal) vs grid (multi-terminal grid)
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // Grid mode state: which agents are pinned to grid, and their display order
  const [gridAgentIds, setGridAgentIds] = useState<string[]>([]);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // Auto-add new agents to grid (newest first, dedup via functional update)
  useEffect(() => {
    // agents is already newest-first (reversed insertion order)
    const allIds = agents.map(a => a.id);

    setGridAgentIds(prev => {
      // Remove stale ids first
      const valid = prev.filter(id => allIds.includes(id));
      // Prepend any new ids (newest first)
      const existingSet = new Set(valid);
      const newIds = allIds.filter(id => !existingSet.has(id));
      return [...newIds, ...valid];
    });
  }, [agents.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Right panel state (list mode only)
  const [rightPanel, setRightPanel] = useState<RightPanel>({ mode: 'empty' });
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<string | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);

  const [editTitleDraft, setEditTitleDraft] = useState('');

  const handleRenameAgent = useCallback((agentId: string, newTitle: string) => {
    client?.send({
      type: 'agent.update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId, title: newTitle.trim() || null },
    });
    setEditingTitleId(null);
  }, [client]);

  // Add agent form state
  const [addAgentRole, setAddAgentRole] = useState('backend');
  const [addAgentPrompt, setAddAgentPrompt] = useState('');
  const [addAgentModel, setAddAgentModel] = useState('sonnet');
  const [addAgentWorkDirMode, setAddAgentWorkDirMode] = useState<'auto' | 'custom'>('auto');
  const [addAgentWorkDir, setAddAgentWorkDir] = useState('');
  const [addAgentUseSkills, setAddAgentUseSkills] = useState(true);
  const [addAgentSuperpowers, setAddAgentSuperpowers] = useState(false);
  const [addAgentSpFeatures, setAddAgentSpFeatures] = useState<SuperpowersFeature[]>(['brainstorm', 'tdd', 'debugging']);
  const [addAgentUseAxure, setAddAgentUseAxure] = useState(true);
  const [addAgentFiles, setAddAgentFiles] = useState<Array<{ file: File; docType: 'SA' | 'SD' }>>([]);

  // Check for focusAgentId from sessionStorage (from task execution navigation)
  useEffect(() => {
    const storedAgentId = sessionStorage.getItem('focusAgentId');
    if (storedAgentId) {
      setRightPanel({ mode: 'terminal', agentId: storedAgentId });
      sessionStorage.removeItem('focusAgentId');
    }
  }, []);

  // Auto-select first agent if none selected
  useEffect(() => {
    if (rightPanel.mode === 'empty' && agents.length > 0) {
      // Prefer a running agent
      const running = agents.find(a => a.status === 'running');
      setRightPanel({ mode: 'terminal', agentId: (running || agents[0]).id });
    }
    // If selected agent was deleted, reset
    if (rightPanel.mode === 'terminal' && !agents.find(a => a.id === rightPanel.agentId)) {
      if (agents.length > 0) {
        setRightPanel({ mode: 'terminal', agentId: agents[0].id });
      } else {
        setRightPanel({ mode: 'empty' });
      }
    }
  }, [agents, rightPanel]);

  // Resolve working directory based on role
  const resolveWorkDir = (role: string): string => {
    if (role === 'frontend' && project?.frontendPath) return project.frontendPath;
    if (role === 'backend' && project?.backendPath) return project.backendPath;
    return project?.workingDir || '';
  };

  const autoResolvedDir = resolveWorkDir(addAgentRole);
  const effectiveWorkDir = addAgentWorkDirMode === 'auto' ? '' : addAgentWorkDir;

  const handleStopAll = useCallback(() => {
    if (!currentProjectId) return;
    for (const agent of agents) {
      if (agent.status === 'running') {
        client?.send({
          type: 'agent.action',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          payload: { agentId: agent.id, action: 'stop' },
        });
      }
    }
    addToast({ type: 'warning', title: 'Stopping all agents...' });
  }, [agents, client, currentProjectId, addToast]);

  const handleDeleteAgent = useCallback((agentId: string) => {
    client?.send({
      type: 'agent.delete',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId },
    });
    addToast({ type: 'success', title: 'Agent removed' });
  }, [client, addToast]);

  const handleSendCommand = useCallback((agentId: string, command: string) => {
    client?.send({
      type: 'agent.command',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId, command },
    });
  }, [client]);

  const handleAgentAction = useCallback((agentId: string, action: 'stop' | 'restart') => {
    client?.send({
      type: 'agent.action',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId, action },
    });
  }, [client]);

  const handleAddAgent = useCallback(async () => {
    if (!currentProjectId || !addAgentPrompt.trim()) return;

    // Pre-generate agentId so uploaded files can be stored under the agent's folder
    const newAgentId = crypto.randomUUID();

    // Upload staged files first, linking them to the pre-generated agentId
    for (const { file, docType } of addAgentFiles) {
      const content = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
        reader.readAsDataURL(file);
      });
      client?.send({
        type: 'project.uploadDocument',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId: currentProjectId,
          filename: file.name,
          content,
          fileType: 'base64',
          docType,
          agentId: newAgentId,
        },
      });
    }

    // Small delay to ensure uploads are processed
    if (addAgentFiles.length > 0) {
      await new Promise(r => setTimeout(r, 300));
    }

    client?.send({
      type: 'agent.add',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        agentId: newAgentId,
        role: addAgentRole,
        prompt: addAgentPrompt.trim(),
        model: addAgentModel,
        workingDir: effectiveWorkDir || undefined,
        useWorkspaceSkills: addAgentUseSkills,
        superpowersFeatures: addAgentSuperpowers ? addAgentSpFeatures : undefined,
        useAxureContext: addAgentUseAxure,
      },
    });
    addToast({ type: 'info', title: 'Agent added', message: `Starting ${addAgentRole} agent (${addAgentModel})...` });
    setRightPanel({ mode: 'empty' }); // will auto-select the new agent when it appears
    setAddAgentPrompt('');
    setAddAgentWorkDir('');
    setAddAgentWorkDirMode('auto');
    setAddAgentFiles([]);
  }, [currentProjectId, client, addToast, addAgentRole, addAgentPrompt, addAgentModel, effectiveWorkDir, addAgentUseSkills, addAgentSuperpowers, addAgentSpFeatures, addAgentUseAxure, addAgentFiles]);

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
            Select a project from the sidebar to manage its agents.
          </p>
        </div>
      </div>
    );
  }

  const runningAgents = agents.filter(a => a.status === 'running');
  const selectedAgentId = rightPanel.mode === 'terminal' ? rightPanel.agentId : null;
  const selectedAgent = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : null;

  return (
    <div className="flex flex-col h-full gap-2">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold">Agents</h2>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            runningAgents.length > 0 ? 'bg-green-500/15 text-green-400' : 'bg-muted text-muted-foreground'
          }`}>
            {runningAgents.length}/{agents.length} running
          </span>
        </div>
        <div className="flex items-center gap-2">
          {runningAgents.length > 0 && (
            <button
              onClick={handleStopAll}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors"
            >
              <IconStop className="w-3 h-3" />
              Stop All
            </button>
          )}
          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
              title="List view"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'}`}
              title="Grid view"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ─── Grid view ─── */}
      {viewMode === 'grid' && (
        <div className="flex-1 min-h-0 flex gap-2 overflow-hidden">
          {/* Grid agent picker sidebar */}
          <div className="w-44 flex-shrink-0 flex flex-col border border-border rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-border text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Show in Grid
            </div>
            <div className="flex-1 overflow-y-auto p-1 space-y-1">
              {agents.map(agent => {
                const inGrid = gridAgentIds.includes(agent.id);
                const currentTask = agent.currentTaskId ? tasks.find(t => t.id === agent.currentTaskId) : null;
                return (
                  <label
                    key={agent.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                      inGrid ? 'bg-primary/8' : 'hover:bg-muted/50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={inGrid}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setGridAgentIds(prev => [...prev, agent.id]);
                        } else {
                          setGridAgentIds(prev => prev.filter(id => id !== agent.id));
                        }
                      }}
                      className="rounded border-border accent-primary w-3.5 h-3.5 flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          agent.status === 'running' ? 'bg-green-500 animate-breathe' :
                          agent.status === 'error' ? 'bg-red-500' : 'bg-gray-500'
                        }`} />
                        <span className={`text-[10px] font-bold capitalize ${ROLE_BG[agent.role]?.split(' ')[1] || 'text-muted-foreground'}`}>
                          {agent.role}
                        </span>
                      </div>
                      <div className="text-[9px] text-muted-foreground truncate mt-0.5" title={agent.title || currentTask?.title || '手動新增'}>
                        {agent.title || currentTask?.title || '手動新增'}
                      </div>
                    </div>
                  </label>
                );
              })}
              {agents.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-4">No agents</div>
              )}
            </div>
            <button
              onClick={() => { setViewMode('list'); setRightPanel({ mode: 'add-agent' }); }}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border-t border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <IconPlus className="w-3.5 h-3.5" />
              Add Agent
            </button>
          </div>

          {/* Grid terminals */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {(() => {
              const visibleAgents = gridAgentIds
                .map(id => agents.find(a => a.id === id))
                .filter((a): a is NonNullable<typeof a> => !!a);

              if (visibleAgents.length === 0) {
                return (
                  <div className="h-full flex items-center justify-center border border-border rounded-lg">
                    <p className="text-sm text-muted-foreground">Select agents to display</p>
                  </div>
                );
              }

              const cols = visibleAgents.length === 1 ? 1 : 2;
              const rows = Math.ceil(visibleAgents.length / cols);
              // If more than 2 rows, enable scrolling with fixed row height
              const needsScroll = rows > 2;

              return (
                <div
                  className={`${needsScroll ? 'overflow-y-auto' : 'h-full'} grid gap-2`}
                  style={{
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gridAutoRows: needsScroll ? 'minmax(320px, 1fr)' : 'minmax(0, 1fr)',
                  }}
                >
                  {visibleAgents.map((agent, idx) => {
                    const currentTask = agent.currentTaskId ? tasks.find(t => t.id === agent.currentTaskId) : null;
                    const isDragging = dragIdx === idx;
                    const isDropTarget = dropIdx === idx && dragIdx !== idx;

                    return (
                      <div
                        key={agent.id}
                        className={`min-h-0 min-w-0 flex flex-col rounded-lg overflow-hidden border transition-all ${
                          isDragging ? 'opacity-50 border-primary/50' :
                          isDropTarget ? 'border-primary border-dashed' :
                          'border-transparent'
                        }`}
                        draggable
                        onDragStart={() => setDragIdx(idx)}
                        onDragOver={(e) => { e.preventDefault(); setDropIdx(idx); }}
                        onDragLeave={() => setDropIdx(null)}
                        onDragEnd={() => {
                          if (dragIdx !== null && dropIdx !== null && dragIdx !== dropIdx) {
                            setGridAgentIds(prev => {
                              const next = [...prev];
                              const [moved] = next.splice(dragIdx, 1);
                              next.splice(dropIdx, 0, moved!);
                              return next;
                            });
                          }
                          setDragIdx(null);
                          setDropIdx(null);
                        }}
                        onDrop={(e) => e.preventDefault()}
                      >
                        {/* Task name label */}
                        <div className="flex items-center gap-1.5 px-2 py-1 bg-card border-b border-border cursor-grab active:cursor-grabbing">
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            agent.status === 'running' ? 'bg-green-500 animate-breathe' :
                            agent.status === 'reviewing' ? 'bg-yellow-500 animate-breathe' :
                            agent.status === 'error' ? 'bg-red-500' : 'bg-gray-500'
                          }`} />
                          <span className={`text-[10px] font-bold capitalize px-1 py-0.5 rounded ${ROLE_BG[agent.role] || 'bg-muted text-muted-foreground'}`}>
                            {agent.role}
                          </span>
                          <span className="text-[10px] text-foreground font-medium truncate flex-1" title={currentTask?.title}>
                            {currentTask?.title || '手動新增'}
                          </span>
                          <span className="text-[9px] text-muted-foreground flex-shrink-0">⠿</span>
                        </div>
                        <div className="flex-1 min-h-0">
                          <TerminalOutput
                            outputs={outputs[agent.id] || []}
                            title={`${agent.role.charAt(0).toUpperCase() + agent.role.slice(1)} Agent${agent.title ? ` — ${agent.title}` : ''}`}
                            role={agent.role}
                            status={agent.status}
                            agentId={agent.id}
                            model={agent.model}
                            totalInputTokens={agent.totalInputTokens}
                            totalOutputTokens={agent.totalOutputTokens}
                            onSendCommand={handleSendCommand}
                            onAction={handleAgentAction}
                            compact
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Overlay to close delete confirm when clicking outside */}
      {confirmDeleteAgentId && (
        <div className="fixed inset-0 z-10" onClick={() => setConfirmDeleteAgentId(null)} />
      )}

      {/* ─── List view: left list + right panel ─── */}
      {viewMode === 'list' && (
      <div className="flex-1 min-h-0 flex gap-2">
        {/* ─── Left: Agent list ─── */}
        <div className="w-56 flex-shrink-0 flex flex-col overflow-hidden">
          {/* Agent list */}
          <div className="flex-1 overflow-y-auto space-y-2 p-1">
            {agents.map(agent => {
              const isSelected = selectedAgentId === agent.id;
              const currentTask = agent.currentTaskId ? tasks.find(t => t.id === agent.currentTaskId) : null;
              const agentOutputs = outputs[agent.id] || [];
              const toolCalls = agentOutputs.filter(o => o.streamType === 'tool_use').length;
              const agentProgress = progress[agent.id];
              const canResume = agent.status === 'error' && agent.sessionId && agent.role !== 'axure';

              return (
                <div
                  key={agent.id}
                  className={`relative px-3 py-2.5 cursor-pointer rounded-lg border transition-all ${confirmDeleteAgentId !== agent.id ? 'group' : ''}
                    ${isSelected
                      ? 'bg-primary/8 border-primary/30 shadow-sm shadow-primary/5'
                      : confirmDeleteAgentId === agent.id
                        ? 'bg-card border-border/60'
                        : 'bg-card border-border/60 hover:bg-muted/50 hover:border-border'
                    }
                  `}
                  onClick={() => setRightPanel({ mode: 'terminal', agentId: agent.id })}
                >
                  {/* Row 1: role badge + status + progress ring */}
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className={`text-[10px] font-bold capitalize px-1.5 py-0.5 rounded ${
                      ROLE_BG[agent.role] || 'bg-muted text-muted-foreground'
                    }`}>
                      {agent.role}
                    </span>
                    {!agentProgress && (
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        agent.status === 'running' ? 'bg-green-500 animate-breathe' :
                        agent.status === 'error' ? 'bg-red-500' :
                        agent.status === 'stopped' ? 'bg-gray-500' :
                        'bg-yellow-500'
                      }`} />
                    )}
                    <div className="ml-auto flex items-center gap-1.5">
                      <span className="text-[9px] text-muted-foreground">{toolCalls} tools</span>
                      {agentProgress && agent.status === 'running' && (
                        <ProgressRing percentage={agentProgress.percentage} size={36} strokeWidth={3} phase={agentProgress.currentPhase} />
                      )}
                    </div>
                  </div>

                  {/* Row 2: agent title + delete */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex-1 min-w-0">
                      {editingTitleId === agent.id ? (
                        <input
                          type="text"
                          value={editTitleDraft}
                          onChange={(e) => setEditTitleDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameAgent(agent.id, editTitleDraft);
                            if (e.key === 'Escape') setEditingTitleId(null);
                          }}
                          onBlur={() => handleRenameAgent(agent.id, editTitleDraft)}
                          className="w-full bg-muted border border-primary/40 rounded px-1 py-0.5 text-[11px] outline-none"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div
                          className="text-xs text-foreground font-semibold truncate leading-tight cursor-text"
                          title={`${agent.title || currentTask?.title || '手動新增'} (double-click to rename)`}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditTitleDraft(agent.title || currentTask?.title || '');
                            setEditingTitleId(agent.id);
                          }}
                        >
                          {agent.title || currentTask?.title || '手動新增'}
                        </div>
                      )}
                    </div>
                    {/* Delete button (non-running only) */}
                    {agent.status !== 'running' && (
                      confirmDeleteAgentId === agent.id ? (
                        <div className="relative z-20 flex items-center gap-1 flex-shrink-0 ml-2" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => { handleDeleteAgent(agent.id); setConfirmDeleteAgentId(null); }}
                            className="text-[10px] text-red-400 hover:text-red-300 font-semibold px-1.5 py-0.5 bg-red-500/20 hover:bg-red-500/30 rounded whitespace-nowrap transition-colors"
                          >
                            刪除
                          </button>
                          <button
                            onClick={() => setConfirmDeleteAgentId(null)}
                            className="text-[10px] text-muted-foreground hover:text-foreground px-1 py-0.5 transition-colors"
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteAgentId(agent.id); }}
                          className="flex-shrink-0 ml-2 p-1 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-all"
                          title="Remove agent"
                        >
                          <IconTrash className="w-3.5 h-3.5" />
                        </button>
                      )
                    )}
                  </div>

                  {/* Row 3: phase text + source badge */}
                  <div className="flex items-center gap-1">
                    {agentProgress?.currentPhase && agent.status === 'running' ? (
                      <span className="text-[10px] text-primary/70 truncate flex-1 font-medium" title={agentProgress.currentPhase}>
                        {agentProgress.currentPhase}
                      </span>
                    ) : currentTask && (
                      <div className="flex items-center gap-1">
                        {currentTask.source === 'asana' && (
                          <span className="text-[8px] px-1 rounded bg-orange-500/15 text-orange-400 font-medium">Asana</span>
                        )}
                        {currentTask.source === 'manual' && (
                          <span className="text-[8px] px-1 rounded bg-muted text-muted-foreground font-medium">Manual</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Resume button for error + sessionId */}
                  {canResume && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        client?.send({
                          type: 'agent.resume',
                          id: crypto.randomUUID(),
                          timestamp: new Date().toISOString(),
                          payload: { agentId: agent.id },
                        });
                        addToast({ type: 'info', title: 'Resuming agent...' });
                      }}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 rounded hover:bg-amber-500/20 transition-colors mt-1"
                    >
                      <IconPlay className="w-3 h-3" />
                      Resume
                    </button>
                  )}
                </div>
              );
            })}

            {agents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <span className="text-2xl mb-2 opacity-30">🤖</span>
                <span className="text-xs">No agents yet</span>
              </div>
            )}
          </div>

          {/* Add Agent button at bottom */}
          <button
            onClick={() => setRightPanel({ mode: 'add-agent' })}
            className={`flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium border-t border-border transition-colors
              ${rightPanel.mode === 'add-agent'
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              }
            `}
          >
            <IconPlus className="w-3.5 h-3.5" />
            Add Agent
          </button>
        </div>

        {/* ─── Right: Terminal or Add Agent form ─── */}
        <div className="flex-1 min-w-0">
          {rightPanel.mode === 'terminal' && selectedAgent ? (
            <TerminalOutput
              key={selectedAgent.id}
              outputs={outputs[selectedAgent.id] || []}
              title={`${selectedAgent.role.charAt(0).toUpperCase() + selectedAgent.role.slice(1)} Agent${selectedAgent.title ? ` — ${selectedAgent.title}` : ''}`}
              role={selectedAgent.role}
              status={selectedAgent.status}
              agentId={selectedAgent.id}
              model={selectedAgent.model}
              totalInputTokens={selectedAgent.totalInputTokens}
              totalOutputTokens={selectedAgent.totalOutputTokens}
              onSendCommand={handleSendCommand}
              onAction={handleAgentAction}
            />
          ) : rightPanel.mode === 'add-agent' ? (
            <AddAgentPanel
              addAgentRole={addAgentRole}
              setAddAgentRole={(r) => { setAddAgentRole(r); setAddAgentWorkDirMode('auto'); }}
              addAgentModel={addAgentModel}
              setAddAgentModel={setAddAgentModel}
              addAgentPrompt={addAgentPrompt}
              setAddAgentPrompt={setAddAgentPrompt}
              addAgentWorkDirMode={addAgentWorkDirMode}
              setAddAgentWorkDirMode={setAddAgentWorkDirMode}
              addAgentWorkDir={addAgentWorkDir}
              setAddAgentWorkDir={setAddAgentWorkDir}
              autoResolvedDir={autoResolvedDir}
              addAgentUseSkills={addAgentUseSkills}
              setAddAgentUseSkills={setAddAgentUseSkills}
              addAgentSuperpowers={addAgentSuperpowers}
              setAddAgentSuperpowers={setAddAgentSuperpowers}
              addAgentSpFeatures={addAgentSpFeatures}
              setAddAgentSpFeatures={setAddAgentSpFeatures}
              addAgentUseAxure={addAgentUseAxure}
              setAddAgentUseAxure={setAddAgentUseAxure}
              dbConnectionString={addAgentRole === 'backend' ? project?.dbConnectionString ?? undefined : undefined}
              files={addAgentFiles}
              setFiles={setAddAgentFiles}
              hasSvnConfig={(() => {
                if (!project?.configJson) return false;
                try {
                  const config = JSON.parse(project.configJson);
                  return !!(config?.svnConfig?.frontendSpecPath || config?.svnConfig?.backendSpecPath);
                } catch { return false; }
              })()}
              hasAxshareUrl={(() => {
                if (!project?.configJson) return false;
                try { return !!(JSON.parse(project.configJson)?.axshareUrl); } catch { return false; }
              })()}
              onStart={handleAddAgent}
              onCancel={() => {
                // Go back to terminal or empty
                if (agents.length > 0) {
                  const running = agents.find(a => a.status === 'running');
                  setRightPanel({ mode: 'terminal', agentId: (running || agents[0]).id });
                } else {
                  setRightPanel({ mode: 'empty' });
                }
              }}
            />
          ) : (
            /* Empty state */
            <div className="h-full flex items-center justify-center border border-border rounded-lg">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-muted/50 flex items-center justify-center">
                  <span className="text-muted-foreground/30 text-xl font-mono">&gt;_</span>
                </div>
                <p className="text-sm text-muted-foreground">No agents yet</p>
                <button
                  onClick={() => setRightPanel({ mode: 'add-agent' })}
                  className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                >
                  <IconPlus className="w-3 h-3" />
                  Add Agent
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════
   Add Agent Panel — displayed in the right panel area
   ════════════════════════════════════════════════════════════ */

interface AddAgentPanelProps {
  addAgentRole: string;
  setAddAgentRole: (role: string) => void;
  addAgentModel: string;
  setAddAgentModel: (model: string) => void;
  addAgentPrompt: string;
  setAddAgentPrompt: (prompt: string) => void;
  addAgentWorkDirMode: 'auto' | 'custom';
  setAddAgentWorkDirMode: (mode: 'auto' | 'custom') => void;
  addAgentWorkDir: string;
  setAddAgentWorkDir: (dir: string) => void;
  autoResolvedDir: string;
  addAgentUseSkills: boolean;
  setAddAgentUseSkills: (v: boolean) => void;
  addAgentSuperpowers: boolean;
  setAddAgentSuperpowers: (v: boolean) => void;
  addAgentSpFeatures: SuperpowersFeature[];
  setAddAgentSpFeatures: (f: SuperpowersFeature[]) => void;
  addAgentUseAxure: boolean;
  setAddAgentUseAxure: (v: boolean) => void;
  dbConnectionString?: string;
  files: Array<{ file: File; docType: 'SA' | 'SD' }>;
  setFiles: (files: Array<{ file: File; docType: 'SA' | 'SD' }>) => void;
  hasSvnConfig?: boolean;
  hasAxshareUrl?: boolean;
  onStart: () => void;
  onCancel: () => void;
}

function AddAgentPanel({
  addAgentRole, setAddAgentRole,
  addAgentModel, setAddAgentModel,
  addAgentPrompt, setAddAgentPrompt,
  addAgentWorkDirMode, setAddAgentWorkDirMode,
  addAgentWorkDir, setAddAgentWorkDir,
  autoResolvedDir,
  addAgentUseSkills, setAddAgentUseSkills,
  addAgentSuperpowers, setAddAgentSuperpowers,
  addAgentSpFeatures, setAddAgentSpFeatures,
  addAgentUseAxure, setAddAgentUseAxure,
  dbConnectionString,
  files, setFiles,
  hasSvnConfig,
  hasAxshareUrl,
  onStart, onCancel,
}: AddAgentPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [specUrl, setSpecUrl] = useState('');
  const [backendSpecUrl, setBackendSpecUrl] = useState('');
  const [showSvnBrowser, setShowSvnBrowser] = useState<'frontend' | 'backend' | false>(false);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected) return;
    const newFiles = Array.from(selected).map(f => ({
      file: f,
      docType: f.name.toLowerCase().includes('sa') ? 'SA' as const : 'SD' as const,
    }));
    setFiles([...files, ...newFiles]);
    e.target.value = '';
  };

  return (
    <div className="h-full border border-border rounded-lg flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <IconPlus className="w-5 h-5 text-primary" />
          <span className="text-base font-semibold">Add Agent</span>
        </div>
        <button
          onClick={onCancel}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
        >
          <IconX className="w-4 h-4" />
        </button>
      </div>

      {/* Form body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* Role */}
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Role</label>
          <div className="flex flex-wrap gap-2">
            {[
              { value: 'frontend', label: 'Frontend' },
              { value: 'backend', label: 'Backend' },
              { value: 'devops', label: 'DevOps' },
              { value: 'testing', label: 'Testing' },
              { value: 'review', label: 'Review' },
              { value: 'quick', label: 'Quick' },
            ].map(r => (
              <button
                key={r.value}
                onClick={() => setAddAgentRole(r.value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  addAgentRole === r.value
                    ? `${ROLE_BUTTON[r.value]} ring-1`
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Model</label>
          <div className="flex gap-2">
            {[
              { value: 'sonnet', label: 'Sonnet' },
              { value: 'opus', label: 'Opus' },
              { value: 'haiku', label: 'Haiku' },
            ].map(m => (
              <button
                key={m.value}
                onClick={() => setAddAgentModel(m.value)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  addAgentModel === m.value
                    ? 'bg-primary/20 text-primary ring-1 ring-primary/40'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Working Directory */}
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Working Directory</label>
          <div className="flex gap-2 mb-2">
            <button
              onClick={() => setAddAgentWorkDirMode('auto')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                addAgentWorkDirMode === 'auto' ? 'bg-primary/20 text-primary ring-1 ring-primary/40' : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              Auto
            </button>
            <button
              onClick={() => setAddAgentWorkDirMode('custom')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                addAgentWorkDirMode === 'custom' ? 'bg-primary/20 text-primary ring-1 ring-primary/40' : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              Custom
            </button>
          </div>
          {addAgentWorkDirMode === 'auto' ? (
            <div className="text-sm text-muted-foreground bg-muted/50 border border-border/50 rounded-lg px-3 py-2 font-mono truncate">
              {autoResolvedDir || '(project root)'}
            </div>
          ) : (
            <FolderPicker value={addAgentWorkDir} onChange={setAddAgentWorkDir} />
          )}
        </div>

        {/* DB connection hint for backend */}
        {addAgentRole === 'backend' && dbConnectionString && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-500/5 border border-purple-500/15 text-sm text-purple-400">
            <span className="font-medium">DB</span>
            <span className="text-muted-foreground font-mono truncate">{dbConnectionString}</span>
            <span className="text-muted-foreground ml-auto flex-shrink-0">(auto-injected)</span>
          </div>
        )}

        {/* Instructions */}
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Instructions</label>
          <textarea
            value={addAgentPrompt}
            onChange={(e) => setAddAgentPrompt(e.target.value)}
            placeholder="Describe what this agent should do..."
            className="w-full bg-muted border border-border rounded-lg px-4 py-3 text-sm min-h-[120px] resize-y focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
          />
        </div>

        {/* Spec Source — Frontend */}
        {hasSvnConfig && (
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">前端 Spec Source</label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={specUrl}
                onChange={(e) => setSpecUrl(e.target.value)}
                placeholder="前端 spec URL / path"
                className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-blue-500/50 focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowSvnBrowser('frontend')}
                className="px-3 py-2 text-sm font-medium rounded-lg border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors flex-shrink-0"
                title="Browse frontend SVN specs"
              >
                SVN
              </button>
              {specUrl && (
                <button type="button" onClick={() => setSpecUrl('')} className="px-1 text-muted-foreground hover:text-red-400 transition-colors">
                  <IconX className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Spec Source — Backend */}
        {hasSvnConfig && (
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">後端 Spec Source</label>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={backendSpecUrl}
                onChange={(e) => setBackendSpecUrl(e.target.value)}
                placeholder="後端 spec URL / path"
                className="flex-1 bg-muted border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500"
              />
              <button
                type="button"
                onClick={() => setShowSvnBrowser('backend')}
                className="px-3 py-2 text-sm font-medium rounded-lg border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 transition-colors flex-shrink-0"
                title="Browse backend SVN specs"
              >
                SVN
              </button>
              {backendSpecUrl && (
                <button type="button" onClick={() => setBackendSpecUrl('')} className="px-1 text-muted-foreground hover:text-red-400 transition-colors">
                  <IconX className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Fallback: single spec input if no SVN configured */}
        {!hasSvnConfig && (
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-2">Spec Source</label>
            <input
              type="text"
              value={specUrl}
              onChange={(e) => setSpecUrl(e.target.value)}
              placeholder="HTTP URL / local path"
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary"
            />
          </div>
        )}

        {/* Spec / Document upload */}
        <div>
          <label className="block text-sm font-medium text-muted-foreground mb-2">Documents (SA/SD)</label>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.md,.txt,.docx,.png,.jpg,.jpeg"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border border-dashed border-border rounded-lg text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/5 transition-colors"
          >
            <IconUpload className="w-4 h-4" />
            Upload Files
          </button>
          {files.length > 0 && (
            <div className="mt-2 space-y-1">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 rounded-lg text-sm">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    f.docType === 'SA' ? 'bg-blue-500/15 text-blue-400' : 'bg-green-500/15 text-green-400'
                  }`}>
                    {f.docType}
                  </span>
                  <span className="text-foreground truncate flex-1">{f.file.name}</span>
                  <button
                    onClick={() => {
                      const updated = [...files];
                      updated.splice(i, 1);
                      setFiles(updated);
                    }}
                    className="p-0.5 text-muted-foreground hover:text-red-400 transition-colors"
                  >
                    <IconX className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Options */}
        <div className="space-y-2.5">
          <label className="flex items-center gap-2.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addAgentUseSkills}
              onChange={(e) => setAddAgentUseSkills(e.target.checked)}
              className="rounded border-border accent-primary w-4 h-4"
            />
            Workspace Skills (CLAUDE.md)
          </label>
          <label className="flex items-center gap-2.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addAgentSuperpowers}
              onChange={(e) => setAddAgentSuperpowers(e.target.checked)}
              className="rounded border-border accent-primary w-4 h-4"
            />
            Superpowers Methodology
          </label>
          {hasAxshareUrl && (
            <label className="flex items-center gap-2.5 text-sm text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={addAgentUseAxure}
                onChange={(e) => setAddAgentUseAxure(e.target.checked)}
                className="rounded border-border accent-primary w-4 h-4"
              />
              使用 Axure 原型內容
            </label>
          )}
        </div>

        {addAgentSuperpowers && (
          <div className="flex gap-2">
            {([
              { id: 'brainstorm' as const, label: 'Brainstorm', colors: 'bg-purple-500/20 text-purple-400 ring-purple-500/40' },
              { id: 'tdd' as const, label: 'TDD', colors: 'bg-blue-500/20 text-blue-400 ring-blue-500/40' },
              { id: 'debugging' as const, label: 'Debugging', colors: 'bg-red-500/20 text-red-400 ring-red-500/40' },
            ]).map(({ id, label, colors }) => {
              const isOn = addAgentSpFeatures.includes(id);
              return (
                <button
                  key={id}
                  onClick={() => {
                    if (isOn) {
                      setAddAgentSpFeatures(addAgentSpFeatures.filter(f => f !== id));
                    } else {
                      setAddAgentSpFeatures([...addAgentSpFeatures, id]);
                    }
                  }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    isOn ? `${colors} ring-1` : 'bg-muted text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer with Start button */}
      <div className="px-5 py-4 border-t border-border">
        <button
          onClick={onStart}
          disabled={!addAgentPrompt.trim()}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
        >
          <IconPlay className="w-4 h-4" />
          Start Agent{files.length > 0 ? ` (${files.length} files)` : ''}
        </button>
      </div>

      {/* SVN Browser modal */}
      {showSvnBrowser && (
        <SvnBrowser
          lockedSpecType={showSvnBrowser}
          onSelect={(url) => {
            if (showSvnBrowser === 'backend') {
              setBackendSpecUrl(url);
            } else {
              setSpecUrl(url);
            }
            setShowSvnBrowser(false);
          }}
          onClose={() => setShowSvnBrowser(false)}
        />
      )}
    </div>
  );
}
