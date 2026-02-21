import { useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useWsStore } from '../../stores/wsStore';
import { TerminalOutput } from './TerminalOutput';

interface DualTerminalProps {
  focusAgentId?: string | null;
}

export function DualTerminal({ focusAgentId }: DualTerminalProps) {
  const agents = useProjectStore(s => s.agents);
  const outputs = useAgentStore(s => s.outputs);
  const client = useWsStore(s => s.client);

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

  // If focusing on a specific agent, show only that one full-width
  if (focusAgentId) {
    const agent = agents.find(a => a.id === focusAgentId);
    if (agent) {
      return (
        <div className="h-full">
          <TerminalOutput
            outputs={outputs[agent.id] || []}
            title={`${agent.role.charAt(0).toUpperCase() + agent.role.slice(1)} Agent`}
            role={agent.role}
            status={agent.status}
            agentId={agent.id}
            onSendCommand={handleSendCommand}
            onAction={handleAgentAction}
          />
        </div>
      );
    }
  }

  // Group agents by role, showing latest agent per role
  const roleMap = new Map<string, typeof agents[0]>();
  for (const agent of agents) {
    const existing = roleMap.get(agent.role);
    if (!existing || agent.status === 'running') {
      roleMap.set(agent.role, agent);
    }
  }

  // Separate review agents from work agents
  const reviewAgent = roleMap.get('review');
  roleMap.delete('review');

  // Work agents (backend, frontend, master, etc.)
  const workAgents = Array.from(roleMap.values());

  // Determine grid columns based on count
  const cols = workAgents.length <= 1 ? 1 : workAgents.length <= 2 ? 2 : 3;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Work agent terminals */}
      <div
        className="flex-1 grid gap-3 min-h-0"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {workAgents.length > 0 ? (
          workAgents.map(agent => (
            <TerminalOutput
              key={agent.id}
              outputs={outputs[agent.id] || []}
              title={`${agent.role.charAt(0).toUpperCase() + agent.role.slice(1)} Agent`}
              role={agent.role}
              status={agent.status}
              agentId={agent.id}
              onSendCommand={handleSendCommand}
              onAction={handleAgentAction}
            />
          ))
        ) : (
          <div className="flex items-center justify-center text-muted-foreground border border-border rounded-lg">
            No agents running. Start a project to see output here.
          </div>
        )}
      </div>

      {/* Code Review agent section */}
      {reviewAgent && (
        <div className="h-48">
          <TerminalOutput
            outputs={outputs[reviewAgent.id] || []}
            title="Code Review Agent"
            role="review"
            status={reviewAgent.status}
            agentId={reviewAgent.id}
            onSendCommand={handleSendCommand}
            onAction={handleAgentAction}
          />
        </div>
      )}
    </div>
  );
}
