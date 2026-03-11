import { useState, useEffect, useRef } from 'react';
import type { QuickTaskType } from '@omni/shared';
import { IconPlay, IconAsana } from '../ui/Icons';

type QuickRole = 'backend' | 'frontend' | 'devops' | 'testing';

interface ImportedTask {
  name: string;
  notes: string;
  asanaGid: string;
}

interface QuickModeSetupProps {
  projectId: string;
  selectedModel: string;
  onModelChange: (model: string) => void;
  onStartExecution: (quickTask: {
    type: QuickTaskType;
    description: string;
    errorLog?: string;
    relatedFiles?: string[];
    role?: QuickRole;
    useWorkspaceSkills?: boolean;
  }) => void;
  importedTask?: ImportedTask;
}

const TASK_TYPES: { value: QuickTaskType; label: string; emoji: string; desc: string }[] = [
  { value: 'bug', label: 'Bug Fix', emoji: '🐛', desc: 'Fix an error or unexpected behavior' },
  { value: 'change', label: 'Small Change', emoji: '✨', desc: 'Minor feature or UI update' },
  { value: 'refactor', label: 'Refactor', emoji: '🔧', desc: 'Improve code structure' },
  { value: 'other', label: 'Other', emoji: '📝', desc: 'General task' },
];

const ROLES: { value: QuickRole; label: string; emoji: string; desc: string }[] = [
  { value: 'backend', label: 'Backend', emoji: '⚙️', desc: 'Server-side, API, database' },
  { value: 'frontend', label: 'Frontend', emoji: '🎨', desc: 'UI, React, styling' },
  { value: 'devops', label: 'DevOps', emoji: '🚀', desc: 'CI/CD, Docker, deployment' },
  { value: 'testing', label: 'Testing', emoji: '🧪', desc: 'Tests, QA, automation' },
];

