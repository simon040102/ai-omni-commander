import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import type { View } from '../layout/AppShell';

const ROLE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  frontend: { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/30' },
  backend: { bg: 'bg-purple-500/10', text: 'text-purple-400', border: 'border-purple-500/30' },
  master: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  architect: { bg: 'bg-orange-500/10', text: 'text-orange-400', border: 'border-orange-500/30' },
  devops: { bg: 'bg-green-500/10', text: 'text-green-400', border: 'border-green-500/30' },
  testing: { bg: 'bg-teal-500/10', text: 'text-teal-400', border: 'border-teal-500/30' },
  review: { bg: 'bg-gray-500/10', text: 'text-gray-400', border: 'border-gray-500/30' },
  quick: { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/30' },
};

interface ActiveAgentsProps {
  onViewChange: (view: View) => void;
}

export function ActiveAgents({ onViewChange }: ActiveAgentsProps) {
  const projects = useProjectStore(s => s.projects);
  const allAgents = useProjectStore(s => s.agents);
  const setCurrentProject = useProjectStore(s => s.setCurrentProject);
  const client = useWsStore(s => s.client);

  // Filter only running agents
  const runningAgents = allAgents.filter(a => a.status === 'running');

  const handleAgentClick = (agentId: string, projectId: string) => {
    // Switch to the agent's project
    setCurrentProject(projectId);
    client?.send({
      type: 'project.getState',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId },
    });
    // Store focus agent ID for Dashboard to pick up
    sessionStorage.setItem('focusAgentId', agentId);
    // Navigate to dashboard
    onViewChange('dashboard');
  };

  if (runningAgents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-muted/50 flex items-center justify-center">
            <svg className="w-10 h-10 text-muted-foreground/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">No Active Agents</h3>
          <p className="text-sm text-muted-foreground">
            All agents are idle. Start a new project execution to see active agents here.
          </p>
        </div>
      </div>
    );
  }

  // Group agents by project
  const agentsByProject = runningAgents.reduce((acc, agent) => {
    if (!acc[agent.projectId]) {
      acc[agent.projectId] = [];
    }
    acc[agent.projectId].push(agent);
    return acc;
  }, {} as Record<string, typeof runningAgents>);

  return (
    <div className="h-full overflow-auto">
      <div className="p-6">
        <div className="mb-6">
          <h2 className="text-2xl font-bold mb-1">Active Agents</h2>
          <p className="text-sm text-muted-foreground">
            {runningAgents.length} agent{runningAgents.length === 1 ? '' : 's'} currently running
          </p>
        </div>

        <div className="space-y-6">
          {Object.entries(agentsByProject).map(([projectId, agents]) => {
            const project = projects.find(p => p.id === projectId);
            return (
              <div key={projectId} className="space-y-3">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold">{project?.name || 'Unknown Project'}</h3>
                  <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded">
                    {project?.mode}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {agents.map(agent => {
                    const roleStyle = ROLE_COLORS[agent.role] || ROLE_COLORS.review;
                    return (
                      <button
                        key={agent.id}
                        onClick={() => handleAgentClick(agent.id, projectId)}
                        className={`relative p-4 rounded-lg border ${roleStyle.border} ${roleStyle.bg} hover:scale-[1.02] transition-all text-left group`}
                      >
                        {/* Pulsing indicator */}
                        <div className="absolute top-3 right-3">
                          <span className="relative flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                          </span>
                        </div>

                        {/* Role */}
                        <div className={`text-lg font-bold ${roleStyle.text} mb-2 capitalize`}>
                          {agent.role}
                        </div>

                        {/* Status */}
                        <div className="flex items-center gap-2 text-sm text-muted-foreground mb-3">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          <span>Running</span>
                        </div>

                        {/* Model */}
                        {agent.model && (
                          <div className="text-xs text-muted-foreground/70">
                            Model: {agent.model}
                          </div>
                        )}

                        {/* Hover indicator */}
                        <div className="absolute bottom-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                          <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                          </svg>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
