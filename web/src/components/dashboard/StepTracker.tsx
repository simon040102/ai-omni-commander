import { useProjectStore } from '../../stores/projectStore';

const STATUS_ICON: Record<string, { icon: string; color: string }> = {
  running: { icon: '▶', color: 'text-green-400' },
  idle: { icon: '○', color: 'text-yellow-400' },
  stopped: { icon: '■', color: 'text-gray-400' },
  error: { icon: '✕', color: 'text-red-400' },
};

const PROJECT_STATUS: Record<string, { label: string; color: string }> = {
  setup: { label: 'Setup', color: 'bg-gray-500/20 text-gray-400' },
  planning: { label: 'Planning', color: 'bg-yellow-500/20 text-yellow-400' },
  executing: { label: 'Executing', color: 'bg-green-500/20 text-green-400' },
  paused: { label: 'Paused', color: 'bg-orange-500/20 text-orange-400' },
  completed: { label: 'Completed', color: 'bg-blue-500/20 text-blue-400' },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-400' },
};

export function StepTracker() {
  const projects = useProjectStore(s => s.projects);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const agents = useProjectStore(s => s.agents);

  const project = projects.find(p => p.id === currentProjectId);
  if (!project) return null;

  const runningCount = agents.filter(a => a.status === 'running').length;
  const stoppedCount = agents.filter(a => a.status === 'stopped').length;
  const errorCount = agents.filter(a => a.status === 'error').length;

  const statusInfo = PROJECT_STATUS[project.status] || PROJECT_STATUS.setup;

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-2.5 flex items-center gap-4">
      {/* Project phase */}
      <span className={`text-xs font-medium px-2 py-0.5 rounded ${statusInfo.color}`}>
        {statusInfo.label}
      </span>

      {/* Agent status summary */}
      {agents.length > 0 && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {runningCount > 0 && (
            <span className="flex items-center gap-1 text-green-400">
              <span className="animate-pulse">▶</span> {runningCount} running
            </span>
          )}
          {stoppedCount > 0 && (
            <span className="flex items-center gap-1 text-gray-400">
              ■ {stoppedCount} done
            </span>
          )}
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              ✕ {errorCount} error
            </span>
          )}
        </div>
      )}

      {/* Divider */}
      {agents.length > 0 && <div className="h-4 w-px bg-border" />}

      {/* Per-agent status pills */}
      <div className="flex items-center gap-1.5 flex-1 overflow-x-auto">
        {agents.map(agent => {
          const si = STATUS_ICON[agent.status] || STATUS_ICON.idle;
          return (
            <span
              key={agent.id}
              className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted ${si.color}`}
              title={`${agent.role}: ${agent.status}`}
            >
              <span>{si.icon}</span>
              <span className="capitalize">{agent.role}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
