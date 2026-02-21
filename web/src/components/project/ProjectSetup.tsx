import { useState, useCallback } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { ModeSelector } from './ModeSelector';
import { DocumentUpload } from './DocumentUpload';
import { InterviewChat } from './InterviewChat';
import { FolderPicker } from './FolderPicker';

interface WorkspaceEntry {
  label: string;
  path: string;
}

type Step = 'mode' | 'workspaces' | 'content' | 'execute';
const STEPS: Step[] = ['mode', 'workspaces', 'content', 'execute'];

export function ProjectSetup() {
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<'spec' | 'creative'>('spec');
  const [name, setName] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([
    { label: '', path: '' },
  ]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [requirement, setRequirement] = useState('');

  // Code Review settings
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [reviewSkillSource, setReviewSkillSource] = useState<string>('auto');
  // "auto" = use the workspace of the task being reviewed
  // workspace label = use that specific workspace's agent skills

  const addWorkspace = () => {
    setWorkspaces([...workspaces, { label: '', path: '' }]);
  };

  const removeWorkspace = (index: number) => {
    if (workspaces.length <= 1) return;
    setWorkspaces(workspaces.filter((_, i) => i !== index));
  };

  const updateWorkspace = (index: number, field: 'label' | 'path', value: string) => {
    setWorkspaces(workspaces.map((ws, i) => (i === index ? { ...ws, [field]: value } : ws)));
  };

  const isWorkspacesValid = name.trim() !== '' && workspaces.every(ws => ws.label.trim() !== '' && ws.path.trim() !== '');

  const handleCreate = useCallback(() => {
    if (!isWorkspacesValid) return;

    const id = crypto.randomUUID();
    setProjectId(id);

    client?.send({
      type: 'project.create',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: id,
        name,
        mode,
        workingDir: workspaces[0].path,
        workspaces: workspaces.map(ws => ({ label: ws.label.trim(), path: ws.path.trim() })),
        reviewConfig: {
          enabled: reviewEnabled,
          skillSource: reviewSkillSource,
        },
      },
    });

    addToast({ type: 'success', title: 'Project created', message: `"${name}" (${mode} mode)` });
    setStep('content');
  }, [name, mode, workspaces, client, isWorkspacesValid, reviewEnabled, reviewSkillSource, addToast]);

  const handleStartExecution = useCallback(() => {
    if (!projectId) return;
    client?.send({
      type: 'project.startExecution',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId,
        requirement: requirement.trim() || undefined,
      },
    });
    addToast({ type: 'info', title: 'Execution started', message: 'Sending tasks to agents...' });
    setStep('execute');
  }, [projectId, client, addToast, requirement]);

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">New Project</h2>

      {/* Step indicator */}
      <div className="flex gap-1 mb-8">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded ${
              i <= STEPS.indexOf(step) ? 'bg-primary' : 'bg-muted'
            }`}
          />
        ))}
      </div>

      {/* Step 1: Mode Selection */}
      {step === 'mode' && (
        <div>
          <ModeSelector mode={mode} onModeChange={setMode} />
          <div className="mt-6">
            <button
              onClick={() => setStep('workspaces')}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Project Name + Workspaces + Review Config */}
      {step === 'workspaces' && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project"
              className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm"
            />
          </div>

          {/* Workspaces */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium">Workspaces</label>
              <button
                onClick={addWorkspace}
                className="text-xs px-2 py-1 bg-primary/20 text-primary rounded hover:bg-primary/30 transition-colors"
              >
                + Add Workspace
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Add the folders that agents will work on. Give each a label (e.g. "frontend", "backend").
            </p>

            <div className="space-y-3">
              {workspaces.map((ws, index) => (
                <div key={index} className="flex gap-2 items-start">
                  <div className="w-32 shrink-0">
                    <input
                      type="text"
                      value={ws.label}
                      onChange={(e) => updateWorkspace(index, 'label', e.target.value)}
                      placeholder="Label"
                      className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex-1">
                    <FolderPicker
                      value={ws.path}
                      onChange={(p) => updateWorkspace(index, 'path', p)}
                    />
                  </div>
                  {workspaces.length > 1 && (
                    <button
                      onClick={() => removeWorkspace(index)}
                      className="shrink-0 px-2 py-2 text-red-400 hover:text-red-300 text-sm"
                      title="Remove"
                    >
                      x
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Code Review Agent Config */}
          <div className="border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium">Code Review Agent</h4>
                <p className="text-xs text-muted-foreground">Automatically reviews code after tasks complete</p>
              </div>
              <button
                onClick={() => setReviewEnabled(!reviewEnabled)}
                className={`w-10 h-5 rounded-full transition-colors relative ${
                  reviewEnabled ? 'bg-emerald-500' : 'bg-muted'
                }`}
              >
                <span
                  className={`block w-4 h-4 rounded-full bg-white absolute top-0.5 transition-all ${
                    reviewEnabled ? 'left-5' : 'left-0.5'
                  }`}
                />
              </button>
            </div>

            {reviewEnabled && workspaces.some(ws => ws.label.trim()) && (
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  Agent Skills Source (CLAUDE.md / .claude/)
                </label>
                <select
                  value={reviewSkillSource}
                  onChange={(e) => setReviewSkillSource(e.target.value)}
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm"
                >
                  <option value="auto">Auto (use reviewed task's workspace)</option>
                  {workspaces
                    .filter(ws => ws.label.trim())
                    .map(ws => (
                      <option key={ws.label} value={ws.label.trim()}>
                        Use "{ws.label.trim()}" workspace skills
                      </option>
                    ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  Choose which workspace's CLAUDE.md and .claude/ settings the review agent should follow.
                </p>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setStep('mode')}
              className="px-4 py-2 bg-muted text-foreground rounded-md text-sm"
            >
              Back
            </button>
            <button
              onClick={handleCreate}
              disabled={!isWorkspacesValid}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-50"
            >
              Create Project
            </button>
          </div>
        </div>
      )}

      {/* Step 3: Content (Spec: upload docs, Creative: interview) */}
      {step === 'content' && projectId && (
        <div>
          {mode === 'spec' ? (
            <div className="space-y-4">
              <DocumentUpload projectId={projectId} />

              {/* Requirement input */}
              <div>
                <label className="block text-sm font-medium mb-1">Requirement / Instructions</label>
                <p className="text-xs text-muted-foreground mb-2">
                  Describe what you want the agents to implement this round. This will be included in the prompt sent to each agent.
                </p>
                <textarea
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  placeholder="e.g. Implement the user authentication module based on the SD spec, including login, registration, and JWT token management..."
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[100px] resize-y"
                />
              </div>

              <button
                onClick={handleStartExecution}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md text-sm"
              >
                Start Execution
              </button>
            </div>
          ) : (
            <InterviewChat projectId={projectId} />
          )}
        </div>
      )}

      {/* Step 4: Execution started */}
      {step === 'execute' && (
        <div className="text-center py-12">
          <h3 className="text-xl font-bold mb-2">Execution Started!</h3>
          <p className="text-muted-foreground">
            Switch to the Dashboard view to monitor agent progress.
          </p>
        </div>
      )}
    </div>
  );
}
