import type { WebSocket } from 'ws';
import type {
  WsMessage, WsCreateProject, WsUploadDocument,
  WsStartExecution,
  WsAgentAction, WsAgentCommand, WsAgentResume, WsInterventionResolve,
  WsDeleteProject, WsUpdateProject, WsDeleteAgent, WsUpdateAgent, WsAddAgent,
  WsPlanAction, WsAsanaFetchTasks, WsAsanaFetchMyProjectTasks, WsAsanaFetchProjects, WsAsanaCheckConnection, WsAsanaFetchTaskStories,
  WsAsanaSyncNow, WsAsanaUpdateSyncConfig,
  WsTaskCreate, WsTaskDelete, WsTaskUpdate, WsTaskBulkDeleteBySource,
  WsWorkspaceScan,
  WsSvnBrowse, WsSvnPreview,
  AgentRole,
} from '@omni/shared';
import type { SvnConfig } from '@omni/shared';
import { normalizeSvnUrl, extractFunctionCode, runCommand, buildSvnAuth, buildCurlAuth } from '../svn/SvnSpecService.js';
import { validateSpecFolders } from '../documents/FolderSpecSource.js';
import type { SvnSpecService } from '../svn/SvnSpecService.js';
import { getSvnCredentials, setSvnCredentials, getAsanaPat, setAsanaPat, getGlobalMcpServers, setGlobalMcpServers } from '../db/queries/globalConfig.js';
import type { McpStdioServerConfig } from '@omni/shared';
import { getConfig, reloadAsanaPat } from '../config.js';
import type { MasterOrchestrator } from '../orchestrator/MasterOrchestrator.js';
import type { AgentManager } from '../agent/AgentManager.js';
import type { OmniWebSocketServer } from './WebSocketServer.js';
import type { AsanaMcpClient } from '../asana/AsanaMcpClient.js';
import type { AsanaSyncService } from '../asana/AsanaSyncService.js';
import type { WorkspaceScanner } from '../workspace/WorkspaceScanner.js';
import { createProject, listProjects, getProject, deleteProject, updateProject } from '../db/queries/projects.js';
import { getTasksByProject, getDependencies, updateTask, createTask, deleteTask, updateTaskFields, deleteTasksBySource, getTask } from '../db/queries/tasks.js';
import { getAgentsByProject, deleteAgent, updateAgent as updateAgentDb } from '../db/queries/agents.js';
import { resolveIntervention, getAgentOutputs, logAgentOutput } from '../db/queries/events.js';
import { JsonlWatcher } from '../agent/JsonlWatcher.js';
import { SessionResolver } from '../agent/SessionResolver.js';
import type { JsonlAssistantMessage, JsonlUserMessage } from '@omni/shared';
import { getPlan, getPlansByProject, updatePlanStatus } from '../db/queries/plans.js';
import { getAgent } from '../db/queries/agents.js';
import { upsertWorkspaceSkills } from '../db/queries/workspaceSkills.js';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';
import { loadSuperpowersPrompt } from '../skills/superpowers/index.js';
import type { SuperpowersFeature } from '@omni/shared';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { getDb } from '../db/connection.js';
// logTaskOutput is a pure db function (mcp/flow-gate) — reused so the Web UI
// [SKIP] audit trail lands in the same agent_outputs stream as the MCP gates.
import { logTaskOutput } from '../mcp/flow-gate.js';
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
  asanaClient?: AsanaMcpClient,
  asanaSyncService?: AsanaSyncService,
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

    // For fullstack tasks: if no other agents remain for this task, reset task to pending
    if (projectId && agentRecord?.currentTaskId) {
      const task = getTask(agentRecord.currentTaskId);
      if (task && (task.status === 'in_progress' || task.status === 'assigned')) {
        const remainingAgents = getAgentsByProject(projectId).filter(
          a => a.currentTaskId === task.id,
        );
        if (remainingAgents.length === 0) {
          updateTask(task.id, { status: 'pending', assignedAgentId: null });
          // Notify frontend
          wsServer.broadcast({
            type: 'task.statusChange',
            id: genId(),
            timestamp: new Date().toISOString(),
            payload: { taskId: task.id, projectId, newStatus: 'pending' },
          } as WsMessage);
        }
      }
    }
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

    // Validate specFolders vs workspace overlap (絕對路徑、不可與 workspace 重疊) — throws → error toast
    // 重疊不變量必須在「任一邊」改變時重驗：configJson 帶 specFolders 時驗新值；
    // 只改 frontendPath/backendPath 時，對「既存」specFolders 重驗（防單邊更新繞過）。
    {
      const effectiveFrontend = payload.frontendPath !== undefined ? payload.frontendPath : existing.frontendPath;
      const effectiveBackend = payload.backendPath !== undefined ? payload.backendPath : existing.backendPath;

      let specFoldersRaw: unknown;
      if (updates.configJson) {
        let parsedConfig: unknown;
        try {
          parsedConfig = JSON.parse(updates.configJson);
        } catch {
          throw new Error('configJson 不是有效的 JSON');
        }
        specFoldersRaw = (parsedConfig as { specFolders?: unknown } | null)?.specFolders;
      } else if (payload.frontendPath !== undefined || payload.backendPath !== undefined) {
        // workspace 路徑變更但沒帶 configJson：對既存設定重驗
        try {
          specFoldersRaw = (JSON.parse(existing.configJson || '{}') as { specFolders?: unknown } | null)?.specFolders;
        } catch { /* 既存 config 損壞時交由其他路徑處理 */ }
      }

      if (specFoldersRaw !== undefined) {
        const { warnings } = validateSpecFolders(specFoldersRaw, [effectiveFrontend, effectiveBackend]);
        if (warnings.length > 0) {
          logger.warn({ projectId: payload.projectId, warnings }, 'specFolders validation warnings');
        }
      }
    }

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
    const validTaskTypes = ['bug', 'feature', 'refactor', 'testing', 'other'] as const;
    const safeTaskType = validTaskTypes.includes(payload.taskType as typeof validTaskTypes[number])
      ? payload.taskType as typeof validTaskTypes[number]
      : 'other';
    const task = createTask({
      projectId: payload.projectId,
      title: payload.title,
      description: payload.description,
      taskType: safeTaskType,
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
    const validTaskTypes = ['bug', 'feature', 'refactor', 'testing', 'other'] as const;
    const safeTaskType = payload.taskType && validTaskTypes.includes(payload.taskType as typeof validTaskTypes[number])
      ? payload.taskType as typeof validTaskTypes[number]
      : payload.taskType ? 'other' : undefined;

    // 稽核：Web UI 的 task.update 可直接寫 completed（使用者親手操作＝同意），
    // 不擋，但比照 MCP 的 [SKIP] 機制留一筆稽核行進 agent_outputs。
    // 目前 UI 沒有直接標 completed 的入口（TaskList 只送 pending reset）——
    // 此稽核是對第三方 WS client / 未來 UI 的防禦。
    const wasNotCompleted = payload.status === 'completed'
      && (() => { const prev = getTask(payload.taskId); return !!prev && prev.status !== 'completed'; })();

    updateTaskFields(payload.taskId, {
      title: payload.title,
      description: payload.description,
      specUrl: payload.specUrl,
      label: payload.label,
      taskType: safeTaskType,
      status: payload.status,
      preferredModel: payload.preferredModel,
      parentName: payload.parentName,
    });

    // 更新成功後才寫稽核——避免 update throw 時留下狀態沒真的改的假紀錄
    if (wasNotCompleted) {
      const nowTask = getTask(payload.taskId);
      if (nowTask?.status === 'completed') {
        try {
          logTaskOutput(getDb(), payload.taskId, nowTask.projectId, '[SKIP] 使用者由 Web UI 直接標記 completed，未經閘門（完工閘 / 檢查表 / AI 規格回對 / 單元測試 / 執行計畫 / 驗收結果）檢查');
        } catch (err) {
          logger.warn({ err, taskId: payload.taskId }, 'Failed to write [SKIP] audit for direct completed');
        }
      }
    }
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
      const svnAuth = buildSvnAuth(creds);

      // Run svn list (non-recursive, one level); fall back to curl --ntlm on E120190
      let buf: Buffer;
      const spawnResult = await runCommand(svnPath, ['list', svnUrl, ...svnAuth.args], {
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        ...(svnAuth.stdin !== undefined && { stdin: svnAuth.stdin }),
      });
      if (!spawnResult.error && spawnResult.status === 0) {
        buf = spawnResult.stdout;
      } else {
        const errMsg = spawnResult.stderr.length > 0 ? spawnResult.stderr.toString('utf-8') : String(spawnResult.error ?? '');
        if (/E120190|authentication context|NTLM|Negotiate/i.test(errMsg)) {
          // NTLM/Negotiate auth — fall back to curl GET (VisualSVN returns HTML index)
          const curlAuth = buildCurlAuth(creds.username, creds.password);
          const listUrl = svnUrl!.endsWith('/') ? svnUrl! : svnUrl + '/';
          const curlResult = await runCommand('curl', [
            ...curlAuth.args,
            listUrl,
          ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024, ...(curlAuth.stdin !== undefined && { stdin: curlAuth.stdin }) });
          if (curlResult.error || curlResult.status !== 0) {
            throw new Error(curlResult.stderr.toString('utf-8') || `curl NTLM failed (exit ${curlResult.status})`);
          }
          const html = curlResult.stdout.toString('utf-8');
          const entries: Array<{ name: string; isDir: boolean; fullUrl: string }> = [];
          const fileRe = /<file[^>]+name="([^"]+)"/g;
          const dirRe = /<dir[^>]+name="([^"]+)"\s+href="([^"]+)"/g;
          let m: RegExpExecArray | null;
          while ((m = fileRe.exec(html)) !== null) {
            const name = m[1]!;
            entries.push({ name, isDir: false, fullUrl: listUrl + encodeURIComponent(name) });
          }
          while ((m = dirRe.exec(html)) !== null) {
            const name = m[1]!;
            entries.push({ name, isDir: true, fullUrl: listUrl + m[2] });
          }
          wsServer.send(ws, { type: 'svn.browseResult', id: genId(), timestamp: new Date().toISOString(), payload: { svnUrl, entries } } as WsMessage);
          return;
        }
        throw new Error(errMsg || 'svn list failed');
      }

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
  wsServer.registerHandler('svn.preview', async (msg: WsMessage, ws: WebSocket) => {
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

      const preview = await svnSpecService.previewSpecsForCode(functionCode, svnConfig, taskLabel);
      if (preview.files.length === 0 && preview.errors.length > 0) {
        throw new Error(`SVN 搜尋失敗: ${preview.errors.join('; ')}`);
      }

      wsServer.send(ws, {
        type: 'svn.previewResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { functionCode, rootCode, files: preview.files },
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
        globalMcpServers: getGlobalMcpServers(),
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

  wsServer.registerHandler('config.setGlobalMcpServers', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { servers: Record<string, unknown> } };
    setGlobalMcpServers(payload.servers as Record<string, McpStdioServerConfig>);
    sendConfigState(ws);
  });

  // Test SVN credentials by running `svn info` on a known SVN path
  wsServer.registerHandler('config.testSvn', async (_msg: WsMessage, ws: WebSocket) => {
    const { detectSvnBinary, isSvnAvailable } = await import('../svn/SvnSpecService.js');

    // Check svn binary exists
    if (!isSvnAvailable()) {
      const hint = process.platform === 'win32'
        ? 'SVN not found. Install TortoiseSVN (enable command-line tools) or SilkSVN.'
        : 'SVN not found. Install via: brew install subversion';
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'svn', success: false, message: hint },
      } as WsMessage);
      return;
    }

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
      const svnAuth = buildSvnAuth(creds);

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

      const svnBin = detectSvnBinary();
      const normalizedUrl = normalizeSvnUrl(testUrl);

      // Try svn first; fall back to curl --ntlm if server requires NTLM/Negotiate auth
      let connected = false;
      let svnError = '';

      const svnResult = await runCommand(svnBin, ['info', normalizedUrl, ...svnAuth.args], {
        timeout: 15000, maxBuffer: 1024 * 1024, ...(svnAuth.stdin !== undefined && { stdin: svnAuth.stdin }),
      });

      if (!svnResult.error && svnResult.status === 0) {
        connected = true;
      } else {
        svnError = (svnResult.stderr.length > 0 ? svnResult.stderr.toString('utf-8') : '') || String(svnResult.error ?? '');
        const isNtlm = /E120190|authentication context|NTLM|Negotiate/i.test(svnError);
        if (isNtlm) {
          // Try curl --ntlm
          const curlAuth = buildCurlAuth(creds.username, creds.password);
          const curlResult = await runCommand('curl', [
            ...curlAuth.args,
            '-X', 'PROPFIND', '-H', 'Depth: 0',
            '-H', 'Content-Type: text/xml',
            '-d', '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
            '-w', '\n%{http_code}',
            normalizedUrl,
          ], { timeout: 15000, maxBuffer: 1024 * 1024, ...(curlAuth.stdin !== undefined && { stdin: curlAuth.stdin }) });

          const curlOut = curlResult.stdout.toString('utf-8');
          const httpCode = curlOut.trim().split('\n').pop() ?? '0';
          if (!curlResult.error && (curlResult.status === 0 || parseInt(httpCode) < 400)) {
            connected = true;
          } else {
            throw new Error(`NTLM auth failed: ${curlResult.stderr.toString('utf-8').slice(0, 200) || httpCode}`);
          }
        } else {
          throw new Error(svnError.slice(0, 300));
        }
      }

      if (connected) {
        wsServer.send(ws, {
          type: 'config.testResult',
          id: genId(),
          timestamp: new Date().toISOString(),
          payload: { service: 'svn', success: true, message: 'SVN connection successful' },
        } as WsMessage);
      }
    } catch (err: unknown) {
      const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      wsServer.send(ws, {
        type: 'config.testResult',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { service: 'svn', success: false, message: errMsg },
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
    let outputs = getAgentOutputs(agent.id, 200);

    // If agent is stopped and has a sessionId, prefer JSONL over DB.
    // JSONL is always a superset of DB — it includes any VSCode-continued conversations.
    const agentCwd = agent.workingDir || project.workingDir;
    if (agent.sessionId && agentCwd &&
        (agent.status === 'stopped' || agent.status === 'error')) {
      try {
        const jsonlPath = SessionResolver.getJsonlPath(agentCwd, agent.sessionId);
        const jsonlOutputs = jsonlMessagesToOutputs(new JsonlWatcher(jsonlPath).readAll());
        if (jsonlOutputs.length > 0) {
          // JSONL is chronological (oldest first); reverse to match DB DESC behavior
          // so the final outputs.reverse() in the send block produces correct order
          outputs = jsonlOutputs.reverse();
        }
      } catch {
        // JSONL not found or unreadable — fall back to DB outputs
      }
    }

    if (outputs.length > 0) {
      wsServer.send(ws, {
        type: 'project.agentOutputs',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          agentId: agent.id,
          outputs: outputs.reverse(),
          flowPlanJson: agent.flowPlanJson || null,
        },
      } as WsMessage);
    }
  }
}

