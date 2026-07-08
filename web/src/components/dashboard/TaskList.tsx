import { useState, useCallback, useRef, useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useWsStore } from '../../stores/wsStore';
import { useToastStore } from '../../stores/toastStore';
import { AsanaImportDrawer } from './AsanaImportDrawer';
import { SvnBrowser } from './SvnBrowser';
import { IconPlus, IconPlay, IconTrash, IconX, IconChevronDown, IconChevronRight, IconAsana, IconDocument, IconExternalLink, IconUpload, IconCheck, IconRefresh, IconGrid } from '../ui/Icons';
import type { TaskType, Task } from '../../stores/projectStore';
import type { TestOptions } from '@omni/shared';
import type { View } from '../layout/AppShell';

const TASK_TYPE_COLORS: Record<TaskType, string> = {
  bug: 'bg-red-500/20 text-red-400',
  feature: 'bg-blue-500/20 text-blue-400',
  refactor: 'bg-purple-500/20 text-purple-400',
  testing: 'bg-teal-500/15 text-teal-400',
  other: 'bg-muted text-muted-foreground',
};

const LABEL_COLORS: Record<string, string> = {
  frontend: 'bg-blue-500/15 text-blue-400',
  backend: 'bg-purple-500/15 text-purple-400',
  fullstack: 'bg-violet-500/15 text-violet-400',
  devops: 'bg-green-500/15 text-green-400',
  testing: 'bg-teal-500/15 text-teal-400',
  review: 'bg-gray-500/15 text-gray-400',
  architect: 'bg-orange-500/15 text-orange-400',
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  in_progress: 'bg-green-500/15 text-green-400 border-green-500/30',
  completed: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
  blocked: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  queued: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  assigned: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  needs_review: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  needs_intervention: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
};

/** Auto-detect document type from filename */
function detectDocType(file: File): 'SA' | 'SD' | 'image' {
  if (file.type.startsWith('image/')) return 'image';
  const name = file.name;
  // 前端 → SA (even if filename contains SD, e.g., "前端SD")
  if (/前端/.test(name)) return 'SA';
  // 後端 → SD
  if (/後端/.test(name)) return 'SD';
  // Explicit SD
  if (/\bSD\b|設計|design/i.test(name)) return 'SD';
  // SA patterns
  if (/\bSA\b|需求|spec|requirement/i.test(name)) return 'SA';
  // Default to SD
  return 'SD';
}

/** Convert SVN download URL to VisualSVN web viewer URL.
 *  https://host/svn/Repo/path/file → https://host/!/#Repo/view/head/path/file */
function svnToWebViewUrl(svnUrl: string): string {
  const m = svnUrl.match(/^(https?:\/\/[^/]+)\/svn\/([^/]+)\/(.+)$/);
  if (!m) return svnUrl;
  const [, origin, repo, filePath] = m;
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `${origin}/!/#${encodeURIComponent(repo)}/view/head/${encoded}`;
}

