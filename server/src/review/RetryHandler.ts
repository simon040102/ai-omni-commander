import type { EventBus } from '../eventbus/EventBus.js';
import type { ExecutionPipeline } from '../orchestrator/ExecutionPipeline.js';
import type { ReviewResult } from '@omni/shared';
import { EventTypes } from '@omni/shared';
import { getTask, updateTask } from '../db/queries/tasks.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('RetryHandler');

/**
 * Listens for review.completed events and auto-retries tasks that failed review.
 */
export class RetryHandler {
  constructor(
    private eventBus: EventBus,
    private pipeline: ExecutionPipeline,
  ) {
    this.eventBus.on(EventTypes.REVIEW_COMPLETED, async (event) => {
      const { taskId, projectId, result } = event.payload as {
        taskId: string | null;
        projectId: string;
        result: ReviewResult;
      };

      if (!taskId || result.verdict !== 'fail') return;

      const task = getTask(taskId);
      if (!task) return;

      if (task.retryCount >= task.maxRetries) {
        logger.info({ taskId, retryCount: task.retryCount, maxRetries: task.maxRetries },
          'Max retries exceeded after review fail, not retrying');
        return;
      }

      logger.info({ taskId, retryCount: task.retryCount, score: result.score },
        'Review failed, auto-retrying task');

      // Increment retry count and reset status
      updateTask(taskId, {
        retryCount: task.retryCount + 1,
        status: 'pending',
      });

      // Emit retrying event for frontend notification
      await this.eventBus.emit({
        type: EventTypes.TASK_RETRYING,
        source: taskId,
        payload: {
          taskId,
          projectId,
          retryCount: task.retryCount + 1,
          reason: result.summary || 'Review failed',
        },
        timestamp: new Date().toISOString(),
      });

      // Re-execute the task (the pipeline will re-assemble context)
      try {
        await this.pipeline.executeTask(taskId);
      } catch (err) {
        logger.error({ err, taskId }, 'Failed to auto-retry task after review');
      }
    });

    logger.info('Retry handler initialized');
  }
}
