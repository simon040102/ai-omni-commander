import type { EventBus } from '../eventbus/EventBus.js';
import type { CodeReviewAgent } from './CodeReviewAgent.js';
import { EventTypes } from '@omni/shared';
import { getTask } from '../db/queries/tasks.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ReviewTrigger');

/**
 * Auto-triggers code reviews when backend or frontend tasks complete.
 */
export class ReviewTrigger {
  constructor(
    private eventBus: EventBus,
    private reviewer: CodeReviewAgent,
  ) {
    this.eventBus.on(EventTypes.TASK_COMPLETED, async (event) => {
      const { taskId, projectId } = event.payload as { taskId: string; projectId: string };
      const task = getTask(taskId);
      if (!task) return;

      // Only review backend and frontend tasks
      if (task.label === 'backend' || task.label === 'frontend') {
        logger.info({ taskId, label: task.label }, 'Auto-triggering code review');
        try {
          await this.reviewer.reviewChanges(projectId, taskId);
        } catch (err) {
          logger.error({ err, taskId }, 'Failed to trigger code review');
        }
      }
    });

    logger.info('Review trigger initialized');
  }
}
