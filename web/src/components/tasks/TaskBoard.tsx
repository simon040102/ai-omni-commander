import { useProjectStore } from '../../stores/projectStore';
import { TaskCard } from './TaskCard';
import { IconChecklist, IconPlus } from '../ui/Icons';
import type { View } from '../layout/AppShell';

const COLUMNS = [
  { key: 'pending', label: 'Pending', color: 'text-gray-400' },
  { key: 'blocked', label: 'Blocked', color: 'text-yellow-400' },
  { key: 'queued', label: 'Queued', color: 'text-blue-400' },
  { key: 'in_progress', label: 'In Progress', color: 'text-cyan-400' },
  { key: 'completed', label: 'Completed', color: 'text-green-400' },
  { key: 'failed', label: 'Failed', color: 'text-red-400' },
];

interface TaskBoardProps {
  onViewChange: (view: View) => void;
}

export function TaskBoard({ onViewChange }: TaskBoardProps) {
  const tasks = useProjectStore(s => s.tasks);
  const dependencies = useProjectStore(s => s.dependencies);
  const currentProjectId = useProjectStore(s => s.currentProjectId);

  if (!currentProjectId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-muted/50 flex items-center justify-center">
            <IconChecklist className="w-8 h-8 text-muted-foreground/40" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">No Project Selected</h3>
          <p className="text-sm text-muted-foreground mb-5">
            Select a project from the sidebar to view its tasks.
          </p>
          <button
            onClick={() => onViewChange('setup')}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
          >
            <IconPlus className="w-4 h-4" />
            Create New Project
          </button>
        </div>
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-sm">
          <div className="w-16 h-16 mx-auto mb-5 rounded-2xl bg-muted/50 flex items-center justify-center">
            <IconChecklist className="w-8 h-8 text-muted-foreground/40" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">No Tasks Yet</h3>
          <p className="text-sm text-muted-foreground">
            Tasks will appear automatically once execution starts.
          </p>
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
