import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';

export function Header() {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const projects = useProjectStore(s => s.projects);
  const connected = useWsStore(s => s.connected);
  const currentProject = projects.find(p => p.id === currentProjectId);

  return (
    <header className="h-14 border-b border-border flex items-center justify-between px-4 bg-card">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-primary">AI-OmniCommander</h1>
        {currentProject && (
          <>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-medium">{currentProject.name}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              currentProject.mode === 'spec'
                ? 'bg-blue-500/20 text-blue-400'
                : 'bg-purple-500/20 text-purple-400'
            }`}>
              {currentProject.mode === 'spec' ? 'Spec Mode' : 'Creative Mode'}
            </span>
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              currentProject.status === 'executing'
                ? 'bg-green-500/20 text-green-400'
                : currentProject.status === 'failed'
                  ? 'bg-red-500/20 text-red-400'
                  : 'bg-yellow-500/20 text-yellow-400'
            }`}>
              {currentProject.status}
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-xs text-muted-foreground">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
    </header>
  );
}
