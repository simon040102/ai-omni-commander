import { useState, useCallback, useMemo } from 'react';
import { useWsStore } from '../../stores/wsStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import { useToastStore } from '../../stores/toastStore';
import { ModeSelector } from '../project/ModeSelector';
import type { TaskMode } from '../project/ModeSelector';
import { QuickModeSetup } from '../project/QuickModeSetup';
import { FolderPicker } from '../project/FolderPicker';
import { TerminalOutput } from '../dashboard/TerminalOutput';
import { IconPlay, IconChevronDown, IconChevronRight, IconTrash } from '../ui/Icons';
import type { View } from '../layout/AppShell';
import type { DocType } from '@omni/shared';

interface NewTaskViewProps {
  onViewChange: (view: View) => void;
}

interface PendingDoc {
  filename: string;
  content: string; // base64
  fileType: string;
  docType: DocType;
}

function detectDocType(filename: string): DocType {
  const upper = filename.toUpperCase();
  if (upper.includes('SA') || upper.includes('系統分析') || upper.includes('需求')) return 'SA';
  return 'SD';
}

const ROLE_COLORS: Record<string, string> = {
  frontend: 'text-blue-400',
  backend: 'text-purple-400',
  devops: 'text-green-400',
  testing: 'text-teal-400',
  review: 'text-gray-400',
  architect: 'text-orange-400',
};

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-green-500 animate-pulse',
  completed: 'bg-blue-500',
  failed: 'bg-red-500',
  idle: 'bg-gray-500',
};

