import type { Task } from '../../stores/projectStore';

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetail({ task, onClose }: TaskDetailProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg w-full max-w-lg mx-4 p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold">{task.title}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground">Status:</span> {task.status}
          </div>
          <div>
            <span className="text-muted-foreground">Label:</span> {task.label}
          </div>
          {task.description && (
            <div>
              <span className="text-muted-foreground">Description:</span>
              <p className="mt-1">{task.description}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
