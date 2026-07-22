import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { AgentRole, SuperpowersFeature, TaskType, ProjectConfig, TestOptions } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import { FullstackController } from './FullstackController.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { type SvnSpecService, extractFunctionCode } from '../svn/SvnSpecService.js';
import { SpecFetcher } from '../documents/SpecFetcher.js';
import type { SpecResult } from '../documents/SpecFetcher.js';
import { SaFlowAnalyzer } from '../documents/SaFlowAnalyzer.js';
import { ModelRouter } from '../agent/ModelRouter.js';
import { getProject, updateProject } from '../db/queries/projects.js';
import { getTask, updateTask } from '../db/queries/tasks.js';
import { getConfig } from '../config.js';
import { getDocumentsForTask } from '../db/queries/taskDocuments.js';
import { getActiveProjectNotes, type ProjectNote } from '../db/queries/projectNotes.js';
import { filterSafeSpecFolders } from '../documents/FolderSpecSource.js';
import { loadSuperpowersPrompt } from '../skills/superpowers/index.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ExecutionPipeline');

/**
 * 任務軌道（由 MCP get_execution_plan 判定後透過 /api/execution-plan?track= 傳入）：
 * 'light' = 小 bug 輕量修復流程——規格檢查表改抽 BUG 原文、規格閱讀改讀 BUG 原文；
 * 'full'  = 規格驅動完整流程（現狀，預設）。
 * 輕的是工序，不是標準：light 軌的兩步規格回對（run_spec_compliance + AI 回對
 * missing=0）完成標準不變。
 */
export type ExecutionTrack = 'light' | 'full';

/**
 * 效能分析（後端限定，強制）— 通用版（stack 中性）。
 * 專案特有的技術棧慣例（如特定 legacy 表、ORM 類別名）放在該專案的
 * backendExtraPrompt / 專案筆記，會自動注入，不寫死在這裡。
 */
const BACKEND_PERFORMANCE_SECTION = `## 效能分析（強制 — 寫 code 之前必須完成，用 report_output 記錄）

寫任何資料存取邏輯前，先完成以下分析：

1. 列出涉及的所有資料表 + 估計資料量（不知道就問使用者）
2. 對每個 DB 查詢寫出過濾條件（對應 SD 的哪條規則）+ 預期回傳筆數
3. 寫完後檢查每個迴圈裡有沒有 DB 查詢（N+1 問題）
4. 從進入點到 DB 走一遍完整資料流：總共打幾次 DB？最大查詢回幾筆？

⚠ 禁止「撈全表回程式記憶體再過濾」——過濾/分頁一律下推到查詢層。Legacy 大表可能有數十萬筆。`;

/**
 * 專案設定的單元測試指令（config_json.frontendTestCommand / backendTestCommand）。
 * 注入「單元測試（強制流程）」區塊——frontend 任務用 frontend、backend 用 backend、
 * 其他 role（fullstack / both）兩個都列。未設定時注入 fallback 文案（用 workspace
 * CLAUDE.md 的測試指令；找不到就 report_output 記錄後跳過）。
 */
export interface TestCommands {
  frontend?: string;
  backend?: string;
}

/** Read test commands from parsed project config（stack 中性——指令內容由專案設定提供）。 */
export function extractTestCommands(config: ProjectConfig | null | undefined): TestCommands {
  const fe = config?.frontendTestCommand;
  const be = config?.backendTestCommand;
  return {
    frontend: typeof fe === 'string' && fe.trim() ? fe.trim() : undefined,
    backend: typeof be === 'string' && be.trim() ? be.trim() : undefined,
  };
}

/**
 * 資料異動驗證（後端限定，R4）— 專案 config 有 dbConnections 時才注入。
 * CRUD 實作完成後用 query_external_db（count/sample）驗證資料真實落地。
 */
const BACKEND_DB_VERIFICATION_SECTION = `## 資料異動驗證（強制 — 專案已綁定外部 DB）

實作 CRUD 後用 mcp__omni-commander__query_external_db 驗證資料真實落地：
- 新增 → count/sample 查得到該筆
- 修改 → sample 確認欄位值正確
- 刪除 → count 查不到
- 欄位名以 describe_table 為準，嚴禁猜`;

/**
 * 安全弱點檢查（後端限定）— 通用版（stack 中性）。
 */
const BACKEND_SECURITY_SECTION = `## 安全檢查（完成實作後逐項確認）

- SQL 一律參數綁定（prepared statement / ORM 參數），禁止字串拼接
- API 驗證當前使用者只能操作自己的資料
- 進入點參數有長度限制和格式驗證
- response 不回傳密碼、token、內部 ID
- 批次操作有上限（如一次最多 100 筆）
- log 不印密碼、token、個資`;

/**
 * Unified execution pipeline that replaces mode-specific handlers.
 * Handles both task-based execution and ad-hoc requirements.
 */
export class ExecutionPipeline {
  private specFetcher: SpecFetcher;
  private modelRouter = new ModelRouter();
  private svnSpecService: SvnSpecService | null = null;
  private saFlowAnalyzer: SaFlowAnalyzer;

  constructor(
    private agentManager: AgentManager,
    private eventBus: EventBus,
    private documentParser: DocumentParser,
    specCacheDir?: string,
  ) {
    this.specFetcher = new SpecFetcher(specCacheDir);
    const dataDir = path.dirname(getConfig().dbPath);
    this.saFlowAnalyzer = new SaFlowAnalyzer(dataDir);
  }

  /** Inject SvnSpecService (optional, set after construction) */
  setSvnSpecService(svc: SvnSpecService): void {
    this.svnSpecService = svc;
  }

  /**
   * Auto-fetch spec documents from ALL configured sources (SVN + local spec
   * folders) for a task. Shared by executeTask / buildExecutionPlan /
   * preparePromptForRole so the three call sites stay identical.
   *
   * 三態聚合（規格不齊全不執行）：
   * - 有檔案 + 有錯誤/警告 → 錯誤降級成警告（文件區塊列出）
   * - 完全沒檔案 + 有錯誤 → error（呼叫端放 [SPEC_FETCH_ERROR] banner）
   * - 沒設定任何來源 → attempted=false，行為與現狀相同
   */
  private async fetchAutoSpecs(
    task: { projectId: string; title: string; parentName: string | null; taskType: TaskType },
    taskId: string,
    projectConfig: ProjectConfig | null,
    roleLabel: string,
  ): Promise<{ docIds: string[]; attempted: boolean; functionCode: string | null; error: string | null; warnings: string[] }> {
    const functionCode = task.parentName || extractFunctionCode(task.title);
    const docIds: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    let attempted = false;

    if (task.taskType !== 'testing' && functionCode && this.svnSpecService) {
      if (projectConfig?.svnConfig) {
        attempted = true;
        try {
          const svnIds = await this.svnSpecService.fetchSpecsForTask(
            task.projectId, taskId, functionCode, projectConfig.svnConfig, roleLabel, task.title,
          );
          docIds.push(...svnIds);
          logger.info({ taskId, functionCode, source: task.parentName ? 'parentName' : 'title', docCount: svnIds.length }, 'Fetched SVN specs');
        } catch (err) {
          // 規格不齊全不執行：do NOT swallow — surface prominently（可能被資料夾來源救回）
          errors.push(err instanceof Error ? err.message : String(err));
          logger.error({ err, taskId, functionCode }, 'SVN spec fetch failed');
        }
      }

      const configuredFolders = projectConfig?.specFolders?.filter(f => typeof f?.path === 'string' && f.path.trim().length > 0) ?? [];
      let specFolders = configuredFolders;
      if (configuredFolders.length > 0) {
        // Defense-in-depth：workspace 路徑可能在設定之後才被改成與規格資料夾
        // 重疊（單邊更新繞過設定驗證）——抓取前複查，重疊一律跳過。
        const proj = getProject(task.projectId);
        const { safe, blockedWarnings } = filterSafeSpecFolders(configuredFolders, [proj?.frontendPath, proj?.backendPath]);
        specFolders = safe;
        if (blockedWarnings.length > 0) {
          warnings.push(...blockedWarnings);
          logger.warn({ taskId, blockedWarnings }, 'Spec folders overlapping workspace were skipped');
        }
      }
      if (specFolders.length > 0) {
        attempted = true;
        try {
          const r = await this.svnSpecService.fetchFolderSpecsForTask(
            task.projectId, taskId, functionCode, specFolders, roleLabel, task.title,
          );
          docIds.push(...r.docIds);
          warnings.push(...r.warnings);
          errors.push(...r.errors.map(e => `規格資料夾：${e}`));
          logger.info({ taskId, functionCode, folderCount: specFolders.length, docCount: r.docIds.length, warnings: r.warnings }, 'Fetched folder specs');
        } catch (err) {
          errors.push(`規格資料夾：${err instanceof Error ? err.message : String(err)}`);
          logger.error({ err, taskId, functionCode }, 'Folder spec fetch failed');
        }
      }
    }

    let error: string | null = null;
    if (errors.length > 0) {
      if (docIds.length === 0) {
        error = errors.join('; ');
        logger.error({ taskId, functionCode, error }, 'Spec fetch failed with no documents — prompt will carry [SPEC_FETCH_ERROR] block（規格不齊全不執行）');
      } else {
        // 部分來源失敗但已取得規格文件 → 降級為警告，附在文件區塊
        warnings.push(...errors);
      }
    }

    return { docIds, attempted, functionCode: functionCode || null, error, warnings };
  }