/** Convert JSONL session messages to the same format as DB agent_outputs */
function jsonlMessagesToOutputs(messages: ReturnType<JsonlWatcher['readAll']>): Array<{
  streamType: string;
  content: string;
  timestamp: string;
}> {
  const outputs: Array<{ streamType: string; content: string; timestamp: string }> = [];
  for (const msg of messages) {
    const ts = msg.timestamp || new Date().toISOString();
    if (msg.type === 'assistant') {
      const asst = msg as JsonlAssistantMessage;
      for (const block of (asst.message?.content || [])) {
        if (block.type === 'text') {
          outputs.push({ streamType: 'text', content: block.text, timestamp: ts });
        } else if (block.type === 'tool_use') {
          outputs.push({ streamType: 'tool_use', content: JSON.stringify({ tool: block.name, input: block.input }), timestamp: ts });
        }
      }
    } else if (msg.type === 'user') {
      const user = msg as JsonlUserMessage;
      for (const block of (user.message?.content || [])) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          outputs.push({ streamType: 'tool_result', content, timestamp: ts });
        } else if (block.type === 'text' && block.text?.trim()) {
          // User's typed message in VSCode (not tool result)
          outputs.push({ streamType: 'system', content: `[USER] ${block.text}`, timestamp: ts });
        }
      }
    }
  }
  return outputs;
}
