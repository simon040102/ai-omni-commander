import path from 'node:path';
import type { TestOptions, Task } from '@omni/shared';
import { EventTypes } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { ExecutionPipeline } from './ExecutionPipeline.js';
import { updateTask } from '../db/queries/tasks.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('FullstackController');

interface FixInstruction {
  target: 'frontend' | 'backend';
  instruction: string;
}

interface FullstackExecOptions {
  model?: string;
  mockupFiles?: string[];
  testOptions?: TestOptions;
  executionRunId?: string;
}

export class FullstackController {
  constructor(
    private readonly agentManager: AgentManager,
    private readonly eventBus: EventBus,
    private readonly pipeline: ExecutionPipeline,
  ) {}

  async execute(
    task: Task,
    project: { id: string; workingDir: string; frontendPath: string | null; backendPath: string | null },
    opts: FullstackExecOptions = {},
  ): Promise<void> {
    const { id: taskId, projectId } = task;

    if (!project.frontendPath || !project.backendPath) {
      throw new Error('Fullstack tasks require both frontendPath and backendPath to be configured');
    }

    try {
      // Phase 0: Start coordinator FIRST (visible from the beginning)
      const coordinatorAgentId = await this.agentManager.startAgent({
        projectId,
        role: 'coordinator',
        taskId,
        prompt: `你是 Fullstack Coordinator（主控 Agent）。前後端 Agent 正在開發中，請等待系統通知。\n\n你會在前後端完成後收到驗證報告路徑，届時請用 Read 工具讀取報告並分析整合問題。\n\n目前狀態：⏳ 等待前後端 Agent 完成...`,
        model: 'sonnet',
        workingDir: project.workingDir,
        useWorkspaceSkills: false,
        skipTaskStatusUpdate: true,
      });
      logger.info({ taskId, coordinatorAgentId }, 'Coordinator started (waiting for FE+BE)');

      // Collect coordinator text output in real-time
      const collectedText: string[] = [];
      const unsubOutput = this.eventBus.on(EventTypes.AGENT_OUTPUT, (event) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.agentId === coordinatorAgentId && payload.streamType === 'text') {
          collectedText.push(payload.content as string);
        }
      });

      // Phase 1: Build FE + BE prompts, start subagents in parallel
      const [feData, beData] = await Promise.all([
        this.pipeline.preparePromptForRole(taskId, 'frontend', {
          ...opts,
          reportTaskId: `${taskId}-frontend`,
        }),
        this.pipeline.preparePromptForRole(taskId, 'backend', {
          ...opts,
          reportTaskId: `${taskId}-backend`,
        }),
      ]);

      const [feAgentId, beAgentId] = await Promise.all([
        this.agentManager.startAgent({
          projectId,
          role: 'frontend',
          taskId,
          prompt: feData.prompt,
          model: feData.model,
          workingDir: feData.workingDir,
          useWorkspaceSkills: true,
          skipTaskStatusUpdate: true,
        }),
        this.agentManager.startAgent({
          projectId,
          role: 'backend',
          taskId,
          prompt: beData.prompt,
          model: beData.model,
          workingDir: beData.workingDir,
          useWorkspaceSkills: true,
          skipTaskStatusUpdate: true,
        }),
      ]);

      logger.info({ taskId, feAgentId, beAgentId }, 'Fullstack subagents started in parallel');

      // Phase 2: Wait for both subagents to complete
      await this.waitForAgents([feAgentId, beAgentId]);
      logger.info({ taskId }, 'Both fullstack subagents completed');

      // Phase 3: Send report paths to coordinator via sendInput
      const fePath = path.join(feData.workingDir, 'docs', 'verification-reports', `${taskId}-frontend.md`).replace(/\\/g, '/');
      const bePath = path.join(beData.workingDir, 'docs', 'verification-reports', `${taskId}-backend.md`).replace(/\\/g, '/');

      const analyzePrompt = `前後端 Agent 已完成開發。請分析以下兩份驗證報告，找出整合問題。

前端驗證報告路徑：\`${fePath}\`
後端驗證報告路徑：\`${bePath}\`

請使用 Read 工具讀取這兩份報告，分析前後端是否存在整合問題（API 路徑不符、欄位名稱不一致、資料型別差異等）。

完成分析後，輸出 [FULLSTACK_FIX] marker（即使沒有問題也必須輸出）。`;

      // Reset collected text for the analysis phase
      collectedText.length = 0;
      await this.agentManager.sendInputToAgent(coordinatorAgentId, analyzePrompt);

      // Wait for coordinator to complete
      await this.waitForAgents([coordinatorAgentId]);
      unsubOutput();

      const coordinatorFixes = this.parseFixInstructions(collectedText.join('\n'));
      logger.info({ taskId, fixCount: coordinatorFixes.length }, 'Coordinator analysis completed');

