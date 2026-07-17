import type { SpecModeHandler } from './SpecModeHandler.js';
import type { ExecutionPipeline } from './ExecutionPipeline.js';
import type { TestOptions } from '@omni/shared';
import { getProject } from '../db/queries/projects.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('MasterOrchestrator');

/**
 * Top-level orchestrator that delegates to the unified ExecutionPipeline.
 * Retains a reference to SpecModeHandler (for document handling) for
 * backward compatibility.
 */
export class MasterOrchestrator {
  constructor(
    private specHandler: SpecModeHandler,
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
      executionRunId?: string;
    },
  ): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    logger.info({ projectId, taskId: opts?.taskId, model: opts?.model }, 'Starting orchestration');

    if (opts?.taskId) {
      // Execute a specific task
      await this.pipeline.executeTask(opts.taskId, opts.model, opts.mockupFiles, opts.testOptions, opts.executionRunId);
    } else if (opts?.requirement) {
      // Ad-hoc execution
      await this.pipeline.executeAdHoc(projectId, opts.requirement, opts.model, opts.role);
    } else {
      // Legacy: spec mode execution with documents
      await this.specHandler.execute(projectId, undefined, opts?.model, undefined, opts?.testOptions);
    }
  }

  getSpecHandler(): SpecModeHandler {
    return this.specHandler;
  }

  getPipeline(): ExecutionPipeline {
    return this.pipeline;
  }
}
