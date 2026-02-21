import { useState, useEffect, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { DualTerminal } from './DualTerminal';
import { StepTracker } from './StepTracker';
import { InterventionBell } from './InterventionBell';
import { DocumentUpload } from '../project/DocumentUpload';

const ROLE_COLORS: Record<string, string> = {
  frontend: 'border-blue-500/40',
  backend: 'border-purple-500/40',
  master: 'border-yellow-500/40',
  architect: 'border-orange-500/40',
  devops: 'border-green-500/40',
  testing: 'border-teal-500/40',
  review: 'border-gray-500/40',
};

const ROLE_BG: Record<string, string> = {
  frontend: 'bg-blue-500/10',
  backend: 'bg-purple-500/10',
  master: 'bg-yellow-500/10',
  architect: 'bg-orange-500/10',
  devops: 'bg-green-500/10',
  testing: 'bg-teal-500/10',
  review: 'bg-gray-500/10',
};

export function Dashboard() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const agents = useProjectStore(s => s.agents);
  const outputs = useAgentStore(s => s.outputs);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [elapsed, setElapsed] = useState('00:00');
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [showNewExecution, setShowNewExecution] = useState(false);
  const [newRequirement, setNewRequirement] = useState('');
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [addAgentRole, setAddAgentRole] = useState('backend');
  const [addAgentPrompt, setAddAgentPrompt] = useState('');

  const project = projects.find(p => p.id === currentProjectId);

  // Elapsed time counter
  useEffect(() => {
    if (!project) return;
    // SQLite datetime('now') is UTC but missing 'Z' suffix; append it
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

  if (!currentProjectId || !project) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <div className="text-4xl mb-4">🤖</div>
          <p className="text-lg">No project selected</p>
          <p className="text-sm mt-2">Create a new project or select one from the sidebar</p>
        </div>
      </div>
    );
  }

  const runningAgents = agents.filter(a => a.status === 'running');
  const totalCost = agents.reduce((sum, a) => sum + a.totalCostUsd, 0);
  const totalTurns = agents.reduce((sum, a) => sum + a.totalTurns, 0);

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Project overview header */}
      <div className="bg-card border border-border rounded-lg p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-sm font-bold">{project.name}</h2>
              <div className="flex items-center gap-3 mt-0.5">
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  project.status === 'executing' ? 'bg-green-500/20 text-green-400' :
                  project.status === 'completed' ? 'bg-blue-500/20 text-blue-400' :
                  project.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                  'bg-muted text-muted-foreground'
                }`}>
                  {project.status}
                </span>
                <span className="text-xs text-muted-foreground">{project.mode} mode</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6">
            {/* Stats */}
            <div className="flex items-center gap-4 text-xs">
              <div className="text-center">
                <div className="text-foreground font-mono font-bold">{elapsed}</div>
                <div className="text-muted-foreground">elapsed</div>
              </div>
              <div className="text-center">
                <div className="text-foreground font-mono font-bold">{runningAgents.length}/{agents.length}</div>
                <div className="text-muted-foreground">agents</div>
              </div>
              <div className="text-center">
                <div className="text-foreground font-mono font-bold">${totalCost.toFixed(4)}</div>
                <div className="text-muted-foreground">cost</div>
              </div>
              <div className="text-center">
                <div className="text-foreground font-mono font-bold">{totalTurns}</div>
                <div className="text-muted-foreground">turns</div>
              </div>
            </div>
            {/* Quick actions */}
            <div className="flex items-center gap-2">
              {runningAgents.length > 0 && (
                <button
                  onClick={handleStopAll}
                  className="px-2.5 py-1 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors"
                >
                  Stop All
                </button>
              )}
              <InterventionBell />
            </div>
          </div>
        </div>
      </div>

      {/* Step tracker */}
      <StepTracker />

      {/* New Execution panel — visible when no agents are running */}
      {runningAgents.length === 0 && agents.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-3">
          {!showNewExecution ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">All agents have finished</p>
                <p className="text-xs text-muted-foreground">Upload new documents and start a new execution round</p>
              </div>
              <button
                onClick={() => setShowNewExecution(true)}
                className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
              >
                New Execution
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">New Execution Round</h3>
                <button
                  onClick={() => setShowNewExecution(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
              {/* Requirement input */}
              <div>
                <label className="block text-xs font-medium mb-1">Requirement / Instructions</label>
                <textarea
                  value={newRequirement}
                  onChange={(e) => setNewRequirement(e.target.value)}
                  placeholder="Describe what you want the agents to implement this round..."
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[80px] resize-y"
                />
              </div>

              <DocumentUpload projectId={currentProjectId} />
              <div className="flex gap-2 pt-2 border-t border-border">
                <button
                  onClick={handleNewExecution}
                  className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
                >
                  Start Execution (with all documents)
                </button>
                <p className="text-[10px] text-muted-foreground self-center">
                  Uses all previously uploaded + new documents
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Agent summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
        {agents.map(agent => {
          const agentOutputs = outputs[agent.id] || [];
          const toolCalls = agentOutputs.filter(o => o.streamType === 'tool_use').length;
          const isFocused = focusAgentId === agent.id;

          return (
            <div
              key={agent.id}
              className={`group relative text-left bg-card border rounded-lg p-2.5 transition-all hover:bg-muted/50 cursor-pointer ${
                ROLE_COLORS[agent.role] || 'border-border'
              } ${isFocused ? 'ring-1 ring-primary' : ''}`}
              onClick={() => setFocusAgentId(isFocused ? null : agent.id)}
            >
              {/* Delete button — top right, visible on hover */}
              {agent.status !== 'running' && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteAgent(agent.id); }}
                  className="absolute top-1 right-1 hidden group-hover:block text-[10px] text-muted-foreground hover:text-red-400 px-1"
                  title="Remove agent"
                >
                  x
                </button>
              )}
              <div className="flex items-center justify-between mb-1">
                <span className={`text-xs font-bold capitalize px-1.5 py-0.5 rounded ${
                  ROLE_BG[agent.role] || 'bg-muted'
                }`}>
                  {agent.role}
                </span>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  agent.status === 'running' ? 'bg-green-500 animate-pulse' :
                  agent.status === 'error' ? 'bg-red-500' :
                  agent.status === 'stopped' ? 'bg-gray-500' :
                  'bg-yellow-500'
                }`} />
              </div>
              <div className="text-[10px] text-muted-foreground space-y-0.5">
                <div className="flex justify-between">
                  <span>{agent.status}</span>
                  <span>${agent.totalCostUsd.toFixed(4)}</span>
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
            className="border border-dashed border-border rounded-lg p-2.5 text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors flex items-center justify-center text-xs"
          >
            + Add Agent
          </button>
        ) : (
          <div className="border border-border rounded-lg p-2.5 col-span-2 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Add Agent</span>
              <button onClick={() => setShowAddAgent(false)} className="text-[10px] text-muted-foreground hover:text-foreground">x</button>
            </div>
            <select
              value={addAgentRole}
              onChange={(e) => setAddAgentRole(e.target.value)}
              className="w-full bg-muted border border-border rounded px-2 py-1 text-xs"
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
              className="w-full bg-muted border border-border rounded px-2 py-1 text-xs min-h-[60px] resize-y"
            />
            <button
              onClick={handleAddAgent}
              disabled={!addAgentPrompt.trim()}
              className="w-full px-2 py-1 text-xs bg-primary text-primary-foreground rounded disabled:opacity-50"
            >
              Start Agent
            </button>
          </div>
        )}
      </div>

      {/* Dual terminal */}
      <div className="flex-1 min-h-0">
        <DualTerminal focusAgentId={focusAgentId} />
      </div>
    </div>
  );
}
