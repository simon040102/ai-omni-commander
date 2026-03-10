import type { WebSocket } from 'ws';
import type {
  WsMessage, WsCreateProject, WsUploadDocument,
  WsStartExecution, WsInterviewResponse, WsInterviewConfirm,
  WsAgentAction, WsAgentCommand, WsInterventionResolve, WsTaskOverride,
  WsDeleteProject, WsUpdateProject, WsDeleteAgent, WsAddAgent,
  WsDeleteDocument, WsPlanAction, WsAsanaFetchTasks, WsAsanaCheckConnection,
  AgentRole,
} from '@omni/shared';
import type { MasterOrchestrator } from '../orchestrator/MasterOrchestrator.js';
import type { AgentManager } from '../agent/AgentManager.js';
import type { OmniWebSocketServer } from './WebSocketServer.js';
import type { AsanaMcpClient } from '../asana/AsanaMcpClient.js';
import { createProject, listProjects, getProject, deleteProject, updateProject } from '../db/queries/projects.js';
import { getTasksByProject, getDependencies, updateTask } from '../db/queries/tasks.js';
import { getAgentsByProject, deleteAgent } from '../db/queries/agents.js';
import { resolveIntervention, getAgentOutputs, logAgentOutput } from '../db/queries/events.js';
import { getPlan, getPlansByProject, updatePlanStatus } from '../db/queries/plans.js';
import { getAgent } from '../db/queries/agents.js';
import { genId } from '../utils/uuid.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('MessageRouter');

/**
 * Registers all WebSocket message handlers.
 */
