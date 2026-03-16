import { useState, useCallback, useRef, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { DualTerminal } from './DualTerminal';
import { DocumentUpload } from '../project/DocumentUpload';
import { PlanPanel } from './PlanPanel';
import { FolderPicker } from '../project/FolderPicker';
import { IconStop, IconPlay, IconPlus, IconX, IconGrid } from '../ui/Icons';
import type { DocType, Workspace, SuperpowersFeature } from '@omni/shared';
import type { View } from '../layout/AppShell';

/* ─── Role accent colors for left bar ─── */
const ROLE_ACCENT: Record<string, string> = {
  frontend: 'before:bg-blue-500',
  backend: 'before:bg-purple-500',
  master: 'before:bg-yellow-500',
  architect: 'before:bg-orange-500',
  devops: 'before:bg-green-500',
  testing: 'before:bg-teal-500',
  review: 'before:bg-gray-500',
  quick: 'before:bg-amber-500',
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

interface DashboardProps {
  onViewChange: (view: View) => void;
}

export function Dashboard({ onViewChange }: DashboardProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const allAgents = useProjectStore(s => s.agents);
  const documents = useProjectStore(s => s.documents);
  const plans = useProjectStore(s => s.plans);
  const outputs = useAgentStore(s => s.outputs);

  // Only show agents for the current project
  const agents = currentProjectId
    ? allAgents.filter(a => a.projectId === currentProjectId)
    : allAgents;
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [showNewExecution, setShowNewExecution] = useState(false);
  const [newRequirement, setNewRequirement] = useState('');
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addAgentRole, setAddAgentRole] = useState('backend');
  const [addAgentPrompt, setAddAgentPrompt] = useState('');
  const [addAgentModel, setAddAgentModel] = useState('sonnet');
  const [addAgentWorkDir, setAddAgentWorkDir] = useState('');
  const [addAgentUseSkills, setAddAgentUseSkills] = useState(true);
  const [addAgentSuperpowers, setAddAgentSuperpowers] = useState(false);
  const [addAgentSpFeatures, setAddAgentSpFeatures] = useState<SuperpowersFeature[]>(['brainstorm', 'tdd', 'debugging']);
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('sonnet');
  const [showPlanPanel, setShowPlanPanel] = useState(true);

  // Document upload state
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showDocDropdown, setShowDocDropdown] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docDropdownRef = useRef<HTMLDivElement>(null);

  // Check for focusAgentId from sessionStorage (set by Sidebar when clicking active agent)
  useEffect(() => {
    const storedAgentId = sessionStorage.getItem('focusAgentId');
    if (storedAgentId) {
      setFocusAgentId(storedAgentId);
      sessionStorage.removeItem('focusAgentId'); // Clear after reading
    }
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (docDropdownRef.current && !docDropdownRef.current.contains(e.target as Node)) {
        setShowDocDropdown(false);
      }
    }
    if (showDocDropdown) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showDocDropdown]);

  // Auto-detect docType from filename (looks for SA or SD in filename)
  const detectDocType = (filename: string): DocType => {
    const upper = filename.toUpperCase();
    if (upper.includes('SA') || upper.includes('系統分析') || upper.includes('需求')) return 'SA';
    return 'SD'; // Default to SD
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentProjectId || !client) return;

    setIsUploading(true);
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const detectedType = detectDocType(file.name);
      client.send({
        type: 'project.uploadDocument',
        payload: {
          projectId: currentProjectId,
          filename: file.name,
          content: base64,
          fileType: 'base64',
          docType: detectedType,
        },
      });

      // Refresh project state to get updated documents
      setTimeout(() => {
        client.send({
          type: 'project.getState',
          payload: { projectId: currentProjectId },
        });
      }, 500);

      setShowUploadDialog(false);
      addToast({ type: 'success', title: 'Document uploaded', message: file.name });
    } catch (err) {
      console.error('Failed to upload file:', err);
      addToast({ type: 'error', title: 'Upload failed' });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const project = projects.find(p => p.id === currentProjectId);

  // Extract workspaces from project config
  const projectWorkspaces: Workspace[] = (() => {
    if (!project?.configJson) return [];
    try {
      const cfg = JSON.parse(project.configJson) as { workspaces?: Workspace[] };
      return cfg.workspaces || [];
    } catch { return []; }
  })();


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

  const handleNewExecution = useCallback(() => {
    if (!currentProjectId) return;
    client?.send({
      type: 'project.startExecution',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        requirement: newRequirement.trim() || undefined,
        model: selectedModel,
      },
    });
    addToast({ type: 'info', title: 'New execution started', message: `Using ${selectedModel} model...` });
    setShowNewExecution(false);
    setNewRequirement('');
  }, [currentProjectId, client, addToast, newRequirement, selectedModel]);

  const handleDeleteAgent = useCallback((agentId: string) => {
    client?.send({
      type: 'agent.delete',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId },
    });
    if (focusAgentId === agentId) setFocusAgentId(null);
    addToast({ type: 'success', title: 'Agent removed' });
  }, [client, addToast, focusAgentId]);

  const handleAddAgent = useCallback(() => {
    if (!currentProjectId || !addAgentPrompt.trim()) return;
    client?.send({
      type: 'agent.add',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        role: addAgentRole,
        prompt: addAgentPrompt.trim(),
        model: addAgentModel,
        workingDir: addAgentWorkDir || undefined,
        useWorkspaceSkills: addAgentUseSkills,
        superpowersFeatures: addAgentSuperpowers ? addAgentSpFeatures : undefined,
      },
    });
    addToast({ type: 'info', title: 'Agent added', message: `Starting ${addAgentRole} agent (${addAgentModel})...` });
    setShowAddAgent(false);
    setAddAgentPrompt('');
    setAddAgentWorkDir('');
  }, [currentProjectId, client, addToast, addAgentRole, addAgentPrompt, addAgentModel, addAgentWorkDir, addAgentUseSkills, addAgentSuperpowers, addAgentSpFeatures]);

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
            Create a new project to start orchestrating AI agents, or select an existing one from the sidebar.
          </p>
          <button
            onClick={() => onViewChange('setup')}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
          >
            <IconPlus className="w-4 h-4" />
            Create New Project
          </button>
        </div>
      </div>
    );
  }

  const runningAgents = agents.filter(a => a.status === 'running');

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* ─── Project overview header with stats ─── */}
      <div className="bg-card border border-border rounded-lg p-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="text-sm font-bold">{project.name}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  project.status === 'executing' ? 'bg-green-500/15 text-green-400' :
                  project.status === 'completed' ? 'bg-blue-500/15 text-blue-400' :
                  project.status === 'failed' ? 'bg-red-500/15 text-red-400' :
                  'bg-muted text-muted-foreground'
                }`}>
                  {project.status}
                </span>
                <span className="text-[10px] text-muted-foreground">{project.mode} mode</span>
              </div>
            </div>

            {/* Documents dropdown */}
            <div className="relative" ref={docDropdownRef}>
              <button
                onClick={() => setShowDocDropdown(!showDocDropdown)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  documents.length > 0
                    ? 'bg-cyan-500/15 text-cyan-400 hover:bg-cyan-500/25'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                <span>{documents.length > 0 ? `${documents.length} Specs` : 'No Specs'}</span>
                <svg className={`w-4 h-4 transition-transform ${showDocDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {showDocDropdown && (
                <div className="absolute top-full mt-1 left-0 z-50 w-[420px] bg-card border border-border rounded-lg shadow-xl p-3">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold text-foreground">Reference Documents</span>
                    <button
                      onClick={() => { setShowDocDropdown(false); setShowUploadDialog(true); }}
                      className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      <IconPlus className="w-3 h-3" />
                      Add
                    </button>
                  </div>

                  {documents.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4 text-center">
                      No documents imported yet
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto space-y-1.5">
                      {documents.map(doc => (
                        <div
                          key={doc.id}
                          title={doc.filename}
                          className="flex items-center gap-2.5 px-3 py-2 hover:bg-muted rounded-md group"
                        >
                          <span className={`text-sm px-2 py-0.5 rounded font-bold flex-shrink-0 ${
                            doc.docType === 'SA' ? 'bg-green-500/20 text-green-400' : 'bg-purple-500/20 text-purple-400'
                          }`}>
                            {doc.docType}
                          </span>
                          <span className="text-sm text-foreground truncate flex-1">{doc.filename}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (currentProjectId && client) {
                                client.send({
                                  type: 'project.deleteDocument',
                                  id: crypto.randomUUID(),
                                  timestamp: new Date().toISOString(),
                                  payload: { projectId: currentProjectId, documentId: doc.id },
                                });
                                addToast({ type: 'success', title: 'Document removed', message: doc.filename });
                              }
                            }}
                            className="p-1 rounded text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                            title="Remove document"
                          >
                            <IconX className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            </div>

          <div className="flex items-center gap-3">
            {/* Stat cards */}
            <div className="flex items-center gap-2">
              <StatCard
                icon={<span className="text-xs">A</span>}
                label="Agents"
                value={`${runningAgents.length}/${agents.length}`}
                accent={runningAgents.length > 0 ? 'text-green-400' : undefined}
              />
            </div>

            {/* Actions */}
            {runningAgents.length > 0 && (
              <button
                onClick={handleStopAll}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors"
              >
                <IconStop className="w-3 h-3" />
                Stop All
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ─── New Execution panel ─── */}
      {runningAgents.length === 0 && agents.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-3">
          {!showNewExecution ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">All agents have finished</p>
                <p className="text-xs text-muted-foreground">Upload new documents and start a new execution round</p>
              </div>
              <button
                onClick={() => {
                  // Clear old documents before new execution round
                  if (currentProjectId) {
                    client?.send({
                      type: 'project.clearDocuments',
                      id: crypto.randomUUID(),
                      timestamp: new Date().toISOString(),
                      payload: { projectId: currentProjectId },
                    });
                  }
                  setShowNewExecution(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
              >
                <IconPlay className="w-3.5 h-3.5" />
                New Execution
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">New Execution Round</h3>
                <button
                  onClick={() => setShowNewExecution(false)}
                  className="px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                >
                  Cancel
                </button>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Requirement / Instructions</label>
                <textarea
                  value={newRequirement}
                  onChange={(e) => setNewRequirement(e.target.value)}
                  placeholder="Describe what you want the agents to implement this round..."
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[80px] resize-y focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
                />
              </div>
              <DocumentUpload projectId={currentProjectId} />
              {/* Model Selection */}
              <div>
                <label className="block text-xs font-medium mb-1">Model</label>
                <div className="flex gap-1.5">
                  {(['sonnet', 'opus', 'haiku'] as const).map((model) => (
                    <button
                      key={model}
                      onClick={() => setSelectedModel(model)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        selectedModel === model
                          ? model === 'opus'
                            ? 'bg-purple-500/20 text-purple-400 border border-purple-500/50'
                            : model === 'haiku'
                              ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                              : 'bg-blue-500/20 text-blue-400 border border-blue-500/50'
                          : 'bg-muted text-muted-foreground border border-border hover:border-primary/50'
                      }`}
                    >
                      {model.charAt(0).toUpperCase() + model.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-3 pt-2 border-t border-border">
                <button
                  onClick={handleNewExecution}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold bg-green-600 hover:bg-green-500 text-white rounded-lg shadow-lg shadow-green-600/20 hover:shadow-green-500/30 transition-all"
                >
                  <IconPlay className="w-3.5 h-3.5" />
                  Start Execution
                </button>
                <p className="text-[10px] text-muted-foreground">
                  Previous documents cleared — only new uploads will be used
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Plan approval panel ─── */}
      {plans.length > 0 && showPlanPanel && (
        <PlanPanel onClose={() => setShowPlanPanel(false)} />
      )}

      {/* ─── Plan panel toggle (when hidden but plans exist) ─── */}
      {plans.length > 0 && !showPlanPanel && (
        <button
          onClick={() => setShowPlanPanel(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-muted/50 hover:bg-muted border border-border rounded-lg text-sm transition-colors"
        >
          <span>📋</span>
          <span className="font-medium">Show Plans</span>
          {plans.filter(p => p.status === 'pending').length > 0 && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-400 animate-pulse">
              {plans.filter(p => p.status === 'pending').length}
            </span>
          )}
        </button>
      )}

      {/* ─── Agent summary cards ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {agents.map(agent => {
          const agentOutputs = outputs[agent.id] || [];
          const toolCalls = agentOutputs.filter(o => o.streamType === 'tool_use').length;
          const isFocused = focusAgentId === agent.id;

          return (
            <div
              key={agent.id}
              className={`relative text-left bg-card border border-border rounded-lg p-3 pl-4 transition-all hover:bg-muted/50 hover:scale-[1.02] cursor-pointer overflow-hidden
                before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1 before:rounded-l-lg
                ${ROLE_ACCENT[agent.role] || 'before:bg-gray-500'}
                ${agent.status === 'running' ? 'before:shadow-[0_0_8px_rgba(34,197,94,0.3)]' : ''}
                ${isFocused ? 'ring-1 ring-primary' : ''}
              `}
              onClick={() => setFocusAgentId(isFocused ? null : agent.id)}
            >
              {/* Delete button — always visible for non-running agents */}
              {agent.status !== 'running' && (
                confirmDeleteAgentId === agent.id ? (
                  <div className="absolute top-1 right-1 flex items-center gap-0.5 animate-fade-in" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => { handleDeleteAgent(agent.id); setConfirmDeleteAgentId(null); }}
                      className="text-[9px] text-red-400 hover:text-red-300 font-semibold px-1.5 py-0.5 bg-red-500/20 rounded"
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmDeleteAgentId(null)}
                      className="text-[9px] text-muted-foreground hover:text-foreground px-1 py-0.5"
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDeleteAgentId(agent.id); }}
                    className="absolute top-1.5 right-1.5 p-0.5 rounded text-muted-foreground/40 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    title="Remove agent"
                  >
                    <IconX className="w-3 h-3" />
                  </button>
                )
              )}
              <div className="flex items-center justify-between mb-1.5">
                <span className={`text-[10px] font-bold capitalize px-1.5 py-0.5 rounded ${
                  ROLE_BG[agent.role] || 'bg-muted text-muted-foreground'
                }`}>
                  {agent.role}
                </span>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  agent.status === 'running' ? 'bg-green-500 animate-breathe' :
                  agent.status === 'error' ? 'bg-red-500' :
                  agent.status === 'stopped' ? 'bg-gray-500' :
                  'bg-yellow-500'
                }`} />
              </div>
              <div className="text-[10px] text-muted-foreground space-y-0.5">
                <div className="flex justify-between">
                  <span className={
                    agent.status === 'running' ? 'text-green-400' :
                    agent.status === 'error' ? 'text-red-400' :
                    ''
                  }>
                    {agent.status}
                  </span>
                  <span>{toolCalls} tools</span>
                </div>
              </div>
            </div>
          );
        })}

        {/* Add Agent card */}
        {!showAddAgent ? (
          <button
            onClick={() => setShowAddAgent(true)}
            className="border border-dashed border-border rounded-lg p-3 text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/5 transition-all flex items-center justify-center gap-1.5 text-xs"
          >
            <IconPlus className="w-3.5 h-3.5" />
            Add Agent
          </button>
        ) : (
          <div className="border border-border rounded-lg p-3 col-span-2 space-y-2 animate-fade-in">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Add Agent</span>
              <button
                onClick={() => setShowAddAgent(false)}
                className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <IconX className="w-3 h-3" />
              </button>
            </div>
            {/* Role & Model */}
            <div className="flex gap-2">
              <select
                value={addAgentRole}
                onChange={(e) => setAddAgentRole(e.target.value)}
                className="flex-1 bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
              >
                <option value="frontend">Frontend</option>
                <option value="backend">Backend</option>
                <option value="devops">DevOps</option>
                <option value="testing">Testing</option>
                <option value="review">Review</option>
                <option value="quick">Quick Task</option>
              </select>
              <select
                value={addAgentModel}
                onChange={(e) => setAddAgentModel(e.target.value)}
                className="w-24 bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
              >
                <option value="sonnet">Sonnet</option>
                <option value="opus">Opus</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
            {/* Working Directory */}
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1">Working Directory</label>
              {projectWorkspaces.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1.5">
                  <button
                    onClick={() => setAddAgentWorkDir('')}
                    className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                      addAgentWorkDir === '' ? 'bg-primary/20 text-primary ring-1 ring-primary/40' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    Auto
                  </button>
                  {projectWorkspaces.map((ws, i) => (
                    <button
                      key={i}
                      onClick={() => setAddAgentWorkDir(ws.path)}
                      className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                        addAgentWorkDir === ws.path ? 'bg-primary/20 text-primary ring-1 ring-primary/40' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                      }`}
                      title={ws.path}
                    >
                      {ws.label || ws.path}
                    </button>
                  ))}
                </div>
              )}
              <FolderPicker
                value={addAgentWorkDir}
                onChange={setAddAgentWorkDir}
              />
            </div>
            {/* Prompt */}
            <textarea
              value={addAgentPrompt}
              onChange={(e) => setAddAgentPrompt(e.target.value)}
              placeholder="Prompt / instructions for this agent..."
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs min-h-[60px] resize-y focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
            />
            {/* Options */}
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={addAgentUseSkills}
                  onChange={(e) => setAddAgentUseSkills(e.target.checked)}
                  className="rounded border-border accent-primary w-3 h-3"
                />
                Workspace Skills (CLAUDE.md)
              </label>
              <div>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={addAgentSuperpowers}
                    onChange={(e) => setAddAgentSuperpowers(e.target.checked)}
                    className="rounded border-border accent-primary w-3 h-3"
                  />
                  Superpowers Methodology
                </label>
                {addAgentSuperpowers && (
                  <div className="flex gap-1 mt-1 ml-5">
                    {([
                      { id: 'brainstorm' as const, label: 'Brainstorm' },
                      { id: 'tdd' as const, label: 'TDD' },
                      { id: 'debugging' as const, label: 'Debugging' },
                    ]).map(({ id, label }) => {
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
                          className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                            isOn ? 'bg-purple-500/20 text-purple-400 ring-1 ring-purple-500/40' : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={handleAddAgent}
              disabled={!addAgentPrompt.trim()}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
            >
              <IconPlay className="w-3 h-3" />
              Start Agent
            </button>
          </div>
        )}
      </div>

      {/* ─── Terminal area ─── */}
      <div className="flex-1 min-h-0">
        <DualTerminal focusAgentId={focusAgentId} />
      </div>

      {/* Upload dialog modal */}
      {showUploadDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-xl p-4 w-80">
            <h3 className="text-sm font-semibold mb-2">Add Spec Document</h3>
            <p className="text-xs text-muted-foreground mb-3">
              檔名包含 SA 會標記為系統分析，否則標記為 SD
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.md,.txt"
              onChange={handleFileUpload}
              className="hidden"
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="w-full py-3 border-2 border-dashed border-border rounded-lg
                         text-sm text-muted-foreground hover:border-primary hover:text-primary
                         transition-colors disabled:opacity-50"
            >
              {isUploading ? 'Uploading...' : 'Click to select file'}
            </button>

            <div className="flex justify-end mt-3">
              <button
                onClick={() => setShowUploadDialog(false)}
                className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Stat card helper ─── */
function StatCard({ icon, label, value, accent }: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-muted/50">
      <span className={`${accent || 'text-muted-foreground'}`}>{icon}</span>
      <div>
        <div className={`text-xs font-mono font-bold leading-tight ${accent || 'text-foreground'}`}>{value}</div>
        <div className="text-[10px] text-muted-foreground leading-tight">{label}</div>
      </div>
    </div>
  );
}
