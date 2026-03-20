import { useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useWsStore } from '../../stores/wsStore';
import { TerminalOutput } from './TerminalOutput';

interface DualTerminalProps {
  focusAgentId?: string | null;
}

export function DualTerminal({ focusAgentId }: DualTerminalProps) {
  const allAgents = useProjectStore(s => s.agents);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const outputs = useAgentStore(s => s.outputs);
  const client = useWsStore(s => s.client);

  // Only show agents for the current project
  const agents = currentProjectId
    ? allAgents.filter(a => a.projectId === currentProjectId)
    : allAgents;

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
            projectId={agent.projectId}
            taskId={agent.currentTaskId ?? undefined}
            model={agent.model}
            totalInputTokens={agent.totalInputTokens}
            totalOutputTokens={agent.totalOutputTokens}
            onSendCommand={handleSendCommand}
            onAction={handleAgentAction}
          />
        </div>
      );
    }
  }

  // Latest review agent (if any)
  const reviewAgent = [...agents]
    .filter(a => a.role === 'review')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  // Latest 4 non-review agents, most recent first
  const workAgents = [...agents]
    .filter(a => a.role !== 'review')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);

  // 1→1col, 2→2col, 3→2col, 4→2col (2×2 grid)
  const cols = workAgents.length <= 1 ? 1 : 2;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Work agent terminals */}
      <div
        className="flex-1 grid gap-3 min-h-0"
        style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {workAgents.length > 0 ? (
          workAgents.map((agent, i) => (
            <div
              key={agent.id}
              style={workAgents.length === 3 && i === 2 ? { gridColumn: '1 / -1' } : undefined}
              className="min-h-0"
            >
            <TerminalOutput
              key={agent.id}
              outputs={outputs[agent.id] || []}
              title={`${agent.role.charAt(0).toUpperCase() + agent.role.slice(1)} Agent`}
              role={agent.role}
              status={agent.status}
              agentId={agent.id}
              projectId={agent.projectId}
              taskId={agent.currentTaskId ?? undefined}
              model={agent.model}
              totalInputTokens={agent.totalInputTokens}
              totalOutputTokens={agent.totalOutputTokens}
              onSendCommand={handleSendCommand}
              onAction={handleAgentAction}
            />
            </div>
          ))
        ) : (
          <div className="flex items-center justify-center text-muted-foreground border border-border rounded-lg">
            <div className="text-center py-8">
              <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-muted/50 flex items-center justify-center">
                <span className="text-muted-foreground/30 text-xl font-mono">&gt;_</span>
              </div>
              <p className="text-sm">Awaiting Output</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Start a project to see terminal streams here</p>
            </div>
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
            projectId={reviewAgent.projectId}
            taskId={reviewAgent.currentTaskId ?? undefined}
            model={reviewAgent.model}
            totalInputTokens={reviewAgent.totalInputTokens}
            totalOutputTokens={reviewAgent.totalOutputTokens}
            onSendCommand={handleSendCommand}
            onAction={handleAgentAction}
          />
        </div>
      )}
    </div>
  );
}
