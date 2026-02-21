import type { Task } from '../../stores/projectStore';

const LABEL_COLORS: Record<string, string> = {
  backend: 'bg-orange-500/20 text-orange-400',
  frontend: 'bg-blue-500/20 text-blue-400',
  devops: 'bg-purple-500/20 text-purple-400',
  testing: 'bg-green-500/20 text-green-400',
  review: 'bg-yellow-500/20 text-yellow-400',
  architect: 'bg-pink-500/20 text-pink-400',
};

interface TaskCardProps {
  task: Task;
  depCount: number;
}

export function TaskCard({ task, depCount }: TaskCardProps) {
  return (
    <div className="bg-card border border-border rounded-md p-2.5 text-xs hover:border-muted-foreground transition-colors cursor-default">
      <div className="flex items-start justify-between gap-1 mb-1.5">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${LABEL_COLORS[task.label] || 'bg-gray-500/20 text-gray-400'}`}>
          {task.label}
        </span>
        {depCount > 0 && (
          <span className="text-[10px] text-muted-foreground" title="Dependencies">
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

      <div className="flex items-center justify-between">
        {task.assignedAgentId && (
          <span className="text-[10px] text-cyan-400">
            Agent assigned
          </span>
        )}
        {task.retryCount > 0 && (
          <span className="text-[10px] text-yellow-400">
            Retry #{task.retryCount}
          </span>
        )}
      </div>
    </div>
  );
}
