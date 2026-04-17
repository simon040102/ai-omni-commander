import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { getConfig, reloadAsanaPat } from './config.js';
import { getDb } from './db/connection.js';
import { getProject } from './db/queries/projects.js';
import { EventBus } from './eventbus/EventBus.js';
import { ContextSync } from './eventbus/ContextSync.js';
import { ContractWatcher } from './eventbus/ContractWatcher.js';
import { AgentManager } from './agent/AgentManager.js';
import { TaskDispatcher } from './orchestrator/TaskDispatcher.js';
import { SpecModeHandler } from './orchestrator/SpecModeHandler.js';
import { CreativeModeHandler } from './orchestrator/CreativeModeHandler.js';
import { ExecutionPipeline } from './orchestrator/ExecutionPipeline.js';
import { MasterOrchestrator } from './orchestrator/MasterOrchestrator.js';
import { QuickModeHandler } from './orchestrator/QuickModeHandler.js';
import { WorkspaceScanner } from './workspace/WorkspaceScanner.js';
import { SkillGenerator } from './workspace/SkillGenerator.js';
import { OmniWebSocketServer } from './websocket/WebSocketServer.js';
import { registerHandlers } from './websocket/MessageRouter.js';
import { AsanaMcpClient } from './asana/AsanaMcpClient.js';
import { AsanaSyncService } from './asana/AsanaSyncService.js';
import { TaskClassifier } from './orchestrator/TaskClassifier.js';
import { CodeReviewAgent } from './review/CodeReviewAgent.js';
import { ReviewTrigger } from './review/ReviewTrigger.js';
import { RetryHandler } from './review/RetryHandler.js';
import { SvnSpecService } from './svn/SvnSpecService.js';
import { SaFlowAnalyzer } from './documents/SaFlowAnalyzer.js';
import { listProjects } from './db/queries/projects.js';
import { getTask } from './db/queries/tasks.js';
import { getRecentPaths, addRecentPath, removeRecentPath, clearRecentPaths, migrateProjectPathsToRecent } from './db/queries/recentPaths.js';
import { genId } from './utils/uuid.js';
import { logger } from './utils/logger.js';
import type { WsMessage } from '@omni/shared';
import { EventTypes, CURRENT_MODELS, LEGACY_MODELS } from '@omni/shared';

