import type { ProjectMode } from '@omni/shared';
import { IconCheck, IconDocument, IconRocket, IconLightning } from '../ui/Icons';

interface ModeSelectorProps {
  mode: ProjectMode;
  onModeChange: (mode: ProjectMode) => void;
}

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  return (
    <div>
      <h3 className="text-lg font-medium mb-4">Development Mode</h3>
      <div className="grid grid-cols-3 gap-4">
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
          onClick={() => onModeChange('creative')}
          className={`relative p-5 rounded-lg border-2 text-left transition-all ${
            mode === 'creative'
              ? 'border-purple-500 bg-purple-500/10 shadow-[0_0_15px_rgba(168,85,247,0.12)] scale-[1.02]'
              : 'border-border hover:border-muted-foreground hover:scale-[1.01]'
          }`}
        >
          {mode === 'creative' && (
            <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center">
              <IconCheck className="w-3 h-3 text-white" />
            </div>
          )}
          <div className="w-10 h-10 rounded-lg bg-purple-500/15 flex items-center justify-center mb-3">
            <IconRocket className="w-5 h-5 text-purple-400" />
          </div>
          <h4 className="font-bold mb-1">Creative Mode</h4>
          <p className="text-xs text-muted-foreground">
            Describe your idea. An AI architect interviews you
            and generates the full spec from scratch.
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
