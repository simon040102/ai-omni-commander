import type { SpecModeHandler } from './SpecModeHandler.js';
import type { CreativeModeHandler } from './CreativeModeHandler.js';
import type { ExecutionPipeline } from './ExecutionPipeline.js';
import type { TestOptions } from '@omni/shared';
import { getProject } from '../db/queries/projects.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('MasterOrchestrator');

/**
 * Top-level orchestrator that delegates to the unified ExecutionPipeline.
 * Retains references to SpecModeHandler (for document handling) and
 * CreativeModeHandler (for interview flow) for backward compatibility.
 */
export class MasterOrchestrator {
  constructor(
    private specHandler: SpecModeHandler,
    private creativeHandler: CreativeModeHandler,
    private pipeline: ExecutionPipeline,
  ) {}

  /**
   * Start execution for a project.
   * v2: Routes to ExecutionPipeline for task-based or ad-hoc execution.
   */
  async start(
    projectId: string,
    opts?: {
      taskId?: string;
      requirement?: string;
      model?: string;
      role?: string;
      mockupFiles?: string[];
      testOptions?: TestOptions;
    },
  ): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    logger.info({ projectId, taskId: opts?.taskId, model: opts?.model }, 'Starting orchestration');

    if (opts?.taskId) {
      // Execute a specific task
      await this.pipeline.executeTask(opts.taskId, opts.model, opts.mockupFiles, opts.testOptions);
    } else if (opts?.requirement) {
      // Ad-hoc execution
      await this.pipeline.executeAdHoc(projectId, opts.requirement, opts.model, opts.role);
    } else {
      // Legacy: spec mode execution with documents
      await this.specHandler.execute(projectId, undefined, opts?.model, undefined, opts?.testOptions);
    }
  }

  /** Start creative mode interview (legacy, kept for backward compat) */
  async startInterview(projectId: string, requirement: string): Promise<void> {
    await this.creativeHandler.startInterview(projectId, requirement);
  }

  getSpecHandler(): SpecModeHandler {
    return this.specHandler;
  }

  getCreativeHandler(): CreativeModeHandler {
    return this.creativeHandler;
  }

  getPipeline(): ExecutionPipeline {
    return this.pipeline;
  }
}
