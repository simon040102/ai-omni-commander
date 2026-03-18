import { useMemo } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { IconPlus } from '../ui/Icons';
import type { View } from '../layout/AppShell';

interface ProjectListProps {
  onViewChange: (view: View) => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  idle: { bg: 'bg-gray-500/15', text: 'text-gray-400' },
  setup: { bg: 'bg-gray-500/15', text: 'text-gray-400' },
  planning: { bg: 'bg-yellow-500/15', text: 'text-yellow-400' },
  executing: { bg: 'bg-green-500/15', text: 'text-green-400' },
  paused: { bg: 'bg-orange-500/15', text: 'text-orange-400' },
  completed: { bg: 'bg-blue-500/15', text: 'text-blue-400' },
  failed: { bg: 'bg-red-500/15', text: 'text-red-400' },
};

function shortenPath(p: string | null): string {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}

export function ProjectList({ onViewChange }: ProjectListProps) {
  const rawProjects = useProjectStore(s => s.projects);
  const agents = useProjectStore(s => s.agents);
  const setCurrentProject = useProjectStore(s => s.setCurrentProject);
  const client = useWsStore(s => s.client);

  const projects = useMemo(() => {
    return [...rawProjects].sort((a, b) => {
      const dateA = new Date(a.createdAt.endsWith('Z') ? a.createdAt : a.createdAt + 'Z').getTime();
      const dateB = new Date(b.createdAt.endsWith('Z') ? b.createdAt : b.createdAt + 'Z').getTime();
      return dateB - dateA;
    });
  }, [rawProjects]);

  const handleProjectClick = (projectId: string) => {
    setCurrentProject(projectId);
    client?.send({
      type: 'project.getState',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId },
    });
    onViewChange('tasks');
  };

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your AI-powered development projects
          </p>
        </div>
        <button
          onClick={() => onViewChange('setup')}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg text-sm font-medium transition-colors"
        >
          <IconPlus className="w-4 h-4" />
          New Project
        </button>
      </div>

      {/* Project grid */}
      {projects.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-border rounded-xl">
          <p className="text-muted-foreground mb-4">No projects yet</p>
          <button
            onClick={() => onViewChange('setup')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary/10 text-primary hover:bg-primary/20 rounded-lg text-sm font-medium transition-colors"
          >
            <IconPlus className="w-4 h-4" />
            Create your first project
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map(p => {
            const statusStyle = STATUS_COLORS[p.status] || STATUS_COLORS['idle'];
            const projectAgents = agents.filter(a => a.projectId === p.id);
            const runningAgents = projectAgents.filter(a => a.status === 'running').length;

            return (
              <button
                key={p.id}
                onClick={() => handleProjectClick(p.id)}
                className="text-left p-4 rounded-xl border border-border hover:border-primary/50 bg-card hover:bg-card/80 transition-all group"
              >
                {/* Title + Status */}
                <div className="flex items-start justify-between mb-3">
                  <h3 className="font-semibold text-sm truncate flex-1 mr-2 group-hover:text-primary transition-colors">
                    {p.name}
                  </h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ${statusStyle.bg} ${statusStyle.text}`}>
                    {p.status}
                  </span>
                </div>

                {/* Paths */}
                <div className="space-y-1 mb-3">
                  {p.frontendPath && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="text-[10px] px-1.5 py-0 rounded bg-blue-500/10 text-blue-400 font-medium">FE</span>
                      <span className="truncate" title={p.frontendPath}>{shortenPath(p.frontendPath)}</span>
                    </div>
                  )}
                  {p.backendPath && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="text-[10px] px-1.5 py-0 rounded bg-purple-500/10 text-purple-400 font-medium">BE</span>
                      <span className="truncate" title={p.backendPath}>{shortenPath(p.backendPath)}</span>
                    </div>
                  )}
                  {!p.frontendPath && !p.backendPath && (
                    <div className="text-xs text-muted-foreground truncate" title={p.workingDir}>
                      {shortenPath(p.workingDir)}
                    </div>
                  )}
                </div>

                {/* Footer stats */}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  {runningAgents > 0 && (
                    <span className="text-green-400 font-medium">
                      {runningAgents} agent{runningAgents > 1 ? 's' : ''} running
                    </span>
                  )}
                  {p.asanaProjectGid && (
                    <span className="text-pink-400">Asana</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
