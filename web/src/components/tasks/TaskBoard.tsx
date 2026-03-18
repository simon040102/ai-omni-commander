import { useCallback, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useProjectStore, type Task } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { KanbanColumn } from './KanbanColumn';
import { TaskCard } from './TaskCard';
import { IconChecklist, IconPlus } from '../ui/Icons';
import type { View } from '../layout/AppShell';

type ColumnKey = 'pending' | 'in_progress' | 'completed' | 'failed';

const COLUMNS: Array<{ key: ColumnKey; label: string; color: string; statuses: string[] }> = [
  { key: 'pending', label: 'Pending', color: 'text-gray-400', statuses: ['pending', 'blocked', 'queued'] },
  { key: 'in_progress', label: 'In Progress', color: 'text-cyan-400', statuses: ['assigned', 'in_progress', 'needs_review', 'needs_intervention'] },
  { key: 'completed', label: 'Completed', color: 'text-green-400', statuses: ['completed'] },
  { key: 'failed', label: 'Failed', color: 'text-red-400', statuses: ['failed'] },
];

function canTransition(_fromColumn: ColumnKey, toColumn: ColumnKey): boolean {
  // Cannot drag into in_progress (requires agent assignment)
  if (toColumn === 'in_progress') return false;
  return true;
}

function getTargetStatus(column: ColumnKey): string {
  switch (column) {
    case 'pending': return 'pending';
    case 'in_progress': return 'in_progress';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
  }
}

function getColumnForTask(task: Task): ColumnKey {
  for (const col of COLUMNS) {
    if (col.statuses.includes(task.status)) return col.key;
  }
  return 'pending';
}

interface TaskBoardProps {
  onViewChange: (view: View) => void;
}

export function TaskBoard({ onViewChange }: TaskBoardProps) {
  const tasks = useProjectStore(s => s.tasks);
  const dependencies = useProjectStore(s => s.dependencies);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const task = tasks.find(t => t.id === event.active.id);
    if (task) setActiveTask(task);
  }, [tasks]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveTask(null);
    const { active, over } = event;
    if (!over || !currentProjectId) return;

    const task = tasks.find(t => t.id === active.id);
    if (!task) return;

    const targetColumn = over.id as ColumnKey;
    const sourceColumn = getColumnForTask(task);

    if (sourceColumn === targetColumn) return;

    if (!canTransition(sourceColumn, targetColumn)) {
      if (targetColumn === 'in_progress') {
        addToast({ type: 'warning', title: 'Cannot drag to In Progress', message: 'Tasks must be assigned by the system', duration: 3000 });
      }
      return;
    }

    const newStatus = getTargetStatus(targetColumn);
    client?.send({
      type: 'task.update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        taskId: task.id,
        status: newStatus as any,
      },
    });
  }, [tasks, currentProjectId, client, addToast]);

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
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4 flex-shrink-0">
        <h2 className="text-xl font-bold">Task Board</h2>
        <span className="text-sm text-muted-foreground">
          {tasks.filter(t => t.status === 'completed').length}/{tasks.length} completed
        </span>
      </div>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="grid grid-cols-4 gap-3 flex-1 min-h-0">
          {COLUMNS.map(col => {
            const columnTasks = tasks.filter(t => col.statuses.includes(t.status));
            return (
              <KanbanColumn
                key={col.key}
                id={col.key}
                label={col.label}
                color={col.color}
                count={columnTasks.length}
              >
                {columnTasks.map(task => (
                  <DraggableTaskCard
                    key={task.id}
                    task={task}
                    depCount={dependencies.filter(d => d.taskId === task.id).length}
                  />
                ))}
              </KanbanColumn>
            );
          })}
        </div>

        <DragOverlay>
          {activeTask && (
            <div className="opacity-80 rotate-2">
              <TaskCard
                task={activeTask}
                depCount={dependencies.filter(d => d.taskId === activeTask.id).length}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

/* ─── Draggable wrapper for TaskCard ─── */

function DraggableTaskCard({ task, depCount }: { task: Task; depCount: number }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={isDragging ? 'opacity-30' : ''}
    >
      <TaskCard task={task} depCount={depCount} />
    </div>
  );
}
