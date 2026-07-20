import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { getConfig, reloadAsanaPat } from './config.js';
import { getDb } from './db/connection.js';
import { backupDatabase } from './db/backup.js';
import { getProject } from './db/queries/projects.js';
import { EventBus } from './eventbus/EventBus.js';
import { ContextSync } from './eventbus/ContextSync.js';
import { ContractWatcher } from './eventbus/ContractWatcher.js';
import { AgentManager } from './agent/AgentManager.js';
import { TaskDispatcher } from './orchestrator/TaskDispatcher.js';
import { SpecModeHandler } from './orchestrator/SpecModeHandler.js';
import { ExecutionPipeline } from './orchestrator/ExecutionPipeline.js';
import { MasterOrchestrator } from './orchestrator/MasterOrchestrator.js';
import { WorkspaceScanner } from './workspace/WorkspaceScanner.js';
import { OmniWebSocketServer } from './websocket/WebSocketServer.js';
import { registerHandlers } from './websocket/MessageRouter.js';
import { AsanaMcpClient } from './asana/AsanaMcpClient.js';
import { AsanaSyncService } from './asana/AsanaSyncService.js';
import { TaskClassifier } from './orchestrator/TaskClassifier.js';
import { RetryHandler } from './review/RetryHandler.js';
import { SvnSpecService, extractFunctionCode } from './svn/SvnSpecService.js';

/** 任務功能代碼：parent_name 優先（Asana 母任務常帶 DF08_… 代碼），退回 title。 */
function taskFunctionCode(parentName: unknown, title: unknown): string | null {
  const p = typeof parentName === 'string' ? extractFunctionCode(parentName) : null;
  if (p) return p;
  return typeof title === 'string' ? extractFunctionCode(title) : null;
}
import { SaFlowAnalyzer } from './documents/SaFlowAnalyzer.js';
import { listProjects } from './db/queries/projects.js';
import { getTask } from './db/queries/tasks.js';
import { getRecentPaths, addRecentPath, removeRecentPath, clearRecentPaths, migrateProjectPathsToRecent } from './db/queries/recentPaths.js';
import { getAllProjectNotes, createProjectNote, archiveProjectNote } from './db/queries/projectNotes.js';
import { genId } from './utils/uuid.js';
import { isSafePathParam } from './utils/pathSafety.js';
import { ensureNotifyToken, verifyNotifyToken } from './utils/notifyToken.js';
import { handleMcpEventToast } from './utils/toastEvents.js';
// maskProjectConfig is a pure function (no MCP process/state dependency) — safe
// to reuse from the Web server so both surfaces mask credentials identically.
import { maskProjectConfig, maskConnectionString } from './mcp/helpers.js';
import { logger } from './utils/logger.js';
import type { WsMessage } from '@omni/shared';
import { EventTypes, CURRENT_MODELS, LEGACY_MODELS } from '@omni/shared';

/** 定期資料庫備份間隔（24h）。啟動時備份一次，之後每隔此間隔再備份一次。 */
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — server continues running, investigate ASAP');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

