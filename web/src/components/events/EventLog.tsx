import { useAgentStore, type AgentOutput } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { IconClock } from '../ui/Icons';

export function EventLog() {
  const outputs = useAgentStore(s => s.outputs);
  const agents = useProjectStore(s => s.agents);

  // Combine all agent outputs into a single sorted timeline
  const allEvents: (AgentOutput & { agentId: string; agentRole: string })[] = [];

  for (const agent of agents) {
    const agentOutputs = outputs[agent.id] || [];
    for (const output of agentOutputs) {
      allEvents.push({
        ...output,
        agentId: agent.id,
        agentRole: agent.role,
      });
    }
  }

  // Sort by timestamp descending
  allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Take latest 200
  const recent = allEvents.slice(0, 200);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Event Log</h2>
        <span className="text-sm text-muted-foreground">{allEvents.length} events</span>
      </div>

      <div className="flex-1 overflow-auto">
        {recent.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-sm">
              <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-muted/50 flex items-center justify-center">
                <IconClock className="w-8 h-8 text-muted-foreground/40" />
              </div>
              <h3 className="text-lg font-semibold text-foreground mb-2">No Activity Yet</h3>
              <p className="text-sm text-muted-foreground">
                Events stream in real time once agents start working.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {recent.map((event, i) => (
              <div key={i} className="flex items-start gap-3 px-2 py-1.5 hover:bg-muted/50 rounded text-xs">
                <span className="text-muted-foreground whitespace-nowrap font-mono">
                  {new Date(event.timestamp).toLocaleTimeString()}
                </span>
                <span className={`px-1.5 py-0.5 rounded whitespace-nowrap ${
                  event.agentRole === 'backend' ? 'bg-purple-500/15 text-purple-400' :
                  event.agentRole === 'frontend' ? 'bg-blue-500/15 text-blue-400' :
                  event.agentRole === 'master' ? 'bg-yellow-500/15 text-yellow-400' :
                  event.agentRole === 'review' ? 'bg-gray-500/15 text-gray-400' :
                  event.agentRole === 'testing' ? 'bg-teal-500/15 text-teal-400' :
                  event.agentRole === 'architect' ? 'bg-orange-500/15 text-orange-400' :
                  'bg-gray-500/15 text-gray-400'
                }`}>
                  {event.agentRole}
                </span>
                <span className={`flex-1 truncate ${
                  event.streamType === 'error' ? 'text-red-400' :
                  event.streamType === 'tool_use' ? 'text-cyan-400' :
                  event.streamType === 'system' ? 'text-yellow-400' :
                  'text-foreground'
                }`}>
                  {event.content}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
