import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { DualTerminal } from './DualTerminal';
import { StepTracker } from './StepTracker';
import { DocumentUpload } from '../project/DocumentUpload';
import { IconStop, IconPlay, IconPlus, IconX, IconGrid, IconClock } from '../ui/Icons';
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
};

const ROLE_BG: Record<string, string> = {
  frontend: 'bg-blue-500/10 text-blue-400',
  backend: 'bg-purple-500/10 text-purple-400',
  master: 'bg-yellow-500/10 text-yellow-400',
  architect: 'bg-orange-500/10 text-orange-400',
  devops: 'bg-green-500/10 text-green-400',
  testing: 'bg-teal-500/10 text-teal-400',
  review: 'bg-gray-500/10 text-gray-400',
};

interface DashboardProps {
  onViewChange: (view: View) => void;
}

export function Dashboard({ onViewChange }: DashboardProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const allAgents = useProjectStore(s => s.agents);
  const outputs = useAgentStore(s => s.outputs);

  // Only show agents for the current project
  const agents = currentProjectId
    ? allAgents.filter(a => a.projectId === currentProjectId)
    : allAgents;
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [elapsed, setElapsed] = useState('00:00');
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [showNewExecution, setShowNewExecution] = useState(false);
  const [newRequirement, setNewRequirement] = useState('');
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addAgentRole, setAddAgentRole] = useState('backend');
  const [addAgentPrompt, setAddAgentPrompt] = useState('');
  const [confirmDeleteAgentId, setConfirmDeleteAgentId] = useState<string | null>(null);

  const project = projects.find(p => p.id === currentProjectId);

  // Elapsed time counter
  useEffect(() => {
    if (!project) return;
    const dateStr = project.createdAt.endsWith('Z') ? project.createdAt : project.createdAt + 'Z';
    const start = new Date(dateStr).getTime();
    const interval = setInterval(() => {
      const diff = Date.now() - start;
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      setElapsed(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [project]);

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
      },
    });
    addToast({ type: 'info', title: 'New execution started', message: 'Agents are being spawned...' });
    setShowNewExecution(false);
    setNewRequirement('');
  }, [currentProjectId, client, addToast, newRequirement]);

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
      },
    });
    addToast({ type: 'info', title: 'Agent added', message: `Starting ${addAgentRole} agent...` });
    setShowAddAgent(false);
    setAddAgentPrompt('');
  }, [currentProjectId, client, addToast, addAgentRole, addAgentPrompt]);

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
  const totalCost = agents.reduce((sum, a) => sum + a.totalCostUsd, 0);
  const totalTurns = agents.reduce((sum, a) => sum + a.totalTurns, 0);

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
          </div>

          <div className="flex items-center gap-3">
            {/* Stat cards */}
            <div className="flex items-center gap-2">
              <StatCard icon={<IconClock className="w-3.5 h-3.5" />} label="Elapsed" value={elapsed} />
              <StatCard
                icon={<span className="text-xs">A</span>}
                label="Agents"
                value={`${runningAgents.length}/${agents.length}`}
                accent={runningAgents.length > 0 ? 'text-green-400' : undefined}
              />
              <StatCard icon={<span className="text-xs font-mono">$</span>} label="Cost" value={`$${totalCost.toFixed(4)}`} />
              <StatCard icon={<span className="text-xs">T</span>} label="Turns" value={String(totalTurns)} />
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

      {/* ─── Step tracker ─── */}
      <StepTracker />

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
                  <span className="font-mono">${agent.totalCostUsd.toFixed(4)}</span>
                </div>
                <div className="flex justify-between">
                  <span>{toolCalls} tools</span>
                  <span>{agent.totalTurns} turns</span>
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
            <select
              value={addAgentRole}
              onChange={(e) => setAddAgentRole(e.target.value)}
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
            >
              <option value="frontend">Frontend</option>
              <option value="backend">Backend</option>
              <option value="devops">DevOps</option>
              <option value="testing">Testing</option>
              <option value="review">Review</option>
            </select>
            <textarea
              value={addAgentPrompt}
              onChange={(e) => setAddAgentPrompt(e.target.value)}
              placeholder="Prompt / instructions for this agent..."
              className="w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs min-h-[60px] resize-y focus:ring-1 focus:ring-primary/50 focus:border-primary outline-none"
            />
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