      // Phase 3b: Integration test with Playwright (if enabled)
      let integrationFixes: FixInstruction[] = [];
      const integrationTestEnabled = opts.testOptions?.frontend?.integrationTest === true;
      if (integrationTestEnabled) {
        integrationFixes = await this.runIntegrationTest(taskId, projectId, project, fePath, bePath, opts);
        logger.info({ taskId, integrationFixCount: integrationFixes.length }, 'Integration test completed');
      }

      // Merge fixes from coordinator + integration test
      const fixes = [...coordinatorFixes, ...integrationFixes];

      // Phase 4: Run fix agents (or complete immediately if no fixes needed)
      if (fixes.length === 0) {
        await this.completeTask(taskId, projectId, 'fullstack-coordinator');
        return;
      }

      // Notify coordinator about fix dispatch
      const fixSummary = fixes.map(f => `- [${f.target}] ${f.instruction.slice(0, 100)}...`).join('\n');
      this.agentManager.sendInputToAgent(coordinatorAgentId, `發現 ${fixes.length} 個整合問題，已派遣 Fix Agent 修正：\n${fixSummary}\n\n等待修正完成...`).catch(() => {});

      const fixAgentIds: string[] = [];
      for (const fix of fixes) {
        const fixRole = fix.target === 'frontend' ? 'frontend' as const : 'backend' as const;
        const fixWorkingDir = fix.target === 'frontend'
          ? (project.frontendPath || project.workingDir)
          : (project.backendPath || project.workingDir);

        const fixAgentId = await this.agentManager.startAgent({
          projectId,
          role: fixRole,
          taskId,
          prompt: `# Fullstack Fix Task\n\n## 整合問題說明\n\n${fix.instruction}\n\n請修正上述整合問題，修正完成後在回應末尾加上 [TASK_COMPLETE]。`,
          model: opts.model || 'sonnet',
          workingDir: fixWorkingDir,
          useWorkspaceSkills: true,
          skipTaskStatusUpdate: true,
        });
        fixAgentIds.push(fixAgentId);
      }

      await this.waitForAgents(fixAgentIds);
      logger.info({ taskId, fixAgentCount: fixAgentIds.length }, 'All fix agents completed');

      // Notify coordinator that all fixes are done
      this.agentManager.sendInputToAgent(coordinatorAgentId, `所有 Fix Agent 已完成修正。任務完成。[TASK_COMPLETE]`).catch(() => {});

