import type { SpecModeHandler } from './SpecModeHandler.js';
import type { CreativeModeHandler } from './CreativeModeHandler.js';
import type { QuickModeHandler, QuickTask } from './QuickModeHandler.js';
import { getProject } from '../db/queries/projects.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('MasterOrchestrator');

/**
 * Top-level orchestrator that routes between Spec, Creative, and Quick modes.
 */
export class MasterOrchestrator {
  constructor(
    private specHandler: SpecModeHandler,
    private creativeHandler: CreativeModeHandler,
    private quickHandler?: QuickModeHandler,
  ) {}

  /** Start execution for a project based on its mode */
  async start(projectId: string, requirement?: string, model?: string, quickTask?: QuickTask): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    logger.info({ projectId, mode: project.mode, model }, 'Starting orchestration');

    if (project.mode === 'spec') {
      await this.specHandler.execute(projectId, requirement, model);
    } else if (project.mode === 'creative') {
      // Creative mode requires an initial requirement from the user
      throw new Error('Creative mode requires startInterview() to be called with a requirement');
    } else if (project.mode === 'quick') {
      if (!this.quickHandler) {
        throw new Error('QuickModeHandler not configured');
      }
      if (!quickTask) {
        throw new Error('Quick mode requires quickTask to be provided');
      }
      await this.quickHandler.execute(projectId, quickTask, model);
    }
  }

  /** Start creative mode interview */
  async startInterview(projectId: string, requirement: string): Promise<void> {
    await this.creativeHandler.startInterview(projectId, requirement);
  }

  getSpecHandler(): SpecModeHandler {
    return this.specHandler;
  }

  getCreativeHandler(): CreativeModeHandler {
    return this.creativeHandler;
  }

  getQuickHandler(): QuickModeHandler | undefined {
    return this.quickHandler;
  }
}
