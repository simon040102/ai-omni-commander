import type { AsanaSyncConfig, ProjectConfig } from '@omni/shared';
import type { AsanaMcpClient } from './AsanaMcpClient.js';
import type { TaskClassifier } from '../orchestrator/TaskClassifier.js';
import type { OmniWebSocketServer } from '../websocket/WebSocketServer.js';
import type { SvnSpecService } from '../svn/SvnSpecService.js';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { getProject, updateProject } from '../db/queries/projects.js';
import { createTask, getTasksByProject, updateTaskFields, deleteTask } from '../db/queries/tasks.js';
import { getDb } from '../db/connection.js';
import { getGlobalConfig, setGlobalConfig } from '../db/queries/globalConfig.js';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';
import type { Task, WsMessage } from '@omni/shared';

const logger = createChildLogger('AsanaSyncService');

export interface SyncResult {
  projectId: string;
  newTasks: number;
  updatedTasks: number;
  removedTasks: number;
  autoExecuted: number;
  lastSyncAt: string;
}

/**
 * Manages scheduled and manual Asana task synchronization.
 */
export class AsanaSyncService {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private lastSyncAt = new Map<string, string>();
  /** Per-project in-flight sync — concurrent callers await the same promise */
  private inFlightSyncs = new Map<string, Promise<SyncResult>>();

  private svnSpecService: SvnSpecService | null = null;
  private documentParser: DocumentParser | null = null;

  constructor(
    private asanaClient: AsanaMcpClient,
    private classifier: TaskClassifier,
    private wsServer: OmniWebSocketServer,
  ) {}

  /** Inject SvnSpecService for auto-fetching specs during sync */
  setSvnSpecService(svc: SvnSpecService): void {
    this.svnSpecService = svc;
  }

  /** Inject DocumentParser for task folder cleanup on delete */
  setDocumentParser(dp: DocumentParser): void {
    this.documentParser = dp;
  }

  /**
   * Start auto-sync for a project based on its config.
   */
  startSync(projectId: string, config: AsanaSyncConfig): void {
    this.stopSync(projectId);

    if (!config.enabled) return;

    const intervalMs = config.intervalMinutes * 60 * 1000;
    logger.info({ projectId, intervalMinutes: config.intervalMinutes }, 'Starting Asana auto-sync');

    const timer = setInterval(async () => {
      try {
        const result = await this.syncOnce(projectId);
        this.broadcastSyncResult(result);
      } catch (err) {
        logger.error({ err, projectId }, 'Auto-sync failed');
      }
    }, intervalMs);

    this.timers.set(projectId, timer);
  }

