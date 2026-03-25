import type { WebSocket } from 'ws';
import type {
  WsMessage, WsCreateProject, WsUploadDocument,
  WsStartExecution, WsStartQuickTask, WsInterviewResponse, WsInterviewConfirm,
  WsAgentAction, WsAgentCommand, WsAgentResume, WsInterventionResolve, WsTaskOverride,
  WsDeleteProject, WsUpdateProject, WsDeleteAgent, WsUpdateAgent, WsAddAgent,
  WsDeleteDocument, WsPlanAction, WsAsanaFetchTasks, WsAsanaFetchMyProjectTasks, WsAsanaFetchProjects, WsAsanaCheckConnection, WsAsanaFetchTaskStories,
  WsAsanaSyncNow, WsAsanaUpdateSyncConfig,
  WsTaskCreate, WsTaskDelete, WsTaskUpdate, WsTaskBulkDeleteBySource,
  WsWorkspaceScan, WsWorkspaceGenerateSkills,
  WsSvnBrowse, WsSvnPreview,
  WsMockupReload,
  WsMockupCrawlAll,
  AgentRole,
} from '@omni/shared';
import type { SvnConfig } from '@omni/shared';
import { normalizeSvnUrl, extractFunctionCode } from '../svn/SvnSpecService.js';
import type { SvnSpecService } from '../svn/SvnSpecService.js';
import { getSvnCredentials, setSvnCredentials, getAsanaPat, setAsanaPat } from '../db/queries/globalConfig.js';
import { getConfig, reloadAsanaPat } from '../config.js';
import type { MasterOrchestrator } from '../orchestrator/MasterOrchestrator.js';
import type { AgentManager } from '../agent/AgentManager.js';
import type { OmniWebSocketServer } from './WebSocketServer.js';
import type { AsanaMcpClient } from '../asana/AsanaMcpClient.js';
import type { AsanaSyncService } from '../asana/AsanaSyncService.js';
import type { WorkspaceScanner } from '../workspace/WorkspaceScanner.js';
import type { SkillGenerator } from '../workspace/SkillGenerator.js';
import { createProject, listProjects, getProject, deleteProject, updateProject } from '../db/queries/projects.js';
import { getTasksByProject, getDependencies, updateTask, createTask, deleteTask, updateTaskFields, deleteTasksBySource, getTask } from '../db/queries/tasks.js';
import { getAgentsByProject, deleteAgent, updateAgent as updateAgentDb } from '../db/queries/agents.js';
import { resolveIntervention, getAgentOutputs, logAgentOutput } from '../db/queries/events.js';
import { getPlan, getPlansByProject, updatePlanStatus } from '../db/queries/plans.js';
import { getAgent } from '../db/queries/agents.js';
import { upsertWorkspaceSkills } from '../db/queries/workspaceSkills.js';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';
import { loadSuperpowersPrompt } from '../skills/superpowers/index.js';
import type { SuperpowersFeature } from '@omni/shared';
import type { QuickModeHandler } from '../orchestrator/QuickModeHandler.js';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const logger = createChildLogger('MessageRouter');

/**
 * Registers all WebSocket message handlers.
 */
