import { useProjectStore } from '../../stores/projectStore';
import { TaskCard } from './TaskCard';

const COLUMNS = [
  { key: 'pending', label: 'Pending', color: 'text-gray-400' },
  { key: 'blocked', label: 'Blocked', color: 'text-yellow-400' },
  { key: 'queued', label: 'Queued', color: 'text-blue-400' },
  { key: 'in_progress', label: 'In Progress', color: 'text-cyan-400' },
  { key: 'completed', label: 'Completed', color: 'text-green-400' },
  { key: 'failed', label: 'Failed', color: 'text-red-400' },
];

export function TaskBoard() {
  const tasks = useProjectStore(s => s.tasks);
  const dependencies = useProjectStore(s => s.dependencies);
  const currentProjectId = useProjectStore(s => s.currentProjectId);

  if (!currentProjectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No project selected
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <div className="text-4xl mb-4">📋</div>
          <p>No tasks yet</p>
          <p className="text-sm mt-1">Tasks will appear after execution starts</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Task Board</h2>
        <span className="text-sm text-muted-foreground">
          {tasks.filter(t => t.status === 'completed').length}/{tasks.length} completed
        </span>
      </div>

      <div className="grid grid-cols-6 gap-3 h-[calc(100%-3rem)]">
        {COLUMNS.map(col => {
          const columnTasks = tasks.filter(t =>
            t.status === col.key ||
            (col.key === 'in_progress' && ['assigned', 'in_progress', 'needs_review', 'needs_intervention'].includes(t.status))
          );
          return (
            <div key={col.key} className="flex flex-col min-h-0">
              <div className={`text-xs font-medium mb-2 flex items-center gap-1 ${col.color}`}>
                <span>{col.label}</span>
                <span className="bg-muted px-1.5 rounded">{columnTasks.length}</span>
              </div>
              <div className="flex-1 overflow-auto space-y-2">
                {columnTasks.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    depCount={dependencies.filter(d => d.taskId === task.id).length}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
