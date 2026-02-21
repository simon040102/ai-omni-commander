import type { AgentManager } from '../agent/AgentManager.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import type { Workspace, ReviewConfig } from '@omni/shared';
import { EventTypes } from '@omni/shared';
import { getTask } from '../db/queries/tasks.js';
import { getProject } from '../db/queries/projects.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('CodeReviewAgent');

/**
 * Spawns a read-only Claude Code agent to review code changes.
 * Can use a specific workspace's agent skills (CLAUDE.md) for review context.
 */
export class CodeReviewAgent {
  constructor(
    private agentManager: AgentManager,
    private eventBus: EventBus,
    private contextSync: ContextSync,
  ) {}

  /** Review code changes made for a specific task */
  async reviewChanges(projectId: string, taskId: string): Promise<void> {
    const task = getTask(taskId);
    if (!task) return;

    // Check if review is enabled and get config
    const project = getProject(projectId);
    if (!project) return;

    let reviewConfig: ReviewConfig | undefined;
    let workspaces: Workspace[] = [];
    if (project.configJson) {
      try {
        const cfg = JSON.parse(project.configJson);
        reviewConfig = cfg.reviewConfig;
        workspaces = cfg.workspaces || [];
      } catch { /* ignore */ }
    }

    // If review is explicitly disabled, skip
    if (reviewConfig && !reviewConfig.enabled) {
      logger.info({ projectId, taskId }, 'Code review disabled for this project');
      return;
    }

    // Determine which workspace's agent skills to use
    let skillSourcePath = '';
    if (reviewConfig?.skillSource && reviewConfig.skillSource !== 'auto') {
      // User specified a specific workspace
      const ws = workspaces.find(w => w.label === reviewConfig!.skillSource);
      if (ws) skillSourcePath = ws.path;
    } else {
      // Auto: use the task's label to find matching workspace
      const ws = workspaces.find(w => w.label.toLowerCase() === task.label?.toLowerCase());
      if (ws) skillSourcePath = ws.path;
      else if (workspaces.length === 1) skillSourcePath = workspaces[0].path;
    }

    const contracts = await this.contextSync.readAllContracts();
    const contractSummary = contracts.length > 0
      ? `\nAPI Contracts to verify against:\n${JSON.stringify(contracts, null, 2)}`
      : '';

    const skillNote = skillSourcePath
      ? `\nIMPORTANT: Read and follow the agent skills from the project at "${skillSourcePath}". Check for CLAUDE.md and .claude/ directory for coding standards and review guidelines.`
      : '';

    const reviewPrompt = `Review the recent code changes for the task: "${task.title}"
${task.description ? `\nTask description: ${task.description}` : ''}
${contractSummary}
${skillNote}

Please review for:
1. Code correctness and potential bugs
2. Security vulnerabilities (SQL injection, XSS, etc.)
3. Consistency with the API contracts
4. Error handling and edge cases
5. Code style and best practices

Use Read, Glob, and Grep to examine the codebase.
Focus on recently modified files.
Provide a structured review with issues categorized as CRITICAL, WARNING, or SUGGESTION.

End your review with [REVIEW_COMPLETE].`;

    logger.info({ projectId, taskId, title: task.title, skillSource: skillSourcePath || 'none' }, 'Starting code review');

    await this.agentManager.startAgent({
      projectId,
      role: 'review',
      taskId: `review-${taskId}`,
      prompt: reviewPrompt,
      model: 'sonnet',
    });

    await this.eventBus.emit({
      type: EventTypes.REVIEW_REQUESTED,
      payload: { projectId, taskId, title: task.title },
      timestamp: new Date().toISOString(),
    });
  }
}
