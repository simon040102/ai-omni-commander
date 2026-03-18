import { useDroppable } from '@dnd-kit/core';
import type { ReactNode } from 'react';

interface KanbanColumnProps {
  id: string;
  label: string;
  color: string;
  count: number;
  children: ReactNode;
}

export function KanbanColumn({ id, label, color, count, children }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col min-h-0 rounded-lg border transition-colors ${
        isOver ? 'border-primary/50 bg-primary/5' : 'border-transparent'
      }`}
    >
      <div className={`text-xs font-medium mb-2 flex items-center gap-1 px-1 ${color}`}>
        <span>{label}</span>
        <span className="bg-muted px-1.5 rounded">{count}</span>
      </div>
      <div className="flex-1 overflow-auto space-y-2 px-1 pb-2">
        {children}
      </div>
    </div>
  );
}
