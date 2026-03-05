import { useState, useCallback, Fragment } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { ModeSelector } from './ModeSelector';
import { DocumentUpload } from './DocumentUpload';
import { InterviewChat } from './InterviewChat';
import { QuickModeSetup } from './QuickModeSetup';
import { FolderPicker } from './FolderPicker';
import { IconCheck, IconPlay, IconArrowRight, IconChevronLeft, IconPlus, IconX, IconRocket } from '../ui/Icons';
import type { View } from '../layout/AppShell';
import type { ProjectMode, QuickTaskType } from '@omni/shared';

interface WorkspaceEntry {
  label: string;
  path: string;
}

type Step = 'mode' | 'workspaces' | 'content' | 'execute';

const STEP_INFO: { key: Step; label: string; desc: string }[] = [
  { key: 'mode', label: 'Mode', desc: 'Choose mode' },
  { key: 'workspaces', label: 'Configure', desc: 'Name & paths' },
  { key: 'content', label: 'Content', desc: 'Docs / Interview' },
  { key: 'execute', label: 'Launch', desc: 'Start agents' },
];

interface ProjectSetupProps {
  onViewChange: (view: View) => void;
}

export function ProjectSetup({ onViewChange }: ProjectSetupProps) {
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<ProjectMode>('spec');
  const [name, setName] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([
    { label: '', path: '' },
  ]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [requirement, setRequirement] = useState('');

  // Validation
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Code Review settings
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [reviewSkillSource, setReviewSkillSource] = useState<string>('auto');

  // Model selection
  const [selectedModel, setSelectedModel] = useState<string>('sonnet');

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
    // Mark all as touched for validation display
    setTouched({ name: true, ...Object.fromEntries(workspaces.flatMap((_, i) => [[`ws${i}label`, true], [`ws${i}path`, true]])) });
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

    // Save workspace paths to recent paths
    for (const ws of workspaces) {
      if (ws.path.trim()) {
        fetch('/api/recent-paths', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: ws.path.trim(), label: ws.label.trim() || undefined }),
        }).catch(() => { /* ignore */ });
      }
    }

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
        model: selectedModel,
      },
    });
    addToast({ type: 'info', title: 'Execution started', message: `Using ${selectedModel} model...` });
    setStep('execute');
  }, [projectId, client, addToast, requirement, selectedModel]);

  const handleQuickStartExecution = useCallback((quickTask: {
    type: QuickTaskType;
    description: string;
    errorLog?: string;
    relatedFiles?: string[];
  }) => {
    if (!projectId) return;
    client?.send({
      type: 'project.startExecution',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId,
        model: selectedModel,
        quickTask,
      },
    });
    addToast({ type: 'info', title: 'Quick task started', message: `Using ${selectedModel} model...` });
    setStep('execute');
  }, [projectId, client, addToast, selectedModel]);

  const currentStepIndex = STEP_INFO.findIndex(s => s.key === step);

  // For quick mode, adjust step labels
  const stepInfo = mode === 'quick'
    ? [
        { key: 'mode' as const, label: 'Mode', desc: 'Choose mode' },
        { key: 'workspaces' as const, label: 'Configure', desc: 'Name & path' },
        { key: 'content' as const, label: 'Task', desc: 'Describe task' },
        { key: 'execute' as const, label: 'Launch', desc: 'Start agent' },
      ]
    : STEP_INFO;

  return (
    <div className="max-w-2xl mx-auto">
      <h2 className="text-2xl font-bold mb-6">New Project</h2>

      {/* ─── Stepper ─── */}
      <div className="flex items-center mb-10">
        {stepInfo.map((s, i) => {
          const isCompleted = i < currentStepIndex;
          const isActive = i === currentStepIndex;
          return (
            <Fragment key={s.key}>
              {i > 0 && (
                <div className={`h-0.5 flex-1 mx-2 rounded transition-colors duration-500 ${
                  isCompleted ? 'bg-primary' : isActive ? 'bg-primary/40' : 'bg-border'
                }`} />
              )}
              <div className="flex flex-col items-center gap-1.5 min-w-[4rem]">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-all duration-500 ${
                  isCompleted
                    ? 'bg-primary border-primary text-primary-foreground'
                    : isActive
                      ? 'border-primary text-primary bg-primary/10 shadow-[0_0_10px_rgba(59,130,246,0.25)]'
                      : 'border-border text-muted-foreground'
                }`}>
                  {isCompleted ? <IconCheck className="w-4 h-4" /> : (i + 1)}
                </div>
                <div className="text-center">
                  <div className={`text-xs font-medium ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {s.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground/60 hidden sm:block">
                    {s.desc}
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* ─── Step 1: Mode Selection ─── */}
      {step === 'mode' && (
        <div>
          <ModeSelector mode={mode} onModeChange={setMode} />
          <div className="mt-8">
            <button
              onClick={() => setStep('workspaces')}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
            >
              Next
              <IconArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ─── Step 2: Project Name + Workspaces + Review Config ─── */}
      {step === 'workspaces' && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(prev => ({ ...prev, name: true }))}
              placeholder={mode === 'quick' ? "Quick Fix - Login Bug" : "My Awesome Project"}
              className={`w-full bg-muted border rounded-md px-3 py-2 text-sm outline-none transition-colors ${
                touched.name && !name.trim()
                  ? 'border-red-500/50 focus:border-red-500 focus:ring-1 focus:ring-red-500/30'
                  : 'border-border focus:border-primary focus:ring-1 focus:ring-primary/30'
              }`}
            />
            {touched.name && !name.trim() && (
              <p className="text-xs text-red-400 mt-1">Project name is required</p>
            )}
          </div>

          {/* Workspaces */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium">
                {mode === 'quick' ? 'Workspace' : 'Workspaces'}
              </label>
              {mode !== 'quick' && (
                <button
                  onClick={addWorkspace}
                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 bg-primary/15 text-primary rounded-md hover:bg-primary/25 transition-colors"
                >
                  <IconPlus className="w-3 h-3" />
                  Add Workspace
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              {mode === 'quick'
                ? 'Select the folder where the agent will work.'
                : 'Add the folders that agents will work on. Give each a label (e.g. "frontend", "backend").'
              }
            </p>

            <div className="space-y-3">
              {workspaces.map((ws, index) => (
                <div key={index} className="flex gap-2 items-start">
                  <div className="w-32 shrink-0">
                    <input
                      type="text"
                      value={ws.label}
                      onChange={(e) => updateWorkspace(index, 'label', e.target.value)}
                      onBlur={() => setTouched(prev => ({ ...prev, [`ws${index}label`]: true }))}
                      placeholder="Label"
                      className={`w-full bg-muted border rounded-md px-3 py-2 text-sm outline-none transition-colors ${
                        touched[`ws${index}label`] && !ws.label.trim()
                          ? 'border-red-500/50 focus:border-red-500'
                          : 'border-border focus:border-primary focus:ring-1 focus:ring-primary/30'
                      }`}
                    />
                    {touched[`ws${index}label`] && !ws.label.trim() && (
                      <p className="text-[10px] text-red-400 mt-0.5">Required</p>
                    )}
                  </div>
                  <div className="flex-1">
                    <FolderPicker
                      value={ws.path}
                      onChange={(p) => updateWorkspace(index, 'path', p)}
                    />
                  </div>
                  {workspaces.length > 1 && mode !== 'quick' && (
                    <button
                      onClick={() => removeWorkspace(index)}
                      className="shrink-0 p-2 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                      title="Remove"
                    >
                      <IconX className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Code Review Agent Config - hide for quick mode */}
          {mode !== 'quick' && (
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
                    className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
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
          )}

          <div className="flex gap-3">
            <button
              onClick={() => setStep('mode')}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-secondary text-secondary-foreground rounded-lg text-sm font-medium hover:bg-secondary/80 transition-colors"
            >
              <IconChevronLeft className="w-4 h-4" />
              Back
            </button>
            <button
              onClick={handleCreate}
              disabled={!isWorkspacesValid}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              Create Project
              <IconArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ─── Step 3: Content (Spec: upload docs, Creative: interview, Quick: task form) ─── */}
      {step === 'content' && projectId && (
        <div>
          {mode === 'spec' ? (
            <div className="space-y-4">
              <DocumentUpload projectId={projectId} />

              <div>
                <label className="block text-sm font-medium mb-1">Requirement / Instructions</label>
                <p className="text-xs text-muted-foreground mb-2">
                  Describe what you want the agents to implement this round. This will be included in the prompt sent to each agent.
                </p>
                <textarea
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  placeholder="e.g. Implement the user authentication module based on the SD spec, including login, registration, and JWT token management..."
                  className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm min-h-[100px] resize-y outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>

              {/* Model Selection */}
              <div>
                <label className="block text-sm font-medium mb-1">Model</label>
                <p className="text-xs text-muted-foreground mb-2">
                  Choose which Claude model the agents will use.
                </p>
                <div className="flex gap-2">
                  {(['sonnet', 'opus', 'haiku'] as const).map((model) => (
                    <button
                      key={model}
                      onClick={() => setSelectedModel(model)}
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

              <button
                onClick={handleStartExecution}
                className="group inline-flex items-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-500 text-white rounded-lg text-sm font-semibold shadow-lg shadow-green-600/20 hover:shadow-green-500/30 transition-all"
              >
                <IconPlay className="w-4 h-4" />
                Start Execution
              </button>
            </div>
          ) : mode === 'creative' ? (
            <InterviewChat projectId={projectId} />
          ) : (
            <QuickModeSetup
              projectId={projectId}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              onStartExecution={handleQuickStartExecution}
            />
          )}
        </div>
      )}

      {/* ─── Step 4: Execution started ─── */}
      {step === 'execute' && (
        <div className="text-center py-16">
          <div className={`w-16 h-16 mx-auto mb-6 rounded-full flex items-center justify-center ${
            mode === 'quick' ? 'bg-amber-500/10' : 'bg-green-500/10'
          }`}>
            <IconRocket className={`w-8 h-8 ${mode === 'quick' ? 'text-amber-400' : 'text-green-400'}`} />
          </div>
          <h3 className="text-xl font-bold mb-2">
            {mode === 'quick' ? 'Quick Task Started!' : 'Execution Started!'}
          </h3>
          <p className="text-muted-foreground mb-8 max-w-sm mx-auto">
            {mode === 'quick'
              ? 'The agent is working on your task. Monitor progress in real time.'
              : 'Agents are being spawned and will begin working on your project. Monitor their progress in real time.'
            }
          </p>
          <button
            onClick={() => onViewChange('dashboard')}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-semibold hover:bg-primary/90 transition-colors shadow-sm"
          >
            Go to Dashboard
            <IconArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