function getSpecTypeBadge(url: string): { label: string; className: string } {
  if (/^https?:\/\//i.test(url)) return { label: 'HTTP', className: 'bg-blue-500/15 text-blue-400' };
  if (/^svn(\+ssh)?:\/\//i.test(url)) return { label: 'SVN', className: 'bg-orange-500/15 text-orange-400' };
  return { label: 'Local', className: 'bg-green-500/15 text-green-400' };
}

interface TaskListProps {
  selectedModel: string;
  onViewChange?: (view: View) => void;
}

export function TaskList({ selectedModel, onViewChange }: TaskListProps) {
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const tasks = useProjectStore(s => s.tasks);
  const project = useProjectStore(s => s.projects.find(p => p.id === s.currentProjectId));
  const client = useWsStore(s => s.client);
  const addToast = useToastStore(s => s.addToast);

  const [showAddForm, setShowAddForm] = useState(false);
  const [showImportDrawer, setShowImportDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newTaskType, setNewTaskType] = useState<TaskType>('feature');
  const [newLabel, setNewLabel] = useState('frontend');
  const [newSpecUrl, setNewSpecUrl] = useState('');
  const [newBackendSpecUrl, setNewBackendSpecUrl] = useState('');
  const [newTestOptions, setNewTestOptions] = useState({ smokeTest: false, e2eSpec: false, consoleScript: false, useMock: true, useRealApi: false, headed: false, integrationTest: false });
  const [stagedFiles, setStagedFiles] = useState<Array<{ file: File; docType: 'SA' | 'SD' | 'image' }>>([]);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [confirmClearAsana, setConfirmClearAsana] = useState(false);
  const [showSvnBrowser, setShowSvnBrowser] = useState<'frontend' | 'backend' | false>(false);
  const [mcpCommandTaskId, setMcpCommandTaskId] = useState<string | null>(null);
  const [showSvnBrowserForEdit, setShowSvnBrowserForEdit] = useState<'frontend' | 'backend' | false>(false);
  const svnBrowserEditCallback = useRef<((url: string) => void) | null>(null);
  const pendingUploadsRef = useRef<Array<{ file: File; docType: 'SA' | 'SD' | 'image' }>>([]);
  const autoExpandNextTask = useRef(false);
  const autoExecuteAfterCreate = useRef<{ testOptions: TestOptions; executionRunId: string } | null>(null);
  const handleExecuteTaskRef = useRef<((taskId: string, modelOverride?: string, mockupFiles?: string[], testOptions?: TestOptions, executionRunId?: string) => void) | null>(null);

  // Check if project has SVN config
  const svnPaths = (() => {
    if (!project?.configJson) return { frontend: false, backend: false };
    try {
      const config = JSON.parse(project.configJson);
      return {
        frontend: !!config?.svnConfig?.frontendSpecPath,
        backend: !!config?.svnConfig?.backendSpecPath,
      };
    } catch { return { frontend: false, backend: false }; }
  })();
  const hasSvnConfig = svnPaths.frontend || svnPaths.backend;

  // Available labels based on project paths
  const availableLabels: string[] = [];
  if (project?.frontendPath) availableLabels.push('frontend');
  if (project?.backendPath) availableLabels.push('backend');
  if (project?.frontendPath && project?.backendPath) availableLabels.push('fullstack');
  if (availableLabels.length === 0) availableLabels.push('frontend', 'backend');

  const projectTasks = currentProjectId
    ? tasks.filter(t => t.projectId === currentProjectId)
    : [];

  const handleCreateTask = useCallback(() => {
    if (!currentProjectId || !client || !newTitle.trim()) return;

    // Stage files for upload after task creation
    pendingUploadsRef.current = [...stagedFiles];
    autoExpandNextTask.current = true;

    // Combine frontend + backend spec URLs
    const specUrls = [newSpecUrl.trim(), newBackendSpecUrl.trim()].filter(Boolean);
    const combinedSpecUrl = specUrls.join('\n') || undefined;

    client.send({
      type: 'task.create',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        taskType: newTaskType,
        label: newLabel as any,
        specUrl: combinedSpecUrl,
      },
    });

    addToast({ type: 'success', title: '已建立任務', message: newTitle.trim() });
    setNewTitle('');
    setNewDescription('');
    setNewSpecUrl('');
    setNewBackendSpecUrl('');
    setStagedFiles([]);
    setShowAddForm(false);
  }, [currentProjectId, client, newTitle, newDescription, newTaskType, newLabel, newSpecUrl, newBackendSpecUrl, stagedFiles, addToast]);

  // When a new task is created, auto-expand and upload staged files
  const prevTaskCount = useRef(projectTasks.length);
  useEffect(() => {
    if (projectTasks.length > prevTaskCount.current && autoExpandNextTask.current) {
      const newTask = projectTasks[projectTasks.length - 1];
      if (newTask) {
        setExpandedTaskId(newTask.id);

        // Upload staged files with the new task ID
        const uploads = pendingUploadsRef.current;
        if (uploads.length > 0 && currentProjectId && client) {
          for (const { file, docType } of uploads) {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(',')[1];
              client.send({
                type: 'project.uploadDocument',
                id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                payload: {
                  projectId: currentProjectId,
                  filename: file.name,
                  taskId: newTask.id,
                  content: base64,
                  fileType: 'base64',
                  docType: docType === 'image' ? 'SD' : docType,
                },
              });
            };
            reader.readAsDataURL(file);
          }
          addToast({ type: 'success', title: `${uploads.length} file(s) uploaded` });
          pendingUploadsRef.current = [];
        }
      }
      // Auto-execute if requested
      if (autoExecuteAfterCreate.current) {
        const { testOptions, executionRunId } = autoExecuteAfterCreate.current;
        autoExecuteAfterCreate.current = null;
        if (handleExecuteTaskRef.current) {
          handleExecuteTaskRef.current(newTask.id, undefined, [], testOptions, executionRunId);
        }
      }

      autoExpandNextTask.current = false;
    }
    prevTaskCount.current = projectTasks.length;
  }, [projectTasks.length, currentProjectId, client, addToast]);

  const handleDeleteTask = useCallback((taskId: string) => {
    if (!currentProjectId || !client) return;

    client.send({
      type: 'task.delete',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: currentProjectId, taskId },
    });

    addToast({ type: 'success', title: '已刪除任務' });
  }, [currentProjectId, client, addToast]);

  const handleClearAsanaTasks = useCallback(() => {
    if (!currentProjectId || !client) return;

    client.send({
      type: 'task.bulkDeleteBySource',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: currentProjectId, source: 'asana' },
    });

    addToast({ type: 'success', title: '已清除所有 Asana 任務' });
    setConfirmClearAsana(false);
  }, [currentProjectId, client, addToast]);

  const handleUpdateTask = useCallback((taskId: string, updates: { description?: string | null; label?: string; taskType?: TaskType }) => {
    if (!currentProjectId || !client) return;

    client.send({
      type: 'task.update',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { projectId: currentProjectId, taskId, ...updates },
    });
  }, [currentProjectId, client]);

  const handleExecuteTask = useCallback((taskId: string, _modelOverride?: string, _mockupFiles?: string[], _testOptions?: TestOptions, _executionRunId?: string) => {
    if (!currentProjectId) return;
    setMcpCommandTaskId(taskId);
    setExpandedTaskId(null);
  }, [currentProjectId]);
  handleExecuteTaskRef.current = handleExecuteTask;

  const handleUploadImage = useCallback((taskId: string, file: File, executionRunId?: string) => {
    if (!currentProjectId || !client) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      client.send({
        type: 'project.uploadDocument',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId: currentProjectId,
          filename: file.name,
          taskId,
          content: base64,
          fileType: 'base64',
          docType: 'SD',
          ...(executionRunId ? { executionRunId } : {}),
        },
      });
      addToast({ type: 'success', title: '已上傳圖片', message: file.name });
    };
    reader.readAsDataURL(file);
  }, [currentProjectId, client, addToast]);

  const handleUploadDoc = useCallback((taskId: string, file: File, docType: 'SA' | 'SD', executionRunId?: string) => {
    if (!currentProjectId || !client) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      client.send({
        type: 'project.uploadDocument',
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId: currentProjectId,
          filename: file.name,
          taskId,
          content: base64,
          fileType: 'base64',
          docType,
          ...(executionRunId ? { executionRunId } : {}),
        },
      });
      addToast({ type: 'success', title: `${docType} document uploaded`, message: file.name });
    };
    reader.readAsDataURL(file);
  }, [currentProjectId, client, addToast]);

  const hasAsana = !!project?.asanaProjectGid;
  const asanaTaskCount = projectTasks.filter(t => t.source === 'asana').length;

  return (
    <>
      <div className="bg-card border border-border rounded-lg p-3">
        {/* Header — clickable to collapse */}
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={() => setCollapsed(prev => !prev)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            {collapsed
              ? <IconChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
              : <IconChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            }
            <h3 className="text-sm font-semibold">Tasks</h3>
            {projectTasks.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                {projectTasks.length}
              </span>
            )}
          </button>
          <div className="flex items-center gap-1.5">
            {/* Clear Asana tasks */}
            {asanaTaskCount > 0 && !collapsed && (
              confirmClearAsana ? (
                <div className="flex items-center gap-1 animate-fade-in">
                  <span className="text-[9px] text-muted-foreground">Clear {asanaTaskCount} Asana tasks?</span>
                  <button
                    onClick={handleClearAsanaTasks}
                    className="text-[9px] text-red-400 hover:text-red-300 font-semibold px-1.5 py-0.5 bg-red-500/20 rounded"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmClearAsana(false)}
                    className="text-[9px] text-muted-foreground hover:text-foreground px-1 py-0.5"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClearAsana(true)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Clear all Asana-imported tasks"
                >
                  <IconTrash className="w-3 h-3" />
                  Clear Asana
                </button>
              )
            )}
            {hasAsana && (
              <button
                onClick={() => setShowImportDrawer(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-orange-500/15 text-orange-400 hover:bg-orange-500/25 transition-colors"
              >
                <IconAsana className="w-3 h-3" />
                Import from Asana
              </button>
            )}
            {!showAddForm && !collapsed && (
              <button
                onClick={() => setShowAddForm(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                <IconPlus className="w-3 h-3" />
                Add Task
              </button>
            )}
          </div>
        </div>

        {/* Collapsible task list */}
        {!collapsed && (
          <>
            {projectTasks.length === 0 && !showAddForm && (
              <p className="text-xs text-muted-foreground py-3 text-center">
                No tasks yet. Add tasks or import from Asana to start.
              </p>
            )}

            {projectTasks.length > 0 && (() => {
              const asanaTasks = projectTasks.filter(t => t.source === 'asana');
              const manualTasks = projectTasks.filter(t => t.source !== 'asana');
              const renderTaskRows = (tasks: typeof projectTasks) => tasks.map(task => (
                <TaskRow
                  key={task.id}
                  task={task}
                  expandedTaskId={expandedTaskId}
                  onExecute={handleExecuteTask}
                  onDelete={handleDeleteTask}
                  onToggleExpand={(id) => setExpandedTaskId(expandedTaskId === id ? null : id)}
                  onUpdate={handleUpdateTask}
                  onUploadDoc={handleUploadDoc}
                  onUploadImage={handleUploadImage}
                  hasSvnConfig={hasSvnConfig}
                  onBrowseSvn={(type, onSelect) => {
                    svnBrowserEditCallback.current = onSelect;
                    setShowSvnBrowserForEdit(type);
                  }}
                  onViewAgents={onViewChange ? (taskId) => {
                    useProjectStore.getState().setAgentsFilterTaskId(taskId);
                    onViewChange('agents');
                  } : undefined}
                />
              ));
              return (
                <div className="space-y-3 mb-2">
                  {asanaTasks.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 px-2 mb-1">
                        <IconAsana className="w-3.5 h-3.5 text-orange-400" />
                        <span className="text-xs font-semibold text-muted-foreground">Asana Tasks</span>
                        <span className="text-[10px] text-muted-foreground">({asanaTasks.length})</span>
                      </div>
                      <div className="space-y-0.5">
                        {renderTaskRows(asanaTasks)}
                      </div>
                    </div>
                  )}
                  {manualTasks.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 px-2 mb-1">
                        <span className="text-xs font-semibold text-muted-foreground">Manual Tasks</span>
                        <span className="text-[10px] text-muted-foreground">({manualTasks.length})</span>
                      </div>
                      <div className="space-y-0.5">
                        {renderTaskRows(manualTasks)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          </>
        )}

        {/* Add task form */}
        {showAddForm && !collapsed && (
          <div className="border border-border rounded-lg p-3 space-y-2 animate-fade-in mt-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">New Task</span>
              <button
                onClick={() => { setShowAddForm(false); setNewTitle(''); setNewDescription(''); setNewSpecUrl(''); setStagedFiles([]); }}
                className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
              >
                <IconX className="w-3 h-3" />
              </button>
            </div>

            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Task title..."
              className="w-full bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && newTitle.trim()) handleCreateTask(); }}
            />

            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              onPaste={(e) => {
                const items = e.clipboardData?.items;
                if (!items) return;
                for (let i = 0; i < items.length; i++) {
                  if (items[i].type.startsWith('image/')) {
                    e.preventDefault();
                    const file = items[i].getAsFile();
                    if (file) {
                      const ext = file.type.split('/')[1] || 'png';
                      const named = new File([file], `screenshot-${Date.now()}.${ext}`, { type: file.type });
                      setStagedFiles(prev => [...prev, { file: named, docType: 'image' }]);
                      addToast({ type: 'info', title: '已暫存圖片', message: named.name });
                    }
                    return;
                  }
                }
              }}
              placeholder="Description (optional, 可貼上圖片)..."
              className="w-full bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs min-h-[100px] resize-y outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
            />

            <div>
              <span className="block text-[10px] text-muted-foreground mb-1">Type</span>
              <div className="flex flex-wrap gap-1.5">
                {(['bug', 'feature', 'refactor', 'testing', 'other'] as TaskType[]).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setNewTaskType(t)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                      t === newTaskType
                        ? `${TASK_TYPE_COLORS[t]} ring-1 ring-current border-current/30`
                        : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground hover:border-border'
                    }`}
                  >
                    {t.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-muted-foreground mb-1">Label</span>
              <div className="flex flex-wrap gap-1.5">
                {availableLabels.map(l => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setNewLabel(l)}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                      l === newLabel
                        ? `${LABEL_COLORS[l] || 'bg-primary/15 text-primary'} ring-1 ring-current border-current/30`
                        : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground hover:border-border'
                    }`}
                  >
                    {l.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {/* Test Options */}
            {(newLabel === 'frontend' || newLabel === 'backend') && (
              <div>
                <span className="block text-[10px] text-muted-foreground mb-1">測試選項</span>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {newLabel === 'frontend' && (
                    <>
                      {([
                        { key: 'smokeTest' as const, label: 'Smoke Test' },
                        { key: 'e2eSpec' as const, label: 'E2E Spec' },
                        { key: 'consoleScript' as const, label: 'Console Script' },
                      ]).map(({ key, label }) => (
                        <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={newTestOptions[key]}
                            onChange={e => setNewTestOptions(prev => ({ ...prev, [key]: e.target.checked }))}
                            className="w-3 h-3 accent-blue-500"
                          />
                          {label}
                        </label>
                      ))}
                      {/* Mock / Real API — always show for frontend (smoke test always runs) */}
                      <div className="flex gap-3 ml-2 pl-2 border-l border-border/50">
                        {([
                          { key: 'useMock' as const, label: 'Mock', color: 'accent-blue-400' },
                          { key: 'useRealApi' as const, label: 'Real API', color: 'accent-green-500' },
                        ]).map(({ key, label, color }) => (
                          <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={newTestOptions[key]}
                              onChange={e => setNewTestOptions(prev => ({ ...prev, [key]: e.target.checked }))}
                              className={`w-3 h-3 ${color}`}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                      {/* headed toggle — only when E2E Spec is checked */}
                      {newTestOptions.e2eSpec && (
                        <div className="w-full flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground">E2E 執行模式：</span>
                          <button
                            type="button"
                            onClick={() => setNewTestOptions(prev => ({ ...prev, headed: false }))}
                            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors border ${
                              !newTestOptions.headed
                                ? 'bg-gray-500/20 text-gray-300 border-gray-500/40 ring-1 ring-gray-400/30'
                                : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            背景執行
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewTestOptions(prev => ({ ...prev, headed: true }))}
                            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors border ${
                              newTestOptions.headed
                                ? 'bg-blue-500/20 text-blue-300 border-blue-500/40 ring-1 ring-blue-400/30'
                                : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            前台執行（可見畫面）
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Spec Source — Frontend */}
            {svnPaths.frontend && (
              <div>
                <label className="block text-[10px] text-muted-foreground mb-0.5">
                  前端 Spec Source
                  {newSpecUrl.trim() && (
                    <span className={`ml-1.5 px-1 py-0 rounded text-[9px] font-medium ${getSpecTypeBadge(newSpecUrl.trim()).className}`}>
                      {getSpecTypeBadge(newSpecUrl.trim()).label}
                    </span>
                  )}
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newSpecUrl}
                    onChange={(e) => setNewSpecUrl(e.target.value)}
                    placeholder="前端 spec URL / path"
                    className="flex-1 bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSvnBrowser('frontend')}
                    className="px-2 py-1.5 text-xs font-medium rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 transition-colors flex-shrink-0"
                    title="Browse frontend SVN specs"
                  >
                    SVN
                  </button>
                  {newSpecUrl && (
                    <button type="button" onClick={() => setNewSpecUrl('')} className="px-1 text-muted-foreground hover:text-red-400 transition-colors">
                      <IconX className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Spec Source — Backend */}
            {svnPaths.backend && (
              <div>
                <label className="block text-[10px] text-muted-foreground mb-0.5">
                  後端 Spec Source
                  {newBackendSpecUrl.trim() && (
                    <span className={`ml-1.5 px-1 py-0 rounded text-[9px] font-medium ${getSpecTypeBadge(newBackendSpecUrl.trim()).className}`}>
                      {getSpecTypeBadge(newBackendSpecUrl.trim()).label}
                    </span>
                  )}
                </label>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newBackendSpecUrl}
                    onChange={(e) => setNewBackendSpecUrl(e.target.value)}
                    placeholder="後端 spec URL / path"
                    className="flex-1 bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSvnBrowser('backend')}
                    className="px-2 py-1.5 text-xs font-medium rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 transition-colors flex-shrink-0"
                    title="Browse backend SVN specs"
                  >
                    SVN
                  </button>
                  {newBackendSpecUrl && (
                    <button type="button" onClick={() => setNewBackendSpecUrl('')} className="px-1 text-muted-foreground hover:text-red-400 transition-colors">
                      <IconX className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Fallback: single spec input if no SVN configured */}
            {!svnPaths.frontend && !svnPaths.backend && (
              <div>
                <label className="block text-[10px] text-muted-foreground mb-0.5">Spec Source (optional)</label>
                <input
                  type="text"
                  value={newSpecUrl}
                  onChange={(e) => setNewSpecUrl(e.target.value)}
                  placeholder="HTTP URL / local folder path"
                  className="w-full bg-muted border border-border rounded-md px-2.5 py-1.5 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
                />
              </div>
            )}

            {/* Attachments (auto-detect SA/SD/Image) */}
            <div>
              <label className="block text-[10px] text-muted-foreground mb-1">Attachments</label>
              <button
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.multiple = true;
                  input.onchange = () => {
                    const files = input.files;
                    if (!files) return;
                    const newFiles = Array.from(files).map(file => ({
                      file,
                      docType: detectDocType(file),
                    }));
                    setStagedFiles(prev => [...prev, ...newFiles]);
                  };
                  input.click();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/5 transition-colors"
              >
                <IconUpload className="w-3.5 h-3.5" />
                上傳檔案 (自動判斷 SA/SD)
              </button>
              {stagedFiles.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {stagedFiles.map((sf, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <button
                        onClick={() => {
                          setStagedFiles(prev => prev.map((f, idx) => idx === i
                            ? { ...f, docType: f.docType === 'SA' ? 'SD' : f.docType === 'SD' ? 'image' : 'SA' }
                            : f
                          ));
                        }}
                        className={`px-1.5 py-0.5 rounded text-[9px] font-medium cursor-pointer hover:opacity-80 transition-opacity ${
                          sf.docType === 'SA' ? 'bg-blue-500/15 text-blue-400' :
                          sf.docType === 'SD' ? 'bg-purple-500/15 text-purple-400' :
                          'bg-green-500/15 text-green-400'
                        }`}
                        title="點擊切換類型"
                      >{sf.docType === 'image' ? 'IMG' : sf.docType}</button>
                      <span className="text-foreground/80 truncate flex-1">{sf.file.name}</span>
                      <button
                        onClick={() => setStagedFiles(prev => prev.filter((_, idx) => idx !== i))}
                        className="text-muted-foreground hover:text-red-400 transition-colors"
                      >
                        <IconX className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCreateTask}
                disabled={!newTitle.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-muted text-foreground border border-border rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/80 transition-colors"
              >
                <IconPlus className="w-3 h-3" />
                建立
              </button>
              <button
                onClick={() => {
                  const executionRunId = crypto.randomUUID();
                  const testOptions: TestOptions = {
                    frontend: { smokeTest: newTestOptions.smokeTest, e2eSpec: newTestOptions.e2eSpec, consoleScript: newTestOptions.consoleScript, useMock: newTestOptions.useMock, useRealApi: newTestOptions.useRealApi, headed: newTestOptions.headed, integrationTest: newTestOptions.integrationTest },
                    backend: { unitTests: true, apiSmokeTest: false, apiContract: false },
                  };
                  autoExecuteAfterCreate.current = { testOptions, executionRunId };
                  handleCreateTask();
                }}
                disabled={!newTitle.trim()}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
              >
                <IconPlay className="w-3 h-3" />
                執行
              </button>
            </div>
          </div>
        )}
      </div>


      {/* Asana import drawer */}
      <AsanaImportDrawer open={showImportDrawer} onClose={() => setShowImportDrawer(false)} />

      {/* SVN browser for new task */}
      {/* MCP Command Modal */}
      {mcpCommandTaskId && (() => {
        const task = projectTasks.find(t => t.id === mcpCommandTaskId);
        const mcpCommand = `請透過 OmniCommander MCP 執行任務 ${mcpCommandTaskId}。

步驟：
1. 呼叫 get_execution_plan("${mcpCommandTaskId}") 取得完整執行計畫（含 superpowers、規格文件、完成標準、MCP 回報指示）
2. 使用 Agent tool 派出一個 subagent，將執行計畫的完整內容作為 prompt 傳入，讓 subagent 在指定 workspace 中執行開發工作
3. 執行計畫中已包含 MCP 回報指示，subagent 會自動呼叫 report_output、report_milestone 回報進度到 Web UI
4. Subagent 完成後，確認結果，呼叫 update_task_status("${mcpCommandTaskId}", "completed", "摘要") 標記完成`;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setMcpCommandTaskId(null)}>
            <div className="bg-card border border-border rounded-xl shadow-2xl w-[680px] max-w-[90vw] p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">Execute via MCP</h3>
                <button onClick={() => setMcpCommandTaskId(null)} className="p-1 rounded hover:bg-muted transition-colors">
                  <IconX className="w-4 h-4" />
                </button>
              </div>
              {task && (
                <div className="text-sm text-muted-foreground mb-3">
                  <span className="font-medium text-foreground">{task.title}</span>
                  <span className="ml-2 px-1.5 py-0.5 rounded text-xs bg-blue-500/15 text-blue-400">{task.label}</span>
                </div>
              )}
              <p className="text-sm text-muted-foreground mb-3">Copy this instruction and paste it into Claude Code / Claude Desktop:</p>
              <div className="relative">
                <pre className="bg-muted/50 border border-border rounded-lg p-4 text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed select-all">{mcpCommand}</pre>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(mcpCommand);
                    addToast({ type: 'success', title: '已複製', message: 'MCP 指令已複製到剪貼簿' });
                  }}
                  className="absolute top-2 right-2 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  Copy
                </button>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => setMcpCommandTaskId(null)}
                  className="px-4 py-2 rounded-lg bg-muted text-muted-foreground hover:bg-muted/80 text-sm transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showSvnBrowser && (
        <SvnBrowser
          lockedSpecType={showSvnBrowser}
          onSelect={(url) => {
            if (showSvnBrowser === 'backend') {
              setNewBackendSpecUrl(url);
            } else {
              setNewSpecUrl(url);
            }
            setShowSvnBrowser(false);
          }}
          onClose={() => setShowSvnBrowser(false)}
        />
      )}

      {/* SVN browser for adding SVN file to task */}
      {showSvnBrowserForEdit && (
        <SvnBrowser
          lockedSpecType={showSvnBrowserForEdit}
          onSelect={(url) => {
            svnBrowserEditCallback.current?.(url);
            svnBrowserEditCallback.current = null;
            setShowSvnBrowserForEdit(false);
          }}
          onClose={() => {
            svnBrowserEditCallback.current = null;
            setShowSvnBrowserForEdit(false);
          }}
        />
      )}
    </>
  );
}

/* ─── SVN preview types ─── */
interface SvnPreviewFile {
  filename: string;
  svnUrl: string;
  svnRoot: 'frontend' | 'backend';
  manual?: boolean;  // true = user manually added via SVN browser
}

/* ─── Single task row with expandable detail ─── */
function TaskRow({ task, expandedTaskId, onExecute, onDelete, onToggleExpand, onUpdate, onUploadDoc, onUploadImage, hasSvnConfig, onBrowseSvn, onViewAgents }: {
  task: Task;
  expandedTaskId: string | null;
  onExecute: (id: string, model?: string, mockupFiles?: string[], testOptions?: TestOptions, executionRunId?: string) => void;
  onDelete: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onUpdate: (id: string, updates: { description?: string | null; label?: string; taskType?: TaskType }) => void;
  onUploadDoc: (taskId: string, file: File, docType: 'SA' | 'SD', executionRunId?: string) => void;
  onUploadImage: (taskId: string, file: File, executionRunId?: string) => void;
  hasSvnConfig?: boolean;
  onBrowseSvn?: (specType: 'frontend' | 'backend', onSelect: (url: string) => void) => void;
  onViewAgents?: (taskId: string) => void;
}) {
  const isRunning = task.status === 'in_progress' || task.status === 'assigned';
  const isExpanded = expandedTaskId === task.id;
  const isAsana = task.source === 'asana';
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Lift SVN preview cache here so it persists across expand/collapse
  const client = useWsStore(s => s.client);
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const [svnPreviewFiles, setSvnPreviewFiles] = useState<SvnPreviewFile[]>([]);
  const [svnPreviewLoading, setSvnPreviewLoading] = useState(false);
  const [svnPreviewError, setSvnPreviewError] = useState('');
  const svnPreviewFetched = useRef(false);

  const fetchSvnPreview = useCallback(() => {
    if (!client || !currentProjectId || !hasSvnConfig) return;
    // Server will extract function code from parentName or task title as fallback

    // Keep manually-added files across reloads
    setSvnPreviewFiles(prev => prev.filter(f => f.manual));
    setSvnPreviewLoading(true);
    setSvnPreviewError('');

    const unsub = client.addMessageListener((msg) => {
      if (msg.type === 'svn.previewResult') {
        const p = msg.payload as { functionCode: string; files: SvnPreviewFile[]; error?: string };
        setSvnPreviewLoading(false);
        if (p.error) {
          setSvnPreviewError(p.error);
        } else {
          setSvnPreviewFiles(prev => {
            const manualFiles = prev.filter(f => f.manual);
            const autoFiles = (p.files || []).filter(
              af => !manualFiles.some(mf => mf.svnUrl === af.svnUrl),
            );
            return [...autoFiles, ...manualFiles];
          });
        }
        unsub();
      }
    });

    client.send({
      type: 'svn.preview',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: currentProjectId,
        taskId: task.id,
        taskLabel: 'all',
      },
    });
  }, [client, currentProjectId, hasSvnConfig, task.parentName, task.id]);

  // Fetch SVN preview once when first expanded
  useEffect(() => {
    if (!isExpanded || svnPreviewFetched.current) return;
    svnPreviewFetched.current = true;
    fetchSvnPreview();
  }, [isExpanded, fetchSvnPreview]);

  const handleAddSvnFile = useCallback((file: SvnPreviewFile) => {
    // Avoid duplicates by svnUrl
    setSvnPreviewFiles(prev => {
      if (prev.some(f => f.svnUrl === file.svnUrl)) return prev;
      return [...prev, file];
    });
  }, []);

  const handleRemoveSvnFile = useCallback((index: number) => {
    setSvnPreviewFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleBrowseSvn = useCallback((specType: 'frontend' | 'backend') => {
    onBrowseSvn?.(specType, (url: string) => {
      const filename = decodeURIComponent(url.split('/').pop() || url);
      handleAddSvnFile({ filename, svnUrl: url, svnRoot: specType, manual: true });
    });
  }, [onBrowseSvn, handleAddSvnFile]);

  return (
    <div className={isExpanded ? 'rounded-lg border border-border/60 bg-muted/40 shadow-sm' : ''}>
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted/50 group transition-colors cursor-pointer ${isExpanded ? 'rounded-b-none border-b border-border/40' : ''}`}
        onClick={() => onToggleExpand(task.id)}
      >
        {/* Expand arrow */}
        <button className="p-0 text-muted-foreground/70 flex-shrink-0">
          {isExpanded
            ? <IconChevronDown className="w-3.5 h-3.5" />
            : <IconChevronRight className="w-3.5 h-3.5" />
          }
        </button>

        {/* Type badge */}
        <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 w-[3.5rem] text-center ${TASK_TYPE_COLORS[task.taskType] || TASK_TYPE_COLORS.other}`}>
          {task.taskType}
        </span>

        {/* Label badge */}
        <span className={`text-[11px] px-1.5 py-0.5 rounded flex-shrink-0 w-[4rem] text-center ${LABEL_COLORS[task.label] || 'bg-muted text-muted-foreground'}`}>
          {task.label}
        </span>

        {/* Spec icon */}
        <span className="flex-shrink-0 w-4 flex items-center justify-center">
          {task.specUrl ? (
            <span title={`Spec: ${task.specUrl}`}><IconDocument className="w-3.5 h-3.5 text-cyan-400" /></span>
          ) : null}
        </span>

        {/* Title — show parentName prefix if available */}
        <span className="flex-1 min-w-0 text-sm text-foreground truncate">
          {task.parentName && !task.title?.startsWith(task.parentName) && (
            <span className="text-muted-foreground">{task.parentName}.</span>
          )}
          {task.title || <span className="italic text-muted-foreground">Untitled</span>}
        </span>

        {/* Status — fixed width for alignment; click to reset if stuck */}
        <span
          className={`text-[11px] font-medium flex-shrink-0 w-[6.5rem] text-center px-2 py-0.5 rounded border ${STATUS_STYLES[task.status] || 'bg-gray-500/15 text-gray-400 border-gray-500/30'} ${(task.status === 'in_progress' || task.status === 'failed' || task.status === 'completed') ? 'cursor-pointer hover:opacity-70' : ''}`}
          title={(task.status === 'in_progress' || task.status === 'failed' || task.status === 'completed') ? 'Click to reset to pending' : undefined}
          onClick={(e) => {
            if (task.status === 'in_progress' || task.status === 'failed' || task.status === 'completed') {
              e.stopPropagation();
              onUpdate(task.id, { status: 'pending' } as any);
            }
          }}
        >
          {task.status.replace(/_/g, ' ')}
        </span>

        {/* Execute / View Agents buttons */}
        <div className="flex-shrink-0 flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
          {!isRunning && task.status !== 'completed' && (
            <button
              onClick={() => onExecute(task.id)}
              className="p-1.5 rounded-md bg-green-500/15 text-green-400 hover:bg-green-500/25 hover:text-green-300 transition-colors"
              title="Execute task"
            >
              <IconPlay className="w-4 h-4" />
            </button>
          )}
          {task.label === 'fullstack' && isRunning && onViewAgents && (
            <button
              onClick={() => onViewAgents(task.id)}
              className="p-1.5 rounded-md bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 hover:text-violet-300 transition-colors"
              title="View FE + BE agents"
            >
              <IconGrid className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Actions (delete) */}
        <div className="relative flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 w-[2.5rem] justify-end" onClick={e => e.stopPropagation()}>
          <button
            onClick={() => setShowDeleteConfirm(v => !v)}
            className="p-1.5 rounded text-muted-foreground/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title={isRunning ? "Force delete (task is running)" : "Delete task"}
          >
            <IconTrash className="w-4 h-4" />
          </button>
          {showDeleteConfirm && (
            <div className="absolute right-0 top-7 z-50 bg-card border border-border rounded-lg shadow-lg p-3 w-48 animate-fade-in">
              <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{task.title}</p>
              <div className="flex gap-1.5 justify-end">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-2 py-1 rounded text-xs border border-border hover:bg-muted transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => { onDelete(task.id); setShowDeleteConfirm(false); }}
                  className="px-2 py-1 rounded text-xs bg-red-500 hover:bg-red-600 text-white font-medium transition-colors"
                >
                  刪除
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Expanded detail — editable */}
      {isExpanded && (
        <TaskExpandedDetail
          task={task}
          onUpdate={onUpdate}
          onUploadDoc={onUploadDoc}
          onUploadImage={onUploadImage}
          hasSvnConfig={hasSvnConfig}
          onBrowseSvn={handleBrowseSvn}
          onExecute={onExecute}
          svnPreviewFiles={svnPreviewFiles}
          svnPreviewLoading={svnPreviewLoading}
          svnPreviewError={svnPreviewError}
          onAddSvnFile={handleAddSvnFile}
          onRemoveSvnFile={handleRemoveSvnFile}
          onReloadSvn={fetchSvnPreview}
        />
      )}
    </div>
  );
}

/* ─── Expanded detail with inline editing ─── */

function TaskExpandedDetail({ task, onUpdate, onUploadDoc, onUploadImage, hasSvnConfig, onBrowseSvn, onExecute, svnPreviewFiles, svnPreviewLoading, svnPreviewError, onAddSvnFile, onRemoveSvnFile, onReloadSvn }: {
  task: Task;
  onUpdate: (id: string, updates: { description?: string | null; label?: string; taskType?: TaskType }) => void;
  onUploadDoc: (taskId: string, file: File, docType: 'SA' | 'SD', executionRunId?: string) => void;
  onUploadImage: (taskId: string, file: File, executionRunId?: string) => void;
  hasSvnConfig?: boolean;
  onBrowseSvn?: (specType: 'frontend' | 'backend') => void;
  onExecute?: (id: string, model?: string, mockupFiles?: string[], testOptions?: TestOptions, executionRunId?: string) => void;
  svnPreviewFiles: SvnPreviewFile[];
  svnPreviewLoading: boolean;
  svnPreviewError: string;
  onAddSvnFile?: (file: SvnPreviewFile) => void;
  onRemoveSvnFile?: (index: number) => void;
  onReloadSvn?: () => void;
}) {
  const ALL_TASK_TYPES: TaskType[] = ['bug', 'feature', 'refactor', 'testing', 'other'];
  const isAsana = task.source === 'asana';
  const client = useWsStore(s => s.client);
  const projects = useProjectStore(s => s.projects);
  const [execModel, setExecModel] = useState<string>(task.preferredModel || 'sonnet');
  const [testOptions, setTestOptions] = useState<TestOptions>(() => ({
    frontend: { smokeTest: false, e2eSpec: false, consoleScript: false, useMock: true, useRealApi: false, headed: false, integrationTest: false },
    backend: { unitTests: true, apiSmokeTest: false, apiContract: false },
  }));
  // Each time the task panel is opened, generate a fresh execution run ID.
  // All file uploads within this session are scoped to this ID.
  const [executionRunId] = useState(() => crypto.randomUUID());
  const currentProjectId = useProjectStore(s => s.currentProjectId);
  const editProject = projects.find(p => p.id === currentProjectId);
  const ALL_LABELS = (['frontend', 'backend', 'fullstack', 'devops', 'review', 'architect'] as const).filter(
    l => l !== 'fullstack' || (editProject?.frontendPath && editProject?.backendPath),
  );
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description || '');
  const [pastedImages, setPastedImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const saInputRef = useRef<HTMLInputElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const frontendUploadRef = useRef<HTMLInputElement>(null);
  const backendUploadRef = useRef<HTMLInputElement>(null);
  const [localUploadedFiles, setLocalUploadedFiles] = useState<Array<{ filename: string; docType: 'SA' | 'SD' }>>([]);

  // Load existing documents from DB (this component only mounts when expanded)
  const [dbDocuments, setDbDocuments] = useState<Array<{ id: string; filename: string; docType: string | null; source: string }>>([]);
  useEffect(() => {
    fetch(`/api/task/${task.id}/documents`)
      .then(res => res.json())
      .then(data => {
        if (data.documents) setDbDocuments(data.documents);
      })
      .catch(() => {});
  }, [task.id]);

  // Mockup discovery state
  const [mockupCode, setMockupCode] = useState(() => {
    const m = task.parentName?.match(/^[A-Za-z]+\d+/);
    return m ? m[0].toUpperCase() : '';
  });
  const [mockupResults, setMockupResults] = useState<Array<{ filename: string; fullPath: string }>>([]);
  const [mockupSearching, setMockupSearching] = useState(false);
  const [mockupChecked, setMockupChecked] = useState<Set<string>>(new Set());

  const handleMockupSearch = useCallback(async () => {
    if (!mockupCode || !currentProjectId) return;
    setMockupSearching(true);
    try {
      const res = await fetch(`/api/projects/${currentProjectId}/mockups?code=${encodeURIComponent(mockupCode)}`);
      const data = await res.json();
      const files: Array<{ filename: string; fullPath: string }> = data.files || [];
      setMockupResults(files);
      setMockupChecked(new Set(files.map(f => f.fullPath)));
    } catch {
      setMockupResults([]);
    } finally {
      setMockupSearching(false);
    }
  }, [mockupCode, currentProjectId]);

  const saveDesc = () => {
    onUpdate(task.id, { description: descDraft.trim() || null });
    setEditingDesc(false);
  };

  const handleImageUpload = (file: File) => {
    // Show preview immediately
    const reader = new FileReader();
    reader.onload = () => {
      setPastedImages(prev => [...prev, { name: file.name, dataUrl: reader.result as string }]);
    };
    reader.readAsDataURL(file);
    // Upload to server, scoped to this execution run
    onUploadImage(task.id, file, executionRunId);
  };

  const handleDescPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          const ext = file.type.split('/')[1] || 'png';
          const named = new File([file], `screenshot-${Date.now()}.${ext}`, { type: file.type });
          handleImageUpload(named);
        }
        return;
      }
    }
  };

  const handleImageFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImageUpload(file);
      e.target.value = '';
    }
  };

  return (
    <div className="mx-3 mb-3 p-3 space-y-3 animate-fade-in">
      {/* Type — editable */}
      <div>
        <span className="text-xs text-muted-foreground font-semibold block mb-1">Type</span>
        <div className="flex flex-wrap gap-1.5">
          {ALL_TASK_TYPES.map(t => (
            <button
              key={t}
              onClick={() => { if (t !== task.taskType) onUpdate(task.id, { taskType: t }); }}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                t === task.taskType
                  ? `${TASK_TYPE_COLORS[t]} ring-1 ring-current border-current/30`
                  : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Label — editable */}
      <div>
        <span className="text-xs text-muted-foreground font-semibold block mb-1">Label (Role)</span>
        <div className="flex flex-wrap gap-1.5">
          {ALL_LABELS.map(l => (
            <button
              key={l}
              onClick={() => { if (l !== task.label) onUpdate(task.id, { label: l }); }}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                l === task.label
                  ? `${LABEL_COLORS[l]} ring-1 ring-current border-current/30`
                  : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Description — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-muted-foreground font-semibold">Description</span>
          {!editingDesc && (
            <button
              onClick={() => { setDescDraft(task.description || ''); setEditingDesc(true); }}
              className="px-2 py-0.5 text-xs font-medium rounded border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
            >
              {task.description ? 'Edit' : '+ Add'}
            </button>
          )}
        </div>
        {editingDesc ? (
          <div className="space-y-1.5">
            <textarea
              value={descDraft}
              onChange={(e) => setDescDraft(e.target.value)}
              onPaste={handleDescPaste}
              placeholder="Task description... (可貼上圖片)"
              className="w-full bg-background/50 border border-border rounded-md px-3 py-2 text-sm min-h-[160px] resize-y outline-none focus:border-primary focus:ring-1 focus:ring-primary/30"
              autoFocus
            />
            {/* Image previews */}
            {pastedImages.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pastedImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img src={img.dataUrl} alt={img.name} className="w-24 h-24 object-cover rounded-md border border-border" />
                    <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 py-0.5 truncate rounded-b-md">
                      {img.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-center">
              <button onClick={saveDesc} className="inline-flex items-center gap-1 px-3 py-1 text-xs font-semibold rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                <IconCheck className="w-3.5 h-3.5" /> Save
              </button>
              <button onClick={() => setEditingDesc(false)} className="px-3 py-1 text-xs font-medium rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors">
                Cancel
              </button>
              <input ref={imgInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageFileSelect} />
              <button
                onClick={() => imgInputRef.current?.click()}
                className="ml-auto inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                title="Upload image"
              >
                <IconUpload className="w-3 h-3" /> Image
              </button>
            </div>
          </div>
        ) : task.description ? (
          <p className="text-sm text-foreground whitespace-pre-wrap">{task.description}</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">No description</p>
        )}
      </div>

      {/* SVN Spec — auto-matched + manually added files */}
      {hasSvnConfig && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground font-semibold">SVN Spec</span>
            {task.parentName && (
              <span className="px-2 py-0.5 rounded text-xs font-mono bg-muted text-foreground/80">{task.parentName}</span>
            )}
            {onReloadSvn && (
              <button
                onClick={onReloadSvn}
                className="p-1 rounded text-muted-foreground/70 hover:text-primary hover:bg-primary/10 transition-colors"
                title="重新搜尋"
                disabled={svnPreviewLoading}
              >
                <IconRefresh className={`w-3.5 h-3.5 ${svnPreviewLoading ? 'animate-spin' : ''}`} />
              </button>
            )}
            {/* 前端 split button: SVN | 手動上傳 */}
            <div className="flex items-center ml-auto rounded border border-blue-500/30 overflow-hidden">
              <button
                onClick={() => onBrowseSvn?.('frontend')}
                className="px-2.5 py-1 text-xs font-medium text-blue-400 hover:bg-blue-500/10 transition-colors"
              >
                + 前端
              </button>
              <div className="w-px bg-blue-500/20 self-stretch" />
              <button
                onClick={() => frontendUploadRef.current?.click()}
                className="px-1.5 py-1 text-blue-400 hover:bg-blue-500/10 transition-colors"
                title="手動上傳前端規格 (SA)"
              >
                <IconUpload className="w-3 h-3" />
              </button>
            </div>
            {/* 後端 split button: SVN | 手動上傳 */}
            <div className="flex items-center rounded border border-orange-500/30 overflow-hidden">
              <button
                onClick={() => onBrowseSvn?.('backend')}
                className="px-2.5 py-1 text-xs font-medium text-orange-400 hover:bg-orange-500/10 transition-colors"
              >
                + 後端
              </button>
              <div className="w-px bg-orange-500/20 self-stretch" />
              <button
                onClick={() => backendUploadRef.current?.click()}
                className="px-1.5 py-1 text-orange-400 hover:bg-orange-500/10 transition-colors"
                title="手動上傳後端規格 (SD)"
              >
                <IconUpload className="w-3 h-3" />
              </button>
            </div>
            {/* Hidden file inputs for manual upload */}
            <input ref={frontendUploadRef} type="file" accept=".pdf,.doc,.docx,.md,.txt" className="hidden" onChange={e => {
              const file = e.target.files?.[0];
              if (file) {
                onUploadDoc(task.id, file, 'SA', executionRunId);
                setLocalUploadedFiles(prev => [...prev, { filename: file.name, docType: 'SA' }]);
              }
              e.target.value = '';
            }} />
            <input ref={backendUploadRef} type="file" accept=".pdf,.doc,.docx,.md,.txt" className="hidden" onChange={e => {
              const file = e.target.files?.[0];
              if (file) {
                onUploadDoc(task.id, file, 'SD', executionRunId);
                setLocalUploadedFiles(prev => [...prev, { filename: file.name, docType: 'SD' }]);
              }
              e.target.value = '';
            }} />
          </div>
          {svnPreviewLoading ? (
            <div className="flex items-center gap-2 py-2">
              <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <span className="text-sm text-muted-foreground">搜尋 SVN 規格文件...</span>
            </div>
          ) : svnPreviewError ? (
            <p className="text-sm text-red-400 py-1">{svnPreviewError}</p>
          ) : svnPreviewFiles.length > 0 ? (
            <div className="space-y-1.5">
              {svnPreviewFiles.map((f, i) => (
                <div key={i} className="flex items-center gap-2.5 text-sm group">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                    f.svnRoot === 'frontend' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400'
                  }`}>
                    {f.svnRoot === 'frontend' ? '前端' : '後端'}
                  </span>
                  <IconCheck className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <a
                    href={svnToWebViewUrl(f.svnUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 underline decoration-blue-500/40 hover:decoration-blue-400 truncate flex-1"
                    title={f.svnUrl}
                    onClick={e => e.stopPropagation()}
                  >{f.filename}</a>
                  {f.manual && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-400 flex-shrink-0">手動</span>
                  )}
                  {onRemoveSvnFile && (
                    <button
                      onClick={() => onRemoveSvnFile(i)}
                      className="p-1 rounded text-muted-foreground/70 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                      title="移除"
                    >
                      <IconTrash className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {/* Locally uploaded files */}
              {localUploadedFiles.map((f, i) => (
                <div key={`upload-${i}`} className="flex items-center gap-2.5 text-sm group">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                    f.docType === 'SA' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400'
                  }`}>
                    {f.docType === 'SA' ? '前端' : '後端'}
                  </span>
                  <IconCheck className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <span className="text-foreground/80 truncate flex-1">{f.filename}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-400 flex-shrink-0">已上傳</span>
                  <button
                    onClick={() => setLocalUploadedFiles(prev => prev.filter((_, j) => j !== i))}
                    className="p-1 rounded text-muted-foreground/70 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="移除"
                  >
                    <IconTrash className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground mt-1.5">
                以上 {svnPreviewFiles.length + localUploadedFiles.length} 份文件將於執行時自動下載並注入 Agent context。
              </p>
            </div>
          ) : localUploadedFiles.length > 0 ? (
            <div className="space-y-1.5">
              {localUploadedFiles.map((f, i) => (
                <div key={`upload-${i}`} className="flex items-center gap-2.5 text-sm group">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                    f.docType === 'SA' ? 'bg-blue-500/15 text-blue-400' : 'bg-orange-500/15 text-orange-400'
                  }`}>
                    {f.docType === 'SA' ? '前端' : '後端'}
                  </span>
                  <IconCheck className="w-4 h-4 text-green-400 flex-shrink-0" />
                  <span className="text-foreground/80 truncate flex-1">{f.filename}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-400 flex-shrink-0">已上傳</span>
                  <button
                    onClick={() => setLocalUploadedFiles(prev => prev.filter((_, j) => j !== i))}
                    className="p-1 rounded text-muted-foreground/70 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="移除"
                  >
                    <IconTrash className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground mt-1.5">
                以上 {localUploadedFiles.length} 份文件將於執行時注入 Agent context。
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground italic py-1">未找到匹配的 SVN 規格文件，可手動新增。</p>
          )}
        </div>
      )}

      {/* Mockup auto-discovery */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted-foreground font-semibold">Mockup 參考畫面</span>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={mockupCode}
            onChange={e => setMockupCode(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === 'Enter') handleMockupSearch(); }}
            placeholder="功能代號 e.g. SM26"
            className="flex-1 bg-background/50 border border-border rounded px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <button
            onClick={handleMockupSearch}
            disabled={!mockupCode || mockupSearching}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-border text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40"
          >
            {mockupSearching ? <IconRefresh className="w-3 h-3 animate-spin" /> : <IconRefresh className="w-3 h-3" />}
            搜尋
          </button>
        </div>
        {mockupResults.length > 0 && (
          <div className="mt-2 space-y-1">
            {mockupResults.map(f => {
              const checked = mockupChecked.has(f.fullPath);
              return (
                <label key={f.fullPath} className="flex items-center gap-2 cursor-pointer group">
                  <div
                    className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                      checked ? 'border-primary bg-primary' : 'border-border'
                    }`}
                    onClick={() => setMockupChecked(prev => {
                      const next = new Set(prev);
                      if (next.has(f.fullPath)) next.delete(f.fullPath); else next.add(f.fullPath);
                      return next;
                    })}
                  >
                    {checked && <IconCheck className="w-2.5 h-2.5 text-white" />}
                  </div>
                  <span className="text-xs text-foreground/80 truncate group-hover:text-foreground">{f.filename}</span>
                </label>
              );
            })}
            <p className="text-[10px] text-muted-foreground mt-1">
              已勾選 {mockupChecked.size}/{mockupResults.length} 份 Mockup，執行時注入 Agent context。
            </p>
          </div>
        )}
        {mockupResults.length === 0 && !mockupSearching && mockupCode && (
          <p className="text-xs text-muted-foreground italic mt-1">輸入代號後按搜尋</p>
        )}
      </div>

      {/* Document Upload (auto-detect SA/SD) */}
      <div>
        <span className="text-xs text-muted-foreground font-semibold block mb-1.5">Upload Documents</span>
        <input ref={saInputRef} type="file" multiple className="hidden" onChange={(e) => {
          const files = e.target.files;
          if (!files) return;
          for (const file of Array.from(files)) {
            const docType = detectDocType(file);
            if (docType === 'image') {
              handleImageUpload(file);
            } else {
              onUploadDoc(task.id, file, docType, executionRunId);
            }
          }
          e.target.value = '';
        }} />
        <button
          onClick={() => saInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/5 transition-colors"
        >
          <IconUpload className="w-3.5 h-3.5" />
          上傳檔案 (自動判斷 SA/SD)
        </button>
      </div>

      {/* Existing documents from DB */}
      {dbDocuments.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground font-semibold block mb-1.5">Attached Documents ({dbDocuments.length})</span>
          <div className="space-y-1">
            {dbDocuments.map(doc => (
              <div key={doc.id} className="flex items-center gap-2 text-sm group">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${
                  doc.docType === 'SA' ? 'bg-blue-500/15 text-blue-400' :
                  doc.docType === 'SD' ? 'bg-orange-500/15 text-orange-400' :
                  'bg-gray-500/15 text-gray-400'
                }`}>
                  {doc.docType || 'other'}
                </span>
                <IconCheck className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                <span className="text-foreground/80 truncate flex-1" title={doc.filename}>{doc.filename.replace(/^\[.*?\]\s*/, '').replace(/^[a-f0-9-]+-/, '')}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${
                  doc.source === 'svn' ? 'bg-orange-500/15 text-orange-400' : 'bg-purple-500/15 text-purple-400'
                }`}>
                  {doc.source === 'svn' ? 'SVN' : '已上傳'}
                </span>
                <button
                  onClick={() => {
                    fetch(`/api/document/${doc.id}`, { method: 'DELETE' })
                      .then(() => setDbDocuments(prev => prev.filter(d => d.id !== doc.id)))
                      .catch(() => {});
                  }}
                  className="p-1 rounded text-muted-foreground/70 hover:text-red-400 hover:bg-red-500/10 transition-colors opacity-0 group-hover:opacity-100"
                  title="刪除"
                >
                  <IconTrash className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Test options (per-role checkboxes) */}
      {onExecute && task.status !== 'in_progress' && task.status !== 'assigned' && (task.label === 'frontend' || task.label === 'backend' || task.label === 'fullstack') && (
        <div className="pt-2 border-t border-border/50 mt-2">
          <div className="text-[10px] text-muted-foreground font-medium mb-1.5 uppercase tracking-wide">測試選項</div>
          {(task.label === 'frontend' || task.label === 'fullstack') && (
            <>
            {task.label === 'fullstack' && <div className="text-[10px] text-blue-400 font-medium mb-0.5">Frontend</div>}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {([
                { key: 'smokeTest', label: 'Smoke Test' },
                { key: 'e2eSpec', label: '產出 E2E Spec' },
                { key: 'consoleScript', label: 'Console Script' },
              ] as const).map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={testOptions.frontend[key]}
                    onChange={e => setTestOptions(prev => ({ ...prev, frontend: { ...prev.frontend, [key]: e.target.checked } }))}
                    className="w-3 h-3 accent-blue-500"
                  />
                  {label}
                </label>
              ))}
              {/* Mock / Real API always shown (smoke test always runs) */}
              <div className="flex gap-3 ml-2 pl-2 border-l border-border/50">
                {([
                  { key: 'useMock' as const, label: 'Mock', color: 'accent-blue-400' },
                  { key: 'useRealApi' as const, label: 'Real API', color: 'accent-green-500' },
                ]).map(({ key, label, color }) => (
                  <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={testOptions.frontend[key]}
                      onChange={e => setTestOptions(prev => ({ ...prev, frontend: { ...prev.frontend, [key]: e.target.checked } }))}
                      className={`w-3 h-3 ${color}`}
                    />
                    {label}
                  </label>
                ))}
              </div>
              {testOptions.frontend.e2eSpec && (
                <div className="flex gap-1.5 ml-2 pl-2 border-l border-border/50">
                  {([
                    { value: false, label: '背景執行' },
                    { value: true, label: '前台執行' },
                  ]).map(({ value, label }) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => setTestOptions(prev => ({ ...prev, frontend: { ...prev.frontend, headed: value } }))}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                        testOptions.frontend.headed === value
                          ? 'bg-amber-500/15 text-amber-400 border-amber-400/30 ring-1 ring-amber-400/30'
                          : 'bg-background/50 border-border/50 text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            </>
          )}
          {(task.label === 'backend' || task.label === 'fullstack') && (
            <>
            {task.label === 'fullstack' && <div className="text-[10px] text-purple-400 font-medium mb-0.5 mt-1.5">Backend</div>}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {([
                { key: 'unitTests', label: '單元測試' },
                { key: 'apiSmokeTest', label: 'API Smoke Test' },
                { key: 'apiContract', label: '產出 API 合約' },
              ] as const).map(({ key, label }) => (
                <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={testOptions.backend[key]}
                    onChange={e => setTestOptions(prev => ({ ...prev, backend: { ...prev.backend, [key]: e.target.checked } }))}
                    className="w-3 h-3 accent-purple-500"
                  />
                  {label}
                </label>
              ))}
            </div>
            </>
          )}
          {task.label === 'fullstack' && (
            <div className="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-border/30">
              <label className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer select-none font-medium">
                <input
                  type="checkbox"
                  checked={testOptions.frontend.integrationTest}
                  onChange={e => setTestOptions(prev => ({ ...prev, frontend: { ...prev.frontend, integrationTest: e.target.checked } }))}
                  className="w-3 h-3 accent-cyan-500"
                />
                API 整合測試（Playwright）
              </label>
              <span className="text-[9px] text-muted-foreground">前端打 API → 驗證 request/response + UI 顯示</span>
            </div>
          )}
        </div>
      )}

      {/* Asana reference + Execute button row */}
      <div className="flex items-center justify-between pt-2 border-t border-border/50 mt-2">
        <div className="flex items-center gap-2">
          {isAsana && task.sourceRef && (
            <a
              href={`https://app.asana.com/0/0/${task.sourceRef}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 hover:underline transition-colors"
              onClick={e => e.stopPropagation()}
            >
              <IconAsana className="w-3.5 h-3.5" />
              Open in Asana
              <IconExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
        {onExecute && task.status === 'completed' && (
          <button
            onClick={() => onExecute(task.id, undefined, [...mockupChecked], testOptions, executionRunId)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground text-xs font-medium transition-colors"
          >
            <IconRefresh className="w-3.5 h-3.5" />
            Re-run
          </button>
        )}
        {onExecute && task.status !== 'in_progress' && task.status !== 'assigned' && task.status !== 'completed' && (
          <div className="flex items-center gap-1">
            {(['sonnet', 'opus', 'haiku'] as const).map(m => (
              <button
                key={m}
                onClick={() => setExecModel(m)}
                className={`px-2 py-1 rounded text-[10px] font-medium transition-all ${
                  execModel === m
                    ? m === 'opus' ? 'bg-purple-500/20 text-purple-400'
                      : m === 'haiku' ? 'bg-green-500/20 text-green-400'
                      : 'bg-blue-500/20 text-blue-400'
                    : 'text-muted-foreground hover:text-foreground bg-muted/50'
                }`}
              >
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
            <button
              onClick={() => onExecute(task.id, execModel, [...mockupChecked], testOptions, executionRunId)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-500 font-semibold text-sm transition-colors whitespace-nowrap shadow-sm"
            >
              <IconPlay className="w-4 h-4" />
              Execute
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
