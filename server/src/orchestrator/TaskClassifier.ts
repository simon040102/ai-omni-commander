import type { TaskLabel } from '@omni/shared';
import {
  detectLabelFromTitle,
  classifyTask,
  type ClassificationResult,
} from '../utils/taskClassification.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('TaskClassifier');

export type { ClassificationResult };

/**
 * Keyword-based task classifier. Thin class shell over the shared pure
 * functions in utils/taskClassification.ts (single source of truth, also
 * used by MCP sync_asana_tasks).
 *
 * The old `claude --print` AI classification path was removed on purpose:
 * spawning claude is disabled in this deployment, and execSync blocked the
 * entire event loop — the Asana sync loop called it per task, freezing the
 * server for up to 30s per call.
 */
export class TaskClassifier {
  /**
   * Quick label override based on explicit Chinese role markers in the title.
   * Returns null when no marker is present.
   */
  detectLabelFromTitle(title: string): TaskLabel | null {
    return detectLabelFromTitle(title);
  }

  /**
   * Classify a task by keywords (async signature kept for caller compatibility).
   */
  async classify(data: {
    title: string;
    description?: string;
    tags?: string[];
  }): Promise<ClassificationResult> {
    const result = classifyTask(data.title, data.description);
    logger.info({ title: data.title, taskType: result.taskType, label: result.label }, 'Task classified (keyword-based)');
    return result;
  }

  /**
   * Kept for API compatibility — same keyword classification as classify().
   */
  fallbackClassify(title: string, description?: string): ClassificationResult {
    return classifyTask(title, description);
  }
}