export function registerHandlers(
  wsServer: OmniWebSocketServer,
  orchestrator: MasterOrchestrator,
  agentManager: AgentManager,
  asanaClient?: AsanaMcpClient,
): void {
  // PROJECT.CREATE
  wsServer.registerHandler('project.create', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsCreateProject;
    if (!payload.name || !payload.projectId || !payload.mode) {
      wsServer.send(ws, {
        type: 'error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'VALIDATION_ERROR', message: 'Missing required fields: name, projectId, mode' },
      } as WsMessage);
      return;
    }
    const config: Record<string, unknown> = {};
    if (payload.workspaces?.length) config['workspaces'] = payload.workspaces;
    if (payload.reviewConfig) config['reviewConfig'] = payload.reviewConfig;
    if (payload.superpowers) config['superpowers'] = payload.superpowers;
    const configJson = Object.keys(config).length > 0 ? JSON.stringify(config) : undefined;
    const project = createProject({
      id: payload.projectId,
      name: payload.name,
      mode: payload.mode,
      workingDir: payload.workingDir,
      configJson,
    });
    logger.info({ projectId: project.id, name: project.name, workspaces: payload.workspaces }, 'Project created');

    // Broadcast updated project list to ALL clients so every open UI reflects the new project
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

  // PROJECT.CLEAR_DOCUMENTS — remove all old documents before a new execution round
  wsServer.registerHandler('project.clearDocuments', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { projectId: string } };
    const specHandler = orchestrator.getSpecHandler();
    const count = await specHandler.clearDocuments(payload.projectId);
    logger.info({ projectId: payload.projectId, deletedCount: count }, 'Documents cleared for new execution');
    // Send acknowledgment so frontend knows it's safe to upload new files
    wsServer.send(ws, {
      type: 'project.documentsCleared',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId: payload.projectId, deletedCount: count },
    } as WsMessage);
  });

  // PROJECT.DELETE_DOCUMENT — delete a single document
  wsServer.registerHandler('project.deleteDocument', async (msg: WsMessage) => {
    const { payload } = msg as WsDeleteDocument;
    const specHandler = orchestrator.getSpecHandler();
    const deletedDoc = await specHandler.getDocumentParser().deleteDocument(payload.documentId);

    if (deletedDoc) {
      logger.info({ projectId: payload.projectId, documentId: payload.documentId, filename: deletedDoc.filename }, 'Document deleted');

      // Clean up the deleted document from all workspaces
      await specHandler.removeDocumentFromWorkspaces(payload.projectId, deletedDoc.filename, deletedDoc.docType);

      // Broadcast updated document list to all clients
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
      payload.docType,
    );

    // Get the newly uploaded document and inject to workspaces
    const docs = specHandler.getDocumentParser().getDocuments(payload.projectId);
    const newDoc = docs.find(d => d.filename === payload.filename);
    if (newDoc) {
      await specHandler.injectNewDocument(payload.projectId, newDoc);
    }

    // Broadcast updated document list to all clients
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
    await orchestrator.start(payload.projectId, payload.requirement, payload.model, payload.quickTask);
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

  // AGENT.COMMAND (send user instruction to a running agent — stops & resumes session)
  wsServer.registerHandler('agent.command', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAgentCommand;
    try {
      const sent = await agentManager.sendInputToAgent(payload.agentId, payload.command);
      if (sent) {
        logger.info({ agentId: payload.agentId }, 'Command sent to agent (session resumed)');
        const userInstructionContent = `[USER INSTRUCTION] ${payload.command}`;
        // Persist to DB so it survives project switches
        logAgentOutput({
          agentId: payload.agentId,
          streamType: 'system',
          content: userInstructionContent,
        });
        // Broadcast feedback so the instruction appears in the terminal output
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

  // AGENT.DELETE — stop and remove an agent
  wsServer.registerHandler('agent.delete', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsDeleteAgent;
    // Stop the agent if running
    await agentManager.stopAgent(payload.agentId);
    // Delete from DB
    deleteAgent(payload.agentId);
    logger.info({ agentId: payload.agentId }, 'Agent deleted');

    // Refresh project state for the requesting client
    // We need the agent's project ID — try to get it before deletion
    // Since we already deleted, we broadcast the project list instead
    // The client will need to re-fetch state
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
  });

  // AGENT.ADD — manually add and start a new agent for a project
  wsServer.registerHandler('agent.add', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAddAgent;
    try {
      const agentId = await agentManager.startAgent({
        projectId: payload.projectId,
        role: payload.role as AgentRole,
        prompt: payload.prompt,
        model: payload.model,
      });
      logger.info({ agentId, projectId: payload.projectId, role: payload.role }, 'Agent manually added');

      // Send updated project state
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

  // AGENT.PLAN_ACTION — approve or reject a plan
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
      // Resume the agent to continue execution
      const agent = getAgent(plan.agentId);
      if (agent) {
        await agentManager.resumeAgent(plan.agentId, '計劃書已核准，請繼續執行。');
        logger.info({ agentId: plan.agentId }, 'Agent resumed after plan approval');
      }
    } else if (payload.action === 'reject' && payload.feedback) {
      // Resume the agent with feedback for revision
      const agent = getAgent(plan.agentId);
      if (agent) {
        await agentManager.resumeAgent(plan.agentId, `計劃書需要修改：\n${payload.feedback}\n\n請重新擬定計劃書。`);
        logger.info({ agentId: plan.agentId }, 'Agent resumed with plan rejection feedback');
      }
    }

    // Broadcast updated plan list to all clients
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
      // Resume the agent
      const agentId = (payload as Record<string, unknown>)['agentId'] as string | undefined;
      if (agentId) {
        await agentManager.resumeAgent(agentId, payload.userInput);
      }
    }
  });

  // TASK.OVERRIDE
  wsServer.registerHandler('task.override', async (msg: WsMessage) => {
    const { payload } = msg as WsTaskOverride;
    switch (payload.action) {
      case 'retry':
        updateTask(payload.taskId, { status: 'queued', retryCount: 0 });
        break;
      case 'skip':
        updateTask(payload.taskId, { status: 'completed', resultSummary: 'Skipped by user' });
        break;
    }
  });

  // PROJECT.DELETE
  wsServer.registerHandler('project.delete', async (msg: WsMessage) => {
    const { payload } = msg as WsDeleteProject;
    // Stop any running agents first
    await agentManager.stopAllForProject(payload.projectId);
    deleteProject(payload.projectId);
    logger.info({ projectId: payload.projectId }, 'Project deleted');

    // Broadcast updated project list
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
    if (payload.workspaces !== undefined) {
      // Merge workspaces into existing config
      let config: Record<string, unknown> = {};
      if (existing.configJson) {
        try { config = JSON.parse(existing.configJson); } catch { /* ignore */ }
      }
      config['workspaces'] = payload.workspaces;
      updates.configJson = JSON.stringify(config);
    }

    updateProject(payload.projectId, updates);
    logger.info({ projectId: payload.projectId }, 'Project updated');

    // Broadcast updated project list
    const allProjects = listProjects();
    wsServer.broadcast({
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects: allProjects },
    } as WsMessage);

    // Send updated project state to the requesting client
    sendProjectState(wsServer, ws, payload.projectId, orchestrator);
  });

  // PROJECT.GET_STATE — client requests full state for a specific project
  wsServer.registerHandler('project.getState', (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as unknown as { payload: { projectId: string } };
    sendProjectState(wsServer, ws, payload.projectId, orchestrator);
  });

  // PROJECTS.LIST (when client asks for all projects)
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
  // ASANA MCP Handlers
  // ============================================

  // ASANA.CHECK_CONNECTION
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

  // ASANA.FETCH_TASKS
  wsServer.registerHandler('asana.fetchTasks', async (msg: WsMessage, ws: WebSocket) => {
    const { payload } = msg as WsAsanaFetchTasks;

    if (!asanaClient) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_NOT_CONFIGURED', message: 'Asana MCP client not initialized' },
      } as WsMessage);
      return;
    }

    if (!asanaClient.isConfigured()) {
      wsServer.send(ws, {
        type: 'asana.error',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: { code: 'ASANA_NOT_CONFIGURED', message: 'ASANA_PAT environment variable not set' },
      } as WsMessage);
      return;
    }

    try {
      const tasks = await asanaClient.getMyTasks(payload);
      logger.info({ count: tasks.length }, 'Fetched Asana tasks');
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

  // On new client connection: send project list + full state for active projects
  wsServer.setInitialStateProvider(() => {
    const projects = listProjects();
    return {
      type: 'projects.list',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projects },
    } as WsMessage;
  });

  // Also send full project state for any executing projects on connection
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

  // Send document list for this project
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

  // Send plan list for this project
  const plans = getPlansByProject(projectId);
  if (plans.length > 0) {
    wsServer.send(ws, {
      type: 'agent.plans',
      id: genId(),
      timestamp: new Date().toISOString(),
      payload: { projectId, plans },
    } as WsMessage);
  }

  // Also send recent outputs for each agent so the terminal is populated
  for (const agent of agents) {
    const outputs = getAgentOutputs(agent.id, 200); // last 200 lines per agent
    if (outputs.length > 0) {
      wsServer.send(ws, {
        type: 'project.agentOutputs',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: {
          agentId: agent.id,
          outputs: outputs.reverse(), // DB returns DESC, reverse to chronological
        },
      } as WsMessage);
    }
  }
}
