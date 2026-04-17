import path from 'node:path';
import type { TestOptions, Task } from '@omni/shared';
import { EventTypes } from '@omni/shared';
import type { AgentManager } from '../agent/AgentManager.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { ExecutionPipeline } from './ExecutionPipeline.js';
import { updateTask } from '../db/queries/tasks.js';
import { getAgentOutputs } from '../db/queries/events.js';
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

    try {
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

      // Phase 3: Run coordinator to analyze reports and produce fix instructions
      const fePath = path.join(feData.workingDir, 'docs', 'verification-reports', `${taskId}-frontend.md`).replace(/\\/g, '/');
      const bePath = path.join(beData.workingDir, 'docs', 'verification-reports', `${taskId}-backend.md`).replace(/\\/g, '/');

      const coordinatorPrompt = `你是 Fullstack Coordinator。請分析以下兩份驗證報告，找出前後端整合問題。

前端驗證報告路徑：\`${fePath}\`
後端驗證報告路徑：\`${bePath}\`

請使用 Read 工具讀取這兩份報告，分析前後端是否存在整合問題（API 路徑不符、欄位名稱不一致、資料型別差異等）。

完成分析後，輸出 [FULLSTACK_FIX] marker（即使沒有問題也必須輸出）。`;

      const fixes = await this.runCoordinator(taskId, projectId, project.workingDir, coordinatorPrompt);
      logger.info({ taskId, fixCount: fixes.length }, 'Coordinator completed');

      // Phase 4: Run fix agents (or complete immediately if no fixes needed)
      if (fixes.length === 0) {
        await this.completeTask(taskId, projectId, 'fullstack-coordinator');
        return;
      }

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

      await this.completeTask(taskId, projectId, 'fullstack-fix');
    } catch (err) {
      logger.error({ err, taskId }, 'Fullstack execution failed');
      await this.failTask(taskId, projectId, err instanceof Error ? err.message : String(err));
    }
  }

  private async runCoordinator(
    taskId: string,
    projectId: string,
    workingDir: string,
    prompt: string,
  ): Promise<FixInstruction[]> {
    const coordinatorAgentId = await this.agentManager.startAgent({
      projectId,
      role: 'coordinator',
      taskId,
      prompt,
      model: 'sonnet',
      workingDir,
      useWorkspaceSkills: false,
      skipTaskStatusUpdate: true,
    });

    await this.waitForAgents([coordinatorAgentId]);

    // Read coordinator output from DB (DESC order, need to reverse)
    const outputs = getAgentOutputs(coordinatorAgentId, 300);
    const textContent = outputs
      .filter(o => o.streamType === 'text')
      .reverse()
      .map(o => o.content)
      .join('\n');

    return this.parseFixInstructions(textContent);
  }

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
        const fixes = json.fixes.filter(
          (f: unknown): f is FixInstruction =>
            typeof f === 'object' && f !== null &&
            ('frontend' === (f as FixInstruction).target || 'backend' === (f as FixInstruction).target) &&
            typeof (f as FixInstruction).instruction === 'string',
        );
        return fixes;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse [FULLSTACK_FIX] JSON — treating as no fixes');
    }
    return [];
  }

  /** Max wait time for agents (60 minutes) */
  private static readonly AGENT_TIMEOUT_MS = 60 * 60 * 1000;

  private waitForAgents(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const remaining = new Set(agentIds);

      const cleanup = () => {
        unsubComplete();
        unsubError();
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
          reject(new Error(`Agent ${agentId} failed with error`));
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
