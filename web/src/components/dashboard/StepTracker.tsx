import { Fragment } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { IconCheck } from '../ui/Icons';

const PHASES = [
  { key: 'setup', label: 'Setup' },
  { key: 'planning', label: 'Planning' },
  { key: 'executing', label: 'Executing' },
  { key: 'completed', label: 'Completed' },
] as const;

const STATUS_TO_PHASE: Record<string, number> = {
  setup: 0,
  interviewing: 0,
  planning: 1,
  executing: 2,
  paused: 2,
  completed: 3,
  failed: 3,
};

const AGENT_STATUS_STYLE: Record<string, { icon: string; color: string }> = {
  running: { icon: '\u25B6', color: 'text-green-400 bg-green-500/10' },
  idle: { icon: '\u25CB', color: 'text-yellow-400 bg-yellow-500/10' },
  starting: { icon: '\u25CB', color: 'text-yellow-400 bg-yellow-500/10' },
  stopped: { icon: '\u25A0', color: 'text-gray-400 bg-gray-500/10' },
  error: { icon: '\u2715', color: 'text-red-400 bg-red-500/10' },
};

export function StepTracker() {
  const projects = useProjectStore(s => s.projects);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const agents = useProjectStore(s => s.agents);

  const project = projects.find(p => p.id === currentProjectId);
  if (!project) return null;

  const currentPhaseIndex = STATUS_TO_PHASE[project.status] ?? 0;
  const isFailed = project.status === 'failed';

  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3">
      {/* Phase stepper */}
      <div className="flex items-center mb-3">
        {PHASES.map((phase, i) => {
          const isCompleted = i < currentPhaseIndex;
          const isActive = i === currentPhaseIndex;
          const isFutureOrFailed = i > currentPhaseIndex;

          return (
            <Fragment key={phase.key}>
              {i > 0 && (
                <div className={`h-0.5 flex-1 mx-1 rounded transition-colors duration-500 ${
                  isCompleted ? 'bg-primary' :
                  isActive && !isFailed ? 'bg-primary/40' :
                  'bg-border'
                }`} />
              )}
              <div className="flex flex-col items-center gap-1">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold border-2 transition-all duration-500 ${
                  isCompleted
                    ? 'bg-primary border-primary text-primary-foreground'
                    : isActive && !isFailed
                      ? 'border-primary text-primary bg-primary/10 shadow-[0_0_10px_rgba(59,130,246,0.25)]'
                      : isActive && isFailed
                        ? 'border-red-500 text-red-400 bg-red-500/10 shadow-[0_0_10px_rgba(239,68,68,0.25)]'
                        : 'border-border text-muted-foreground bg-card'
                }`}>
                  {isCompleted ? <IconCheck className="w-3.5 h-3.5" /> : (i + 1)}
                </div>
                <span className={`text-[10px] whitespace-nowrap ${
                  isActive ? (isFailed ? 'text-red-400 font-medium' : 'text-foreground font-medium') :
                  isCompleted ? 'text-muted-foreground' :
                  'text-muted-foreground/50'
                }`}>
                  {isFailed && isActive ? 'Failed' : phase.label}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* Per-agent status pills */}
      {agents.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pt-2 border-t border-border">
          {agents.map(agent => {
            const si = AGENT_STATUS_STYLE[agent.status] || AGENT_STATUS_STYLE.idle;
            return (
              <span
                key={agent.id}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md ${si.color}`}
                title={`${agent.role}: ${agent.status}`}
              >
                <span className={agent.status === 'running' ? 'animate-pulse' : ''}>{si.icon}</span>
                <span className="capitalize">{agent.role}</span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