async function main() {
  // Allow self-signed TLS certs for internal DB connections (MSSQL/PostgreSQL)
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const config = getConfig();
  logger.info({ port: config.port }, 'Starting AI-OmniCommander (SDK mode)');

  // Log available Claude models
  logger.info('=== Available Claude Models ===');
  logger.info('Current models:');
  for (const [alias, info] of Object.entries(CURRENT_MODELS)) {
    logger.info(`  ${alias.padEnd(8)} -> ${info.id.padEnd(30)} (${info.displayName}, $${info.pricing.inputPerMTok}/$${info.pricing.outputPerMTok} per MTok)`);
  }
  logger.info('Legacy models:');
  for (const [alias, info] of Object.entries(LEGACY_MODELS)) {
    const deprecated = info.deprecated ? ' [DEPRECATED]' : '';
    logger.info(`  ${alias.padEnd(12)} -> ${info.id.padEnd(35)} (${info.displayName})${deprecated}`);
  }
  logger.info('===============================');

  // 1. Initialize database
  const db = getDb();
  logger.info({ dbPath: config.dbPath }, 'Database initialized');

  // Migrate existing project paths to recent_paths (one-time on startup)
  migrateProjectPathsToRecent();

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
  const specCacheDir = path.join(path.dirname(config.dbPath), 'spec-cache');
  const pipeline = new ExecutionPipeline(agentManager, eventBus, specHandler.getDocumentParser(), specCacheDir);

  // SVN Spec Service: auto-fetch spec documents from SVN
  const svnCacheDir = path.join(path.dirname(config.dbPath), 'svn-cache');
  const svnSpecService = new SvnSpecService(specHandler.getDocumentParser(), svnCacheDir);
  pipeline.setSvnSpecService(svnSpecService);

  const orchestrator = new MasterOrchestrator(specHandler, creativeHandler, pipeline);
  const quickModeHandler = new QuickModeHandler(agentManager, eventBus);

  // v2: Workspace services
  const workspaceScanner = new WorkspaceScanner();
  const skillGenerator = new SkillGenerator(agentManager);

  // v3: Code review and auto-retry
  // Note: ReviewTrigger (separate review agent) replaced by self-review in AgentManager.handleAgentComplete
  // const codeReviewAgent = new CodeReviewAgent(agentManager, eventBus, contextSync);
  // const _reviewTrigger = new ReviewTrigger(eventBus, codeReviewAgent);
  const _retryHandler = new RetryHandler(eventBus, pipeline);

  // Load Asana PAT from DB, or persist ENV value to DB for portability
  {
    const { getAsanaPat, setAsanaPat } = await import('./db/queries/globalConfig.js');
    const dbPat = getAsanaPat();
    if (dbPat) {
      reloadAsanaPat(dbPat);
      logger.info('Asana PAT loaded from database');
    } else if (config.asanaPat) {
      // ENV has PAT but DB doesn't — persist to DB so it works without ENV next time
      setAsanaPat(config.asanaPat);
      logger.info('Asana PAT from ENV persisted to database');
    }
  }

  // Create Asana MCP client (optional - only connects when ASANA_PAT is set)
  const asanaClient = new AsanaMcpClient(config);
  if (config.asanaPat) {
    logger.info('Asana MCP integration enabled');
  } else {
    logger.info('Asana MCP integration disabled (no PAT configured)');
  }

  // Create task classifier and sync service
  const taskClassifier = new TaskClassifier();

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

  // Get available Claude models
  app.get('/api/models', (_req, res) => {
    res.json({
      current: CURRENT_MODELS,
      legacy: LEGACY_MODELS,
      selectable: ['sonnet', 'opus', 'haiku'],
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

  // Recent paths API
  app.get('/api/recent-paths', (req, res) => {
    const limit = parseInt(req.query['limit'] as string) || 10;
    const paths = getRecentPaths(limit);
    res.json({ paths });
  });

  app.post('/api/recent-paths', (req, res) => {
    const { path: pathValue, label } = req.body as { path?: string; label?: string };
    if (!pathValue) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    const result = addRecentPath(pathValue, label);
    res.json(result);
  });

  app.delete('/api/recent-paths/:id', (req, res) => {
    const idOrPath = req.params['id'];
    const numId = parseInt(idOrPath);
    if (!isNaN(numId)) {
      removeRecentPath(numId);
    } else {
      removeRecentPath(idOrPath);
    }
    res.json({ success: true });
  });

  app.delete('/api/recent-paths', (_req, res) => {
    clearRecentPaths();
    res.json({ success: true });
  });

  // List .claude/commands/ skill files from a workspace directory
  app.get('/api/skills', (req, res) => {
    const dir = req.query['path'] as string;
    if (!dir) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    try {
      const result = workspaceScanner.scan(dir);
      res.json({
        skills: result.skills,
        hasClaudeMd: result.hasClaudeMd,
        hasClaudeDir: result.hasClaudeDir,
        detectedFramework: result.detectedFramework,
        scripts: result.scripts,
      });
    } catch (err) {
      res.status(400).json({ error: `Cannot read skills: ${dir}` });
    }
  });

  // v2: Workspace scan endpoint (for folder picker real-time feedback)
  app.get('/api/workspace/scan', (req, res) => {
    const dir = req.query['path'] as string;
    if (!dir) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    try {
      const result = workspaceScanner.scan(dir);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: `Cannot scan workspace: ${dir}` });
    }
  });

  // ============ Mockup HTML Snapshots ============
  const SNAPSHOTS_DIR = path.join(path.dirname(config.dbPath), '..', 'docs', 'axure-snapshots');

  app.get('/api/projects/:id/mockups', (req, res) => {
    const dir = path.join(SNAPSHOTS_DIR, req.params['id']);
    const codeFilter = (req.query['code'] as string | undefined)?.toLowerCase().trim();
    try {
      if (!fs.existsSync(dir)) { res.json({ files: [] }); return; }
      let files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.html'))
        .map(f => {
          const stat = fs.statSync(path.join(dir, f));
          return {
            filename: f,
            fullPath: path.join(dir, f).replace(/\\/g, '/'),
            updatedAt: stat.mtime.toISOString(),
          };
        })
        .sort((a, b) => a.filename.localeCompare(b.filename));
      if (codeFilter) {
        files = files.filter(f => f.filename.toLowerCase().startsWith(codeFilter + '-'));
      }
      res.json({ files });
    } catch {
      res.status(400).json({ error: 'Cannot read mockup directory' });
    }
  });

  app.get('/api/projects/:id/mockups/:filename', (req, res) => {
    const filename = path.basename(req.params['filename']); // prevent path traversal
    const filepath = path.join(SNAPSHOTS_DIR, req.params['id'], filename);
    try {
      if (!fs.existsSync(filepath)) { res.status(404).json({ error: 'File not found' }); return; }
      const content = fs.readFileSync(filepath, 'utf-8');
      // Wrap fragment in minimal full HTML doc for iframe rendering
      const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:13px;padding:8px;}</style></head><body>${content}</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(wrapped);
    } catch {
      res.status(400).json({ error: 'Cannot read file' });
    }
  });

  // ============ DB Explorer (read-only) ============
  const DB_TABLE_WHITELIST = [
    'projects', 'agents', 'tasks', 'task_dependencies', 'task_documents', 'events',
    'agent_outputs', 'documents', 'interventions', 'agent_plans',
    'recent_paths', 'workspace_skills',
  ];

  app.get('/api/db/tables', (_req, res) => {
    try {
      const tables = DB_TABLE_WHITELIST.map(name => {
        const row = db.prepare(`SELECT COUNT(*) as count FROM ${name}`).get() as { count: number };
        return { name, count: row.count };
      });
      res.json({ tables });
    } catch (err) {
      res.status(500).json({ error: `Failed to list tables: ${(err as Error).message}` });
    }
  });

  app.get('/api/db/:table', (req, res) => {
    const tableName = req.params['table'];
    if (!tableName || !DB_TABLE_WHITELIST.includes(tableName)) {
      res.status(400).json({ error: `Invalid table: ${tableName}. Allowed: ${DB_TABLE_WHITELIST.join(', ')}` });
      return;
    }

    const limit = Math.min(parseInt(req.query['limit'] as string) || 50, 200);
    const offset = parseInt(req.query['offset'] as string) || 0;
    const orderBy = req.query['orderBy'] as string || 'rowid';
    const order = (req.query['order'] as string || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const search = req.query['search'] as string || '';
    const projectId = req.query['projectId'] as string || '';

    try {
      // Get column info
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>;
      const colNames = columns.map(c => c.name);

      // Validate orderBy column
      const safeOrderBy = colNames.includes(orderBy) ? orderBy : 'rowid';

      // Build WHERE clause
      const conditions: string[] = [];
      const params: string[] = [];

      if (projectId && colNames.includes('project_id')) {
        conditions.push('project_id = ?');
        params.push(projectId);
      }

      if (search) {
        // Search across all TEXT columns
        const textCols = columns.filter(c => c.type === 'TEXT').map(c => c.name);
        if (textCols.length > 0) {
          const searchCondition = textCols.map(c => `${c} LIKE ?`).join(' OR ');
          conditions.push(`(${searchCondition})`);
          for (const _ of textCols) {
            params.push(`%${search}%`);
          }
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count total
      const countRow = db.prepare(`SELECT COUNT(*) as total FROM ${tableName} ${whereClause}`).get(...params) as { total: number };

      // Fetch rows
      const rows = db.prepare(
        `SELECT * FROM ${tableName} ${whereClause} ORDER BY ${safeOrderBy} ${order} LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      res.json({
        table: tableName,
        columns: columns.map(c => ({ name: c.name, type: c.type })),
        rows,
        totalCount: countRow.total,
        limit,
        offset,
      });
    } catch (err) {
      res.status(500).json({ error: `Failed to query table: ${(err as Error).message}` });
    }
  });

  // ── External DB Schema API ──────────────────────────────────────
  const { ExternalSchemaFetcher } = await import('./db/externalDb.js');
  const { getSchema: getCachedSchema, setSchema: setCachedSchema } = await import('./db/schemaCache.js');
  const { generateFullERDiagram, generateSingleTableERDiagram } = await import('./db/erDiagramGenerator.js');
  const schemaFetcher = new ExternalSchemaFetcher();

  // POST /api/schema/:projectId/:connectionId/fetch — trigger schema fetch (manual only)
  app.post('/api/schema/:projectId/:connectionId/fetch', async (req, res) => {
    const { projectId, connectionId } = req.params;
    const project = getProject(projectId as string);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

    const cfg = project.configJson ? JSON.parse(project.configJson) : {};
    const conn = (cfg.dbConnections || []).find((c: { id: string }) => c.id === connectionId);
    if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

    try {
      const result = await schemaFetcher.fetchSchema(connectionId as string, conn.connectionString, conn.dbType);
      setCachedSchema(projectId as string, connectionId as string, result);

      // Persist schema.json and er-diagram.mmd so agents can read them
      const dataDir = path.dirname(config.dbPath);
      const schemaDir = path.join(dataDir, 'schemas', projectId as string, connectionId as string);
      fs.mkdirSync(schemaDir, { recursive: true });
      fs.writeFileSync(path.join(schemaDir, 'schema.json'), JSON.stringify(result, null, 2), 'utf8');
      const mmdContent = generateFullERDiagram(result);
      fs.writeFileSync(path.join(schemaDir, 'er-diagram.mmd'), mmdContent, 'utf8');

      res.json({ result, schemaPath: path.join(schemaDir, 'schema.json'), erPath: path.join(schemaDir, 'er-diagram.mmd') });
    } catch (err) {
      res.status(500).json({ error: `Schema fetch failed: ${(err as Error).message}` });
    }
  });

  // GET /api/schema/:projectId/:connectionId — get cached schema
  app.get('/api/schema/:projectId/:connectionId', (req, res) => {
    const { projectId, connectionId } = req.params;
    const cached = getCachedSchema(projectId as string, connectionId as string);
    if (!cached) { res.status(404).json({ error: 'No cached schema. Click "Fetch Schema" to load.' }); return; }
    res.json({ result: cached });
  });

  // GET /api/schema/:projectId/:connectionId/er-diagram?table= — get Mermaid ER diagram
  app.get('/api/schema/:projectId/:connectionId/er-diagram', (req, res) => {
    const { projectId, connectionId } = req.params;
    let schema = getCachedSchema(projectId as string, connectionId as string);

    // Fallback: load from disk if not in memory (e.g. after server restart)
    if (!schema) {
      const dataDir = path.dirname(config.dbPath);
      const schemaFile = path.join(dataDir, 'schemas', projectId as string, connectionId as string, 'schema.json');
      if (fs.existsSync(schemaFile)) {
        try {
          schema = JSON.parse(fs.readFileSync(schemaFile, 'utf8'));
          if (schema) setCachedSchema(projectId as string, connectionId as string, schema);
        } catch { /* ignore parse errors */ }
      }
    }

    if (!schema) { res.status(404).json({ error: 'No schema found. Click "Fetch Schema" first.' }); return; }

    const tableName = req.query['table'] as string | undefined;
    const mermaid = tableName
      ? generateSingleTableERDiagram(schema, tableName)
      : generateFullERDiagram(schema);
    res.json({ mermaid });
  });

  // GET /api/sa-flow/:projectId — list all cached SA flows for a project
  const saFlowAnalyzer = new SaFlowAnalyzer(path.dirname(config.dbPath));
  app.get('/api/sa-flow/:projectId', (req, res) => {
    const { projectId } = req.params;
    const flows = saFlowAnalyzer.listProjectFlows(projectId);
    res.json({ flows });
  });

  // GET /api/sa-flow/:projectId/file?path= — serve a .mmd file
  app.get('/api/sa-flow/:projectId/file', (req, res) => {
    const flowPath = req.query['path'] as string;
    if (!flowPath || !flowPath.endsWith('.mmd')) { res.status(400).json({ error: 'Invalid path' }); return; }
    if (!fs.existsSync(flowPath)) { res.status(404).json({ error: 'Flow file not found' }); return; }
    res.type('text/plain').send(fs.readFileSync(flowPath, 'utf-8'));
  });

  // GET /api/task/:taskId/verification-report — serve verification report MD
  app.get('/api/task/:taskId/verification-report', (req, res) => {
    const { taskId } = req.params;
    const task = getTask(taskId as string);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    const project = getProject(task.projectId);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    // Determine workspace dir (frontend_path or backend_path or working_dir)
    const workspaceDir = (task.label === 'frontend' ? project.frontendPath : project.backendPath) || project.workingDir;
    const reportPath = path.join(workspaceDir, 'docs', 'verification-reports', `${taskId}.md`);
    if (!fs.existsSync(reportPath)) { res.status(404).json({ error: 'Report not found' }); return; }
    res.type('text/plain').send(fs.readFileSync(reportPath, 'utf-8'));
  });

  // POST /api/schema/test-connection — test DB connectivity
  app.post('/api/schema/test-connection', async (req, res) => {
    const { connectionString, dbType } = req.body as { connectionString: string; dbType: string };
    if (!connectionString || !dbType) { res.status(400).json({ error: 'Missing connectionString or dbType' }); return; }
    try {
      await schemaFetcher.testConnection(connectionString, dbType as 'postgresql' | 'mysql' | 'mssql');
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: (err as Error).message });
    }
  });

  // Upload file (for pasted images/files from clipboard)
  const uploadsDir = path.join(path.dirname(config.dbPath), 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  app.post('/api/upload', (req, res) => {
    try {
      const { data, filename, mimeType, projectId, taskId } = req.body as {
        data: string; // base64 encoded
        filename?: string;
        mimeType?: string;
        projectId?: string;
        taskId?: string;
      };

      if (!data) {
        res.status(400).json({ error: 'data is required' });
        return;
      }

      // Determine target directory (task subfolder if context provided)
      let targetDir = uploadsDir;
      if (projectId && taskId) {
        const task = getTask(taskId);
        const code = task?.parentName || null;
        const subFolder = code ? `${code}_${taskId.slice(0, 8)}` : `task_${taskId.slice(0, 8)}`;
        targetDir = path.join(uploadsDir, projectId, subFolder);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      } else if (projectId) {
        targetDir = path.join(uploadsDir, projectId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      }

      // Generate unique filename
      const ext = mimeType?.split('/')[1] || 'bin';
      const name = filename || `upload_${Date.now()}.${ext}`;
      const safeName = name.replace(/[^a-zA-Z0-9._\u4e00-\u9fff\u3040-\u30ff-]/g, '_');
      const filePath = path.join(targetDir, `${Date.now()}_${safeName}`);

      // Decode base64 and save
      const buffer = Buffer.from(data, 'base64');
      fs.writeFileSync(filePath, buffer);

      logger.info({ filePath, size: buffer.length }, 'File uploaded');
      res.json({ success: true, path: filePath, size: buffer.length });
    } catch (err) {
      logger.error({ err }, 'Upload failed');
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // 4. Create HTTP server and WebSocket server
  const httpServer = createServer(app);
  const wsServer = new OmniWebSocketServer(httpServer);

  // 5. Create sync service (needs wsServer)
  const asanaSyncService = new AsanaSyncService(asanaClient, taskClassifier, pipeline, wsServer);
  asanaSyncService.setSvnSpecService(svnSpecService);
  asanaSyncService.setDocumentParser(specHandler.getDocumentParser());

  // 6. Register WebSocket message handlers
  registerHandlers(wsServer, orchestrator, agentManager, workspaceScanner, skillGenerator, asanaClient, asanaSyncService, quickModeHandler, svnSpecService, specHandler.getDocumentParser());

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

  eventBus.on('review.*', (event) => {
    wsServer.broadcast({
      type: event.type,
      id: genId(),
      timestamp: event.timestamp,
      payload: event.payload,
    } as WsMessage);
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
    asanaSyncService.stopAll();
    await agentManager.stopAllForProject('*');
    await contractWatcher.stop();
    await asanaClient.disconnect();
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
