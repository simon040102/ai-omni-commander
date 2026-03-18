import { useProjectStore, type Task } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { ProgressRing } from '../ui/ProgressRing';

const LABEL_COLORS: Record<string, string> = {
  backend: 'bg-orange-500/20 text-orange-400',
  frontend: 'bg-blue-500/20 text-blue-400',
  devops: 'bg-purple-500/20 text-purple-400',
  testing: 'bg-green-500/20 text-green-400',
  review: 'bg-yellow-500/20 text-yellow-400',
  architect: 'bg-pink-500/20 text-pink-400',
};

const TYPE_BADGE: Record<string, { bg: string; label: string }> = {
  bug: { bg: 'bg-red-500/20 text-red-400', label: 'Bug' },
  feature: { bg: 'bg-blue-500/20 text-blue-400', label: 'Feature' },
  refactor: { bg: 'bg-purple-500/20 text-purple-400', label: 'Refactor' },
  other: { bg: 'bg-gray-500/20 text-gray-400', label: 'Other' },
};

const MODEL_BADGE: Record<string, string> = {
  haiku: 'bg-emerald-500/15 text-emerald-400',
  sonnet: 'bg-sky-500/15 text-sky-400',
  opus: 'bg-amber-500/15 text-amber-400',
};

interface TaskCardProps {
  task: Task;
  depCount: number;
}

export function TaskCard({ task, depCount }: TaskCardProps) {
  const agents = useProjectStore(s => s.agents);
  const progress = useAgentStore(s => s.progress);

  const assignedAgent = task.assignedAgentId
    ? agents.find(a => a.id === task.assignedAgentId)
    : null;
  const agentProgress = assignedAgent ? progress[assignedAgent.id] : null;
  const typeBadge = TYPE_BADGE[task.taskType] || TYPE_BADGE.other;

  return (
    <div className="bg-card border border-border rounded-md p-2.5 text-xs hover:border-muted-foreground transition-colors cursor-default">
      {/* Row 1: label + type badge + deps */}
      <div className="flex items-start justify-between gap-1 mb-1.5">
        <div className="flex items-center gap-1 flex-wrap">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${LABEL_COLORS[task.label] || 'bg-gray-500/20 text-gray-400'}`}>
            {task.label}
          </span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadge.bg}`}>
            {typeBadge.label}
          </span>
          {task.source === 'asana' && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-500/15 text-orange-400">
              Asana
            </span>
          )}
          {task.parentName && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-500/15 text-cyan-400" title="Parent task / function code">
              {task.parentName}
            </span>
          )}
        </div>
        {depCount > 0 && (
          <span className="text-[10px] text-muted-foreground flex-shrink-0" title="Dependencies">
            ⬆{depCount}
          </span>
        )}
      </div>

      <h4 className="font-medium text-foreground leading-tight mb-1 line-clamp-2">
        {task.title}
      </h4>

      {task.description && (
        <p className="text-muted-foreground leading-tight line-clamp-2 mb-1.5">
          {task.description}
        </p>
      )}

      {/* Bottom row: agent info + model + progress + retry */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {assignedAgent && (
          <div className="flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${
              assignedAgent.status === 'running' ? 'bg-green-500' :
              assignedAgent.status === 'error' ? 'bg-red-500' :
              'bg-gray-500'
            }`} />
            <span className="text-[10px] text-cyan-400 capitalize">{assignedAgent.role}</span>
          </div>
        )}
        {assignedAgent?.model && (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${MODEL_BADGE[assignedAgent.model] || 'bg-gray-500/15 text-gray-400'}`}>
            {assignedAgent.model}
          </span>
        )}
        {agentProgress && assignedAgent?.status === 'running' && (
          <ProgressRing percentage={agentProgress.percentage} size={18} strokeWidth={2} phase={agentProgress.currentPhase} />
        )}
        {task.retryCount > 0 && (
          <span className="text-[10px] text-yellow-400 ml-auto">
            Retry #{task.retryCount}
          </span>
        )}
        {task.preferredModel && (
          <span className={`text-[10px] px-1 py-0.5 rounded font-medium ml-auto ${MODEL_BADGE[task.preferredModel] || 'bg-gray-500/15 text-gray-400'}`} title="Preferred model">
            {task.preferredModel}
          </span>
        )}
      </div>
    </div>
  );
}