  /**
   * Execute a specific task from the task list.
   */
  async executeTask(taskId: string, model?: string, mockupFiles?: string[], testOptions?: TestOptions, executionRunId?: string): Promise<string> {
    // Fail fast BEFORE any side effect: the SA-flow analysis below PTY-spawns
    // claude on cache miss, which must not happen when legacy spawn is disabled
    // (the startAgent gate alone would fire only after that spawn already ran).
    const allowLegacySpawn = process.env['ALLOW_LEGACY_SPAWN'];
    if (allowLegacySpawn !== '1' && allowLegacySpawn !== 'true') {
      throw new Error('spawn 派工已停用：任務執行請走外部 Claude Code session + MCP（get_execution_plan）。確定要使用 legacy spawn 請設環境變數 ALLOW_LEGACY_SPAWN=1');
    }

    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Guard: prevent duplicate spawning if already running
    if (task.status === 'in_progress' || task.status === 'assigned') {
      logger.warn({ taskId, status: task.status }, 'Task already running — skipping duplicate spawn');
      return '';
    }

    const project = getProject(task.projectId);
    if (!project) throw new Error(`Project ${task.projectId} not found`);

    updateProject(task.projectId, { status: 'executing' });
    updateTask(taskId, { status: 'in_progress' });

    // Fullstack: delegate to FullstackController
    if (task.label === 'fullstack') {
      const controller = new FullstackController(this.agentManager, this.eventBus, this);
      await controller.execute(task, project, { model, mockupFiles, testOptions, executionRunId });
      return '';
    }

    // Auto-select superpowers based on task type
    const superpowers = this.selectSuperpowers(task.taskType);

    // Parse project config (needed for SVN auth in spec fetch and auto-fetch)
    const projectConfig = project.configJson ? JSON.parse(project.configJson) as ProjectConfig : null;
    const extraPrompt = task.label === 'frontend'
      ? projectConfig?.frontendExtraPrompt
      : task.label === 'backend'
      ? projectConfig?.backendExtraPrompt
      : undefined;
    const testCommands = extractTestCommands(projectConfig);

    // Fetch spec content if available (pass svnConfig so SVN https:// URLs get auth)
    let specResult: SpecResult | null = null;
    if (task.specUrl) {
      try {
        specResult = await this.specFetcher.fetch(task.specUrl, projectConfig?.svnConfig);
        logger.info({ taskId, specUrl: task.specUrl, type: specResult.type }, 'Fetched spec');
      } catch (err) {
        logger.warn({ err, taskId, specUrl: task.specUrl }, 'Failed to fetch spec content');
      }
    }
    // Auto-fetch spec documents from SVN + local spec folders (skip for testing tasks):
    // Priority 1: use parentName (from Asana parent task, e.g. "OV0101")
    // Priority 2: extract function code from task title (e.g. "IC01 修改發票查詢" → "IC01")
    const specFetch = await this.fetchAutoSpecs(task, taskId, projectConfig, task.label);

    // Find task-associated attachments scoped to this execution run
    const taskAttachments = this.getTaskAttachments(task.projectId, taskId, executionRunId);

    // Get auto-fetched (SVN / folder) documents for this task, filtered by role:
    // Frontend agent → SA + SD, Backend agent → SD only
    const allSvnDocs = specFetch.docIds.length > 0
      ? getDocumentsForTask(taskId).filter(d => d.source === 'svn' || d.source === 'folder')
      : [];
    const svnDocuments = task.label === 'backend'
      ? allSvnDocs.filter(d => d.docType === 'SD')
      : allSvnDocs;  // frontend / others get SA + SD

    // Find available DB schema files for this project
    const schemaBasePath = path.join(path.dirname(getConfig().dbPath), 'schemas', task.projectId);
    const dbSchemaFiles: Array<{ label: string; schemaPath: string; erPath: string }> = [];
    if (fs.existsSync(schemaBasePath)) {
      const projectConfig: ProjectConfig = project.configJson ? JSON.parse(project.configJson) : {};
      const connections = projectConfig.dbConnections ?? [];
      for (const connDir of fs.readdirSync(schemaBasePath)) {
        const schemaFile = path.join(schemaBasePath, connDir, 'schema.json');
        const erFile = path.join(schemaBasePath, connDir, 'er-diagram.mmd');
        if (fs.existsSync(schemaFile)) {
          const conn = connections.find((c: { id: string }) => c.id === connDir);
          dbSchemaFiles.push({
            label: conn?.label ?? connDir,
            schemaPath: schemaFile,
            erPath: fs.existsSync(erFile) ? erFile : '',
          });
        }
      }
    }

    // Analyze SA flow diagram for frontend tasks
    let saFlowResult = null;
    if (task.label === 'frontend') {
      const saDoc = this.findSaDocument(taskId, task.projectId, allSvnDocs);
      if (saDoc) {
        try {
          saFlowResult = await this.saFlowAnalyzer.analyze({
            projectId: task.projectId,
            taskId,
            saContent: saDoc.content,
            sourceFilename: saDoc.filename,
            taskType: task.taskType,
            taskDescription: task.description || '',
          });
          if (saFlowResult) {
            logger.info({ taskId, filename: saDoc.filename }, 'SA flow diagram ready');
          }
        } catch (err) {
          logger.warn({ err, taskId }, 'SA flow analysis failed, continuing without it');
        }
      }
    }

    // Assemble context
    const prompt = this.assembleContext({
      superpowers,
      projectId: task.projectId,
      taskId,
      role: task.label,
      taskTitle: task.title,
      taskDescription: task.description || '',
      taskType: task.taskType,
      specResult,
      dbConnectionString: project.dbConnectionString,
      dbSchemaFiles: dbSchemaFiles.length > 0 ? dbSchemaFiles : undefined,
      taskAttachments,
      svnDocuments,
      mockupFiles,
      testOptions,
      extraPrompt,
      testCommands,
      hasDbConnections: (projectConfig?.dbConnections?.length ?? 0) > 0,
      saFlowResult: saFlowResult ?? undefined,
      svnSpecFetch: { attempted: specFetch.attempted, functionCode: specFetch.functionCode || undefined, error: specFetch.error, warnings: specFetch.warnings },
    });

    // Resolve working directory
    const workingDir = this.resolveWorkingDir(project, task.label);

    const agentRole: AgentRole = task.label as AgentRole;

    // Auto-route model based on task characteristics
    const { model: autoModel, reasoning } = this.modelRouter.selectModel(task);
    const finalModel = model || autoModel;

    logger.info({
      taskId, projectId: task.projectId, taskType: task.taskType,
      role: agentRole, superpowers, model: finalModel, modelReasoning: reasoning,
    }, 'Executing task');

    const agentId = await this.agentManager.startAgent({
      projectId: task.projectId,
      role: agentRole,
      taskId,
      prompt,
      model: finalModel,
      workingDir,
      useWorkspaceSkills: true,
    });

    return agentId;
  }

  /**
   * Build the full execution plan prompt for a task WITHOUT spawning an agent.
   * Used by MCP Server to provide execution context to external Claude Code sessions.
   * Reuses the same assembleContext logic as executeTask.
   */
  async buildExecutionPlan(taskId: string, model?: string, mockupFiles?: string[], testOptions?: TestOptions, executionRunId?: string, track?: ExecutionTrack): Promise<{ prompt: string; workingDir: string; model: string }> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const project = getProject(task.projectId);
    if (!project) throw new Error(`Project ${task.projectId} not found`);

    const superpowers = this.selectSuperpowers(task.taskType);
    const projectConfig = project.configJson ? JSON.parse(project.configJson) as ProjectConfig : null;
    const extraPrompt = task.label === 'frontend'
      ? projectConfig?.frontendExtraPrompt
      : task.label === 'backend'
      ? projectConfig?.backendExtraPrompt
      : undefined;
    const testCommands = extractTestCommands(projectConfig);

    let specResult: SpecResult | null = null;
    if (task.specUrl) {
      try {
        specResult = await this.specFetcher.fetch(task.specUrl, projectConfig?.svnConfig);
      } catch { /* ignore */ }
    }

    const specFetch = await this.fetchAutoSpecs(task, taskId, projectConfig, task.label);

    const taskAttachments = this.getTaskAttachments(task.projectId, taskId, executionRunId);
    const allSvnDocs = specFetch.docIds.length > 0
      ? getDocumentsForTask(taskId).filter(d => d.source === 'svn' || d.source === 'folder')
      : [];
    const svnDocuments = task.label === 'backend'
      ? allSvnDocs.filter(d => d.docType === 'SD')
      : allSvnDocs;

    const schemaBasePath = path.join(path.dirname(getConfig().dbPath), 'schemas', task.projectId);
    const dbSchemaFiles: Array<{ label: string; schemaPath: string; erPath: string }> = [];
    if (fs.existsSync(schemaBasePath)) {
      const pConfig: ProjectConfig = project.configJson ? JSON.parse(project.configJson) : {};
      const connections = pConfig.dbConnections ?? [];
      for (const connDir of fs.readdirSync(schemaBasePath)) {
        const schemaFile = path.join(schemaBasePath, connDir, 'schema.json');
        const erFile = path.join(schemaBasePath, connDir, 'er-diagram.mmd');
        if (fs.existsSync(schemaFile)) {
          const conn = connections.find((c: { id: string }) => c.id === connDir);
          dbSchemaFiles.push({
            label: conn?.label ?? connDir,
            schemaPath: schemaFile,
            erPath: fs.existsSync(erFile) ? erFile : '',
          });
        }
      }
    }

    // For MCP mode: check SA flow cache only (no PTY generation).
    // If not cached, the subagent will generate it via save_sa_flow MCP tool.
    let saFlowResult = null;
    if (task.label === 'frontend') {
      const saDoc = this.findSaDocument(taskId, task.projectId, allSvnDocs);
      if (saDoc) {
        // Check cache only — don't call PTY
        const saHash = crypto.createHash('sha256').update(saDoc.content).digest('hex').slice(0, 16);
        const cachedPath = this.saFlowAnalyzer.getFlowPath(task.projectId, saHash);
        if (fs.existsSync(cachedPath)) {
          const cachedFlow = fs.readFileSync(cachedPath, 'utf-8');
          saFlowResult = { fullFlow: cachedFlow, relevantFlow: cachedFlow, flowPath: cachedPath };
        }
        // If not cached, saFlowResult stays null → assembleContext won't include it
        // The MCP prompt header instructs the subagent to generate and save_sa_flow
      }
    }