export function registerHandlers(
  wsServer: OmniWebSocketServer,
  orchestrator: MasterOrchestrator,
  agentManager: AgentManager,
  workspaceScanner: WorkspaceScanner,
  skillGenerator: SkillGenerator,
  asanaClient?: AsanaMcpClient,
  asanaSyncService?: AsanaSyncService,
  quickModeHandler?: QuickModeHandler,
  svnSpecService?: SvnSpecService,
  documentParser?: DocumentParser,
): void {
  // PROJECT.CREATE
  wsServer.registerHandler('project.create', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsCreateProject;
    if (!payload.name || !payload.projectId) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'VALIDATION_ERROR', message: 'Missing required fields: name, projectId' },
      } as WsMessage);
      return;
    }
    const config: Record<string, unknown> = {};
    if (payload.planConfig) config['planConfig'] = payload.planConfig;
    const configJson = Object.keys(config).length > 0 ? JSON.stringify(config) : undefined;
    const project = createProject({
      id: payload.projectId,
      name: payload.name,
      workingDir: payload.workingDir,
      frontendPath: payload.frontendPath,
      backendPath: payload.backendPath,
      asanaProjectGid: payload.asanaProjectGid,
      configJson,
    });
    logger.info({ projectId: project.id, name: project.name }, 'Project created');

    // Auto-create axure-snapshots directory for the new project
    try {
      const snapshotsDir = join(dirname(getConfig().dbPath), '..', 'docs', 'axure-snapshots', project.id);
      mkdirSync(snapshotsDir, { recursive: true });
    } catch { /* non-critical */ }

    // Broadcast updated project list to ALL clients
    const allProjects = listProjects();
    wsServer.broadcast({
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects: allProjects },
    } as WsMessage);

    // Send full project state to the requesting client
    sendProjectState(wsServer, ws, project.id, orchestrator);
  });

  // PROJECT.CLEAR_DOCUMENTS
  wsServer.registerHandler('project.clearDocuments', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { projectId: string } };
    const specHandler = orchestrator.getSpecHandler();
    const count = await specHandler.clearDocuments(payload.projectId);
    logger.info({ projectId: payload.projectId, deletedCount: count }, 'Documents cleared for new execution');
    wsServer.send(ws, {
      type: 'project.documentsCleared',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId: payload.projectId, deletedCount: count },
    } as WsMessage);
  });

  // PROJECT.DELETE_DOCUMENT
  wsServer.registerHandler('project.deleteDocument', async (msg: WsMessage) => {
    const { payload } = msg as WsDeleteDocument;
    const specHandler = orchestrator.getSpecHandler();
    const deletedDoc = await specHandler.getDocumentParser().deleteDocument(payload.documentId);

    if (deletedDoc) {
      logger.info({ projectId: payload.projectId, documentId: payload.documentId, filename: deletedDoc.filename }, 'Document deleted');
      await specHandler.removeDocumentFromWorkspaces(payload.projectId, deletedDoc.filename, deletedDoc.docType);

      const docs = specHandler.getDocumentParser().getDocuments(payload.projectId);
      wsServer.broadcast({
        type: 'project.documents',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId: payload.projectId,
          documents: docs.map(d => ({
            id: d.id,
            filename: d.filename,
            docType: d.docType,
          })),
        },
      } as WsMessage);
    }
  });

  // PROJECT.UPLOAD_DOCUMENT
  wsServer.registerHandler('project.uploadDocument', async (msg: WsMessage) => {
    const { payload } = msg as WsUploadDocument;
    const specHandler = orchestrator.getSpecHandler();
    await specHandler.uploadDocument(
      payload.projectId, payload.filename, payload.content, payload.fileType,
      payload.docType, payload.taskId, payload.agentId, payload.executionRunId,
    );

    const docs = specHandler.getDocumentParser().getDocuments(payload.projectId);
    const newDoc = docs.find(d => d.filename === payload.filename);
    if (newDoc) {
      await specHandler.injectNewDocument(payload.projectId, newDoc);
    }

    wsServer.broadcast({
      type: 'project.documents',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: {
        projectId: payload.projectId,
        documents: docs.map(d => ({
          id: d.id,
          filename: d.filename,
          docType: d.docType,
        })),
      },
    } as WsMessage);
  });

  // PROJECT.START_EXECUTION
  wsServer.registerHandler('project.startExecution', async (msg: WsMessage) => {
    const { payload } = msg as WsStartExecution;
    await orchestrator.start(payload.projectId, {
      taskId: payload.taskId,
      requirement: payload.requirement,
      model: payload.model,
      role: payload.role,
      mockupFiles: payload.mockupFiles,
      testOptions: payload.testOptions,
      executionRunId: payload.executionRunId,
    });
  });

  // PROJECT.START_QUICK_TASK
  wsServer.registerHandler('project.startQuickTask', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsStartQuickTask;
    if (!quickModeHandler) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'QUICK_MODE_UNAVAILABLE', message: 'Quick mode handler not configured' },
      } as WsMessage);
      return;
    }

    // Find the most recently created project matching this workingDir to associate the quick task
    const allProjects = listProjects();
    const project = allProjects
      .filter(p => p.workingDir === payload.workingDir)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (!project) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'NO_PROJECT', message: 'No project found for this workspace. Create a project first.' },
      } as WsMessage);
      return;
    }

    await quickModeHandler.execute(project.id, {
      type: payload.taskType,
      description: payload.description,
      errorLog: payload.errorLog,
      relatedFiles: payload.relatedFiles,
      role: payload.role,
      useWorkspaceSkills: payload.useWorkspaceSkills,
    }, payload.model);
  });

  // PROJECT.PAUSE
  wsServer.registerHandler('project.pause', async (msg: WsMessage) => {
    const { payload } = msg as unknown as { payload: { projectId: string } };
    await agentManager.stopAllForProject(payload.projectId);
  });

  // INTERVIEW.USER_RESPONSE
  wsServer.registerHandler('interview.userResponse', (msg: WsMessage) => {
    const { payload } = msg as WsInterviewResponse;
    orchestrator.getCreativeHandler().handleUserResponse(payload.projectId, payload.message);
  });

  // INTERVIEW.CONFIRM_SPEC
  wsServer.registerHandler('interview.confirmSpec', async (msg: WsMessage) => {
    const { payload } = msg as WsInterviewConfirm;
    await orchestrator.getCreativeHandler().handleSpecConfirmation(
      payload.projectId, payload.confirmed, payload.modifications,
    );
  });

  // AGENT.ACTION
  wsServer.registerHandler('agent.action', async (msg: WsMessage) => {
    const { payload } = msg as WsAgentAction;
    switch (payload.action) {
      case 'stop':
        await agentManager.stopAgent(payload.agentId);
        break;
      case 'restart':
        await agentManager.restartAgent(payload.agentId);
        break;
      case 'pause':
        await agentManager.stopAgent(payload.agentId);
        break;
    }
  });

  // AGENT.COMMAND
  wsServer.registerHandler('agent.command', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAgentCommand;
    try {
      const sent = await agentManager.sendInputToAgent(payload.agentId, payload.command);
      if (sent) {
        logger.info({ agentId: payload.agentId }, 'Command sent to agent (session resumed)');
        const userInstructionContent = `[USER INSTRUCTION] ${payload.command}`;
        logAgentOutput({
          agentId: payload.agentId,
          streamType: 'system',
          content: userInstructionContent,
        });
        wsServer.broadcast({
          type: 'agent.output',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: {
            agentId: payload.agentId,
            streamType: 'system',
            content: userInstructionContent,
            timestamp: new Date().toISOString(),
          },
        } as WsMessage);
      } else {
        logger.warn({ agentId: payload.agentId }, 'Agent not found or not running');
        wsServer.send(ws, {
          type: 'error',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { code: 'agent.command_failed', message: 'Agent not found or no session to resume.' },
        } as WsMessage);
      }
    } catch (err) {
      logger.error({ agentId: payload.agentId, err }, 'Failed to send command to agent');
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'agent.command_failed', message: `Failed to resume agent session: ${(err as Error).message}` },
      } as WsMessage);
    }
  });

  // AGENT.RESUME — resume a crashed/errored agent using its session ID
  wsServer.registerHandler('agent.resume', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAgentResume;
    try {
      const agentForRoleCheck = getAgent(payload.agentId);
      if (agentForRoleCheck?.role === 'axure') {
        logger.warn({ agentId: payload.agentId }, 'Axure agent cannot be resumed — Playwright MCP sessions are ephemeral');
        wsServer.send(ws, {
          type: 'error',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { code: 'agent.resume_failed', message: 'Axure agent 無法 resume（Playwright MCP session 不可恢復）。請使用 MockupView 的「繼續爬取」按鈕重新派發。' },
        } as WsMessage);
        return;
      }
      await agentManager.resumeAgent(payload.agentId, payload.prompt);
      logger.info({ agentId: payload.agentId }, 'Agent resumed via WS command');
    } catch (err) {
      logger.error({ agentId: payload.agentId, err }, 'Failed to resume agent');
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'agent.resume_failed', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // AGENT.DELETE
  wsServer.registerHandler('agent.delete', async (msg: WsMessage) => {
    const { payload } = msg as WsDeleteAgent;
    // Look up the agent's project before deleting so we can refresh the task list
    const agentRecord = getAgent(payload.agentId);
    const projectId = agentRecord?.projectId;

    // Reset tasks assigned to this agent back to pending before deleting
    if (projectId) {
      const projectTasks = getTasksByProject(projectId);
      for (const t of projectTasks) {
        if (t.assignedAgentId === payload.agentId && (t.status === 'in_progress' || t.status === 'assigned')) {
          updateTask(t.id, { status: 'pending', assignedAgentId: null });
        }
      }
    }

    await agentManager.stopAgent(payload.agentId);
    deleteAgent(payload.agentId);
    logger.info({ agentId: payload.agentId }, 'Agent deleted');

    // Clean up per-agent upload folder
    if (projectId && documentParser) {
      await documentParser.deleteByAgent(payload.agentId, projectId);
      logger.info({ agentId: payload.agentId, projectId }, 'Cleaned up per-agent uploads');
    }

    wsServer.broadcast({
      type: 'agent.statusChange',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: {
        agentId: payload.agentId,
        previousStatus: 'stopped',
        newStatus: 'deleted',
        reason: 'Removed by user',
      },
    } as WsMessage);

    // Broadcast updated task list
    if (projectId) {
      const tasks = getTasksByProject(projectId);
      wsServer.broadcast({
        type: 'task.list',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { projectId, tasks },
      } as WsMessage);
    }
  });

  // AGENT.UPDATE (rename title, etc.)
  wsServer.registerHandler('agent.update', async (msg: WsMessage) => {
    const { payload } = msg as WsUpdateAgent;
    if (payload.title !== undefined) {
      updateAgentDb(payload.agentId, { title: payload.title });
    }
    const agent = getAgent(payload.agentId);
    if (agent) {
      wsServer.broadcast({
        type: 'project.state',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          project: getProject(agent.projectId)!,
          tasks: getTasksByProject(agent.projectId),
          agents: getAgentsByProject(agent.projectId),
          dependencies: [],
        },
      } as WsMessage);
    }
  });

  // AGENT.ADD
  wsServer.registerHandler('agent.add', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAddAgent;
    try {
      const parts: string[] = [];

      if (payload.superpowersFeatures && payload.superpowersFeatures.length > 0) {
        const spPrompt = loadSuperpowersPrompt(payload.superpowersFeatures as SuperpowersFeature[]);
        if (spPrompt) parts.push(spPrompt);
      }

      const docContext = orchestrator.getSpecHandler().getDocumentContext(payload.projectId, payload.role);
      if (docContext) parts.push(docContext);

      // Inject Axure HTML snapshots if requested
      if (payload.useAxureContext !== false) {
        const nodePath = await import('node:path');
        let filePaths: string[] = [];

        if (payload.mockupFiles && payload.mockupFiles.length > 0) {
          // Use explicitly selected files from the client
          filePaths = payload.mockupFiles;
        } else {
          // Fallback: scan all files in the project's snapshots dir
          const nodeFs = await import('node:fs');
          const snapshotsDir = nodePath.default.join(
            nodePath.default.dirname(getConfig().dbPath), '..', 'docs', 'axure-snapshots', payload.projectId,
          );
          if (nodeFs.default.existsSync(snapshotsDir)) {
            filePaths = nodeFs.default.readdirSync(snapshotsDir)
              .filter((f: string) => f.endsWith('.html'))
              .sort()
              .map((f: string) => nodePath.default.join(snapshotsDir, f).replace(/\\/g, '/'));
          }
        }

        if (filePaths.length > 0) {
          // Group by function code (leading alphanumeric prefix before first '-')
          const groups = new Map<string, string[]>();
          for (const p of filePaths) {
            const filename = p.split('/').pop() ?? p;
            const code = filename.match(/^([a-zA-Z0-9]+)-/)?.[1]?.toUpperCase() ?? 'OTHER';
            if (!groups.has(code)) groups.set(code, []);
            groups.get(code)!.push(p);
          }
          const lines: string[] = [];
          for (const [code, paths] of groups) {
            lines.push(`**${code}**`);
            for (const p of paths) lines.push(`  - ${p}`);
          }
          parts.push(`## Axure 原型 HTML 快照\n需要了解某功能的 UI 規格時，請用 Read tool 讀取對應的 HTML 檔案：\n\n${lines.join('\n')}`);
        }
      }

      const prefix = parts.length > 0 ? parts.join('\n\n---\n\n') + '\n\n---\n\n' : '';
      const fullPrompt = prefix + payload.prompt;

      const agentId = await agentManager.startAgent({
        projectId: payload.projectId,
        agentId: payload.agentId,
        role: payload.role as AgentRole,
        prompt: fullPrompt,
        model: payload.model,
        workingDir: payload.workingDir,
        useWorkspaceSkills: payload.useWorkspaceSkills,
      });
      logger.info({ agentId, projectId: payload.projectId, role: payload.role }, 'Agent manually added');

      sendProjectState(wsServer, ws, payload.projectId, orchestrator);
    } catch (err) {
      logger.error({ err, projectId: payload.projectId }, 'Failed to add agent');
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'agent.add_failed', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // AGENT.PLAN_ACTION
  wsServer.registerHandler('agent.planAction', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsPlanAction;
    const plan = getPlan(payload.planId);
    if (!plan) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'plan.not_found', message: 'Plan not found' },
      } as WsMessage);
      return;
    }

    updatePlanStatus(payload.planId, payload.action === 'approve' ? 'approved' : 'rejected');
    logger.info({ planId: payload.planId, action: payload.action }, 'Plan action taken');

    if (payload.action === 'approve') {
      const agent = getAgent(plan.agentId);
      if (agent) {
        await agentManager.resumeAgent(plan.agentId, '計劃書已核准，請繼續執行。');
        logger.info({ agentId: plan.agentId }, 'Agent resumed after plan approval');
      }
    } else if (payload.action === 'reject' && payload.feedback) {
      const agent = getAgent(plan.agentId);
      if (agent) {
        await agentManager.resumeAgent(plan.agentId, `計劃書需要修改：\n${payload.feedback}\n\n請重新擬定計劃書。`);
        logger.info({ agentId: plan.agentId }, 'Agent resumed with plan rejection feedback');
      }
    }

    const plans = getPlansByProject(plan.projectId);
    wsServer.broadcast({
      type: 'agent.plans',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId: plan.projectId, plans },
    } as WsMessage);
  });

  // INTERVENTION.RESOLVE
  wsServer.registerHandler('intervention.resolve', async (msg: WsMessage) => {
    const { payload } = msg as WsInterventionResolve;
    resolveIntervention(payload.interventionId, payload.userInput || payload.decision);

    if (payload.decision === 'approve') {
      const agentId = (payload as Record<string, unknown>)['agentId'] as string | undefined;
      if (agentId) {
        await agentManager.resumeAgent(agentId, payload.userInput);
      }
    }
  });

  // TASK.OVERRIDE
  wsServer.registerHandler('task.override', async (msg: WsMessage) => {
    const { payload } = msg as WsTaskOverride;
    let newStatus: string;
    switch (payload.action) {
      case 'retry':
        updateTask(payload.taskId, { status: 'queued', retryCount: 0 });
        newStatus = 'queued';
        break;
      case 'skip':
        updateTask(payload.taskId, { status: 'completed', resultSummary: 'Skipped by user' });
        newStatus = 'completed';
        break;
      default:
        return;
    }
    // Broadcast task status change to frontend
    wsServer.broadcast({
      type: 'task.statusChange',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { taskId: payload.taskId, newStatus },
    } as WsMessage);
  });

  // PROJECT.DELETE
  wsServer.registerHandler('project.delete', async (msg: WsMessage) => {
    const { payload } = msg as WsDeleteProject;
    await agentManager.stopAllForProject(payload.projectId);
    deleteProject(payload.projectId);
    logger.info({ projectId: payload.projectId }, 'Project deleted');

    const allProjects = listProjects();
    wsServer.broadcast({
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects: allProjects },
    } as WsMessage);
  });

  // PROJECT.UPDATE
  wsServer.registerHandler('project.update', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsUpdateProject;
    const existing = getProject(payload.projectId);
    if (!existing) return;

    const updates: Parameters<typeof updateProject>[1] = {};
    if (payload.name !== undefined) updates.name = payload.name;
    if (payload.frontendPath !== undefined) updates.frontendPath = payload.frontendPath;
    if (payload.backendPath !== undefined) updates.backendPath = payload.backendPath;
    if (payload.asanaProjectGid !== undefined) updates.asanaProjectGid = payload.asanaProjectGid;
    if (payload.dbConnectionString !== undefined) updates.dbConnectionString = payload.dbConnectionString;
    if (payload.configJson !== undefined) updates.configJson = payload.configJson ?? undefined;

    updateProject(payload.projectId, updates);
    logger.info({ projectId: payload.projectId }, 'Project updated');

    const allProjects = listProjects();
    wsServer.broadcast({
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects: allProjects },
    } as WsMessage);

    sendProjectState(wsServer, ws, payload.projectId, orchestrator);
  });

  // PROJECT.GET_STATE
  wsServer.registerHandler('project.getState', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { projectId: string } };
    sendProjectState(wsServer, ws, payload.projectId, orchestrator);
  });

  // PROJECTS.LIST
  wsServer.registerHandler('projects.list', (msg: WsMessage, ws: WebSocket) => {
    const projects = listProjects();
    wsServer.send(ws, {
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects },
    } as WsMessage);
  });

  // ============================================
  // v2: Task Management Handlers
  // ============================================

  // TASK.CREATE
  wsServer.registerHandler('task.create', (msg: WsMessage) => {
    const { payload } = msg as WsTaskCreate;
    const task = createTask({
      projectId: payload.projectId,
      title: payload.title,
      description: payload.description,
      taskType: payload.taskType,
      label: payload.label,
      source: payload.source,
      sourceRef: payload.sourceRef,
      specUrl: payload.specUrl,
      preferredModel: payload.preferredModel,
      parentName: payload.parentName,
    });

    logger.info({ taskId: task.id, projectId: payload.projectId, taskType: payload.taskType }, 'Task created');

    wsServer.broadcast({
      type: 'task.created',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { task },
    } as WsMessage);
  });

  // TASK.DELETE
  wsServer.registerHandler('task.delete', async (msg: WsMessage) => {
    const { payload } = msg as WsTaskDelete;
    const task = getTask(payload.taskId);
    if (task && documentParser) {
      await documentParser.deleteTaskFolder(task.projectId, task.parentName, task.id);
    }
    deleteTask(payload.taskId);
    logger.info({ taskId: payload.taskId, projectId: payload.projectId }, 'Task deleted');

    const tasks = getTasksByProject(payload.projectId);
    wsServer.broadcast({
      type: 'task.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId: payload.projectId, tasks },
    } as WsMessage);
  });

  // TASK.UPDATE — update task fields (title, description, specUrl)
  wsServer.registerHandler('task.update', (msg: WsMessage) => {
    const { payload } = msg as WsTaskUpdate;
    updateTaskFields(payload.taskId, {
      title: payload.title,
      description: payload.description,
      specUrl: payload.specUrl,
      label: payload.label,
      taskType: payload.taskType,
      status: payload.status,
      preferredModel: payload.preferredModel,
      parentName: payload.parentName,
    });
    logger.info({ taskId: payload.taskId, projectId: payload.projectId }, 'Task updated');

    const tasks = getTasksByProject(payload.projectId);
    wsServer.broadcast({
      type: 'task.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId: payload.projectId, tasks },
    } as WsMessage);
  });

  // TASK.BULK_DELETE_BY_SOURCE — delete all tasks with a given source (e.g. 'asana')
  wsServer.registerHandler('task.bulkDeleteBySource', async (msg: WsMessage) => {
    const { payload } = msg as WsTaskBulkDeleteBySource;
    if (documentParser) {
      const tasksToDelete = getTasksByProject(payload.projectId).filter(t => t.source === payload.source);
      await Promise.all(tasksToDelete.map(t => documentParser!.deleteTaskFolder(t.projectId, t.parentName, t.id)));
    }
    const count = deleteTasksBySource(payload.projectId, payload.source);
    logger.info({ projectId: payload.projectId, source: payload.source, deletedCount: count }, 'Tasks bulk deleted by source');

    const tasks = getTasksByProject(payload.projectId);
    wsServer.broadcast({
      type: 'task.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId: payload.projectId, tasks },
    } as WsMessage);
  });

  // ============================================
  // v2: Workspace Handlers
  // ============================================

  // WORKSPACE.SCAN
  wsServer.registerHandler('workspace.scan', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsWorkspaceScan;
    try {
      const result = workspaceScanner.scan(payload.path);

      upsertWorkspaceSkills(payload.projectId, payload.workspaceType, {
        path: payload.path,
        hasClaudeMd: result.hasClaudeMd,
        hasClaudeDir: result.hasClaudeDir,
        skills: result.skills,
      });

      wsServer.send(ws, {
        type: 'workspace.scanResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId: payload.projectId,
          workspaceType: payload.workspaceType,
          path: payload.path,
          hasClaudeMd: result.hasClaudeMd,
          hasClaudeDir: result.hasClaudeDir,
          skills: result.skills,
        },
      } as WsMessage);
    } catch (err) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'workspace.scan_failed', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // WORKSPACE.GENERATE_SKILLS
  wsServer.registerHandler('workspace.generateSkills', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsWorkspaceGenerateSkills;
    try {
      const agentId = await skillGenerator.generate(
        payload.projectId,
        payload.path,
        payload.workspaceType,
      );
      logger.info({ agentId, projectId: payload.projectId, workspaceType: payload.workspaceType }, 'Skill generation started');

      sendProjectState(wsServer, ws, payload.projectId, orchestrator);
    } catch (err) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'workspace.generate_failed', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // ============================================
  // SVN Browse Handler
  // ============================================

  wsServer.registerHandler('svn.browse', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsSvnBrowse;

    try {
      const project = getProject(payload.projectId);
      if (!project) throw new Error('Project not found');

      const config = project.configJson ? JSON.parse(project.configJson) : null;
      const svnConfig = config?.svnConfig as SvnConfig | undefined;
      if (!svnConfig) throw new Error('No SVN config found for this project');

      // Determine which SVN root URL to list (auto-normalize VisualSVN web URLs)
      let svnUrl = payload.svnUrl ? normalizeSvnUrl(payload.svnUrl) : undefined;
      if (!svnUrl) {
        const raw = payload.specType === 'backend'
          ? svnConfig.backendSpecPath
          : svnConfig.frontendSpecPath;
        if (!raw) throw new Error(`No SVN path configured for ${payload.specType || 'frontend'}`);
        svnUrl = normalizeSvnUrl(raw);
      }

      // Find SVN executable
      const fs = await import('node:fs');
      const { execSync } = await import('node:child_process');
      const iconv = (await import('iconv-lite')).default;

      const svnCandidates = [
        'C:/Program Files/TortoiseSVN/bin/svn.exe',
        'C:/Program Files (x86)/TortoiseSVN/bin/svn.exe',
      ];
      let svnPath = 'svn';
      for (const c of svnCandidates) {
        if (fs.existsSync(c)) { svnPath = c; break; }
      }

      const creds = getSvnCredentials();
      const authArgs = [
        '--non-interactive',
        '--trust-server-cert',
        '--no-auth-cache',
      ];
      if (creds.username) authArgs.push(`--username "${creds.username}"`);
      if (creds.password) authArgs.push(`--password "${creds.password}"`);
      const auth = authArgs.join(' ');

      // Run svn list (non-recursive, one level)
      const buf = execSync(`"${svnPath}" list "${svnUrl}" ${auth}`, {
        encoding: 'buffer',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      // Decode (UTF-8 or Big5)
      const utf8 = buf.toString('utf-8');
      let listing: string;
      if (utf8.includes('\uFFFD') || /[\x80-\xFF]/.test(utf8.replace(/[\u0080-\uFFFF]/g, ''))) {
        try { listing = iconv.decode(buf, 'cp950'); } catch { listing = utf8; }
      } else {
        listing = utf8;
      }

      const entries = listing
        .split('\n')
        .map(f => f.trim())
        .filter(f => f.length > 0)
        .map(f => {
          const isDir = f.endsWith('/');
          const name = isDir ? f.slice(0, -1) : f;
          const baseUrl = svnUrl!.endsWith('/') ? svnUrl! : svnUrl + '/';
          return {
            name,
            isDir,
            fullUrl: baseUrl + encodeURIComponent(f).replace(/%2F/g, '/'),
          };
        });

      wsServer.send(ws, {
        type: 'svn.browseResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { svnUrl, entries },
      } as WsMessage);
    } catch (err) {
      wsServer.send(ws, {
        type: 'svn.browseResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { svnUrl: payload.svnUrl || '', entries: [], error: (err as Error).message },
      } as WsMessage);
    }
  });

  // SVN.PREVIEW — preview which spec files would be auto-fetched
  wsServer.registerHandler('svn.preview', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsSvnPreview;

    try {
      if (!svnSpecService) throw new Error('SVN service not available');

      const project = getProject(payload.projectId);
      if (!project) throw new Error('Project not found');

      const config = project.configJson ? JSON.parse(project.configJson) : null;
      const svnConfig = config?.svnConfig as SvnConfig | undefined;
      if (!svnConfig) throw new Error('No SVN config for this project');

      // Determine function code
      let functionCode = payload.functionCode;
      if (!functionCode && payload.taskId) {
        const task = getTask(payload.taskId);
        if (task) {
          functionCode = task.parentName || extractFunctionCode(task.title) || undefined;
        }
      }
      if (!functionCode) throw new Error('No function code provided or extractable');

      const taskLabel = payload.taskLabel || 'frontend';
      const rootCode = functionCode.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() || '';

      const files = svnSpecService.previewSpecsForCode(functionCode, svnConfig, taskLabel);

      wsServer.send(ws, {
        type: 'svn.previewResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { functionCode, rootCode, files },
      } as WsMessage);
    } catch (err) {
      wsServer.send(ws, {
        type: 'svn.previewResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { functionCode: payload.functionCode || '', rootCode: '', files: [], error: (err as Error).message },
      } as WsMessage);
    }
  });

  // ============================================
  // Global Config Handlers
  // ============================================

  const sendConfigState = (ws: WebSocket) => {
    const creds = getSvnCredentials();
    const asanaPat = getAsanaPat();
    wsServer.send(ws, {
      type: 'config.state',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: {
        svnUsername: creds.username,
        hasSvnPassword: !!creds.password,
        hasAsanaPat: !!(asanaPat || getConfig().asanaPat),
        asanaPatSource: asanaPat ? 'db' : getConfig().asanaPat ? 'env' : 'none',
      },
    } as WsMessage);
  };

  wsServer.registerHandler('config.get', (_msg: WsMessage, ws: WebSocket) => {
    sendConfigState(ws);
  });

  wsServer.registerHandler('config.setSvnCredentials', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { username: string; password: string } };
    setSvnCredentials({ username: payload.username, password: payload.password });
    sendConfigState(ws);
  });

  wsServer.registerHandler('config.setAsanaPat', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { pat: string } };
    setAsanaPat(payload.pat);
    reloadAsanaPat(payload.pat || null);
    sendConfigState(ws);
  });

  // Test SVN credentials by running `svn info` on a known SVN path
  wsServer.registerHandler('config.testSvn', async (msg: WsMessage, ws: WebSocket) => {
    const creds = getSvnCredentials();
    if (!creds.username && !creds.password) {
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'svn', success: false, message: 'No SVN credentials configured' },
      } as WsMessage);
      return;
    }

    try {
      const { execSync } = await import('node:child_process');
      // Use any project's SVN path to test, or just test auth with svn info on the server root
      const authArgs = [
        '--non-interactive', '--trust-server-cert', '--no-auth-cache',
      ];
      if (creds.username) authArgs.push('--username', creds.username);
      if (creds.password) authArgs.push('--password', creds.password);

      // Try to find a project with an SVN path configured
      const projects = listProjects();
      let testUrl = '';
      for (const p of projects) {
        if (p.configJson) {
          try {
            const cfg = JSON.parse(p.configJson);
            testUrl = cfg.svnConfig?.frontendSpecPath || cfg.svnConfig?.backendSpecPath || '';
            if (testUrl) break;
          } catch { /* ignore */ }
        }
      }

      if (!testUrl) {
        wsServer.send(ws, {
          type: 'config.testResult',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { service: 'svn', success: false, message: 'No SVN path configured in any project. Set SVN Spec paths in Project Settings first.' },
        } as WsMessage);
        return;
      }

      execSync(`svn info "${testUrl}" ${authArgs.join(' ')}`, {
        encoding: 'buffer',
        timeout: 15000,
      });

      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'svn', success: true, message: 'SVN connection successful' },
      } as WsMessage);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAuth = /auth|401|403|password|credential/i.test(errMsg);
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'svn', success: false, message: isAuth ? 'Authentication failed — check username/password' : errMsg.slice(0, 200) },
      } as WsMessage);
    }
  });

  // Test Asana PAT by calling /users/me
  wsServer.registerHandler('config.testAsana', async (_msg: WsMessage, ws: WebSocket) => {
    if (!asanaClient) {
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'asana', success: false, message: 'Asana client not initialized' },
      } as WsMessage);
      return;
    }

    try {
      await asanaClient.connect();
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'asana', success: true, message: 'Asana connection successful' },
      } as WsMessage);
    } catch (err: unknown) {
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'asana', success: false, message: err instanceof Error ? err.message : String(err) },
      } as WsMessage);
    }
  });

  // ============================================
  // ASANA MCP Handlers
  // ============================================

  wsServer.registerHandler('asana.checkConnection', async (msg: WsMessage, ws: WebSocket) => {
    if (!asanaClient) {
      wsServer.send(ws, {
        type: 'asana.connectionStatus',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          connected: false,
          configured: false,
          lastChecked: new Date().toISOString(),
          error: 'Asana MCP client not initialized',
        },
      } as WsMessage);
      return;
    }

    try {
      const status = await asanaClient.checkConnection();
      wsServer.send(ws, {
        type: 'asana.connectionStatus',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: status,
      } as WsMessage);
    } catch (err) {
      wsServer.send(ws, {
        type: 'asana.connectionStatus',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          connected: false,
          configured: asanaClient.isConfigured(),
          lastChecked: new Date().toISOString(),
          error: (err as Error).message,
        },
      } as WsMessage);
    }
  });

  wsServer.registerHandler('asana.fetchTasks', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaFetchTasks;

    if (!asanaClient || !asanaClient.isConfigured()) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_NOT_CONFIGURED', message: 'Asana not configured' },
      } as WsMessage);
      return;
    }

    try {
      // If projectGid is provided, fetch all tasks in that project (for import drawer)
      // Otherwise, fetch tasks assigned to me (global view)
      const tasks = payload.projectGid
        ? await asanaClient.getProjectTasks(payload.projectGid, { includeCompleted: payload.includeCompleted })
        : await asanaClient.getMyTasks(payload);
      logger.info({ count: tasks.length, projectGid: payload.projectGid || 'all' }, 'Fetched Asana tasks');
      wsServer.send(ws, {
        type: 'asana.tasks',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { tasks },
      } as WsMessage);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Asana tasks');
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_FETCH_ERROR', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // ASANA.FETCH_MY_PROJECT_TASKS — tasks assigned to me in a specific Asana project
  wsServer.registerHandler('asana.fetchMyProjectTasks', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaFetchMyProjectTasks;

    if (!asanaClient || !asanaClient.isConfigured()) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_NOT_CONFIGURED', message: 'Asana not configured' },
      } as WsMessage);
      return;
    }

    try {
      const tasks = await asanaClient.getMyTasksForProject(payload.projectGid, {
        includeCompleted: payload.includeCompleted,
      });
      logger.info({ projectGid: payload.projectGid, count: tasks.length }, 'Fetched my Asana project tasks');
      wsServer.send(ws, {
        type: 'asana.tasks',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { tasks },
      } as WsMessage);
    } catch (err) {
      logger.error({ err, projectGid: payload.projectGid }, 'Failed to fetch my Asana project tasks');
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_FETCH_ERROR', message: (err as Error).message },
      } as WsMessage);
    }
  });

  wsServer.registerHandler('asana.fetchProjects', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaFetchProjects;

    if (!asanaClient || !asanaClient.isConfigured()) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_NOT_CONFIGURED', message: 'Asana not configured' },
      } as WsMessage);
      return;
    }

    try {
      const projects = await asanaClient.getProjects(payload.workspace);
      wsServer.send(ws, {
        type: 'asana.projects',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { projects },
      } as WsMessage);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Asana projects');
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_FETCH_ERROR', message: (err as Error).message },
      } as WsMessage);
    }
  });

  wsServer.registerHandler('asana.fetchTaskStories', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaFetchTaskStories;

    if (!asanaClient || !asanaClient.isConfigured()) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_NOT_CONFIGURED', message: 'Asana not configured' },
      } as WsMessage);
      return;
    }

    try {
      const stories = await asanaClient.getTaskStories(payload.taskGid);
      wsServer.send(ws, {
        type: 'asana.taskStories',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { taskGid: payload.taskGid, stories },
      } as WsMessage);
    } catch (err) {
      logger.error({ err }, 'Failed to fetch Asana task stories');
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_STORIES_ERROR', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // ============================================
  // ASANA SYNC Handlers
  // ============================================

  wsServer.registerHandler('asana.syncNow', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaSyncNow;

    if (!asanaSyncService) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'SYNC_NOT_AVAILABLE', message: 'Sync service not initialized' },
      } as WsMessage);
      return;
    }

    try {
      const result = await asanaSyncService.syncOnce(payload.projectId);
      wsServer.broadcast({
        type: 'asana.syncResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: result,
      } as WsMessage);
    } catch (err) {
      logger.error({ err, projectId: payload.projectId }, 'Sync failed');
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'SYNC_FAILED', message: (err as Error).message },
      } as WsMessage);
    }
  });

  wsServer.registerHandler('asana.updateSyncConfig', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaUpdateSyncConfig;

    if (!asanaSyncService) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'SYNC_NOT_AVAILABLE', message: 'Sync service not initialized' },
      } as WsMessage);
      return;
    }

    try {
      asanaSyncService.updateSyncConfig(payload.projectId, payload.config);
      wsServer.broadcast({
        type: 'asana.syncConfig',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { projectId: payload.projectId, config: payload.config },
      } as WsMessage);
    } catch (err) {
      logger.error({ err, projectId: payload.projectId }, 'Update sync config failed');
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'SYNC_CONFIG_ERROR', message: (err as Error).message },
      } as WsMessage);
    }
  });

  // On new client connection
  wsServer.setInitialStateProvider(() => {
    const projects = listProjects();
    return {
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects },
    } as WsMessage;
  });

  // MOCKUP.RELOAD — spawn axure agent to re-crawl selected pages
  wsServer.registerHandler('mockup.reload', async (msg: WsMessage, _ws: WebSocket) => {
    const { projectId, filenames, axshareUrl } = (msg as WsMockupReload).payload;
    const project = getProject(projectId);
    if (!project) return;

    const fileList = filenames.map(f => `- ${f}`).join('\n');
    const prompt = `Use the /crawl-axure-snapshots skill to re-crawl the following Axure snapshot pages.

IMPORTANT: Use ONLY mcp__playwright__browser_navigate and mcp__playwright__browser_evaluate. Do NOT use browser_take_screenshot or browser_resize — the workflow is pure JS coordinate analysis, no screenshots needed. Do NOT run playwright via Node.js scripts or npm/npx.

Axure Share base URL: ${axshareUrl}
Project ID: ${projectId}
Output directory: docs/axure-snapshots/${projectId}/

Pages to re-crawl (filenames tell you the module and page type):
${fileList}

For each filename like "sb01-查詢.html" (module: sb01, page type: 查詢):
1. browser_close → close any existing browser
2. browser_navigate → direct .html URL for the page
3. browser_evaluate → hide chrome elements
4. browser_evaluate → JS Step 1: field labels sorted by y coordinate
5. browser_evaluate → JS Step 2: x coordinates for same-row fields
6. browser_evaluate → JS Step 3: input/select/textarea types, options, defaults
7. browser_evaluate → JS Step 3.5: large custom components (height > 80px, non-standard tags)
8. Write semantic HTML from JS data, save with Write tool to docs/axure-snapshots/${projectId}/{filename}
9. browser_evaluate → JS Step 4: verify buttons

Context compaction recovery: if your context was compacted and you are unsure which pages remain, run:
  Bash: ls docs/axure-snapshots/${projectId}/
Then compare with the full sitemap page list and continue with the pages not yet saved.

Browser stuck rule: if the browser fails or hangs 3 times in total (across all pages), stop immediately and end with [TASK_COMPLETE] noting which pages were completed.

When all pages are saved, end with [TASK_COMPLETE].`;

    await agentManager.startAgent({
      projectId,
      role: 'axure',
      prompt,
      workingDir: getConfig().projectRoot,
    });
  });

  // MOCKUP.CRAWL_ALL — initial crawl: fetch sitemap then crawl all pages
  wsServer.registerHandler('mockup.crawlAll', async (msg: WsMessage, _ws: WebSocket) => {
    const { projectId, axshareUrl, existingFiles } = (msg as WsMockupCrawlAll).payload;
    const project = getProject(projectId);
    if (!project) return;

    const skipSection = existingFiles && existingFiles.length > 0
      ? `\nAlready crawled (SKIP these):\n${existingFiles.map(f => `- ${f}`).join('\n')}\n`
      : '';

    const prompt = `Use the /crawl-axure-snapshots skill to crawl ALL pages from this Axure Share project.

IMPORTANT: Use ONLY mcp__playwright__browser_navigate and mcp__playwright__browser_evaluate (Playwright MCP tools). Do NOT use browser_take_screenshot or browser_resize — the workflow is pure JS coordinate analysis, no screenshots needed. Do NOT run playwright via Node.js scripts or npm/npx.

Axure Share URL: ${axshareUrl}
Project ID: ${projectId}
Output directory: docs/axure-snapshots/${projectId}/${skipSection}

Workflow per page (Method A from the skill — pure JS, no screenshots):
1. browser_close → close any existing browser
2. browser_navigate → direct .html URL for the page (preferred over shell URL)
3. browser_evaluate → hide chrome elements
4. browser_evaluate → JS Step 1: get all field labels sorted by y coordinate
5. browser_evaluate → JS Step 2: get x coordinates for fields that appear to be on the same row
6. browser_evaluate → JS Step 3: get input/select/textarea types, options, default values
7. browser_evaluate → JS Step 3.5: detect large custom components (WYSIWYG editors, file widgets) by height > 80px filter
8. Write semantic HTML based on the JS coordinate data (NOT from screenshots)
9. Write tool → save to docs/axure-snapshots/${projectId}/{module_code}-{page_type}.html
10. browser_evaluate → JS Step 4: verify button list matches HTML

To get all page names: navigate to the Axure Share base URL and run:
  () => { const flat = []; const walk = (nodes) => nodes.forEach(n => { flat.push({name: n.pageName, id: n.id, url: n.url}); if (n.children) walk(n.children); }); walk(window.$axure.document.sitemap.rootNodes); return flat; }

Context compaction recovery: if your context was compacted and you are unsure which pages remain, run:
  Bash: ls docs/axure-snapshots/${projectId}/
Then compare with the full sitemap page list and continue with the pages not yet saved.

Browser stuck rule: if the browser fails or hangs 3 times in total (across all pages), stop immediately and end with [TASK_COMPLETE] noting which pages were completed.

When all pages are saved, end with [TASK_COMPLETE].`;

    await agentManager.startAgent({
      projectId,
      role: 'axure',
      prompt,
      workingDir: getConfig().projectRoot,
    });
  });

  wsServer.setPostConnectionHandler((ws) => {
    const projects = listProjects();
    for (const p of projects) {
      if (['executing', 'planning'].includes(p.status)) {
        sendProjectState(wsServer, ws, p.id, orchestrator);
      }
    }
  });
}

