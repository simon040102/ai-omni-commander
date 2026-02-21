import type { AgentManager } from '../agent/AgentManager.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { EventTypes } from '@omni/shared';
import { getTask, getTasksByProject } from '../db/queries/tasks.js';
import { getDependencies } from '../db/queries/tasks.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('IntegrationTestRunner');

/**
 * Auto-triggers integration tests when paired frontend + backend tasks
 * for the same feature are both completed.
 */
export class IntegrationTestRunner {
  constructor(
    private agentManager: AgentManager,
    private eventBus: EventBus,
  ) {
    this.eventBus.on(EventTypes.TASK_COMPLETED, async (event) => {
      const { taskId, projectId } = event.payload as { taskId: string; projectId: string };
      await this.checkAndRunTests(projectId, taskId);
    });

    logger.info('Integration test runner initialized');
  }

  private async checkAndRunTests(projectId: string, completedTaskId: string): Promise<void> {
    const task = getTask(completedTaskId);
    if (!task) return;

    // Only trigger when a backend endpoint task completes
    if (task.label !== 'backend') return;

    // Check if there are corresponding frontend tasks that also depend on this backend task
    const allTasks = getTasksByProject(projectId);
    const deps = getDependencies(projectId);

    // Find frontend tasks that depend on this completed backend task
    const frontendDependents = deps
      .filter(d => d.dependsOnId === completedTaskId)
      .map(d => allTasks.find(t => t.id === d.taskId))
      .filter(t => t && t.label === 'frontend' && t.status === 'completed');

    if (frontendDependents.length === 0) return;

    logger.info({ projectId, taskId: completedTaskId }, 'Both frontend and backend tasks complete, running integration tests');

    const testPrompt = `Run integration tests for the following feature:

Backend task: "${task.title}"
${task.description ? `Description: ${task.description}` : ''}

Related frontend tasks:
${frontendDependents.map(t => `- "${t!.title}"`).join('\n')}

Please:
1. Identify the relevant test files
2. Run the tests using the appropriate test runner (jest, vitest, etc.)
3. If no tests exist, write basic integration tests
4. Report results clearly

End with [TASK_COMPLETE].`;

    try {
      await this.agentManager.startAgent({
        projectId,
        role: 'testing',
        prompt: testPrompt,
      });

      await this.eventBus.emit({
        type: EventTypes.TEST_TRIGGERED,
        payload: { projectId, triggeredBy: completedTaskId },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, projectId }, 'Failed to start integration tests');
    }
  }
}