    const prompt = this.assembleContext({
      superpowers,
      projectId: task.projectId,
      taskId,
      track,
      role: task.label,
      taskTitle: task.title,
      taskDescription: task.description || '',
      taskType: task.taskType,
      specResult,
      dbConnectionString: project.dbConnectionString,
      dbSchemaFiles: dbSchemaFiles.length > 0 ? dbSchemaFiles : undefined,
      taskAttachments,
      svnDocuments,
      mockupFiles,
      testOptions,
      extraPrompt,
      testCommands,
      hasDbConnections: (projectConfig?.dbConnections?.length ?? 0) > 0,
      saFlowResult: saFlowResult ?? undefined,
      svnSpecFetch: { attempted: specFetch.attempted, functionCode: specFetch.functionCode || undefined, error: specFetch.error, warnings: specFetch.warnings },
    });

    const workingDir = this.resolveWorkingDir(project, task.label);
    const { model: autoModel } = this.modelRouter.selectModel(task);
    const finalModel = model || autoModel;

    return { prompt, workingDir, model: finalModel };
  }

  /**
   * Build the assembled prompt for a task with a given role override.
   * Used by FullstackController to build FE/BE prompts from a fullstack task.
   */
  async preparePromptForRole(
    taskId: string,
    forRole: 'frontend' | 'backend',
    opts?: {
      model?: string;
      mockupFiles?: string[];
      testOptions?: TestOptions;
      executionRunId?: string;
      reportTaskId?: string;
      track?: ExecutionTrack;
    },
  ): Promise<{ prompt: string; workingDir: string; model: string }> {
    const task = getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const project = getProject(task.projectId);
    if (!project) throw new Error(`Project ${task.projectId} not found`);

    const projectConfig = project.configJson ? JSON.parse(project.configJson) as ProjectConfig : null;
    const extraPrompt = forRole === 'frontend'
      ? projectConfig?.frontendExtraPrompt
      : forRole === 'backend'
      ? projectConfig?.backendExtraPrompt
      : undefined;
    const testCommands = extractTestCommands(projectConfig);

    const superpowers = this.selectSuperpowers(task.taskType);

    let specResult: SpecResult | null = null;
    if (task.specUrl) {
      try {
        specResult = await this.specFetcher.fetch(task.specUrl, projectConfig?.svnConfig);
      } catch { /* ignore */ }
    }

    const specFetch = await this.fetchAutoSpecs(task, taskId, projectConfig, forRole);

    const taskAttachments = this.getTaskAttachments(task.projectId, taskId, opts?.executionRunId);
    const allSvnDocs = specFetch.docIds.length > 0
      ? getDocumentsForTask(taskId).filter(d => d.source === 'svn' || d.source === 'folder')
      : [];
    const svnDocuments = forRole === 'backend'
      ? allSvnDocs.filter(d => d.docType === 'SD')
      : allSvnDocs;

    const schemaBasePath = path.join(path.dirname(getConfig().dbPath), 'schemas', task.projectId);
    const dbSchemaFiles: Array<{ label: string; schemaPath: string; erPath: string }> = [];
    if (fs.existsSync(schemaBasePath)) {
      const cfg: ProjectConfig = project.configJson ? JSON.parse(project.configJson) : {};
      const connections = cfg.dbConnections ?? [];
      for (const connDir of fs.readdirSync(schemaBasePath)) {
        const schemaFile = path.join(schemaBasePath, connDir, 'schema.json');
        const erFile = path.join(schemaBasePath, connDir, 'er-diagram.mmd');
        if (fs.existsSync(schemaFile)) {
          const conn = connections.find((c: { id: string }) => c.id === connDir);
          dbSchemaFiles.push({
            label: conn?.label ?? connDir,
            schemaPath: schemaFile,
            erPath: fs.existsSync(erFile) ? erFile : '',
          });
        }
      }
    }

    // For MCP mode: check SA flow cache only (no PTY generation) — same as
    // buildExecutionPlan above. If not cached, the subagent generates it via
    // the save_sa_flow MCP tool; we must never spawn claude from this path.
    let saFlowResult = null;
    if (forRole === 'frontend') {
      const saDoc = this.findSaDocument(taskId, task.projectId, allSvnDocs);
      if (saDoc) {
        // Check cache only — don't call PTY
        const saHash = crypto.createHash('sha256').update(saDoc.content).digest('hex').slice(0, 16);
        const cachedPath = this.saFlowAnalyzer.getFlowPath(task.projectId, saHash);
        if (fs.existsSync(cachedPath)) {
          const cachedFlow = fs.readFileSync(cachedPath, 'utf-8');
          saFlowResult = { fullFlow: cachedFlow, relevantFlow: cachedFlow, flowPath: cachedPath };
        }
        // If not cached, saFlowResult stays null → assembleContext won't include it
        // The MCP prompt header instructs the subagent to generate and save_sa_flow
      }
    }

    const prompt = this.assembleContext({
      superpowers,
      projectId: task.projectId,
      taskId,
      reportTaskId: opts?.reportTaskId,
      track: opts?.track,
      role: forRole,
      taskTitle: task.title,
      taskDescription: task.description || '',
      taskType: task.taskType,
      specResult,
      dbConnectionString: project.dbConnectionString,
      dbSchemaFiles: dbSchemaFiles.length > 0 ? dbSchemaFiles : undefined,
      taskAttachments,
      svnDocuments,
      mockupFiles: opts?.mockupFiles,
      testOptions: opts?.testOptions,
      extraPrompt,
      testCommands,
      hasDbConnections: (projectConfig?.dbConnections?.length ?? 0) > 0,
      saFlowResult: saFlowResult ?? undefined,
      svnSpecFetch: { attempted: specFetch.attempted, functionCode: specFetch.functionCode || undefined, error: specFetch.error, warnings: specFetch.warnings },
    });

    const workingDir = this.resolveWorkingDir(project, forRole);
    const { model: autoModel } = this.modelRouter.selectModel(task);
    const finalModel = opts?.model || autoModel;

    return { prompt, workingDir, model: finalModel };
  }

  /**
   * Execute an ad-hoc requirement (not tied to a task record).
   * Backward-compatible with v1 execution flow.
   */
  async executeAdHoc(
    projectId: string,
    requirement: string,
    model?: string,
    role?: string,
  ): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    updateProject(projectId, { status: 'executing' });

    // Classify the requirement to auto-select superpowers
    const taskType = this.classifyTask(requirement);
    const superpowers = this.selectSuperpowers(taskType);

    const agentRole: AgentRole = (role || 'backend') as AgentRole;

    const prompt = this.assembleContext({
      superpowers,
      projectId,
      role: agentRole,
      taskTitle: 'Ad-hoc Task',
      taskDescription: requirement,
      taskType,
      dbConnectionString: project.dbConnectionString,
    });

    const workingDir = this.resolveWorkingDir(project, agentRole);

    logger.info({
      projectId, taskType, role: agentRole, superpowers, model,
    }, 'Executing ad-hoc requirement');

    await this.agentManager.startAgent({
      projectId,
      role: agentRole,
      prompt,
      model: model || 'sonnet',
      workingDir,
      useWorkspaceSkills: true,
    });
  }

  /**
   * Classify a task description into a TaskType.
   */
  classifyTask(description: string): TaskType {
    const lower = description.toLowerCase();

    // Bug indicators
    if (/\b(bug|fix|error|crash|broken|fail|issue|problem|wrong|incorrect)\b/.test(lower)) {
      return 'bug';
    }

    // Refactor indicators
    if (/\b(refactor|restructure|reorganize|consolidate|simplify|clean\s*up|extract|decouple)\b/.test(lower)) {
      return 'refactor';
    }

    // Feature indicators
    if (/\b(add|create|implement|build|new|feature|support|enable|introduce)\b/.test(lower)) {
      return 'feature';
    }

    return 'other';
  }

  /**
   * Select superpowers methodology based on task type.
   * Superpowers are now always-on (standard) in v2.
   */
  selectSuperpowers(taskType: TaskType): SuperpowersFeature[] {
    switch (taskType) {
      case 'bug':
        return ['debugging'];
      case 'feature':
        return ['brainstorm', 'tdd'];
      case 'refactor':
        return ['brainstorm'];
      default:
        return [];
    }
  }

  /**
   * Assemble the full agent prompt with layered context.
   */
  assembleContext(opts: {
    superpowers: SuperpowersFeature[];
    projectId: string;
    taskId?: string;
    /** Override taskId used for verification report path only (e.g. `${taskId}-frontend`) */
    reportTaskId?: string;
    /** 任務軌道：light = BUG 原文驅動的輕量流程；預設 full（規格驅動） */
    track?: ExecutionTrack;
    role: string;
    taskTitle: string;
    taskDescription: string;
    taskType: TaskType;
    specResult?: SpecResult | null;
    dbConnectionString?: string | null;
    dbSchemaFiles?: Array<{ label: string; schemaPath: string; erPath: string }>;
    taskAttachments?: Array<{ filename: string; filePath: string; docType?: string }>;
    svnDocuments?: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null; docType: string | null }>;
    mockupFiles?: string[];
    testOptions?: TestOptions;
    extraPrompt?: string;
    /** 專案設定的單元測試指令（frontendTestCommand / backendTestCommand），注入「單元測試（強制流程）」區塊 */
    testCommands?: TestCommands;
    /** 專案 config 有 dbConnections 時為 true → backend role 注入「資料異動驗證」規範（R4） */
    hasDbConnections?: boolean;
    saFlowResult?: { fullFlow: string; relevantFlow: string; flowPath: string } | null;
    /**
     * Auto spec fetch outcome (SVN + local spec folders) — attempted=true means
     * at least one source was configured and a fetch was tried; error is set when
     * ALL sources failed with zero documents; warnings carry non-fatal issues
     * (git pull skipped/failed, partial source failures rescued by another source).
     */
    svnSpecFetch?: { attempted: boolean; functionCode?: string; error?: string | null; warnings?: string[] };
  }): string {
    const parts: string[] = [];

    // Layer 0: SVN spec fetch error banner — MUST be first so the orchestrator cannot miss it
    // （專案規範：「規格不齊全不執行」）
    if (opts.svnSpecFetch?.error) {
      parts.push(this.buildSpecFetchErrorBanner(opts.svnSpecFetch.error));
    }

    // Layer 1: Superpowers methodology
    if (opts.superpowers.length > 0) {
      const spPrompt = loadSuperpowersPrompt(opts.superpowers);
      if (spPrompt) parts.push(spPrompt);
    }

    // Layer 2: Task-bound documents (SA/SD uploaded and bound to this specific task)
    const docContext = opts.taskId
      ? this.getDocumentContext(opts.taskId, opts.role)
      : null;
    if (docContext) parts.push(docContext);

    // Layer 2.5: Spec content (if available)
    if (opts.specResult) {
      parts.push(this.buildSpecSection(opts.specResult));
    }

    // Layer 2.6: Auto-fetched specification documents (SVN + local spec folders)
    const specWarnings = opts.svnSpecFetch?.warnings ?? [];
    if (opts.svnSpecFetch?.error) {
      // All sources failed — show the error honestly instead of pretending "no documents"
      parts.push([
        '## 規格文件（自動取得：SVN／規格資料夾）',
        '',
        `⚠ 撈取失敗：${opts.svnSpecFetch.error}`,
        '',
        '未取得任何規格文件——這不代表規格不存在，而是規格來源（SVN／規格資料夾）撈取發生錯誤。',
        '處理方式見本 prompt 最前面的 [SPEC_FETCH_ERROR] 區塊。',
      ].join('\n'));
    } else if (opts.svnDocuments && opts.svnDocuments.length > 0) {
      parts.push(this.buildSvnDocsSection(opts.svnDocuments, specWarnings));
    } else if (opts.svnSpecFetch?.attempted) {
      // Sources configured and fetch succeeded, but zero documents found for this task/role
      const lines = [
        '## 規格文件（自動取得：SVN／規格資料夾）',
        '',
        `⚠ 警告：未找到規格文件。規格來源已設定且撈取成功，但功能代碼「${opts.svnSpecFetch.functionCode ?? '(未知)'}」沒有找到本任務適用的 SA/SD 規格文件。`,
      ];
      if (specWarnings.length > 0) {
        lines.push('', '規格來源警告：', ...specWarnings.map(w => `- ⚠ ${w}`));
      }
      lines.push(
        '依專案規範「規格不齊全不執行」，開工前請先告知使用者並取得指示（提供文件路徑，或明確說「跳過」）。',
        '若使用者選擇跳過，必須先用 report_output 記錄 [SKIP] 使用者跳過規格檢查。',
      );
      parts.push(lines.join('\n'));
    }

    // Layer 2.7: Project experience notes（前人踩坑教訓）— placed next to the
    // spec-document layers so agents read them before coding. Omitted entirely
    // when the project has no active notes.
    const projectNotes = getActiveProjectNotes(opts.projectId);
    if (projectNotes.length > 0) {
      parts.push(this.buildProjectNotesSection(projectNotes));
    }

    // Layer 2.7b: DB schema files (for backend agents to query when needed)
    if (opts.dbSchemaFiles && opts.dbSchemaFiles.length > 0) {
      parts.push(this.buildDbSchemaSection(opts.dbSchemaFiles));
    }

    // Layer 2.8: Task attachments (images, documents uploaded per task)
    if (opts.taskAttachments && opts.taskAttachments.length > 0) {
      parts.push(this.buildAttachmentsSection(opts.taskAttachments));
    }

    // Layer 2.9: Mockup / Axure HTML snapshots
    if (opts.mockupFiles && opts.mockupFiles.length > 0) {
      parts.push(this.buildMockupSection(opts.mockupFiles));
    }

    // Layer 2.95: Extra prompt (per-role, from project settings)
    if (opts.extraPrompt?.trim()) {
      const resolved = opts.extraPrompt.trim().replace(
        /\{AXURE_SNAPSHOTS_PATH\}/g,
        path.join(getConfig().projectRoot, 'docs', 'axure-snapshots', opts.projectId),
      );
      parts.push(`## 專案額外指令\n\n${resolved}`);
    }

    // Layer 2.97: SA operation flow diagram (frontend tasks only)
    if (opts.saFlowResult?.relevantFlow) {
      parts.push(this.buildSaFlowSection(opts.saFlowResult.relevantFlow, opts.taskType));
    }

    // Layer 3: Task prompt (use reportTaskId for verification report path if provided)
    const taskPrompt = this.buildTaskPrompt(opts.taskTitle, opts.taskDescription, opts.taskType, {
      role: opts.role,
      testOptions: opts.testOptions,
      reportTaskId: opts.reportTaskId ?? opts.taskId,
      realTaskId: opts.taskId,
      projectId: opts.projectId,
      track: opts.track,
      testCommands: opts.testCommands,
      hasDbConnections: opts.hasDbConnections,
    });
    parts.push(taskPrompt);

    return parts.join('\n\n---\n\n');
  }

  /**
   * Get documents/images associated with a specific task.
   * If executionRunId is provided, only returns files from that execution's subfolder.
   * Otherwise falls back to legacy [task:id] prefix in the project folder.
   */
  private getTaskAttachments(projectId: string, taskId: string, executionRunId?: string): Array<{ filename: string; filePath: string; docType?: string }> {
    const task = getTask(taskId);
    const uploadDir = this.documentParser.getUploadDir();

    // Build a lookup map from filePath → docType using DB records
    const allDocs = this.documentParser.getDocuments(projectId);
    const docTypeByPath = new Map(allDocs.map(d => [d.filePath, d.docType]));

    const code = task?.parentName || null;
    const taskBase = code ? `${code}_${taskId.slice(0, 8)}` : `task_${taskId.slice(0, 8)}`;

    // Option 2: scope to executionRunId subfolder only
    if (executionRunId) {
      const runDir = path.join(uploadDir, projectId, taskBase, executionRunId);
      if (fs.existsSync(runDir)) {
        try {
          const entries = fs.readdirSync(runDir);
          return entries
            .filter(e => !fs.statSync(path.join(runDir, e)).isDirectory())
            .map(e => {
              const filePath = path.join(runDir, e);
              return { filename: e, filePath, docType: docTypeByPath.get(filePath) };
            });
        } catch { /* fall through */ }
      }
      return []; // executionRunId given but no files uploaded → return empty
    }

    // Fallback: legacy [task:id] prefix in flat project folder
    const prefix = `[task:${taskId}]`;
    return allDocs
      .filter(d => d.filename.startsWith(prefix))
      .map(d => ({ filename: d.filename, filePath: d.filePath, docType: d.docType }));
  }

  /**
   * Build the task attachments section (images, documents uploaded per task).
   * Documents with SA/SD docType are shown as spec files, not generic attachments.
   */
  private buildAttachmentsSection(attachments: Array<{ filename: string; filePath: string; docType?: string }>): string {
    const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
    const images = attachments.filter(a => IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)));
    const specDocs = attachments.filter(a =>
      !IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)) &&
      (a.docType === 'SA' || a.docType === 'SD')
    );
    const otherDocs = attachments.filter(a =>
      !IMAGE_EXTS.some(ext => a.filename.toLowerCase().endsWith(ext)) &&
      a.docType !== 'SA' && a.docType !== 'SD'
    );

    const lines: string[] = ['## 任務附件'];

    if (specDocs.length > 0) {
      lines.push('');
      lines.push('### 規格文件（手動上傳）');
      lines.push('');
      lines.push('以下規格文件由使用者指定，請使用 Read 工具閱讀，**這是主要的實作依據**：');
      lines.push('');
      for (const doc of specDocs) {
        const cleanName = doc.filename.replace(/\[task:[^\]]+\]\s*/, '').replace(/^[a-f0-9-]+-/, '');
        const tag = doc.docType === 'SA' ? '[SA 前端規格]' : '[SD 後端規格]';
        lines.push(`- **${tag} ${cleanName}**: 請用 Read tool 讀取 \`${doc.filePath.replace(/\\/g, '/')}\``);
      }
    }

    if (images.length > 0) {
      lines.push('');
      lines.push('### 截圖 / 圖片');
      lines.push('');
      lines.push('以下圖片與本次任務相關，請使用 Read 工具閱讀以了解視覺上下文：');
      lines.push('');
      for (const img of images) {
        const cleanName = img.filename.replace(/\[task:[^\]]+\]\s*/, '');
        lines.push(`- **${cleanName}**: \`${img.filePath.replace(/\\/g, '/')}\``);
      }
    }

    if (otherDocs.length > 0) {
      lines.push('');
      lines.push('### 其他附件');
      lines.push('');
      for (const doc of otherDocs) {
        const cleanName = doc.filename.replace(/\[task:[^\]]+\]\s*/, '');
        lines.push(`- **${cleanName}**: \`${doc.filePath.replace(/\\/g, '/')}\``);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build the project experience notes section（前人踩坑教訓）injected near the
   * spec-document layers. One bullet per active note: `- [category] content`.
   */
  private buildProjectNotesSection(notes: ProjectNote[]): string {
    const lines: string[] = ['## 專案經驗筆記（前人踩坑教訓，開發前必讀）', '（每則為精簡重點+出處，詳情自行查規格/程式）'];
    for (const n of notes) {
      lines.push(n.category ? `- [${n.category}] ${n.content}` : `- ${n.content}`);
    }
    return lines.join('\n');
  }

  /**
   * Build prompt section for Axure mockup HTML snapshots selected by the user.
   */
  private buildMockupSection(filePaths: string[]): string {
    const lines: string[] = ['## Mockup 參考畫面（Axure 原型，僅供參考）', ''];
    lines.push('以下是本次任務對應的 UI Mockup HTML 截圖，**僅供視覺參考，實作依據以 SA 規格文件為準**。');
    lines.push('必要時才使用 Read 工具閱讀這些檔案（例如需要確認欄位名稱、按鈕位置等畫面細節）：');
    lines.push('');
    for (const fp of filePaths) {
      const filename = fp.split(/[\\/]/).pop() || fp;
      lines.push(`- **${filename}**: \`${fp.replace(/\\/g, '/')}\``);
    }
    return lines.join('\n');
  }

  /**
   * Build DB schema reference section — tells backend agents where to find schema files.
   * Does NOT embed the full schema; agents use Read tool to query what they need.
   */
  private buildDbSchemaSection(files: Array<{ label: string; schemaPath: string; erPath: string }>): string {
    const lines: string[] = [
      '## 資料庫 Schema 參考',
      '',
      '本專案已預先抓取以下資料庫的 schema，存放在以下檔案。',
      '**需要了解 DB 結構時，用 Read tool 查閱對應檔案，不要全部載入，只讀你需要的部分。**',
      '',
    ];
    for (const f of files) {
      lines.push(`### ${f.label}`);
      lines.push(`- **Schema JSON** (tables / columns / foreign keys): \`${f.schemaPath.replace(/\\/g, '/')}\``);
      if (f.erPath) {
        lines.push(`- **ER Diagram (Mermaid)**: \`${f.erPath.replace(/\\/g, '/')}\``);
      }
      lines.push('');
    }
    lines.push('Schema JSON 結構：`{ tables: [{name, schema}], columns: [{tableName, columnName, dataType, isPrimaryKey, isForeignKey, referencedTable}], foreignKeys: [{tableName, columnName, referencedTable, referencedColumn}] }`');
    return lines.join('\n');
  }

  /**
   * Build SA operation flow section injected into frontend agent prompt.
   */
  private buildSaFlowSection(flowDiagram: string, taskType: string): string {
    const typeNote = taskType === 'bug'
      ? '以下是與此 Bug 相關的前端操作流程路徑（從完整 SA 流程中提取）。'
      : taskType === 'testing'
      ? '以下是此測試任務需要覆蓋的前端操作流程路徑。'
      : '以下是從 SA 規格文件分析出的完整前端操作流程圖。';

    const verificationNote = taskType === 'bug'
      ? '修復完成後，請確認相關流程路徑能正常運作。'
      : taskType === 'testing'
      ? '測試必須覆蓋以下所有流程路徑，包含正常路徑與分支條件。'
      : '實作完成後，請逐一確認流程圖中每個節點都有對應的 UI 元件與行為，包含所有分支條件。';

    return `## SA 前端操作流程圖

${typeNote}

**實作時請對照此流程圖，確保每條路徑都有對應實作。**

\`\`\`mermaid
${flowDiagram}
\`\`\`

> **完成驗證要求**：${verificationNote}`;
  }

  /**
   * Find the best SA document for a frontend task.
   * Priority: task-bound SA docs → SVN SA docs
   */
  private findSaDocument(
    taskId: string,
    _projectId: string,
    _svnDocs: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null; docType: string | null }>,
  ): { filename: string; content: string } | null {
    // Query DB directly — all SA docs bound to this task (upload or SVN)
    const taskDocs = getDocumentsForTask(taskId).filter(d => d.docType === 'SA');
    for (const doc of taskDocs) {
      const content = this.readDocContent(doc.parsedText, doc.filePath);
      if (content) return { filename: doc.filename, content };
    }
    return null;
  }

  /**
   * Read document content from parsedText or file path.
   */
  private readDocContent(parsedText: string | null, filePath: string): string | null {
    if (!parsedText) return null;

    // parsedText = "[Document saved at: /path/to/file.md]"
    const mdMatch = parsedText.match(/^\[Document saved at: (.+)\]/);
    if (mdMatch) {
      const mdPath = mdMatch[1].trim();
      try {
        return fs.readFileSync(mdPath, 'utf-8');
      } catch {
        return null;
      }
    }

    // Plain text content
    if (!parsedText.startsWith('[') && parsedText.length > 50) {
      return parsedText;
    }

    // Try reading the file directly
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf-8');
      }
    } catch { /* ignore */ }

    return null;
  }

  /**
   * Build the spec section based on the type of spec result.
   */
  private buildSpecSection(spec: SpecResult): string {
    switch (spec.type) {
      case 'content':
        return `## 規格文件\n\n以下是本次任務的參考規格（來源：${spec.path}）：\n\n---\n${spec.content}\n---`;

      case 'file':
        return `## 規格文件\n\n規格文件已下載到本地（來源：${spec.path}）：\n\n文件路徑：\`${spec.filePath}\`\n\n**指示**：請使用 Read 工具讀取此文件。`;

      case 'directory':
        return `## 規格文件目錄\n\n以下是規格文件的根目錄：${spec.path}\n\n目錄中找到的規格相關文件：\n${spec.content}\n\n**指示**：請使用 Read 工具讀取上述目錄中與本次任務相關的文件。根據任務名稱和描述，選擇最可能相關的文件來閱讀。`;

      case 'svn-root':
        return `## 規格文件目錄 (SVN)\n\nSVN 規格根目錄：${spec.path}\n\n目錄中找到的規格相關文件：\n${spec.content}\n\n**指示**：請使用 \`svn cat "${spec.path}/<filename>"\` 命令來讀取上述目錄中與本次任務相關的文件。根據任務名稱和描述，選擇最可能相關的文件來閱讀。`;
    }
  }

  /**
   * Build the prominent error banner placed at the VERY TOP of the plan when
   * SVN spec fetch fails (auth failure, network down, etc.).
   * The plan still returns successfully, but the orchestrator must see this
   * and stop for user instruction before starting development.
   */
  private buildSpecFetchErrorBanner(errorMessage: string): string {
    return [
      `⚠ [SPEC_FETCH_ERROR] 規格自動撈取失敗（SVN／規格資料夾）：${errorMessage}`,
      '依專案規範「規格不齊全不執行」，請先告知使用者此錯誤並取得指示（重試 / 提供文件路徑 / 明確說「跳過」）後才能開始開發。',
      '若使用者選擇跳過，必須先用 report_output 記錄 [SKIP] 使用者跳過規格檢查。',
    ].join('\n');
  }

  /**
   * Build prompt section for SVN-fetched specification documents.
   * Only provides file paths — agent must use Read tool to access content.
   * This prevents spec content from being lost when conversation is compressed.
   */
  private buildSvnDocsSection(
    docs: Array<{ documentId: string; filename: string; filePath: string; parsedText: string | null; docType: string | null }>,
    warnings: string[] = [],
  ): string {
    const lines: string[] = ['## 規格文件（自動取得：SVN／規格資料夾）', ''];
    lines.push('以下規格文件已從規格來源（SVN／本地規格資料夾）自動取得，與本次任務相關。');
    lines.push('**重要**：請使用 Read 工具讀取這些文件。如果對話被壓縮導致你忘記規格內容，請重新讀取這些檔案。');
    lines.push('');
    if (warnings.length > 0) {
      lines.push('⚠ 規格來源警告（文件仍已取得，但請知悉以下狀況並轉告使用者）：');
      for (const w of warnings) lines.push(`- ${w}`);
      lines.push('');
    }

    for (const doc of docs) {
      const typeLabel = doc.docType === 'SA' ? '(SA 需求規格)' : doc.docType === 'SD' ? '(SD 系統設計)' : '';
      const isPdf = doc.filename.toLowerCase().endsWith('.pdf');
      const mdMatch = doc.parsedText?.match(/^\[Document saved at: (.+)\]/);
      const hasText = doc.parsedText && !doc.parsedText.startsWith('[') && doc.parsedText.length > 50;
      lines.push(`### ${doc.filename} ${typeLabel}`);
      if (isPdf) {
        lines.push(`路徑：\`${doc.filePath}\`（請用 Read tool 讀取，PDF 包含文字與圖片）`);
      } else if (mdMatch) {
        lines.push(`路徑：\`${mdMatch[1]}\`（請用 Read tool 讀取 Markdown，含文字與圖片路徑）`);
      } else if (hasText) {
        lines.push('');
        lines.push(doc.parsedText!);
      } else {
        lines.push(`路徑：\`${doc.filePath}\``);
      }
      lines.push('');
    }

    lines.push('請理解以上所有規格文件內容後再開始開發。');

    return lines.join('\n');
  }

  /**
   * Get document context for an agent based on task binding.
   * Only returns documents explicitly bound to this task (via task_documents table).
   * Frontend gets SA+SD, Backend gets SD only.
   * Auto-fetched documents (SVN / spec folders) are excluded here — they are handled separately in Layer 2.6.
   */
  private getDocumentContext(taskId: string, role: string): string | null {
    const allTaskDocs = getDocumentsForTask(taskId).filter(d => d.source !== 'svn' && d.source !== 'folder');
    if (allTaskDocs.length === 0) return null;

    const filteredDocs = allTaskDocs.filter(d => {
      if (role === 'backend') return d.docType === 'SD';
      return true;
    });

    // Remap to match the shape used below
    const docs = filteredDocs.map(d => ({
      docType: d.docType,
      filename: d.filename,
      filePath: d.filePath,
      content: d.parsedText,
    }));

    if (docs.length === 0) return null;

    const sections = docs.map(d => {
      const typeLabel = d.docType || 'Document';
      const isPdf = d.filename.toLowerCase().endsWith('.pdf');
      const mdMatch = d.content?.match(/^\[Document saved at: (.+)\]/);
      const imgMatch = d.content?.match(/^\[Image saved at: (.+)\]/);
      const hasText = d.content && !d.content.startsWith('[') && d.content.length > 50;

      if (isPdf) {
        return `- **${typeLabel}: ${d.filename}**: 請用 Read tool 讀取 "${d.filePath}"（PDF 包含文字與圖片）`;
      }
      if (mdMatch) {
        return `- **${typeLabel}: ${d.filename}**: 請用 Read tool 讀取 "${mdMatch[1]}"（Markdown 含文字與圖片路徑）`;
      }
      if (imgMatch) {
        return `- **${typeLabel}: ${d.filename}**: 請用 Read tool 讀取 "${imgMatch[1]}"（截圖圖片）`;
      }
      if (hasText) {
        return `### ${typeLabel}: ${d.filename}\n\n${d.content}`;
      }
      return `- **${typeLabel}: ${d.filename}**\n  路徑：\`${d.filePath}\``;
    });

    const hasInlineText = docs.some(d => {
      const hasText = d.content && !d.content.startsWith('[') && d.content.length > 50;
      return hasText;
    });

    const header = hasInlineText
      ? `# Project Documents\n\n以下是本次任務的相關文件內容：`
      : `# Project Documents\n\n以下文件與本次任務相關。**請使用 Read 工具讀取這些文件**。`;

    return `${header}\n\n${sections.join('\n\n')}\n\n請理解以上文件內容後再開始開發。`;
  }

  /**
   * Build the task-specific prompt section.
   */
  // reportTaskId：驗證報告檔名用（fullstack 會帶 -frontend/-backend 後綴）；
  // realTaskId：MCP 工具呼叫範例用（必須是真實的 task ID，工具才查得到任務）。
  buildTaskPrompt(
    title: string,
    description: string,
    taskType: TaskType,
    promptOpts: { role?: string; testOptions?: TestOptions; reportTaskId?: string; realTaskId?: string; projectId?: string; track?: ExecutionTrack; testCommands?: TestCommands; hasDbConnections?: boolean } = {},
  ): string {
    const { role, testOptions, reportTaskId, realTaskId, projectId, track, testCommands, hasDbConnections } = promptOpts;
    const taskId = realTaskId ?? reportTaskId;
    const typeLabels: Record<TaskType, string> = {
      bug: 'Bug Fix',
      feature: 'New Feature',
      refactor: 'Refactor',
      testing: 'Testing',
      other: 'Task',
    };

    // Backend-only mandatory sections（來自專案規範：效能分析 + 安全檢查；
    // 專案 config 有 dbConnections 時追加資料異動驗證——R4）
    const backendSections = role === 'backend'
      ? `${BACKEND_PERFORMANCE_SECTION}\n\n${BACKEND_SECURITY_SECTION}\n\n${hasDbConnections ? `${BACKEND_DB_VERIFICATION_SECTION}\n\n` : ''}`
      : '';

    return `# ${typeLabels[taskType]}: ${title}

## 任務描述

${description}

## 第一步：讀取專案設定

請先檢查工作目錄中是否有 CLAUDE.md 或 .claude/ 設定，如果有請讀取並遵循其中的指示和技能定義。

${this.buildSpecComplianceSection(taskId, track)}

${this.buildSpecReadingSection(taskId, track)}

${this.buildSpecChecklistSection(taskId, track, projectId)}

${this.buildUnitTestSection(taskId, track, role, testCommands)}

${this.buildStrategy(taskType, taskId, projectId)}

${backendSections}## 完成標準

${this.buildCompletionCriteria(role, testOptions, reportTaskId ?? realTaskId, taskId)}
- 如果遇到需要人工決策的問題，請加上 [NEEDS_HUMAN] 並說明原因`;
  }

  /**
   * 規格遵循（最高原則）— 逐字取自專案 CLAUDE.md「#### 2a. 嚴禁自行編造（最高原則）」，
   * 「規格不清楚」的處理改為使用 report_spec_gap MCP 工具。所有 role 都注入。
   */
  private buildSpecComplianceSection(taskId?: string, track?: ExecutionTrack): string {
    const tidComma = taskId ? `taskId="${taskId}", ` : '';
    // light 軌：原則不變，但「規格」的語境 = 原始 BUG 內容與現有程式碼慣例
    const lightNote = track === 'light'
      ? `

（light 軌註記：本任務無 SA/SD 規格文件，「規格」= 原始 BUG 內容（任務描述 / Asana 留言 / 附件截圖）與現有程式碼慣例。修復不可偏離 BUG 原文描述的預期行為；BUG 原文沒提的東西不要順手改，訊息文字/欄位名一律沿用現有程式碼與 BUG 原文，不可自創。）`
      : '';
    return `## 規格遵循（最高原則 — 違反此規則等同任務失敗）

**所有實作都必須有規格依據。規格沒寫的東西，不做。規格寫的東西，照做。**${lightNote}

具體規則：
1. 欄位名稱、按鈕文字、訊息文字 → 必須從 SA/SD 文件逐字抄，不可以自己翻譯或改寫
2. API 路徑、參數名、型別 → 必須從 SD 文件抄，不可以自己命名
3. SQL 欄位名 → 必須從 DB schema 或 ORM 欄位定義（Entity/Model 對應）確認，不可以猜
4. UI 元件選擇（checkbox/radio/select）→ 必須從 SA 或 Axure 確認，不可以自己決定
5. 查詢邏輯（WHERE 條件、JOIN、排序）→ 必須照 SD 規格的 SQL/規則實作，不可以簡化或替代
6. DDL 欄位 → 必須與 ORM/模型定義逐欄對照確認（含系統共用欄位，如建立/修改時間），不可以猜

如果規格不清楚、未定義或有矛盾：
- 呼叫 mcp__omni-commander__report_spec_gap(${tidComma}category=..., description=...) 記錄缺口（category: sa_missing/sd_missing/field_undefined/api_undefined/logic_unclear/other）
- 標記 [NEEDS_CLARIFICATION] 繼續做其他有規格依據的部分
- 寧可不做也不要做錯，不要自己編值`;
  }

  /**
   * 規格文件閱讀協議 — 逐字取自專案 CLAUDE.md「#### 2. 確實閱讀規格文件」。所有 role 都注入。
   * 有 taskId 時第 4 條寫成具體的 report_output MCP 呼叫格式。
   */
  private buildSpecReadingSection(taskId?: string, track?: ExecutionTrack): string {
    // light 軌：無 SA/SD，改讀原始 BUG 內容（任務描述 + Asana 留言 + 附件截圖）
    if (track === 'light') {
      const commentsCall = taskId
        ? `mcp__omni-commander__get_asana_task_comments(taskId="${taskId}")`
        : 'mcp__omni-commander__get_asana_task_comments()';
      const lightReportLine = taskId
        ? `3. 讀完後，用 mcp__omni-commander__report_output(taskId="${taskId}", content="...") 摘要你理解的重點（問題現象、修復後預期行為、涉及的欄位/訊息文字）`
        : '3. 讀完後，在 report_output 摘要你理解的重點（問題現象、修復後預期行為、涉及的欄位/訊息文字）';
      return `## BUG 原文閱讀（light 軌 — 強制，寫 code 之前必須完成）

本任務無 SA/SD 規格文件，**原始 BUG 內容就是驗證基準**：
1. 完整讀取任務描述 — 逐字讀每個提到的欄位名稱、按鈕文字、訊息文字、操作步驟
2. 呼叫 ${commentsCall} 讀回報討論串；有附件截圖就取回並用 Read tool 看圖
${lightReportLine}
4. 開發過程中遇到任何訊息文字、欄位名，回頭查 BUG 原文與現有程式碼確認，不要憑印象寫`;
    }

    const reportLine = taskId
      ? `4. 讀完後，用 mcp__omni-commander__report_output(taskId="${taskId}", content="...") 摘要你理解的重點（欄位清單、API 清單、特殊邏輯）`
      : '4. 讀完後，在 report_output 摘要你理解的重點（欄位清單、API 清單、特殊邏輯）';
    const consistencyCall = taskId
      ? `check_spec_consistency(taskId="${taskId}")`
      : 'check_spec_consistency(taskId)';
    return `## 規格文件閱讀（強制，寫 code 之前必須完成）

1. 用 Read tool 完整讀取 SA 文件 — 不是掃過去，是逐項讀每個欄位名稱、按鈕文字、訊息文字、操作流程
2. 用 Read tool 完整讀取 SD 文件 — 逐個 API 讀清楚 path、method、每個參數名和型別、response 結構
3. 如果有 Axure HTML — 用 Read tool 讀取，對照 SA 確認 UI 結構
${reportLine}
5. 開發過程中遇到任何文字、欄位名、API 路徑，回頭查規格確認，不要憑印象寫
6. （建議）讀完後若發現 SA 與 SD 有疑似矛盾，通知 orchestrator 執行 ${consistencyCall} 做系統性比對——規格矛盾先解決再開工，否則規格回對無法 100%`;
  }

  /**
   * 規格檢查表（規格回對輸入）— 讀完規格後立即用 save_spec_checklist 抽取
   * 結構化 checklist；任務完成時 run_spec_compliance 做程式預檢（advisory），
   * 再由獨立 AI 回對（save_compliance_review）逐項驗證，最新 AI 回對 missing
   * 不為 0 無法標 completed。所有 role 都注入；有 taskId 才注入具體呼叫。
   */
  private buildSpecChecklistSection(taskId?: string, track?: ExecutionTrack, projectId?: string): string {
    // ui_text 抽取規範——與 mcp/tools/compliance-tools.ts 的 UI_TEXT_EXTRACTION_RULE 同文
    // （web/MCP 邊界不互相 import，靠測試釘住兩處同步）：行為敘述句存成 ui_text 永遠
    // 驗不過（程式中不存在該字面文字），只能事後豁免。
    const uiTextRule = '**行為敘述句（「點擊X後…」「當…時…」）與元件動態組字的完整 label 禁止存 ui_text——存 logic**；ui_text 只放程式中應存在的字面文字（按鈕字、標題、訊息、i18n 值）';
    const saveCall = taskId
      ? `mcp__omni-commander__save_spec_checklist(taskId="${taskId}", items=[{itemType, content, side?, sourceRef?}, ...])`
      : 'save_spec_checklist(taskId, items=[...])';

    // light 軌：檢查表來源改為原始 BUG 內容——工序輕，回對標準不變
    if (track === 'light') {
      const commentsCall = taskId
        ? `mcp__omni-commander__get_asana_task_comments(taskId="${taskId}")`
        : 'mcp__omni-commander__get_asana_task_comments()';
      const attachArgs = [
        projectId ? `projectId="${projectId}"` : '',
        taskId ? `taskId="${taskId}"` : '',
      ].filter(Boolean).join(', ');
      const attachCall = `mcp__omni-commander__fetch_task_attachments(${attachArgs})`;
      return `## 規格檢查表（light 軌 — 從 BUG 原文抽取，強制）

本任務無 SA/SD，檢查表來源是原始 BUG 內容：
1. 讀任務描述、呼叫 ${commentsCall} 讀回報討論串、${attachCall} 取截圖並用 Read tool 看圖
2. 從中抽出「修復後預期行為」清單（每個可驗證的行為一項，itemType="logic"；若 bug 涉及特定訊息文字/欄位則用 ui_text）
   - ${uiTextRule}
3. ${saveCall} 寫入
範例：「計劃部門查詢欄位輸入值後查詢，結果正確過濾」

任務完成時先用 run_spec_compliance 做程式預檢，再由 orchestrator 派獨立 AI 回對 agent 逐項驗證（含 logic 項目），最新 AI 回對的 missing 不為 0 無法標 completed——light 軌輕的是工序，不是標準。`;
    }

    return `## 規格檢查表（強制 — 讀完規格後立即執行）

讀完 SA/SD 規格後，立即呼叫 ${saveCall} 抽取結構化檢查表：
- **每一個欄位名/按鈕文字/訊息文字/API/DB 欄位都是一項**，content 必須從規格**逐字抄**（不可翻譯或改寫）
- itemType：ui_text=規格逐字文字 / api=API 路徑（如 "POST /api/wa05/save"）/ param=請求參數 / response_field=回應欄位 / db_field=DB 欄位 / logic=邏輯規則
- ${uiTextRule}
- 邏輯類規則（WHERE 條件、排序、狀態轉換等）標 itemType="logic"（程式預檢不比對，由 AI 回對驗證）
- sourceRef 填規格檔名+章節，方便回查

任務完成時先用 run_spec_compliance 做程式預檢（抓文字/路徑錯字），再由 orchestrator 派獨立 AI 回對 agent 逐項驗證（含 logic 項目），最新 AI 回對的 missing 不為 0 無法標 completed。`;
  }

  /**
   * 單元測試（強制流程）— 與規格檢查表同一精神：先列案例清單再寫測試，
   * 清單用 report_output 留稽核軌跡；失敗案例的預期結果必須有規格出處
   * （承接「規格未定義禁止自創」——沒定義就 report_spec_gap，嚴禁編造預期值）。
   * 單元測試只驗邏輯，不驗 SQL 和欄位名——API 煙霧測試照舊，是補強不是取代。
   * 測試指令來自專案設定（frontendTestCommand / backendTestCommand）：
   * frontend 任務注入 frontend 指令、backend 注入 backend 指令、其他 role 兩個都列；
   * 未設定則注入 fallback 文案（用 workspace CLAUDE.md 的測試指令）。
   */
  private buildUnitTestSection(taskId?: string, track?: ExecutionTrack, role?: string, testCommands?: TestCommands): string {
    const tidComma = taskId ? `taskId="${taskId}", ` : '';

    // 測試指令：side 對應（frontend/backend 各注入自己的；其他 role 兩個都列）
    const FALLBACK = '用 workspace CLAUDE.md 定義的測試指令；找不到測試指令則用 report_output 記錄「此 workspace 無測試指令」後跳過本節';
    let commandNote: string;
    if (role === 'frontend') {
      commandNote = testCommands?.frontend ? `\`${testCommands.frontend}\`` : FALLBACK;
    } else if (role === 'backend') {
      commandNote = testCommands?.backend ? `\`${testCommands.backend}\`` : FALLBACK;
    } else {
      const both: string[] = [];
      if (testCommands?.frontend) both.push(`前端 \`${testCommands.frontend}\``);
      if (testCommands?.backend) both.push(`後端 \`${testCommands.backend}\``);
      commandNote = both.length > 0 ? both.join('、') : FALLBACK;
    }

    // 案例來源：full 軌 = SA 流程 + 檢查表 logic 項 + Axure；light 軌 = BUG 原文重現步驟
    const caseSourceLine = track === 'light'
      ? '1. **先理解流程**：重讀 BUG 原文的重現步驟與預期行為（任務描述、Asana 留言、附件截圖）與檢查表的 logic 項，弄清楚每條行為的觸發條件與預期結果'
      : '1. **先理解流程**：重讀 SA 操作流程、規格檢查表的 logic 項、Axure 畫面操作，弄清楚每條邏輯的輸入、輸出與分支條件';
    const normalCaseSource = track === 'light'
      ? '每個自己 side 的 logic 項（修復後預期行為）至少一條成功案例'
      : '每個自己 side 的 logic 項至少一條成功案例';

    return `## 單元測試（強制流程 — 先列案例清單，再寫測試）

與規格檢查表同一精神：**先列案例清單、再寫測試**，清單是可稽核的產出。單元測試只驗邏輯，不驗 SQL 和欄位名——API 煙霧測試照舊執行，是補強不是取代。

${caseSourceLine}
2. **先列測試案例清單，列完才准寫測試**：用 mcp__omni-commander__report_output(${tidComma}content="...") 回報完整案例清單留下稽核軌跡，分類必須涵蓋：
   - **正常流程**：${normalCaseSource}
   - **失敗路徑**：必填空值、格式/長度錯誤、資料不存在、權限不足、依賴失敗
   - **邊界/花式操作**：邊界值、重複送出、特殊字元、分頁邊界等
   每條案例標注對應的 checklist itemId 或規格出處
3. **失敗案例的預期結果必須有規格出處**：錯誤訊息、驗證規則是規格寫的才能斷言；規格沒定義的失敗行為 → 呼叫 mcp__omni-commander__report_spec_gap(${tidComma}category=..., description=...) 記錄，該案例先不寫或只斷言「不得 crash」這類中性行為——**嚴禁編造預期值**（編出來的預期值會被測試固化成「正確答案」）
4. **寫測試 → 跑到綠**：測試名稱或註解標注對應的 itemId/規格出處——之後 AI 回對 logic 項可直接引用測試檔的 file+line 當證據
5. **測試分層（開發迴圈快、結案全套）**：
   - 開發迴圈：修改-驗證迴圈中，跑**與本任務相關的測試檔**即可（如 jest/vitest 的路徑過濾、gradle 的 --tests 過濾），加快迭代
   - 結案前：**完成前必須跑全套**（專案設定的測試指令原樣執行）——測試指令：${commandNote}。全綠才回報 report_verification_result passed——**閘門認的是全套結果，相關測試綠不等於全套綠**（撞到既有的**無關失敗**依第 7 條處理：本任務相關測試全綠即可 passed=true，note 誠實列出無關失敗）
6. **禁裝擋板**：測試指令執行失敗且原因是**框架/套件不存在**（command not found、找不到模組/類別路徑）→ **嚴禁自行安裝任何套件或修改建置檔**（package.json / pom.xml / build.gradle / lockfile 一律不可動）。這代表專案設定與 workspace 實況不符：report_output 記錄後標 failed，由使用者處理。「修復重試最多 3 次」僅適用於**測試本身的失敗**（斷言不過、程式 bug）
7. **只准新增/修改與本任務直接相關的測試**：跑全套時撞到既有的**無關失敗** → 不可順手修（你沒有那些功能的規格脈絡，亂修會把潛在 bug 固化成斷言）——用 mcp__omni-commander__report_output(${tidComma}content="...") 記錄無關失敗清單，並建議使用者執行 get_test_baseline_plan 做基線修復。這些無關失敗**不阻擋**你回報自己任務的測試結果：自己任務相關的測試全綠即可回報 passed=true，note 必列無關失敗清單（report_verification_result 的 note 註明）`;
  }

  /**
   * Build the strategy section for a task type.
   * Bug tasks get an extra step 0 that pulls BUG evidence via MCP tools (needs taskId).
   */
  private buildStrategy(taskType: TaskType, taskId?: string, projectId?: string): string {
    if (taskType === 'bug') {
      const attachArgs = [
        projectId ? `projectId="${projectId}"` : '',
        taskId ? `taskId="${taskId}"` : '',
      ].filter(Boolean).join(', ');
      const attachCall = `mcp__omni-commander__fetch_task_attachments(${attachArgs})`;
      const commentsCall = taskId
        ? `mcp__omni-commander__get_asana_task_comments(taskId="${taskId}")`
        : 'mcp__omni-commander__get_asana_task_comments()';
      return `## 修復策略

0. **取得 BUG 現場**：先呼叫 ${attachCall} 取得 BUG 截圖、${commentsCall} 看回報討論串（若非 Asana 任務或無附件會回空，屬正常）
1. **分析問題**：根據描述和錯誤訊息，定位問題的根本原因
2. **找到相關程式碼**：使用 Grep/Glob 找到相關檔案
3. **理解現有邏輯**：閱讀相關程式碼，理解其運作方式
4. **制定修復方案**：確定最小改動的修復方式
5. **實作修復**：修改程式碼
6. **驗證修復**：如果有測試，執行測試確認修復成功`;
    }

    const strategies: Record<Exclude<TaskType, 'bug'>, string> = {
      feature: `## 開發策略

1. **理解需求**：確認要做什麼功能
2. **設計方案**：在寫程式之前先思考設計
3. **找到相關程式碼**：使用 Grep/Glob 找到相關檔案，理解現有架構
4. **寫測試**：先寫失敗測試（如果適用）
5. **實作功能**：按設計方案實作
6. **驗證功能**：執行測試和 build 確認成功`,

      refactor: `## 重構策略

1. **理解現有程式碼**：閱讀需要重構的程式碼
2. **識別問題**：找出程式碼中的問題（重複、複雜度、耦合等）
3. **制定重構計劃**：規劃重構步驟，確保每步都可驗證
4. **逐步重構**：按計劃進行重構，每步都確保功能正常
5. **驗證重構**：執行測試或手動驗證，確保行為不變`,

      testing: `## 測試策略

1. **確認測試範圍**：根據任務描述，確認要測試的功能模組
2. **執行 smoke test**：使用 validate-output skill，直接用 MCP browser 工具驗證頁面
3. **執行 E2E spec**：如果有 .spec.ts，執行 npx playwright test
4. **記錄結果**：產生測試報告到 docs/smoke-tests/`,

      other: `## 執行策略

1. **理解任務**：確認需要完成什麼
2. **搜尋相關程式碼**：找到相關的檔案和模組
3. **制定計劃**：規劃實作步驟
4. **執行任務**：按計劃實作
5. **驗證完成**：確認任務已正確完成`,
    };

    return strategies[taskType];
  }

  /**
   * MCP 驗收工具接線 — 完成標準共用的 get_verification_plan / report_verification_result /
   * report_verification_evidence 呼叫指引。taskId undefined 時省略 taskId 參數值。
   */
  private buildVerificationToolLines(taskId?: string, includeEvidence = true): string[] {
    const tid = taskId ? `taskId="${taskId}"` : '';
    const tidComma = taskId ? `taskId="${taskId}", ` : '';
    const lines = [
      `- 開發完成後呼叫 mcp__omni-commander__get_verification_plan(${tid}) 取得驗收清單，逐項執行`,
      `- 逐項結果用 mcp__omni-commander__report_verification_result(${tidComma}results=[...]) 回報`,
    ];
    if (includeEvidence) {
      lines.push(`- 截圖等驗收證據用 mcp__omni-commander__report_verification_evidence(${tidComma}filePath=...) 上傳`);
    }
    lines.push(`- 完成後呼叫 mcp__omni-commander__run_spec_compliance(${tid}) 做程式預檢（抓文字/路徑錯字並修掉；有正當理由的項目用 waive_checklist_item 豁免並說明）——預檢僅供快速修正，不解鎖完成閘門`);
    lines.push(`- **通知 orchestrator 派獨立 AI 回對 agent**（get_compliance_review_plan(${tid}) → reviewer 逐項驗證 → save_compliance_review），最新 AI 回對 **missing=0 才可標 completed**；你（implementer）不可自行執行 AI 回對或自評`);
    return lines;
  }

  private buildCompletionCriteria(role?: string, testOptions?: TestOptions, reportTaskId?: string, realTaskId?: string): string {
    const taskId = realTaskId ?? reportTaskId;
    const reportName = reportTaskId ?? realTaskId ?? 'adhoc';
    // 單元測試：順序在 build 之後、run_spec_compliance（buildVerificationToolLines）之前
    const unitTestLine = taskId
      ? `- Build 通過後跑單元測試（指令與案例要求見「單元測試（強制流程）」區塊），確保全數通過；失敗則修復後重跑，最多 3 次；最終仍失敗 → mcp__omni-commander__update_task_status(taskId="${taskId}", status="failed", summary="單元測試失敗：...")`
      : '- Build 通過後跑單元測試（指令與案例要求見「單元測試（強制流程）」區塊），確保全數通過；失敗則修復後重跑，最多 3 次；最終仍失敗 → 標記任務 failed 並說明原因';
    if (role === 'frontend') {
      const opts = testOptions?.frontend;
      const lines: string[] = [
        '- **回對規格**：開發完成後，重新閱讀原始規格文件，逐項確認畫面欄位、元件互動、API 串接、data-testid 是否都已正確實作。列出每項需求對應的程式碼位置及確認結果，若有缺漏立即修復',
        '- 執行 build 指令（例如 npm run build / pnpm build），確保零錯誤',
        unitTestLine,
        '- 所有 playwright 截圖一律使用 `fullPage: true`，確保捕捉完整頁面（含捲軸內容）',
      ];
      const runMock = opts?.useMock !== false && !opts?.useRealApi || opts?.useMock;
      const runReal = opts?.useRealApi;
      if (opts?.smokeTest) {
        if (runMock) {
          lines.push(
            `- Build 成功後，若工作目錄有\`.claude/skills/validate-output/SKILL.md\`，` +
            `**必須**呼叫該 skill 執行 playwright-mcp smoke test（使用 mock 資料，USE_MOCK=true），截圖存到 \`docs/smoke-tests/{模組}/mock/\``,
            '- validate-output 失敗時，嘗試修復錯誤後重新執行；無法修復則加上 [NEEDS_HUMAN]',
          );
        }
        if (runReal) {
          lines.push(
            `- ${runMock ? 'Mock smoke test 通過後，' : 'Build 成功後，'}若工作目錄有\`.claude/skills/validate-output/SKILL.md\`，` +
            `再次執行 playwright-mcp smoke test（使用真實後端 API），截圖存到 \`docs/smoke-tests/{模組}/realAPI/\``,
          );
        }
      }
      if (opts?.e2eSpec) {
        const modes: string[] = [];
        if (runMock) modes.push('mock 模式（E2E_MODE=mock）');
        if (runReal) modes.push('真實 API 模式（USE_MOCK=false，確認後端已啟動）');
        const modeNote = modes.join('，再跑一次 ');
        lines.push(
          `- ${opts?.smokeTest ? 'Smoke test 通過後，' : ''}若 \`e2e/templates/\` 存在，` +
          `依照 \`e2e/templates/module-spec.template.ts\` 格式，為本次開發的模組在 \`e2e/\` 目錄撰寫 E2E spec 檔案（同時建立對應的 mock-data JSON）`,
          `- E2E spec 執行指令（從 spec 檔案名稱取出模組代碼，如 \`e2e/sm29.spec.ts\` → \`sm29\`）：` +
          (runMock ? `mock 模式（不需後端，跳過 auth setup）：\`E2E_MODE=mock TEST_MODULE={模組} TEST_API_MODE=mock npx playwright test e2e/{模組}.spec.ts --project=chromium --no-deps${opts?.headed ? ' --headed' : ''}\`，截圖存到 \`test-results/{模組}/mock/\`` : '') +
          (runMock && runReal ? '；' : '') +
          (runReal ? `real API 模式（需後端已啟動，含登入 auth setup）：\`TEST_MODULE={模組} TEST_API_MODE=realAPI npx playwright test e2e/{模組}.spec.ts --project=chromium${opts?.headed ? ' --headed' : ''}\`（不加 --no-deps，讓 auth.setup.ts 先跑完登入），截圖存到 \`test-results/{模組}/realAPI/\`` : ''),
        );
      }
      if (opts?.consoleScript) {
        lines.push(
          `- 為本次開發的模組產生瀏覽器 Console 測試腳本，存到 \`e2e/console-scripts/{模組}.js\`：` +
          `腳本需動態載入 html2canvas（\`await import('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js')\`），` +
          `腳本開頭一律先導航到登入頁、填入帳號密碼（admin/Admin123!/驗證碼0000）並等待跳轉完成（不管當前是否已登入），` +
          `登入完成後導航到目標頁面，依據 data-testid 驗證關鍵元素、點擊查詢按鈕、確認結果渲染，每個步驟後截圖並自動下載 PNG，` +
          `最後 \`console.table(results)\` 輸出 pass/fail 摘要。腳本必須可直接貼到瀏覽器 Console 執行，無需任何 npm 套件。`,
        );
      }
      lines.push(...this.buildVerificationToolLines(taskId));
      lines.push(
        `- 所有驗證步驟完成後，將完整驗證結果（規格逐項確認、build 結果、測試結果、截圖路徑）以 Markdown 格式寫入 \`docs/verification-reports/${reportName}.md\`（目錄不存在則建立）`,
        '- 所有步驟完成後，在回應末尾加上 [TASK_COMPLETE]',
      );
      return lines.join('\n');
    }

    if (role === 'backend') {
      const opts = testOptions?.backend;
      const lines: string[] = [
        '- **回對規格**：開發完成後，重新閱讀原始規格文件，逐項確認每支 API 的 URL、INPUT/OUTPUT 欄位、商業邏輯是否都已正確實作。列出每項需求對應的程式碼位置及確認結果，若有缺漏立即修復',
        '- 執行 build 指令，確保零錯誤',
        unitTestLine,
      ];
      if (opts?.unitTests) {
        lines.push(
          '- 撰寫每個端點/模組的單元測試（案例清單與測試指令依「單元測試（強制流程）」區塊，不可另用其他指令），確保全數通過',
          '- 在所有測試通過之前，**不要**標記 [TASK_COMPLETE]',
        );
      }
      if (opts?.apiSmokeTest) {
        lines.push(
          '- Build 成功後，若工作目錄有 `.claude/skills/validate-api/SKILL.md`，' +
          '**必須**呼叫該 skill 執行 API smoke test，確認端點回應正常',
          '- validate-api 失敗時，嘗試修復錯誤後重新執行；無法修復則加上 [NEEDS_HUMAN]',
        );
      }
      if (opts?.apiContract) {
        lines.push(
          '- 將本次開發的端點合約寫入 `.ai_context/api-contracts/{module}.json`（如目錄不存在請建立）',
        );
      }
      lines.push(...this.buildVerificationToolLines(taskId));
      lines.push(
        `- 所有驗證步驟完成後，將完整驗證結果以 Markdown 格式寫入 \`docs/verification-reports/${reportName}.md\`（目錄不存在則建立），內容包含：\n` +
        `  1. 規格逐項確認結果\n` +
        `  2. Build 結果\n` +
        `  3. 測試結果\n` +
        `  4. **測試用 SQL 指令**（獨立的 code block）：\n` +
        `     - \`-- [SETUP] 新增假資料\`：針對本次 API 所需的 INSERT 語句，讓測試人員可直接執行建立測試資料\n` +
        `     - \`-- [TEARDOWN] 清除假資料\`：對應的 DELETE 語句，條件需精確（用剛才 INSERT 的識別欄位），確保不誤刪其他資料`,
        '- 所有步驟完成後，在回應末尾加上 [TASK_COMPLETE]',
      );
      return lines.join('\n');
    }

    // Default for other roles
    return [
      '- **回對規格**：開發完成後，重新閱讀原始規格文件，逐項確認每項需求是否都已正確實作。列出每項需求對應的程式碼位置及確認結果，若有缺漏立即修復',
      '- 如果是前端專案，請執行 build 確保成功',
      unitTestLine,
      ...this.buildVerificationToolLines(taskId, false),
      '- 確認完成後，在回應末尾加上 [TASK_COMPLETE]',
    ].join('\n');
  }

  /**
   * Resolve the working directory for an agent based on project config and role.
   */
  resolveWorkingDir(
    project: { workingDir: string; frontendPath: string | null; backendPath: string | null },
    label: string,
  ): string {
    if (label === 'frontend' && project.frontendPath) {
      return project.frontendPath;
    }
    if (label === 'backend' && project.backendPath) {
      return project.backendPath;
    }
    return project.workingDir;
  }
}