  /**
   * Stop auto-sync for a project.
   */
  stopSync(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(projectId);
      logger.info({ projectId }, 'Stopped Asana auto-sync');
    }
  }

  /**
   * Stop all sync timers (e.g. on shutdown).
   */
  stopAll(): void {
    for (const [projectId, timer] of this.timers) {
      clearInterval(timer);
      logger.info({ projectId }, 'Stopped Asana auto-sync');
    }
    this.timers.clear();
  }

  /**
   * Sync once: fetch Asana tasks, create new ones, optionally auto-execute.
   * Concurrent calls for the same project share a single in-flight sync.
   */
  async syncOnce(projectId: string): Promise<SyncResult> {
    const inFlight = this.inFlightSyncs.get(projectId);
    if (inFlight) {
      logger.info({ projectId }, 'Sync already in flight — awaiting existing sync');
      return inFlight;
    }
    const promise = this.doSyncOnce(projectId).finally(() => {
      this.inFlightSyncs.delete(projectId);
    });
    this.inFlightSyncs.set(projectId, promise);
    return promise;
  }

  private async doSyncOnce(projectId: string): Promise<SyncResult> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
    if (!project.asanaProjectGid) throw new Error(`Project ${projectId} has no Asana project GID`);

    logger.info({ projectId, asanaProjectGid: project.asanaProjectGid }, 'Syncing Asana tasks');

    // Get existing Asana tasks in local DB
    const existingTasks = getTasksByProject(projectId);
    const existingAsanaTasks = existingTasks.filter(t => t.source === 'asana' && t.sourceRef);
    const existingByGid = new Map(existingAsanaTasks.map(t => [t.sourceRef!, t]));

    // Fetch tasks assigned to me from the bound Asana project
    const asanaTasks = await this.asanaClient.getMyTasksForProject(project.asanaProjectGid);
    const remoteGids = new Set(asanaTasks.map(t => t.gid));

    // Parse project config for auto-execute rules
    let config: ProjectConfig | null = null;
    if (project.configJson) {
      try {
        config = JSON.parse(project.configJson) as ProjectConfig;
      } catch (err) {
        logger.error({ err, projectId }, 'Project config_json is corrupted — aborting sync');
        return {
          projectId, newTasks: 0, updatedTasks: 0, removedTasks: 0, autoExecuted: 0,
          lastSyncAt: this.getLastSyncAt(projectId) || '',
        };
      }
    }
    const syncConfig = config?.asanaSyncConfig;
    // autoExecuteRules 仍會被讀取（僅為記錄），但不再觸發任何 spawn 派工 —
    // 執行一律走外部 Claude Code session + MCP。
    const autoExecuteRules = syncConfig?.autoExecuteRules || { bug: false, feature: false, refactor: false, testing: false, other: false };

    let newTasks = 0;
    let updatedTasks = 0;
    let removedTasks = 0;
    const autoExecuted = 0;

    // --- 1. Compute mutations (async classification happens here, DB writes deferred) ---
    const pendingUpdates: Array<{ taskId: string; fields: Parameters<typeof updateTaskFields>[1] }> = [];
    const pendingCreates: Array<Parameters<typeof createTask>[0]> = [];

    for (const asanaTask of asanaTasks) {
      // specUrl is no longer auto-extracted from notes — SVN auto-fetch handles specs via parentName
      const description = asanaTask.notes.length > 2000
        ? asanaTask.notes.substring(0, 2000) + '...'
        : asanaTask.notes;

      const existing = existingByGid.get(asanaTask.gid);

      // Asana 分類維度（新欄位）
      const newSection = asanaTask.section ?? null;
      const newTags = asanaTask.tags ?? [];
      const newCustomFields = asanaTask.customFields ?? {};
      const newAssignee = asanaTask.assignee?.name ?? null;
      const newAssigneeGid = asanaTask.assignee?.gid ?? null;

      if (existing) {
        // Update if title or description changed
        const titleChanged = existing.title !== asanaTask.name;
        const descChanged = (existing.description || '') !== description;
        const parentChanged = (existing.parentName || '') !== (asanaTask.parent?.name || '');
        // 分類維度變更偵測（否則既有單不會觸發 update）
        const sectionChanged = (existing.section ?? null) !== newSection;
        const tagsChanged = JSON.stringify(existing.tags ?? []) !== JSON.stringify(newTags);
        const cfChanged = JSON.stringify(existing.customFields ?? {}) !== JSON.stringify(newCustomFields);
        const assigneeChanged = (existing.assignee ?? null) !== newAssignee || (existing.assigneeGid ?? null) !== newAssigneeGid;

        // Always apply explicit Chinese role markers (前端/後端) regardless of whether title changed
          const forcedLabel = this.classifier.detectLabelFromTitle(asanaTask.name);

      if (titleChanged || descChanged || parentChanged || (forcedLabel && forcedLabel !== existing.label) || sectionChanged || tagsChanged || cfChanged || assigneeChanged) {
          // Re-classify label if title changed (catches keyword changes like 前端/後端)
          let newLabel = forcedLabel ?? existing.label;
          if (titleChanged && !forcedLabel) {
            const reclassification = await this.classifier.classify({
              title: asanaTask.name,
              description: asanaTask.notes,
              tags: asanaTask.tags,
            });
            newLabel = reclassification.label;
            logger.info({ taskId: existing.id, oldLabel: existing.label, newLabel, title: asanaTask.name }, 'Re-classified task label on title change');
          } else if (forcedLabel && forcedLabel !== existing.label) {
            logger.info({ taskId: existing.id, oldLabel: existing.label, newLabel: forcedLabel, title: asanaTask.name }, 'Overriding label based on explicit Chinese role marker');
          }
          pendingUpdates.push({
            taskId: existing.id,
            fields: {
              title: asanaTask.name,
              description: description || null,
              parentName: asanaTask.parent?.name || null,
              label: newLabel,
              section: newSection,
              tags: newTags,
              customFields: newCustomFields,
              assignee: newAssignee,
              assigneeGid: newAssigneeGid,
            },
          });
        }
      } else {
        // New task — classify and create
        // Always check explicit markers first — they override AI classification
        const markerLabel = this.classifier.detectLabelFromTitle(asanaTask.name);
        const classification = markerLabel
          ? { taskType: this.classifier.fallbackClassify(asanaTask.name, asanaTask.notes).taskType, label: markerLabel }
          : await this.classifier.classify({ title: asanaTask.name, description: asanaTask.notes, tags: asanaTask.tags });

        logger.info({ title: asanaTask.name, markerLabel, label: classification.label }, 'Task label resolved');

        pendingCreates.push({
          projectId,
          title: asanaTask.name,
          description,
          taskType: classification.taskType,
          label: classification.label,
          source: 'asana',
          sourceRef: asanaTask.gid,
          parentName: asanaTask.parent?.name || undefined,
          section: newSection,
          tags: newTags,
          customFields: newCustomFields,
          assignee: newAssignee,
          assigneeGid: newAssigneeGid,
        });
      }
    }

    // --- 2. Determine removals (tasks no longer assigned to me) ---
    const pendingRemovals: Task[] = [];
    for (const [gid, localTask] of existingByGid) {
      if (!remoteGids.has(gid)) {
        // Skip running tasks — don't kill in-progress work
        if (localTask.status === 'in_progress' || localTask.status === 'assigned') {
          logger.info({ taskId: localTask.id, asanaGid: gid }, 'Skipped removing running Asana task');
          continue;
        }
        pendingRemovals.push(localTask);
      }
    }

    // Clean up task folders BEFORE deleting task rows (folder lookup depends on task_documents)
    if (this.documentParser) {
      for (const localTask of pendingRemovals) {
        await this.documentParser.deleteTaskFolder(localTask.projectId, localTask.parentName, localTask.id);
      }
    }

    // --- 3. Apply all DB writes in a single transaction ---
    const createdTasks: Task[] = [];
    const db = getDb();
    db.transaction(() => {
      for (const update of pendingUpdates) {
        updateTaskFields(update.taskId, update.fields);
        logger.info({ taskId: update.taskId }, 'Updated Asana task');
      }
      for (const params of pendingCreates) {
        const task = createTask(params);
        createdTasks.push(task);
        logger.info({ taskId: task.id, asanaGid: params.sourceRef, taskType: params.taskType, label: params.label }, 'Imported Asana task');
      }
      for (const localTask of pendingRemovals) {
        deleteTask(localTask.id);
        logger.info({ taskId: localTask.id, asanaGid: localTask.sourceRef }, 'Removed Asana task (no longer assigned to me)');
      }
    })();

    updatedTasks = pendingUpdates.length;
    newTasks = createdTasks.length;
    removedTasks = pendingRemovals.length;

    // --- 4. Broadcasts (after transaction) ---
    for (const task of createdTasks) {
      this.wsServer.broadcast({
        type: 'task.created',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { task },
      } as WsMessage);
    }

    // Always broadcast final task list so frontend stays in sync
    const finalTasks = getTasksByProject(projectId);
    this.wsServer.broadcast({
      type: 'task.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId, tasks: finalTasks },
    } as WsMessage);

    // --- 5. Auto-execute removed (legacy spawn path) ---
    // 任務已同步進本地 DB；執行請走外部 Claude Code session + MCP（get_execution_plan）。
    for (const task of createdTasks) {
      const wouldHaveAutoExecuted = (autoExecuteRules as Record<string, boolean>)[task.taskType] || false;
      if (wouldHaveAutoExecuted) {
        logger.info({ taskId: task.id, taskType: task.taskType }, '任務已同步（auto-execute 已停用）— 執行請走外部 Claude Code session + MCP');
      }
    }

    const lastSyncAt = new Date().toISOString();
    this.lastSyncAt.set(projectId, lastSyncAt);
    try {
      setGlobalConfig(`asana.lastSyncAt.${projectId}`, lastSyncAt);
    } catch (err) {
      logger.warn({ err, projectId }, 'Failed to persist lastSyncAt');
    }

    const result: SyncResult = { projectId, newTasks, updatedTasks, removedTasks, autoExecuted, lastSyncAt };
    logger.info(result, 'Asana sync completed');
    return result;
  }

  /**
   * Get last sync timestamp for a project (memory first, falls back to persisted value).
   */
  getLastSyncAt(projectId: string): string | null {
    const inMemory = this.lastSyncAt.get(projectId);
    if (inMemory) return inMemory;
    const persisted = getGlobalConfig(`asana.lastSyncAt.${projectId}`);
    if (persisted) this.lastSyncAt.set(projectId, persisted);
    return persisted;
  }

  /**
   * Update sync config for a project (persists to config_json and restarts timer).
   */
  updateSyncConfig(projectId: string, syncConfig: AsanaSyncConfig): void {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    const config = project.configJson ? JSON.parse(project.configJson) as ProjectConfig : {};
    config.asanaSyncConfig = syncConfig;
    updateProject(projectId, { configJson: JSON.stringify(config) });

    // Restart timer with new config
    this.startSync(projectId, syncConfig);

    logger.info({ projectId, syncConfig }, 'Updated Asana sync config');
  }

  /**
   * Get sync config for a project.
   */
  getSyncConfig(projectId: string): AsanaSyncConfig | null {
    const project = getProject(projectId);
    if (!project?.configJson) return null;
    const config = JSON.parse(project.configJson) as ProjectConfig;
    return config.asanaSyncConfig || null;
  }

  private broadcastSyncResult(result: SyncResult): void {
    this.wsServer.broadcast({
      type: 'asana.syncResult',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: result,
    } as WsMessage);
  }
}

