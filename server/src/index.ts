import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { getConfig } from './config.js';
import { getDb } from './db/connection.js';
import { EventBus } from './eventbus/EventBus.js';
import { ContextSync } from './eventbus/ContextSync.js';
import { ContractWatcher } from './eventbus/ContractWatcher.js';
import { AgentManager } from './agent/AgentManager.js';
import { TaskDispatcher } from './orchestrator/TaskDispatcher.js';
import { SpecModeHandler } from './orchestrator/SpecModeHandler.js';
import { CreativeModeHandler } from './orchestrator/CreativeModeHandler.js';
import { MasterOrchestrator } from './orchestrator/MasterOrchestrator.js';
import { OmniWebSocketServer } from './websocket/WebSocketServer.js';
import { registerHandlers } from './websocket/MessageRouter.js';
import { listProjects } from './db/queries/projects.js';
import { genId } from './utils/uuid.js';
import { logger } from './utils/logger.js';
import type { WsMessage } from '@omni/shared';
import { EventTypes } from '@omni/shared';

async function main() {
  const config = getConfig();
  logger.info({ port: config.port }, 'Starting AI-OmniCommander (SDK mode)');

  // 1. Initialize database
  const db = getDb();
  logger.info({ dbPath: config.dbPath }, 'Database initialized');

  // 2. Create core services
  const eventBus = new EventBus();
  const contextSync = new ContextSync(config.aiContextDir);
  await contextSync.init();

  const agentManager = new AgentManager(eventBus, contextSync);
  const dispatcher = new TaskDispatcher(eventBus, contextSync);

  // Wire dispatcher to agent manager
  dispatcher.onDispatch(async (taskId, role, prompt) => {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
    if (!task) return;
    await agentManager.startAgent({
      projectId: task.project_id,
      role,
      taskId,
      prompt,
    });
  });

  const specHandler = new SpecModeHandler(agentManager, dispatcher, contextSync, eventBus);
  const creativeHandler = new CreativeModeHandler(agentManager, dispatcher, contextSync, eventBus);
  const orchestrator = new MasterOrchestrator(specHandler, creativeHandler);

  // 3. Create Express app for HTTP
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'sdk',
      activeAgents: agentManager.getActiveAgents().length,
    });
  });

  // Browse local filesystem directories
  app.get('/api/browse', (req, res) => {
    const dir = (req.query['path'] as string) || os.homedir();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const folders = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(dir, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ current: dir, parent: path.dirname(dir), folders });
    } catch (err) {
      res.status(400).json({ error: `Cannot read directory: ${dir}` });
    }
  });

  // 4. Create HTTP server and WebSocket server
  const httpServer = createServer(app);
  const wsServer = new OmniWebSocketServer(httpServer);

  // 5. Register WebSocket message handlers
  registerHandlers(wsServer, orchestrator, agentManager);

  // 6. Wire EventBus to WebSocket broadcast
  eventBus.on('agent.*', (event) => {
    wsServer.broadcast({
      type: `agent.${event.type.split('.')[1]}`,
      id: genId(),
      timestamp: event.timestamp,
      payload: event.payload,
    } as WsMessage);
  });

  eventBus.on('task.*', (event) => {
    wsServer.broadcast({
      type: `task.${event.type.split('.')[1]}`,
      id: genId(),
      timestamp: event.timestamp,
      payload: event.payload,
    } as WsMessage);
  });

  eventBus.on('project.*', (event) => {
    // Broadcast project phase changes (e.g. executing → completed)
    if (event.type === EventTypes.PROJECT_PHASE_CHANGED) {
      const allProjects = listProjects();
      wsServer.broadcast({
        type: 'projects.list',
        id: genId(),
        timestamp: event.timestamp,
        payload: { projects: allProjects },
      } as WsMessage);
    }
  });

  eventBus.on('contract.*', (event) => {
    wsServer.broadcast({
      type: 'eventbus.notification',
      id: genId(),
      timestamp: event.timestamp,
      payload: {
        eventType: event.type,
        source: event.source || '',
        target: event.target || '',
        data: event.payload,
      },
    } as WsMessage);
  });

  eventBus.on('intervention.*', (event) => {
    wsServer.broadcast({
      type: 'intervention.request',
      id: genId(),
      timestamp: event.timestamp,
      payload: event.payload,
    } as WsMessage);
  });

  // Wire creative mode interview events to WebSocket
  creativeHandler.onInterview((type, data) => {
    if (type === 'question') {
      wsServer.broadcast({
        type: 'interview.question',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: data,
      } as WsMessage);
    } else if (type === 'specDraft') {
      wsServer.broadcast({
        type: 'interview.specDraft',
        id: genId(),
        timestamp: new Date().toISOString(),
        payload: data,
      } as WsMessage);
    }
  });

  // 7. Start contract watcher (uses a default project ID for now)
  // In production, each project gets its own watcher
  const contractWatcher = new ContractWatcher(config.aiContextDir, eventBus, 'default');
  contractWatcher.start();

  // 8. Listen
  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, 'AI-OmniCommander server is running');
    logger.info(`Dashboard: http://localhost:5173`);
    logger.info(`API: http://localhost:${config.port}/api/health`);
    logger.info(`WebSocket: ws://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await agentManager.stopAllForProject('*');
    await contractWatcher.stop();
    httpServer.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
