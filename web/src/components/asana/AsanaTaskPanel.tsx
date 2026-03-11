import { useState, useEffect, useMemo } from 'react';
import { useAsanaStore } from '../../stores/asanaStore';
import { useWsStore } from '../../stores/wsStore';
import type { AsanaTask, ProjectMode } from '@omni/shared';
import { IconRefresh, IconSearch, IconExternalLink, IconAsana, IconChevronDown } from '../ui/Icons';

interface AsanaTaskPanelProps {
  onUseTask?: (task: AsanaTask, mode: ProjectMode) => void;
}

export function AsanaTaskPanel({ onUseTask }: AsanaTaskPanelProps) {
  const tasks = useAsanaStore(s => s.tasks);
  const loading = useAsanaStore(s => s.loading);
  const error = useAsanaStore(s => s.error);
  const connectionStatus = useAsanaStore(s => s.connectionStatus);
  const setLoading = useAsanaStore(s => s.setLoading);
  const client = useWsStore(s => s.client);

  const [search, setSearch] = useState('');
  const [expandedTaskGid, setExpandedTaskGid] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  // Check connection status and auto-load tasks on mount
  useEffect(() => {
    if (client) {
      client.send({
        type: 'asana.checkConnection',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {},
      });
      // Auto-load tasks if not already loaded
      if (tasks.length === 0 && !loading) {
        setLoading(true);
        client.send({
          type: 'asana.fetchTasks',
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          payload: { limit: 50 },
        });
      }
    }
  }, [client]);

  // Fetch tasks
  const fetchTasks = () => {
    if (!client) return;
    setLoading(true);
    client.send({
      type: 'asana.fetchTasks',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { limit: 50 },
    });
  };

  // Filter tasks by search term
  const filteredTasks = useMemo(() => {
    if (!search.trim()) return tasks;
    const term = search.toLowerCase();
    return tasks.filter(
      t =>
        t.name.toLowerCase().includes(term) ||
        t.notes.toLowerCase().includes(term) ||
        t.projectName.toLowerCase().includes(term) ||
        t.tags.some(tag => tag.toLowerCase().includes(term))
    );
  }, [tasks, search]);

  // Group tasks by project
  const tasksByProject = useMemo(() => {
    const groups: Record<string, AsanaTask[]> = {};
    for (const task of filteredTasks) {
      const key = task.projectName || 'No Project';
      if (!groups[key]) groups[key] = [];
      groups[key]!.push(task);
    }
    return groups;
  }, [filteredTasks]);

  const handleUseTask = (task: AsanaTask, mode: ProjectMode) => {
    if (onUseTask) {
      onUseTask(task, mode);
    }
  };

  const toggleProject = (projectName: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectName)) {
        next.delete(projectName);
      } else {
        next.add(projectName);
      }
      return next;
    });
  };


  // Not configured state
  if (!connectionStatus.configured) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-4">
          <IconAsana className="w-6 h-6 text-pink-500" />
          <h2 className="text-xl font-semibold">Asana Integration</h2>
        </div>
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
          <h3 className="font-medium text-yellow-400 mb-2">Setup Required</h3>
          <p className="text-sm text-muted-foreground mb-3">
            To use Asana integration, you need to set the <code className="bg-muted px-1 rounded">ASANA_PAT</code> environment variable.
          </p>
          <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
            <li>Go to Asana Developer Console</li>
            <li>Create a Personal Access Token or MCP Application</li>
            <li>Add to your <code className="bg-muted px-1 rounded">.env</code> file: <code className="bg-muted px-1 rounded">ASANA_PAT=your_token</code></li>
            <li>Restart the server</li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <IconAsana className="w-5 h-5 text-pink-500" />
            <h2 className="text-lg font-semibold">Asana Tasks</h2>
          </div>
          <div className="flex items-center gap-2">
            {/* Connection status */}
            <div
              className={`w-2 h-2 rounded-full ${
                connectionStatus.connected ? 'bg-green-500' : 'bg-yellow-500'
              }`}
              title={connectionStatus.connected ? 'Connected' : 'Not connected'}
            />
            <button
              onClick={fetchTasks}
              disabled={loading}
              className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
              title="Refresh tasks"
            >
              <IconRefresh className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="w-full bg-muted border border-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 bg-red-500/10 border-b border-red-500/30">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-12">
            <div className="relative">
              <IconAsana className="w-12 h-12 text-pink-500 animate-pulse" />
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-16 border-2 border-pink-500/30 border-t-pink-500 rounded-full animate-spin" />
              </div>
            </div>
            <p className="text-muted-foreground mt-4">Loading tasks from Asana...</p>
            <p className="text-xs text-muted-foreground/60 mt-1">This may take a moment on first connection</p>
          </div>
        )}

        {tasks.length === 0 && !loading && (
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">No tasks loaded yet</p>
            <button
              onClick={fetchTasks}
              className="px-4 py-2 bg-pink-500/20 text-pink-400 rounded-lg hover:bg-pink-500/30 transition-colors"
            >
              Load My Tasks
            </button>
          </div>
        )}

        {!loading && tasks.length > 0 && Object.entries(tasksByProject).map(([projectName, projectTasks]) => {
          const isExpanded = expandedProjects.has(projectName);
          return (
            <div key={projectName} className="space-y-2">
              <button
                onClick={() => toggleProject(projectName)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted transition-colors group"
              >
                <IconChevronDown
                  className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                />
                <h3 className="text-sm font-medium text-muted-foreground flex-1 text-left">
                  {projectName}
                </h3>
                <span className="text-sm text-muted-foreground/60 group-hover:text-muted-foreground">
                  {projectTasks.length}
                </span>
              </button>
              {isExpanded && projectTasks.map(task => (
                <TaskCard
                  key={task.gid}
                  task={task}
                  expanded={expandedTaskGid === task.gid}
                  onToggle={() =>
                    setExpandedTaskGid(expandedTaskGid === task.gid ? null : task.gid)
                  }
                  onUseTask={handleUseTask}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface TaskCardProps {
  task: AsanaTask;
  expanded: boolean;
  onToggle: () => void;
  onUseTask: (task: AsanaTask, mode: ProjectMode) => void;
}

function TaskCard({ task, expanded, onToggle, onUseTask }: TaskCardProps) {
  const isOverdue = task.dueOn && new Date(task.dueOn) < new Date();
  const isDueSoon =
    task.dueOn &&
    !isOverdue &&
    new Date(task.dueOn).getTime() - Date.now() < 3 * 24 * 60 * 60 * 1000;

  return (
    <div
      className={`bg-muted rounded-lg border transition-colors ${
        expanded ? 'border-pink-500/50' : 'border-border hover:border-muted-foreground'
      }`}
    >
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full p-3 text-left flex items-start gap-3"
      >
        <div
          className={`w-4 h-4 rounded border-2 flex-shrink-0 mt-0.5 ${
            task.completed
              ? 'bg-green-500 border-green-500'
              : 'border-muted-foreground'
          }`}
        >
          {task.completed && (
            <svg className="w-full h-full text-white" viewBox="0 0 16 16">
              <path
                fill="currentColor"
                d="M6.5 12L3 8.5l1.5-1.5L6.5 9l5-5L13 5.5z"
              />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-medium ${task.completed ? 'line-through text-muted-foreground' : ''}`}>
            {task.name}
          </p>
          {task.dueOn && (
            <p
              className={`text-xs mt-1 ${
                isOverdue
                  ? 'text-red-400'
                  : isDueSoon
                  ? 'text-yellow-400'
                  : 'text-muted-foreground'
              }`}
            >
              Due: {new Date(task.dueOn).toLocaleDateString()}
            </p>
          )}
          {task.tags.length > 0 && (
            <div className="flex gap-1 mt-2 flex-wrap">
              {task.tags.map(tag => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 bg-background rounded text-[10px] text-muted-foreground"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border mt-2">
          {/* Parent task */}
          {task.parent && (
            <div className="mt-3 p-2 bg-background rounded-lg border border-border">
              <p className="text-xs text-muted-foreground mb-1">Parent Task</p>
              <p className="text-sm font-medium text-blue-400">{task.parent.name}</p>
              {task.parent.notes && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.parent.notes}</p>
              )}
            </div>
          )}

          {/* Notes */}
          {task.notes && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground mb-1">Notes</p>
              <p className="text-sm whitespace-pre-wrap">{task.notes}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 mt-4">
            <button
              onClick={() => onUseTask(task, 'quick')}
              className="flex-1 px-3 py-2 bg-amber-500/20 text-amber-400 rounded-lg text-sm font-medium hover:bg-amber-500/30 transition-colors"
            >
              Quick Task
            </button>
            <button
              onClick={() => onUseTask(task, 'spec')}
              className="flex-1 px-3 py-2 bg-blue-500/20 text-blue-400 rounded-lg text-sm font-medium hover:bg-blue-500/30 transition-colors"
            >
              Spec Mode
            </button>
            {task.permalink_url && (
              <a
                href={task.permalink_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 hover:bg-background rounded-lg transition-colors"
                title="Open in Asana"
              >
                <IconExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