export function QuickModeSetup({
  selectedModel,
  onModelChange,
  onStartExecution,
  importedTask,
}: QuickModeSetupProps) {
  const [taskType, setTaskType] = useState<QuickTaskType>('bug');
  const [role, setRole] = useState<QuickRole>('backend');
  const [description, setDescription] = useState('');
  const [errorLog, setErrorLog] = useState('');
  const [relatedFiles, setRelatedFiles] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [useWorkspaceSkills, setUseWorkspaceSkills] = useState(true);
  const hasAppliedImport = useRef(false);

  // Pre-fill from imported Asana task
  useEffect(() => {
    if (importedTask && !hasAppliedImport.current) {
      hasAppliedImport.current = true;
      // Use notes if available, otherwise use name
      const taskDescription = importedTask.notes?.trim()
        ? `${importedTask.name}\n\n${importedTask.notes}`
        : importedTask.name;
      setDescription(taskDescription);
      // Default to 'other' type for imported tasks
      setTaskType('other');
    }
  }, [importedTask]);

  const handleStart = () => {
    if (!description.trim()) return;

    onStartExecution({
      type: taskType,
      description: description.trim(),
      errorLog: errorLog.trim() || undefined,
      relatedFiles: relatedFiles.trim()
        ? relatedFiles.split('\n').map(f => f.trim()).filter(Boolean)
        : undefined,
      role,
      useWorkspaceSkills,
    });
  };

  return (
    <div className="space-y-5">
      {/* Asana Import Banner */}
      {importedTask && (
        <div className="flex items-center gap-2 px-3 py-2 bg-pink-500/10 border border-pink-500/30 rounded-lg">
          <IconAsana className="w-4 h-4 text-pink-500" />
          <span className="text-sm text-pink-400">Imported from Asana</span>
          <span className="text-xs text-muted-foreground ml-auto">GID: {importedTask.asanaGid}</span>
        </div>
      )}

      {/* Task Type */}
      <div>
        <label className="block text-sm font-medium mb-2">Task Type</label>
        <div className="grid grid-cols-4 gap-2">
          {TASK_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setTaskType(type.value)}
              className={`p-3 rounded-lg border-2 text-left transition-all ${
                taskType === type.value
                  ? 'border-amber-500 bg-amber-500/10'
                  : 'border-border hover:border-muted-foreground'
              }`}
            >
              <div className="text-lg mb-1">{type.emoji}</div>
              <div className="text-xs font-medium">{type.label}</div>
              <div className="text-[10px] text-muted-foreground">{type.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Role Selection */}
      <div>
        <label className="block text-sm font-medium mb-2">Agent Role</label>
        <div className="grid grid-cols-4 gap-2">
          {ROLES.map((r) => (
            <button
              key={r.value}
              onClick={() => setRole(r.value)}
              className={`p-3 rounded-lg border-2 text-left transition-all ${
                role === r.value
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-border hover:border-muted-foreground'
              }`}
            >
              <div className="text-lg mb-1">{r.emoji}</div>
              <div className="text-xs font-medium">{r.label}</div>
              <div className="text-[10px] text-muted-foreground">{r.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Task Description */}
      <div>
        <label className="block text-sm font-medium mb-1">
          Task Description <span className="text-red-400">*</span>
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Describe what you want to fix or change. Be specific about the current behavior and expected outcome.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={
            taskType === 'bug'
              ? "e.g. When clicking the submit button, the form doesn't validate the email field. It should show an error if the email format is invalid."
              : taskType === 'change'
                ? "e.g. Add a dark mode toggle button in the header next to the user profile icon."
                : taskType === 'refactor'
                  ? "e.g. The useAuth hook has duplicated logic with useSession. Consolidate them into a single hook."
                  : "Describe your task here..."
          }
          className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
        />
      </div>

      {/* Advanced Options Toggle */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {showAdvanced ? '▼' : '▶'} Advanced options (error log, related files)
      </button>

      {showAdvanced && (
        <div className="space-y-4 pl-4 border-l-2 border-border">
          {/* Error Log */}
          <div>
            <label className="block text-sm font-medium mb-1">Error Log / Stack Trace</label>
            <p className="text-xs text-muted-foreground mb-2">
              Paste any error messages or stack traces (optional)
            </p>
            <textarea
              value={errorLog}
              onChange={(e) => setErrorLog(e.target.value)}
              placeholder="Paste error messages here..."
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono min-h-[80px] resize-y outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
            />
          </div>

          {/* Related Files */}
          <div>
            <label className="block text-sm font-medium mb-1">Related Files</label>
            <p className="text-xs text-muted-foreground mb-2">
              File paths that might be related (one per line, optional)
            </p>
            <textarea
              value={relatedFiles}
              onChange={(e) => setRelatedFiles(e.target.value)}
              placeholder="src/components/Form.tsx&#10;src/hooks/useValidation.ts"
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono min-h-[60px] resize-y outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
            />
          </div>
        </div>
      )}

      {/* Model Selection */}
      <div>
        <label className="block text-sm font-medium mb-1">Model</label>
        <p className="text-xs text-muted-foreground mb-2">
          Choose which Claude model to use.
        </p>
        <div className="flex gap-2">
          {(['sonnet', 'opus', 'haiku'] as const).map((model) => (
            <button
              key={model}
              onClick={() => onModelChange(model)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                selectedModel === model
                  ? model === 'opus'
                    ? 'bg-purple-500/20 text-purple-400 border border-purple-500/50'
                    : model === 'haiku'
                      ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                      : 'bg-blue-500/20 text-blue-400 border border-blue-500/50'
                  : 'bg-muted text-muted-foreground border border-border hover:border-primary/50 hover:text-foreground'
              }`}
            >
              {model.charAt(0).toUpperCase() + model.slice(1)}
              {model === 'opus' && <span className="ml-1 text-[10px] opacity-60">(most capable)</span>}
              {model === 'haiku' && <span className="ml-1 text-[10px] opacity-60">(fastest)</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Workspace Skills Toggle */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30 rounded-lg border border-border">
        <div className="flex-1">
          <label className="text-sm font-medium block mb-0.5">Use Project Skills</label>
          <p className="text-xs text-muted-foreground">
            Load CLAUDE.md and .claude/ settings from workspace
          </p>
        </div>
        <button
          onClick={() => setUseWorkspaceSkills(!useWorkspaceSkills)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            useWorkspaceSkills ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              useWorkspaceSkills ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Start Button */}
      <button
        onClick={handleStart}
        disabled={!description.trim()}
        className="group inline-flex items-center gap-2 px-6 py-3 bg-amber-600 hover:bg-amber-500 disabled:bg-amber-600/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-lg shadow-amber-600/20 hover:shadow-amber-500/30 transition-all"
      >
        <IconPlay className="w-4 h-4" />
        Start Quick Task
      </button>
    </div>
  );
}