      await this.completeTask(taskId, projectId, 'fullstack-fix');
    } catch (err) {
      logger.error({ err, taskId }, 'Fullstack execution failed');
      await this.failTask(taskId, projectId, err instanceof Error ? err.message : String(err));
    }
  }

  private async runIntegrationTest(
    taskId: string,
    projectId: string,
    project: { workingDir: string; frontendPath: string | null; backendPath: string | null },
    feReportPath: string,
    beReportPath: string,
    opts: FullstackExecOptions,
  ): Promise<FixInstruction[]> {
    const collectedText: string[] = [];

    const prompt = `你是整合測試 Agent。請用 Playwright 驗證前端是否能正確呼叫後端 API 並顯示正確資料。

## 測試資訊來源
- 前端驗證報告：\`${feReportPath}\`
- 後端驗證報告：\`${beReportPath}\`
- 前端工作目錄：\`${(project.frontendPath || project.workingDir).replace(/\\/g, '/')}\`

## 測試步驟
1. 先用 Read 工具讀取兩份報告，了解有哪些 API endpoint 和 UI 頁面
2. 確認前端 dev server 是否在跑（若沒有，用 Bash 啟動）
3. 用 browser_navigate 打開前端頁面
4. 用 browser_network_requests 開始監控 API 呼叫
5. 用 browser_click / browser_type 操作 UI 觸發 API 呼叫
6. 驗證：
   - Request URL、method、payload 是否正確
   - Response status code 是否為 2xx
   - Response body 欄位和型別是否符合預期
   - UI 是否正確顯示 API 回傳的資料
7. 用 browser_take_screenshot 截圖作為證據

## 輸出格式
完成後輸出：

[INTEGRATION_TEST_RESULT]
{
  "passed": true/false,
  "tests": [
    { "name": "API 名稱", "passed": true/false, "detail": "測試細節" }
  ],
  "fixes": [
    { "target": "frontend|backend", "instruction": "修正說明" }
  ]
}
[/INTEGRATION_TEST_RESULT]

rules:
- 全部通過 → "fixes": []
- 有失敗 → 具體說明哪裡不對、怎麼修
- 截圖存到 docs/integration-tests/ 目錄
- 輸出完 marker 後加 [TASK_COMPLETE]`;

    const testAgentId = await this.agentManager.startAgent({
      projectId,
      role: 'integration-test',
      taskId,
      prompt,
      model: opts.model || 'sonnet',
      workingDir: project.frontendPath || project.workingDir,
      useWorkspaceSkills: false,
      skipTaskStatusUpdate: true,
    });

    const unsubOutput = this.eventBus.on(EventTypes.AGENT_OUTPUT, (event) => {
      const payload = event.payload as Record<string, unknown>;
      if (payload.agentId === testAgentId && payload.streamType === 'text') {
        collectedText.push(payload.content as string);
      }
    });

    try {
      await this.waitForAgents([testAgentId]);
    } finally {
      unsubOutput();
    }

    const fullText = collectedText.join('\n');
    return this.parseIntegrationTestResult(fullText);
  }

  // ── Marker parsers ──

  private parseFixInstructions(output: string): FixInstruction[] {
    const match = output.match(/\[FULLSTACK_FIX\]([\s\S]*?)\[\/FULLSTACK_FIX\]/);
    if (!match) {
      logger.warn('No [FULLSTACK_FIX] marker found in coordinator output — assuming no fixes');
      return [];
    }

    try {
      const raw = match[1].trim();
      const json = JSON.parse(raw);
      if (Array.isArray(json.fixes)) {
        return json.fixes.filter(
          (f: unknown): f is FixInstruction =>
            typeof f === 'object' && f !== null &&
            ('frontend' === (f as FixInstruction).target || 'backend' === (f as FixInstruction).target) &&
            typeof (f as FixInstruction).instruction === 'string',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse [FULLSTACK_FIX] JSON — treating as no fixes');
    }
    return [];
  }

  private parseIntegrationTestResult(output: string): FixInstruction[] {
    const match = output.match(/\[INTEGRATION_TEST_RESULT\]([\s\S]*?)\[\/INTEGRATION_TEST_RESULT\]/);
    if (!match) {
      logger.warn('No [INTEGRATION_TEST_RESULT] marker found — assuming no issues');
      return [];
    }

    try {
      const json = JSON.parse(match[1].trim());
      if (Array.isArray(json.fixes)) {
        return json.fixes.filter(
          (f: unknown): f is FixInstruction =>
            typeof f === 'object' && f !== null &&
            ('frontend' === (f as FixInstruction).target || 'backend' === (f as FixInstruction).target) &&
            typeof (f as FixInstruction).instruction === 'string',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse [INTEGRATION_TEST_RESULT] JSON');
    }
    return [];
  }

  // ── Wait & status helpers ──

  /** Max wait time for agents (4 hours) */
  private static readonly AGENT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

  private waitForAgents(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const remaining = new Set(agentIds);

      const cleanup = () => {
        unsubComplete();
        unsubError();
        unsubStopped();
        clearTimeout(timer);
      };

      const checkDone = (agentId: string) => {
        if (agentId && remaining.has(agentId)) {
          remaining.delete(agentId);
          if (remaining.size === 0) {
            cleanup();
            resolve();
          }
        }
      };

      const unsubComplete = this.eventBus.on(EventTypes.AGENT_COMPLETED, (event) => {
        const agentId = ((event.payload as Record<string, unknown>)?.agentId as string | undefined)
          ?? (event.source ?? '');
        checkDone(agentId);
      });

      const unsubError = this.eventBus.on(EventTypes.AGENT_ERROR, (event) => {
        const agentId = ((event.payload as Record<string, unknown>)?.agentId as string | undefined)
          ?? (event.source ?? '');
        if (agentId && remaining.has(agentId)) {
          cleanup();
          for (const id of remaining) {
            if (id !== agentId) this.agentManager.stopAgent(id).catch(() => {});
          }
          reject(new Error(`Agent ${agentId} failed with error`));
        }
      });

      const unsubStopped = this.eventBus.on(EventTypes.AGENT_STOPPED, (event) => {
        const agentId = ((event.payload as Record<string, unknown>)?.agentId as string | undefined)
          ?? (event.source ?? '');
        if (agentId && remaining.has(agentId)) {
          cleanup();
          for (const id of remaining) {
            if (id !== agentId) this.agentManager.stopAgent(id).catch(() => {});
          }
          reject(new Error(`Agent ${agentId} was manually stopped`));
        }
      });

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for agents: ${[...remaining].join(', ')}`));
      }, FullstackController.AGENT_TIMEOUT_MS);
    });
  }

  private async completeTask(taskId: string, projectId: string, source: string): Promise<void> {
    updateTask(taskId, { status: 'completed' });

    await this.eventBus.emit({
      type: EventTypes.TASK_STATUS_CHANGED,
      source,
      payload: { taskId, projectId, newStatus: 'completed' },
      timestamp: new Date().toISOString(),
    });

    await this.eventBus.emit({
      type: EventTypes.TASK_COMPLETED,
      source,
      payload: { taskId, projectId, status: 'completed' },
      timestamp: new Date().toISOString(),
    });
  }

  private async failTask(taskId: string, projectId: string, reason: string): Promise<void> {
    updateTask(taskId, { status: 'failed', resultSummary: `Fullstack execution failed: ${reason}` });

    await this.eventBus.emit({
      type: EventTypes.TASK_STATUS_CHANGED,
      source: 'fullstack-controller',
      payload: { taskId, projectId, newStatus: 'failed' },
      timestamp: new Date().toISOString(),
    });
  }
}