export function NewTaskView({ onViewChange }: NewTaskViewProps) {
  const client = useWsStore(s => s.client);
  const setCurrentProject = useProjectStore(s => s.setCurrentProject);
  const addToast = useToastStore(s => s.addToast);
  const projects = useProjectStore(s => s.projects);
  const allAgents = useProjectStore(s => s.agents);
  const agentOutputs = useAgentStore(s => s.outputs);

  const [mode, setMode] = useState<TaskMode>('quick');
  const [model, setModel] = useState('sonnet');
  const [showForm, setShowForm] = useState(true);
  const [expandedAgentId, setExpandedAgentId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [mcpCommand, setMcpCommand] = useState<string | null>(null);

  // Spec mode state
  const [specWorkspacePath, setSpecWorkspacePath] = useState('');
  const [specDocuments, setSpecDocuments] = useState<PendingDoc[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Quick Run projects: those named "Quick-*"
  const quickProjects = useMemo(() => {
    return [...projects]
      .filter(p => p.name.startsWith('Quick-'))
      .sort((a, b) => {
        const dateA = new Date(a.createdAt.endsWith('Z') ? a.createdAt : a.createdAt + 'Z').getTime();
        const dateB = new Date(b.createdAt.endsWith('Z') ? b.createdAt : b.createdAt + 'Z').getTime();
        return dateB - dateA;
      });
  }, [projects]);

  // Agents grouped by quick project
  const quickAgents = useMemo(() => {
    const projectIds = new Set(quickProjects.map(p => p.id));
    return allAgents.filter(a => projectIds.has(a.projectId));
  }, [quickProjects, allAgents]);

  const generateProjectName = useCallback(() => {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const seq = String(Math.floor(Math.random() * 999) + 1).padStart(3, '0');
    return `Quick-${date}-${seq}`;
  }, []);

  // Read file as base64
  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1] || '';
        resolve(base64);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileUpload = useCallback(async (fileList: FileList | null) => {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const base64 = await readFileAsBase64(file);
      setSpecDocuments(prev => [...prev, {
        filename: file.name,
        content: base64,
        fileType: 'base64',
        docType: detectDocType(file.name),
      }]);
    }
  }, []);

  // Quick Mode handler — generates MCP command for user to paste into Claude Code
  const handleQuickStart = useCallback((quickTask: {
    type: string;
    description: string;
    errorLog?: string;
    relatedFiles?: string[];
    role?: string;
    useWorkspaceSkills?: boolean;
    workspacePath: string;
  }) => {
    const typeLabel = { bug: 'Bug Fix', feature: 'New Feature', refactor: 'Refactor', other: 'Task' }[quickTask.type] || 'Task';
    const errorSection = quickTask.errorLog ? `\n\n錯誤訊息：\n${quickTask.errorLog}` : '';
    const filesSection = quickTask.relatedFiles?.length ? `\n\n相關檔案：${quickTask.relatedFiles.join(', ')}` : '';

    const command = `請在工作目錄 \`${quickTask.workspacePath}\` 執行以下任務。

## ${typeLabel}

${quickTask.description}${errorSection}${filesSection}

## 執行方式
使用 Agent tool 派出一個 subagent，在 \`${quickTask.workspacePath}\` 目錄中執行開發工作。
${quickTask.useWorkspaceSkills ? '請先讀取工作目錄中的 CLAUDE.md 和 .claude/ 設定。' : ''}`;

    setMcpCommand(command);

    // Save path to recent
    fetch('/api/recent-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: quickTask.workspacePath }),
    }).catch(() => {});
  }, []);

  // Spec Mode handler — auto-creates project, uploads docs, starts execution
  const handleSpecStart = useCallback(() => {
    if (!client || !specWorkspacePath.trim() || specDocuments.length === 0) return;

    const projectId = crypto.randomUUID();
    const projectName = generateProjectName();

    // Create lightweight project
    client.send({
      type: 'project.create',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId,
        name: projectName,
        workingDir: specWorkspacePath.trim(),
        frontendPath: null,
        backendPath: specWorkspacePath.trim(),
      },
    });

    // Upload documents
    for (const doc of specDocuments) {
      client.send({
        type: 'project.uploadDocument',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId,
          filename: doc.filename,
          content: doc.content,
          fileType: doc.fileType,
          docType: doc.docType,
        },
      });
    }

    // Start execution
    client.send({
      type: 'project.startExecution',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId,
        model,
      },
    });

    // Save path to recent
    fetch('/api/recent-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: specWorkspacePath.trim() }),
    }).catch(() => {});

    addToast({ type: 'success', title: 'Spec execution started', message: `"${projectName}"` });
    setShowForm(false);
  }, [client, specWorkspacePath, specDocuments, model, generateProjectName, addToast]);

  const handleDeleteProject = useCallback((projectId: string) => {
    client?.send({
      type: 'project.delete',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId },
    });
    setConfirmDeleteId(null);
    addToast({ type: 'success', title: 'Quick Run deleted' });
  }, [client, addToast]);

  const handleSendCommand = useCallback((agentId: string, command: string) => {
    if (!client) return;
    client.send({
      type: 'agent.command',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId, command },
    });
  }, [client]);

  const handleAgentAction = useCallback((agentId: string, action: 'stop' | 'restart') => {
    if (!client) return;
    client.send({
      type: 'agent.action',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { agentId, action },
    });
  }, [client]);

  const handleGoToProject = (projectId: string) => {
    setCurrentProject(projectId);
    client?.send({
      type: 'project.getState',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId },
    });
    onViewChange('agents');
  };

  const runningCount = quickAgents.filter(a => a.status === 'running').length;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Quick Run</h2>
          <p className="text-sm text-muted-foreground mt-1">
            快速啟動 Agent 執行任務
            {runningCount > 0 && (
              <span className="ml-2 text-green-400 font-medium">{runningCount} running</span>
            )}
          </p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          {showForm ? <IconChevronDown className="w-4 h-4" /> : <IconPlay className="w-4 h-4" />}
          {showForm ? '收起' : '新增 Quick Run'}
        </button>
      </div>

      {/* Quick task form (collapsible) */}
      {showForm && (
        <div className="bg-card border border-border rounded-lg p-4 animate-fade-in">
          <div className="space-y-4">
            <ModeSelector mode={mode} onModeChange={setMode} />

            {mode === 'quick' && (
              <QuickModeSetup
                selectedModel={model}
                onModelChange={setModel}
                onStartExecution={handleQuickStart}
              />
            )}

            {mode === 'spec' && (
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Workspace Path <span className="text-red-400">*</span>
                  </label>
                  <FolderPicker value={specWorkspacePath} onChange={setSpecWorkspacePath} />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-2">
                    Upload SA/SD Documents <span className="text-red-400">*</span>
                  </label>

                  <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => { e.preventDefault(); setIsDragging(false); handleFileUpload(e.dataTransfer.files); }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                      isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground'
                    }`}
                    onClick={() => document.getElementById('new-task-file-input')?.click()}
                  >
                    <p className="text-sm text-muted-foreground">
                      {isDragging ? 'Drop files here' : 'Drop files here or click to browse'}
                    </p>
                    <input
                      id="new-task-file-input"
                      type="file"
                      multiple
                      accept=".md,.txt,.pdf,.doc,.docx"
                      className="hidden"
                      onChange={(e) => { handleFileUpload(e.target.files); e.target.value = ''; }}
                    />
                  </div>

                  {specDocuments.length > 0 && (
                    <div className="mt-3 space-y-1.5">
                      {specDocuments.map((doc, i) => (
                        <div key={i} className="flex items-center gap-2 text-sm bg-muted/30 rounded-md px-3 py-1.5 group">
                          <button
                            onClick={() => {
                              setSpecDocuments(prev => prev.map((d, j) =>
                                j === i ? { ...d, docType: d.docType === 'SA' ? 'SD' : 'SA' } : d
                              ));
                            }}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer hover:opacity-80 ${
                              doc.docType === 'SA' ? 'bg-green-500/20 text-green-400' : 'bg-purple-500/20 text-purple-400'
                            }`}
                          >{doc.docType}</button>
                          <span className="flex-1 truncate text-muted-foreground">{doc.filename}</span>
                          <button
                            onClick={() => setSpecDocuments(prev => prev.filter((_, j) => j !== i))}
                            className="text-xs text-red-400/60 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          >remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Model</label>
                  <div className="flex gap-2">
                    {(['sonnet', 'opus', 'haiku'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setModel(m)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                          model === m
                            ? m === 'opus' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/50'
                              : m === 'haiku' ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                              : 'bg-blue-500/20 text-blue-400 border border-blue-500/50'
                            : 'bg-muted text-muted-foreground border border-border hover:border-primary/50 hover:text-foreground'
                        }`}
                      >{m.charAt(0).toUpperCase() + m.slice(1)}</button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={handleSpecStart}
                  disabled={!specWorkspacePath.trim() || specDocuments.length === 0}
                  className="group inline-flex items-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-600/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-lg shadow-blue-600/20 hover:shadow-blue-500/30 transition-all"
                >
                  <IconPlay className="w-4 h-4" />
                  Start Spec Execution
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Quick Run history */}
      {quickProjects.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground px-1">
            歷史記錄 ({quickProjects.length})
          </h3>
          {quickProjects.map(project => {
            const agents = quickAgents.filter(a => a.projectId === project.id);
            const hasRunning = agents.some(a => a.status === 'running');

            return (
              <div key={project.id} className="bg-card border border-border rounded-lg overflow-hidden">
                {/* Project header */}
                <div className="flex items-center gap-2 px-3 py-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    hasRunning ? 'bg-green-500 animate-pulse' :
                    project.status === 'completed' ? 'bg-blue-500' :
                    project.status === 'failed' ? 'bg-red-500' :
                    'bg-gray-500'
                  }`} />
                  <span className="text-sm font-medium truncate flex-1">{project.name}</span>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0">
                    {new Date(project.createdAt.endsWith('Z') ? project.createdAt : project.createdAt + 'Z').toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button
                    onClick={() => handleGoToProject(project.id)}
                    className="text-[10px] text-primary hover:underline flex-shrink-0"
                  >
                    詳細
                  </button>
                  {confirmDeleteId === project.id ? (
                    <div className="flex items-center gap-1 animate-fade-in">
                      <button onClick={() => handleDeleteProject(project.id)} className="text-[10px] text-red-400 font-semibold px-1.5 py-0.5 bg-red-500/20 rounded">Yes</button>
                      <button onClick={() => setConfirmDeleteId(null)} className="text-[10px] text-muted-foreground px-1">No</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(project.id)}
                      className="p-1 text-muted-foreground/30 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors flex-shrink-0"
                    >
                      <IconTrash className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Agents for this project */}
                {agents.length > 0 && (
                  <div className="border-t border-border/50">
                    {agents.map(agent => {
                      const isExpanded = expandedAgentId === agent.id;
                      const outputs = agentOutputs[agent.id] || [];

                      return (
                        <div key={agent.id}>
                          <button
                            onClick={() => setExpandedAgentId(isExpanded ? null : agent.id)}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/30 transition-colors"
                          >
                            {isExpanded
                              ? <IconChevronDown className="w-3 h-3 text-muted-foreground" />
                              : <IconChevronRight className="w-3 h-3 text-muted-foreground" />
                            }
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_COLORS[agent.status] || 'bg-gray-500'}`} />
                            <span className={`font-medium ${ROLE_COLORS[agent.role] || 'text-foreground'}`}>{agent.role}</span>
                            {agent.title && (
                              <span className="text-muted-foreground truncate">{agent.title}</span>
                            )}
                            <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">
                              {agent.model}
                              {agent.totalCostUsd > 0 && ` · $${agent.totalCostUsd.toFixed(3)}`}
                            </span>
                          </button>

                          {/* Inline terminal */}
                          {isExpanded && (
                            <div className="border-t border-border/30">
                              <div className="h-[300px]">
                                <TerminalOutput
                                  outputs={outputs}
                                  title={agent.title || agent.role}
                                  role={agent.role}
                                  status={agent.status}
                                  agentId={agent.id}
                                  model={agent.model}
                                  totalInputTokens={agent.totalInputTokens}
                                  totalOutputTokens={agent.totalOutputTokens}
                                  onSendCommand={(cmd) => handleSendCommand(agent.id, cmd)}
                                  onAction={(agentId, action) => handleAgentAction(agentId, action)}
                                  compact
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* No agents yet */}
                {agents.length === 0 && (
                  <div className="border-t border-border/50 px-3 py-2">
                    <span className="text-xs text-muted-foreground italic">等待 Agent 啟動...</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : !showForm ? (
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">還沒有 Quick Run 記錄</p>
          <button
            onClick={() => setShowForm(true)}
            className="mt-3 text-sm text-primary hover:underline"
          >
            建立第一個 Quick Run
          </button>
        </div>
      ) : null}

      {/* MCP Command Modal */}
      {mcpCommand && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMcpCommand(null)}>
          <div className="bg-card border border-border rounded-xl shadow-2xl w-[680px] max-w-[90vw] p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Execute via MCP</h3>
              <button onClick={() => setMcpCommand(null)} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground">&times;</button>
            </div>
            <p className="text-sm text-muted-foreground mb-3">Copy this instruction and paste it into Claude Code:</p>
            <div className="relative">
              <pre className="bg-muted/50 border border-border rounded-lg p-4 text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed select-all max-h-[50vh] overflow-y-auto">{mcpCommand}</pre>
              <button
                onClick={() => { navigator.clipboard.writeText(mcpCommand); addToast({ type: 'success', title: 'Copied!' }); }}
                className="absolute top-2 right-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
              >Copy</button>
            </div>
            <div className="mt-4 flex justify-end">
              <button onClick={() => setMcpCommand(null)} className="px-4 py-2 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 text-sm transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
