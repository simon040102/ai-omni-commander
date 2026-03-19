import { execSync } from 'node:child_process';
import type { TaskType, TaskLabel } from '@omni/shared';
import { getConfig } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('TaskClassifier');

export interface ClassificationResult {
  taskType: TaskType;
  label: TaskLabel;
}

/**
 * Uses Claude haiku to classify tasks by type and label.
 */
export class TaskClassifier {
  /**
   * Classify a task using AI (Claude haiku).
   */
  /**
   * Quick label override based on explicit Chinese role markers in the title.
   * Takes priority over AI classification.
   */
  detectLabelFromTitle(title: string): TaskLabel | null {
    // "-前端" / "前端" suffix → frontend
    if (/前端/.test(title)) return 'frontend';
    // "-後端" / "後端" suffix → backend
    if (/後端/.test(title)) return 'backend';
    // 串接 → frontend
    if (/串接/.test(title)) return 'frontend';
    return null;
  }

  async classify(data: {
    title: string;
    description?: string;
    tags?: string[];
  }): Promise<ClassificationResult> {
    // Check for explicit Chinese role markers first — override AI entirely
    const forcedLabel = this.detectLabelFromTitle(data.title);
    logger.info({ title: data.title, forcedLabel }, 'classify() called');
    if (forcedLabel) {
      // Use fallback only for taskType, forcedLabel wins for label
      const fallback = this.fallbackClassify(data.title, data.description);
      logger.info({ forcedLabel, taskType: fallback.taskType }, 'Skipping AI — using forced label');
      return { taskType: fallback.taskType, label: forcedLabel };
    }

    const config = getConfig();

    const prompt = `You are a task classifier. Given the task information below, classify it.

Task title: ${data.title}
${data.description ? `Description: ${data.description}` : ''}
${data.tags?.length ? `Tags: ${data.tags.join(', ')}` : ''}

Respond with ONLY a JSON object (no markdown, no explanation):
{"taskType": "<bug|feature|refactor|other>", "label": "<backend|frontend|devops|testing|review|architect>"}

Rules:
- taskType: "bug" for fixes/errors, "feature" for new functionality, "refactor" for code improvements, "other" for everything else
- label: choose based on which area the task primarily affects`;

    try {
      const claudePath = config.claudePath;
      const args = claudePath === 'npx'
        ? 'npx @anthropic-ai/claude-code --print --model haiku --output-format text'
        : `"${claudePath}" --print --model haiku --output-format text`;

      const result = execSync(args, {
        input: prompt,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env },
      });

      const jsonMatch = result.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        logger.warn({ result }, 'No JSON found in classifier response, using fallback');
        const fallback = this.fallbackClassify(data.title, data.description);
        return { taskType: fallback.taskType, label: forcedLabel ?? fallback.label };
      }

      const parsed = JSON.parse(jsonMatch[0]) as { taskType?: string; label?: string };

      const validTypes: TaskType[] = ['bug', 'feature', 'refactor', 'other'];
      const validLabels: TaskLabel[] = ['backend', 'frontend', 'devops', 'testing', 'review', 'architect'];

      const taskType = validTypes.includes(parsed.taskType as TaskType)
        ? parsed.taskType as TaskType
        : 'other';
      const label = forcedLabel ?? (validLabels.includes(parsed.label as TaskLabel)
        ? parsed.label as TaskLabel
        : 'backend');

      logger.info({ title: data.title, taskType, label, forcedLabel }, 'Task classified by AI');
      return { taskType, label };
    } catch (err) {
      logger.warn({ err, title: data.title }, 'AI classification failed, using fallback');
      const fallback = this.fallbackClassify(data.title, data.description);
      return { taskType: fallback.taskType, label: forcedLabel ?? fallback.label };
    }
  }

  /**
   * Regex-based fallback classification when AI is unavailable.
   */
  fallbackClassify(title: string, description?: string): ClassificationResult {
    const text = `${title} ${description || ''}`.toLowerCase();

    let taskType: TaskType = 'other';
    if (/\b(bug|fix|error|crash|broken|fail|issue|problem|wrong|incorrect)\b/.test(text)) {
      taskType = 'bug';
    } else if (/\b(refactor|restructure|reorganize|consolidate|simplify|clean\s*up|extract|decouple)\b/.test(text)) {
      taskType = 'refactor';
    } else if (/\b(add|create|implement|build|new|feature|support|enable|introduce)\b/.test(text)) {
      taskType = 'feature';
    }

    let label: TaskLabel = 'backend';
    if (/\b(ui|ux|css|style|component|react|vue|angular|html|layout|design|frontend|front.?end)\b/.test(text) || /前端|串接/.test(text)) {
      label = 'frontend';
    } else if (/\b(deploy|ci|cd|docker|k8s|kubernetes|pipeline|infra|devops)\b/.test(text)) {
      label = 'devops';
    } else if (/\b(test|spec|coverage|e2e|unit test|integration test)\b/.test(text)) {
      label = 'testing';
    }

    return { taskType, label };
  }
}
