interface ModeSelectorProps {
  mode: 'spec' | 'creative';
  onModeChange: (mode: 'spec' | 'creative') => void;
}

export function ModeSelector({ mode, onModeChange }: ModeSelectorProps) {
  return (
    <div>
      <h3 className="text-lg font-medium mb-4">Development Mode</h3>
      <div className="grid grid-cols-2 gap-4">
        <button
          onClick={() => onModeChange('spec')}
          className={`p-4 rounded-lg border-2 text-left transition-colors ${
            mode === 'spec'
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-border hover:border-muted-foreground'
          }`}
        >
          <div className="text-2xl mb-2">📋</div>
          <h4 className="font-bold mb-1">Spec Mode</h4>
          <p className="text-xs text-muted-foreground">
            Upload SA/SD documents. The system extracts tasks,
            API definitions, and DB schema automatically.
          </p>
        </button>

        <button
          onClick={() => onModeChange('creative')}
          className={`p-4 rounded-lg border-2 text-left transition-colors ${
            mode === 'creative'
              ? 'border-purple-500 bg-purple-500/10'
              : 'border-border hover:border-muted-foreground'
          }`}
        >
          <div className="text-2xl mb-2">💡</div>
          <h4 className="font-bold mb-1">Creative Mode</h4>
          <p className="text-xs text-muted-foreground">
            Describe your idea. An AI architect interviews you
            and generates the full spec from scratch.
          </p>
        </button>
      </div>
    </div>
  );
}
