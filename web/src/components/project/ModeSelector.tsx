type TaskMode = 'spec' | 'quick';
import { IconCheck, IconDocument, IconLightning } from '../ui/Icons';

interface ModeSelectorProps {
  mode: TaskMode;
  onModeChange: (mode: TaskMode) => void;
}

export type { TaskMode };

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  return (
    <div>
      <h3 className="text-lg font-medium mb-4">Task Mode</h3>
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => onModeChange('spec')}
          className={`relative p-5 rounded-lg border-2 text-left transition-all ${
            mode === 'spec'
              ? 'border-blue-500 bg-blue-500/10 shadow-[0_0_15px_rgba(59,130,246,0.12)] scale-[1.02]'
              : 'border-border hover:border-muted-foreground hover:scale-[1.01]'
          }`}
        >
          {mode === 'spec' && (
            <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center">
              <IconCheck className="w-3 h-3 text-white" />
            </div>
          )}
          <div className="w-10 h-10 rounded-lg bg-blue-500/15 flex items-center justify-center mb-3">
            <IconDocument className="w-5 h-5 text-blue-400" />
          </div>
          <h4 className="font-bold mb-1">Spec Mode</h4>
          <p className="text-xs text-muted-foreground">
            Upload SA/SD documents. The system extracts tasks,
            API definitions, and DB schema automatically.
          </p>
        </button>

        <button
          onClick={() => onModeChange('quick')}
          className={`relative p-5 rounded-lg border-2 text-left transition-all ${
            mode === 'quick'
              ? 'border-amber-500 bg-amber-500/10 shadow-[0_0_15px_rgba(245,158,11,0.12)] scale-[1.02]'
              : 'border-border hover:border-muted-foreground hover:scale-[1.01]'
          }`}
        >
          {mode === 'quick' && (
            <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center">
              <IconCheck className="w-3 h-3 text-white" />
            </div>
          )}
          <div className="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center mb-3">
            <IconLightning className="w-5 h-5 text-amber-400" />
          </div>
          <h4 className="font-bold mb-1">Quick Mode</h4>
          <p className="text-xs text-muted-foreground">
            Fast bug fixes or small changes. Just describe
            the task and start immediately.
          </p>
        </button>
      </div>
    </div>
  );
}
