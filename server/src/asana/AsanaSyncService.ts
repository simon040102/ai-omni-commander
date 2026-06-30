import type { AsanaSyncConfig, ProjectConfig } from '@omni/shared';
import type { AsanaMcpClient } from './AsanaMcpClient.js';
import type { TaskClassifier } from '../orchestrator/TaskClassifier.js';
import type { ExecutionPipeline } from '../orchestrator/ExecutionPipeline.js';
import type { OmniWebSocketServer } from '../websocket/WebSocketServer.js';
import type { SvnSpecService } from '../svn/SvnSpecService.js';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { getProject, updateProject } from '../db/queries/projects.js';
import { createTask, getTasksByProject, updateTaskFields, deleteTask } from '../db/queries/tasks.js';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';
import type { WsMessage } from '@omni/shared';

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

  private svnSpecService: SvnSpecService | null = null;
  private documentParser: DocumentParser | null = null;

  constructor(
    private asanaClient: AsanaMcpClient,
    private classifier: TaskClassifier,
    private pipeline: ExecutionPipeline,
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
   */
  async syncOnce(projectId: string): Promise<SyncResult> {
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
    const config = project.configJson ? JSON.parse(project.configJson) as ProjectConfig : null;
    const syncConfig = config?.asanaSyncConfig;
    const autoExecuteRules = syncConfig?.autoExecuteRules || { bug: false, feature: false, refactor: false, testing: false, other: false };
    const maxConcurrent = syncConfig?.maxConcurrentAgents || 2;

    let newTasks = 0;
    let updatedTasks = 0;
    let removedTasks = 0;
    let autoExecuted = 0;

    // --- 1. Create new + Update existing ---
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
          updateTaskFields(existing.id, {
            title: asanaTask.name,
            description: description || null,
            parentName: asanaTask.parent?.name || null,
            label: newLabel,
            section: newSection,
            tags: newTags,
            customFields: newCustomFields,
            assignee: newAssignee,
            assigneeGid: newAssigneeGid,
          });
          updatedTasks++;
          logger.info({ taskId: existing.id, asanaGid: asanaTask.gid }, 'Updated Asana task');

          // Broadcast updated task list
          const updatedTaskList = getTasksByProject(projectId);
          this.wsServer.broadcast({
            type: 'task.list',
            id: genId(),
            timestamp: new Date().toISOString(),
            payload: { projectId, tasks: updatedTaskList },
          } as WsMessage);
        }
      } else {
        // New task — classify and create
        // Always check explicit markers first — they override AI classification
        const markerLabel = this.classifier.detectLabelFromTitle(asanaTask.name);
        const classification = markerLabel
          ? { taskType: this.classifier.fallbackClassify(asanaTask.name, asanaTask.notes).taskType, label: markerLabel }
          : await this.classifier.classify({ title: asanaTask.name, description: asanaTask.notes, tags: asanaTask.tags });

        logger.info({ title: asanaTask.name, markerLabel, label: classification.label }, 'Task label resolved');

        const task = createTask({
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

        newTasks++;
        logger.info({
          taskId: task.id,
          asanaGid: asanaTask.gid,
          taskType: classification.taskType,
          label: classification.label,
        }, 'Imported Asana task');

        this.wsServer.broadcast({
          type: 'task.created',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { task },
        } as WsMessage);

        // Auto-execute if rules allow
        const shouldAutoExecute = (autoExecuteRules as Record<string, boolean>)[classification.taskType] || false;
        if (shouldAutoExecute && autoExecuted < maxConcurrent) {
          try {
            await this.pipeline.executeTask(task.id);
            autoExecuted++;
            logger.info({ taskId: task.id }, 'Auto-executed Asana task');
          } catch (err) {
            logger.error({ err, taskId: task.id }, 'Failed to auto-execute task');
          }
        }
      }
    }

    // --- 2. Remove tasks no longer assigned to me ---
    for (const [gid, localTask] of existingByGid) {
      if (!remoteGids.has(gid)) {
        // Skip running tasks — don't kill in-progress work
        if (localTask.status === 'in_progress' || localTask.status === 'assigned') {
          logger.info({ taskId: localTask.id, asanaGid: gid }, 'Skipped removing running Asana task');
          continue;
        }
        if (this.documentParser) {
          await this.documentParser.deleteTaskFolder(localTask.projectId, localTask.parentName, localTask.id);
        }
        deleteTask(localTask.id);
        removedTasks++;
        logger.info({ taskId: localTask.id, asanaGid: gid }, 'Removed Asana task (no longer assigned to me)');
      }
    }

    // Always broadcast final task list so frontend stays in sync
    const finalTasks = getTasksByProject(projectId);
    this.wsServer.broadcast({
      type: 'task.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId, tasks: finalTasks },
    } as WsMessage);

    const lastSyncAt = new Date().toISOString();
    this.lastSyncAt.set(projectId, lastSyncAt);

    const result: SyncResult = { projectId, newTasks, updatedTasks, removedTasks, autoExecuted, lastSyncAt };
    logger.info(result, 'Asana sync completed');
    return result;
  }

  /**
   * Get last sync timestamp for a project.
   */
  getLastSyncAt(projectId: string): string | null {
    return this.lastSyncAt.get(projectId) || null;
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