async function main() {
  // NOTE: Self-signed cert handling is done per-connection in externalDb.ts
  // Do NOT set NODE_TLS_REJECT_UNAUTHORIZED globally — it disables TLS for ALL requests

  const config = getConfig();
  logger.info({ port: config.port }, 'Starting AI-OmniCommander');

  // Loud warning when binding beyond loopback — the HTTP/WS surface has NO
  // authentication: anyone on the LAN could read specs/credentials and drive tasks.
  const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!LOOPBACK_HOSTS.has(config.host)) {
    logger.warn('============================================================');
    logger.warn(`  !! WARNING: HOST=${config.host} — server 綁定非 loopback 介面 !!`);
    logger.warn('  Web UI / API 沒有任何認證，區網內任何人都能讀取專案設定');
    logger.warn('  （含 DB 連線字串）並操作任務。僅限受信任的內網使用。');
    logger.warn('============================================================');
  }

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

  // 1b. Auto-backup DB on startup (best-effort — failure never blocks startup)
  await backupDatabase(db, path.dirname(config.dbPath));

  // 1c. Periodic DB backup (every BACKUP_INTERVAL_MS). backupDatabase is
  // best-effort (never throws) and reuses pruneBackups to keep only the newest
  // MAX_BACKUPS copies. unref() so the timer never keeps the process alive on
  // its own; cleared explicitly in graceful shutdown.
  const backupTimer = setInterval(() => {
    void backupDatabase(db, path.dirname(config.dbPath));
  }, BACKUP_INTERVAL_MS);
  backupTimer.unref();

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
    // fullstack label is handled by ExecutionPipeline.executeTask → FullstackController
    if (role === 'fullstack') return;
    await agentManager.startAgent({
      projectId: task.project_id,
      role: role as import('@omni/shared').AgentRole,
      taskId,
      prompt,
    });
  });

  const specHandler = new SpecModeHandler(agentManager, dispatcher, contextSync, eventBus);
  const specCacheDir = path.join(path.dirname(config.dbPath), 'spec-cache');
  const pipeline = new ExecutionPipeline(agentManager, eventBus, specHandler.getDocumentParser(), specCacheDir);

  // SVN Spec Service: auto-fetch spec documents from SVN
  const svnCacheDir = path.join(path.dirname(config.dbPath), 'svn-cache');
  const svnSpecService = new SvnSpecService(specHandler.getDocumentParser(), svnCacheDir);
  pipeline.setSvnSpecService(svnSpecService);

  const orchestrator = new MasterOrchestrator(specHandler, pipeline);

  // v2: Workspace services
  const workspaceScanner = new WorkspaceScanner();

  // v3: Auto-retry
  // Note: separate review agent (CodeReviewAgent/ReviewTrigger) replaced by self-review in AgentManager.handleAgentComplete
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

  // Assigned after the WS server is created (routes above it may reference it at request time)
  let wsServerRef: OmniWebSocketServer | null = null;

  // Path-parameter traversal guard: shared impl in utils/pathSafety.ts

  // Health check (ok + uptime consumed by MCP health_check tool)
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      status: 'ok',
      mode: config.agentBackend,
      uptime: process.uptime(),
      activeAgents: agentManager.getActiveAgents().length,
      projectRoot: config.projectRoot.replace(/\\/g, '/'),
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

  // Serve shared static assets (CSS, images) for mockup HTML
  app.use('/api/mockup-assets', express.static(SNAPSHOTS_DIR, { maxAge: '1d' }));

  app.get('/api/projects/:id/mockups', (req, res) => {
    if (!isSafePathParam(req.params['id'])) { res.status(400).json({ error: 'Invalid project ID' }); return; }
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
      // Build group labels from _sitemap.json (moduleCode → Chinese name)
      // sitemap items have {moduleCode, name, pageType}
      // Group label = common prefix of page names, or extract from moduleCode parent node name
      let groupLabels: Record<string, string> = {};
      const sitemapPath = path.join(dir, '_sitemap.json');
      if (fs.existsSync(sitemapPath)) {
        try {
          const sitemap = JSON.parse(fs.readFileSync(sitemapPath, 'utf-8')) as Array<{moduleCode: string; name: string; pageType: string}>;
          for (const page of sitemap) {
            if (page.moduleCode && !groupLabels[page.moduleCode]) {
              // Method 1: page name minus pageType = module Chinese name
              // e.g. name="系統代碼維護-查詢", pageType="查詢" → "系統代碼維護"
              let label = page.name;
              // Strip module code prefix (e.g. "SM03_人員帳號維護" → "人員帳號維護")
              label = label.replace(/^[A-Za-z]+\d+[_]?/, '');
              // Strip page type suffix
              if (page.pageType && label.endsWith(page.pageType)) {
                label = label.slice(0, -page.pageType.length).replace(/[-_]$/, '');
              } else if (page.pageType) {
                // Try removing pageType with separator
                label = label.replace(new RegExp('[-_]?' + page.pageType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
              }
              if (label && label.length > 0) {
                groupLabels[page.moduleCode] = label;
              }
            }
          }
        } catch {}
      }
      res.json({ files, groupLabels });
    } catch {
      res.status(400).json({ error: 'Cannot read mockup directory' });
    }
  });

  app.get('/api/projects/:id/mockups/:filename', (req, res) => {
    if (!isSafePathParam(req.params['id'])) { res.status(400).json({ error: 'Invalid project ID' }); return; }
    const filename = path.basename(req.params['filename']); // prevent path traversal
    const filepath = path.join(SNAPSHOTS_DIR, req.params['id'], filename);
    try {
      if (!fs.existsSync(filepath)) { res.status(404).json({ error: 'File not found' }); return; }
      const content = fs.readFileSync(filepath, 'utf-8');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // If file is already a full HTML document, send as-is; otherwise wrap in minimal doc
      if (content.trimStart().toLowerCase().startsWith('<!doctype') || content.trimStart().toLowerCase().startsWith('<html')) {
        // Rewrite relative asset paths to API paths for iframe serving
        let rewritten = content.replace(/href="\.\.\/style\.min\.css"/g, 'href="/api/mockup-assets/style.min.css"')
                                .replace(/src="\.\.\/images\//g, 'src="/api/mockup-assets/images/');
        // Inject inline style to fix icon sprite path (CSS relative URL doesn't resolve correctly in iframe)
        const iconFix = '<style>.tabeIcon::before{background-image:url(/api/mockup-assets/images/icon.svg)!important;}</style>';
        rewritten = rewritten.replace('</head>', iconFix + '</head>');
        res.send(rewritten);
      } else {
        const wrapped = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:13px;padding:8px;}</style></head><body>${content}</body></html>`;
        res.send(wrapped);
      }
    } catch {
      res.status(400).json({ error: 'Cannot read file' });
    }
  });

  // ============ DB Explorer (read-only) ============
  const DB_TABLE_WHITELIST = [
    'projects', 'agents', 'tasks', 'task_dependencies', 'task_documents', 'events',
    'agent_outputs', 'documents', 'interventions', 'agent_plans',
    'recent_paths', 'workspace_skills', 'spec_gaps',
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
      ).all(...params, limit, offset) as Array<Record<string, unknown>>;

      // projects.config_json carries credentials (dbConnections password /
      // connectionString, legacy svnConfig.password) — mask before returning.
      if (tableName === 'projects') {
        for (const row of rows) {
          const raw = row['config_json'];
          if (typeof raw === 'string' && raw.trim() !== '') {
            try {
              row['config_json'] = JSON.stringify(maskProjectConfig(JSON.parse(raw)));
            } catch {
              // Unparseable JSON could still contain secrets — never return it raw.
              row['config_json'] = '"[config_json unparseable — masked]"';
            }
          }
          // Legacy top-level column (v3 migration) also embeds Password=…
          const connStr = row['db_connection_string'];
          if (typeof connStr === 'string' && connStr !== '') {
            row['db_connection_string'] = maskConnectionString(connStr);
          }
        }
      }

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

  // GET /api/sa-flow/:projectId/file?path= — serve a .mmd file (must be within data/sa-flows/)
  const SA_FLOWS_DIR = path.resolve(path.join(path.dirname(config.dbPath), 'sa-flows'));
  app.get('/api/sa-flow/:projectId/file', (req, res) => {
    const flowPath = req.query['path'] as string;
    if (!flowPath || !flowPath.endsWith('.mmd')) { res.status(400).json({ error: 'Invalid path' }); return; }
    const resolved = path.resolve(flowPath);
    if (!resolved.startsWith(SA_FLOWS_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }
    if (!fs.existsSync(resolved)) { res.status(404).json({ error: 'Flow file not found' }); return; }
    res.type('text/plain').send(fs.readFileSync(resolved, 'utf-8'));
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

      // projectId/taskId become filesystem path segments — reject traversal
      // characters and unknown projects before touching the filesystem.
      if (projectId !== undefined) {
        if (typeof projectId !== 'string' || !isSafePathParam(projectId)) {
          res.status(400).json({ error: 'Invalid projectId' });
          return;
        }
        if (!getProject(projectId)) {
          res.status(400).json({ error: `Unknown projectId: ${projectId}` });
          return;
        }
      }
      if (taskId !== undefined && (typeof taskId !== 'string' || !isSafePathParam(taskId))) {
        res.status(400).json({ error: 'Invalid taskId' });
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

  // ── Task documents endpoint ──────────────────────────
  // Returns documents bound to a specific task (from task_documents + project-level docs).
  app.get('/api/task/:taskId/documents', (req, res) => {
    try {
      const { taskId } = req.params;
      const db = getDb();

      // Only return documents explicitly bound to this task
      const taskDocs = db.prepare(`
        SELECT d.id, d.filename, d.file_path, d.file_type, d.doc_type, d.source
        FROM task_documents td JOIN documents d ON d.id = td.document_id
        WHERE td.task_id = ?
        ORDER BY d.created_at ASC
      `).all(taskId) as Array<Record<string, unknown>>;

      const docs = taskDocs.map(d => ({
        id: d['id'] as string,
        filename: d['filename'] as string,
        filePath: d['file_path'] as string,
        docType: d['doc_type'] as string | null,
        source: d['source'] as string,
      }));

      res.json({ taskId, documents: docs });
    } catch (err) {
      logger.error({ err }, 'Failed to get task documents');
      res.status(500).json({ error: 'Failed to get task documents' });
    }
  });

  // ── Delete document endpoint ──────────────────────────
  app.delete('/api/document/:documentId', (req, res) => {
    try {
      const { documentId } = req.params;
      const db = getDb();
      db.prepare('DELETE FROM task_documents WHERE document_id = ?').run(documentId);
      db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to delete document');
      res.status(500).json({ error: 'Failed to delete document' });
    }
  });

  // ── MCP Execution Plan endpoint ──────────────────────────
  // Returns the full assembled prompt for a task (same as what agents receive).
  // Called by MCP Server's get_execution_plan tool.
  app.get('/api/execution-plan/:taskId', async (req, res) => {
    try {
      const { taskId } = req.params;
      const role = req.query['role'] as string | undefined;
      // 任務軌道：light = 輕量修復流程（checklist 改抽 BUG 原文）；預設 full（向後相容）
      const track: 'light' | 'full' = req.query['track'] === 'light' ? 'light' : 'full';
      logger.info({ taskId, role, track }, 'Building execution plan');

      let result: { prompt: string; workingDir: string; model: string };
      if (role && (role === 'frontend' || role === 'backend')) {
        result = await pipeline.preparePromptForRole(taskId, role, { track });
      } else {
        result = await pipeline.buildExecutionPlan(taskId, undefined, undefined, undefined, undefined, track);
      }

      // Always include both paths for orchestrator
      const task = getTask(taskId);
      const project = task ? getProject(task.projectId) : null;

      res.json({
        prompt: result.prompt,
        workingDir: result.workingDir,
        model: result.model,
        frontendPath: project?.frontendPath || null,
        backendPath: project?.backendPath || null,
      });
    } catch (err: any) {
      logger.error({ err, taskId: req.params['taskId'] }, 'Failed to build execution plan');
      res.status(500).json({ error: err.message || 'Failed to build execution plan' });
    }
  });

  // 4. Create HTTP server and WebSocket server
  const httpServer = createServer(app);
  const wsServer = new OmniWebSocketServer(httpServer);
  wsServerRef = wsServer;

  // 5. Create sync service (needs wsServer)
  const asanaSyncService = new AsanaSyncService(asanaClient, taskClassifier, wsServer);
  asanaSyncService.setSvnSpecService(svnSpecService);
  asanaSyncService.setDocumentParser(specHandler.getDocumentParser());

  // 6. Register WebSocket message handlers
  registerHandlers(wsServer, orchestrator, agentManager, workspaceScanner, asanaClient, asanaSyncService, svnSpecService, specHandler.getDocumentParser());

  // ── Spec gaps endpoints (backs the Web UI 待補規格 panel) ──────
  app.get('/api/spec-gaps/:projectId', (req, res) => {
    const projectId = req.params['projectId'];
    if (!projectId) { res.status(400).json({ error: 'Missing projectId' }); return; }
    try {
      const rows = db.prepare(`
        SELECT g.id, g.task_id, g.project_id, g.category, g.description, g.status,
               g.resolution_note, g.created_at, g.resolved_at, t.title as task_title, t.parent_name as task_parent_name
        FROM spec_gaps g LEFT JOIN tasks t ON t.id = g.task_id
        WHERE g.project_id = ?
        ORDER BY g.status ASC, g.created_at DESC
      `).all(projectId) as Array<Record<string, unknown>>;
      res.json({
        projectId,
        gaps: rows.map(r => ({
          id: r['id'],
          taskId: r['task_id'],
          taskTitle: r['task_title'],
          functionCode: taskFunctionCode(r['task_parent_name'], r['task_title']),
          category: r['category'],
          description: r['description'],
          status: r['status'],
          resolutionNote: r['resolution_note'],
          createdAt: r['created_at'],
          resolvedAt: r['resolved_at'],
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list spec gaps');
      res.status(500).json({ error: 'Failed to list spec gaps' });
    }
  });

  app.post('/api/spec-gaps/:gapId/resolve', (req, res) => {
    const gapId = req.params['gapId'];
    if (!gapId) { res.status(400).json({ error: 'Missing gapId' }); return; }
    try {
      const gap = db.prepare('SELECT id, task_id, project_id, category, description, status FROM spec_gaps WHERE id = ?').get(gapId) as
        { id: string; task_id: string; project_id: string; category: string; description: string; status: string } | undefined;
      if (!gap) { res.status(404).json({ error: 'Spec gap not found' }); return; }
      const note = (req.body as { note?: string } | undefined)?.note;
      if (gap.status !== 'resolved') {
        db.prepare("UPDATE spec_gaps SET status = 'resolved', resolution_note = ?, resolved_at = datetime('now') WHERE id = ?")
          .run(note || null, gapId);
        // Broadcast so open SpecGaps panels refetch
        wsServerRef?.broadcast({
          type: 'task.specGap',
          id: gapId,
          timestamp: new Date().toISOString(),
          payload: { gapId, taskId: gap.task_id, projectId: gap.project_id, category: gap.category, description: gap.description, status: 'resolved', action: 'resolved' },
        } as any);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to resolve spec gap');
      res.status(500).json({ error: 'Failed to resolve spec gap' });
    }
  });

  // ── Spec compliance endpoints (backs the Web UI 規格回對 panel) ──
  // Project-level summary: tasks that have checklist items + their latest run counts.
  app.get('/api/spec-compliance/project/:projectId', (req, res) => {
    const projectId = req.params['projectId'];
    if (!projectId) { res.status(400).json({ error: 'Missing projectId' }); return; }
    try {
      const rows = db.prepare(`
        SELECT c.task_id, t.title as task_title, t.parent_name as task_parent_name, t.status as task_status, COUNT(*) as item_count,
               SUM(CASE WHEN c.waived = 1 THEN 1 ELSE 0 END) as waived_count
        FROM spec_checklist_items c LEFT JOIN tasks t ON t.id = c.task_id
        WHERE c.project_id = ?
        GROUP BY c.task_id
        ORDER BY MAX(c.created_at) DESC
      `).all(projectId) as Array<{ task_id: string; task_title: string | null; task_parent_name: string | null; task_status: string | null; item_count: number; waived_count: number }>;
      const latestRunStmt = db.prepare(
        'SELECT id, run_at, source, total, matched, missing, manual, waived FROM spec_compliance_runs WHERE task_id = ? ORDER BY run_at DESC, rowid DESC LIMIT 1'
      );
      const aiReviewCountStmt = db.prepare(
        "SELECT COUNT(*) as c FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review'"
      );
      res.json({
        projectId,
        tasks: rows.map(r => {
          const run = latestRunStmt.get(r.task_id) as { id: string; run_at: string; source: string; total: number; matched: number; missing: number; manual: number; waived: number } | undefined;
          const hasAiReviewRun = (aiReviewCountStmt.get(r.task_id) as { c: number }).c > 0;
          return {
            taskId: r.task_id,
            taskTitle: r.task_title,
            functionCode: taskFunctionCode(r.task_parent_name, r.task_title),
            taskStatus: r.task_status,
            itemCount: r.item_count,
            waivedCount: r.waived_count,
            hasAiReviewRun,
            latestRun: run ? { id: run.id, runAt: run.run_at, source: run.source, total: run.total, matched: run.matched, missing: run.missing, manual: run.manual, waived: run.waived } : null,
          };
        }),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list spec compliance summary');
      res.status(500).json({ error: 'Failed to list spec compliance summary' });
    }
  });

  // Task-level detail: checklist items + latest run (with per-item results).
  app.get('/api/spec-compliance/:taskId', (req, res) => {
    const taskId = req.params['taskId'];
    if (!taskId) { res.status(400).json({ error: 'Missing taskId' }); return; }
    try {
      const items = db.prepare(
        'SELECT id, task_id, project_id, item_type, content, side, detail_json, source_ref, waived, waive_reason, created_at FROM spec_checklist_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC'
      ).all(taskId) as Array<Record<string, unknown>>;
      const run = db.prepare(
        'SELECT id, run_at, source, total, matched, missing, manual, waived, results_json FROM spec_compliance_runs WHERE task_id = ? ORDER BY run_at DESC, rowid DESC LIMIT 1'
      ).get(taskId) as { id: string; run_at: string; source: string; total: number; matched: number; missing: number; manual: number; waived: number; results_json: string } | undefined;
      const hasAiReviewRun = (db.prepare(
        "SELECT COUNT(*) as c FROM spec_compliance_runs WHERE task_id = ? AND source = 'ai_review'"
      ).get(taskId) as { c: number }).c > 0;
      let runResults: unknown[] = [];
      if (run) {
        try { runResults = JSON.parse(run.results_json) as unknown[]; } catch { /* corrupt json — return empty */ }
      }
      res.json({
        taskId,
        items: items.map(r => ({
          id: r['id'],
          itemType: r['item_type'],
          content: r['content'],
          side: r['side'] ?? 'both',
          sourceRef: r['source_ref'],
          waived: r['waived'] === 1,
          waiveReason: r['waive_reason'],
          createdAt: r['created_at'],
        })),
        hasAiReviewRun,
        latestRun: run ? {
          id: run.id,
          runAt: run.run_at,
          source: run.source,
          total: run.total,
          matched: run.matched,
          missing: run.missing,
          manual: run.manual,
          waived: run.waived,
          results: runResults,
        } : null,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get spec compliance detail');
      res.status(500).json({ error: 'Failed to get spec compliance detail' });
    }
  });

  // Waive a checklist item from the Web UI (reason required).
  app.post('/api/checklist-items/:itemId/waive', (req, res) => {
    const itemId = req.params['itemId'];
    if (!itemId) { res.status(400).json({ error: 'Missing itemId' }); return; }
    try {
      const reason = (req.body as { reason?: string } | undefined)?.reason;
      if (typeof reason !== 'string' || !reason.trim()) { res.status(400).json({ error: 'Missing reason' }); return; }
      const item = db.prepare('SELECT id, task_id, project_id, content, waived FROM spec_checklist_items WHERE id = ?').get(itemId) as
        { id: string; task_id: string; project_id: string; content: string; waived: number } | undefined;
      if (!item) { res.status(404).json({ error: 'Checklist item not found' }); return; }
      if (item.waived !== 1) {
        db.prepare('UPDATE spec_checklist_items SET waived = 1, waive_reason = ? WHERE id = ?').run(reason.trim(), itemId);
        // Broadcast so open SpecCompliance panels refetch
        wsServerRef?.broadcast({
          type: 'task.checklistSaved',
          id: itemId,
          timestamp: new Date().toISOString(),
          payload: { taskId: item.task_id, projectId: item.project_id, itemId, action: 'waived' },
        } as any);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to waive checklist item');
      res.status(500).json({ error: 'Failed to waive checklist item' });
    }
  });

  // ── Project notes endpoints (backs the Web UI 專案筆記 panel) ──
  app.get('/api/project-notes/:projectId', (req, res) => {
    const projectId = req.params['projectId'];
    if (!projectId) { res.status(400).json({ error: 'Missing projectId' }); return; }
    try {
      res.json({ projectId, notes: getAllProjectNotes(projectId) });
    } catch (err) {
      logger.error({ err }, 'Failed to list project notes');
      res.status(500).json({ error: 'Failed to list project notes' });
    }
  });

  app.post('/api/project-notes/:projectId', (req, res) => {
    const projectId = req.params['projectId'];
    if (!projectId) { res.status(400).json({ error: 'Missing projectId' }); return; }
    try {
      const body = (req.body || {}) as { content?: string; category?: string };
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) { res.status(400).json({ error: 'Missing content' }); return; }
      const project = getProject(projectId);
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const note = createProjectNote(projectId, content, typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null);
      // Broadcast so open ProjectNotes panels refetch
      wsServerRef?.broadcast({
        type: 'project.noteSaved',
        id: note.id,
        timestamp: new Date().toISOString(),
        payload: { noteId: note.id, projectId, category: note.category, content: note.content, action: 'created' },
      } as any);
      res.json({ note });
    } catch (err) {
      logger.error({ err }, 'Failed to create project note');
      res.status(500).json({ error: 'Failed to create project note' });
    }
  });

  app.post('/api/project-notes/:noteId/archive', (req, res) => {
    const noteId = req.params['noteId'];
    if (!noteId) { res.status(400).json({ error: 'Missing noteId' }); return; }
    try {
      const note = archiveProjectNote(noteId);
      if (!note) { res.status(404).json({ error: 'Project note not found' }); return; }
      // Broadcast so open ProjectNotes panels refetch
      wsServerRef?.broadcast({
        type: 'project.noteSaved',
        id: note.id,
        timestamp: new Date().toISOString(),
        payload: { noteId: note.id, projectId: note.projectId, category: note.category, content: note.content, action: 'archived' },
      } as any);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Failed to archive project note');
      res.status(500).json({ error: 'Failed to archive project note' });
    }
  });

  // ── MCP Notification endpoint ──────────────────────────
  // Receives notifications from the MCP Server process (separate process)
  // and broadcasts them via WebSocket to the Web UI.
  // Whitelist covers every event the MCP tools actually send (see server/src/mcp/tools/*):
  // agent.started / agent.output / agent.completed, task.milestone / task.statusChange / task.created / task.updated / task.specGap / task.checklistSaved,
  // project.created / project.updated / project.noteSaved, sa-flow.saved, asana.syncResult.
  const MCP_EVENT_PREFIXES = ['agent.', 'task.', 'project.', 'sa-flow.', 'asana.'];

  // Shared-secret token (data/.notify-token) — the MCP process reads the same
  // file and sends it as x-notify-token. null = file unwritable → skip validation.
  const notifyToken = ensureNotifyToken(path.dirname(config.dbPath));
  if (!notifyToken) {
    logger.warn('Could not create data/.notify-token — /api/mcp-notify will accept unauthenticated requests');
  }

  app.post('/api/mcp-notify', (req, res) => {
    try {
      if (!verifyNotifyToken(notifyToken, req.headers['x-notify-token'])) {
        logger.warn('Rejected MCP notify request (missing/invalid x-notify-token)');
        res.status(401).json({ error: 'Invalid or missing x-notify-token' });
        return;
      }
      const { event, data } = req.body as { event: string; data: Record<string, unknown> };
      if (!event || typeof event !== 'string') {
        res.status(400).json({ error: 'Missing event field' });
        return;
      }
      if (!MCP_EVENT_PREFIXES.some(prefix => event.startsWith(prefix))) {
        logger.warn({ event }, 'Rejected MCP notify event (not in whitelist)');
        res.status(400).json({ error: `Event not allowed: ${event}` });
        return;
      }

      // Broadcast as WS message — wrap data in payload to match frontend expectations
      wsServer.broadcast({ type: event, id: data.agentId || data.taskId || '', timestamp: new Date().toISOString(), payload: data } as any);

      // Windows toast (fire-and-forget — never affects the notify response):
      // task completed/failed, [NEEDS_HUMAN] agent output, new spec gaps.
      handleMcpEventToast(event, data && typeof data === 'object' ? data : {});

      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, 'MCP notify error');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // Express error middleware (must be registered after all routes)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled Express error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error' });
  });

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

  // 7. Start contract watcher (uses a default project ID for now)
  // In production, each project gets its own watcher
  const contractWatcher = new ContractWatcher(config.aiContextDir, eventBus, 'default');
  contractWatcher.start();

  // 8. Log agent backend mode
  logger.info({ agentBackend: config.agentBackend }, 'Agent backend mode');

  // 8b. Recover agents that were running before server shutdown/crash
  await agentManager.recoverRunningAgents();

  // 9. Listen
  httpServer.listen(config.port, config.host, () => {
    logger.info({ port: config.port, host: config.host }, 'AI-OmniCommander server is running');
    logger.info(`Dashboard: http://localhost:5174`);
    logger.info(`API: http://localhost:${config.port}/api/health`);
    logger.info(`WebSocket: ws://localhost:${config.port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(backupTimer);
    asanaSyncService.stopAll();
    // Kill agent processes without touching DB status here — on next startup,
    // recoverRunningAgents() kills any leftover PIDs and marks these agents as
    // 'error' / resets their tasks to 'pending' (no auto-resume).
    await agentManager.killAllProcessesForShutdown();
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
