import type { Task, TaskType } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ModelRouter');

export interface ModelSelection {
  model: string;
  reasoning: string;
}

const BASE_MODEL_MAP: Record<TaskType, string> = {
  bug: 'sonnet',
  feature: 'opus',
  refactor: 'sonnet',
  testing: 'sonnet',
  other: 'haiku',
};

const TIER_ORDER = ['haiku', 'sonnet', 'opus'] as const;

const COMPLEXITY_KEYWORDS = /\b(complex|architecture|migration|redesign|overhaul|integration|multi-step|critical|security|auth|performance)\b/i;

/**
 * Auto-selects the optimal Claude model based on task characteristics.
 */
export class ModelRouter {
  /**
   * Select the best model for a task.
   * If the task has a preferredModel, that always wins.
   */
  selectModel(task: Pick<Task, 'taskType' | 'title' | 'description' | 'preferredModel'>): ModelSelection {
    // User override
    if (task.preferredModel) {
      return { model: task.preferredModel, reasoning: 'User-specified model preference' };
    }

    // Base model from task type
    let model = BASE_MODEL_MAP[task.taskType] || 'sonnet';
    let reasoning = `Base selection: ${task.taskType} → ${model}`;

    // Complexity upgrade heuristics
    const fullText = `${task.title} ${task.description || ''}`;
    const isComplex = this.assessComplexity(fullText);

    if (isComplex) {
      const currentIdx = TIER_ORDER.indexOf(model as typeof TIER_ORDER[number]);
      if (currentIdx >= 0 && currentIdx < TIER_ORDER.length - 1) {
        const upgraded = TIER_ORDER[currentIdx + 1];
        reasoning = `Upgraded ${model} → ${upgraded} (complexity detected)`;
        model = upgraded;
      }
    }

    logger.info({ taskType: task.taskType, model, reasoning }, 'Model auto-routed');
    return { model, reasoning };
  }

  /**
   * Assess whether a task description suggests high complexity.
   */
  private assessComplexity(text: string): boolean {
    // Long description suggests complex task
    if (text.length > 500) return true;

    // Complexity keywords
    if (COMPLEXITY_KEYWORDS.test(text)) return true;

    return false;
  }
}