function sendProjectState(
  wsServer: OmniWebSocketServer,
  ws: WebSocket,
  projectId: string,
  orchestrator?: MasterOrchestrator,
): void {
  const project = getProject(projectId);
  if (!project) return;

  const tasks = getTasksByProject(projectId);
  const agents = getAgentsByProject(projectId);
  const dependencies = getDependencies(projectId);

  wsServer.send(ws, {
    type: 'project.state',
    id: genId(),
    timestamp: new Date().toISOString(),
    payload: { project, tasks, agents, dependencies },
  } as WsMessage);

  if (orchestrator) {
    const docs = orchestrator.getSpecHandler().getDocumentParser().getDocuments(projectId);
    if (docs.length > 0) {
      wsServer.send(ws, {
        type: 'project.documents',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          projectId,
          documents: docs.map(d => ({
            id: d.id,
            filename: d.filename,
            docType: d.docType,
          })),
        },
      } as WsMessage);
    }
  }

  const plans = getPlansByProject(projectId);
  if (plans.length > 0) {
    wsServer.send(ws, {
      type: 'agent.plans',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId, plans },
    } as WsMessage);
  }

  for (const agent of agents) {
    const outputs = getAgentOutputs(agent.id, 200);
    if (outputs.length > 0) {
      wsServer.send(ws, {
        type: 'project.agentOutputs',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          agentId: agent.id,
          outputs: outputs.reverse(),
        },
      } as WsMessage);
    }
  }
}
