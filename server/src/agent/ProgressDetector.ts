import type { AgentOutputEvent, AgentProgress } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ProgressDetector');

interface FlowStepState {
  n: number;
  label: string;
  status: 'pending' | 'active' | 'done';
}

interface ProgressState {
  fileWrites: number;
  toolUses: number;
  completedTodos: number;
  totalTodos: number;
  currentPhase: string;
  lastEmittedKey: string; // dedup
  flowTotalSteps: number;   // from [FLOW_PLAN]
  flowDoneSteps: number;    // from [STEP_DONE:N]
  flowSteps: FlowStepState[];  // full step details for DB persistence
  textBuffer: string;       // accumulated text for flow plan parsing
}

/**
 * Detects progress signals from agent output in real-time.
 * Parses TodoWrite, file writes, and markers to estimate task completion.
 */
export class ProgressDetector {
  private state = new Map<string, ProgressState>();

  /**
   * Process a single agent output event.
   * Returns an AgentProgress snapshot if progress changed, null otherwise.
   */
  processOutput(agentId: string, output: AgentOutputEvent): AgentProgress | null {
    if (!this.state.has(agentId)) {
      this.state.set(agentId, {
        fileWrites: 0,
        toolUses: 0,
        completedTodos: 0,
        totalTodos: 0,
        currentPhase: 'starting',
        lastEmittedKey: '',
        flowTotalSteps: 0,
        flowDoneSteps: 0,
        flowSteps: [],
        textBuffer: '',
      });
    }

    const s = this.state.get(agentId)!;
    let changed = false;

    // Count tool uses
    if (output.streamType === 'tool_use') {
      s.toolUses++;

      const toolName = output.toolName || '';

      // File write/edit tools
      if (toolName === 'Write' || toolName === 'Edit') {
        s.fileWrites++;
        if (s.currentPhase === 'starting' || s.currentPhase === 'analyzing') {
          s.currentPhase = 'coding';
        }
        changed = true;
      }

      // TodoWrite tool — parse todos to get completion ratio
      if (toolName === 'TodoWrite' && output.toolInput) {
        const todos = output.toolInput['todos'] as Array<{ status?: string }> | undefined;
        if (Array.isArray(todos)) {
          s.totalTodos = todos.length;
          s.completedTodos = todos.filter(t => t.status === 'completed').length;
          const hasInProgress = todos.some(t => t.status === 'in_progress');
          if (hasInProgress) {
            s.currentPhase = 'coding';
          }
          changed = true;
        }
      }

      // Read/Grep/Glob → analyzing phase
      if (['Read', 'Grep', 'Glob'].includes(toolName) && s.currentPhase === 'starting') {
        s.currentPhase = 'analyzing';
        changed = true;
      }

      // Bash with test/build commands → testing phase
      if (toolName === 'Bash' && output.toolInput) {
        const cmd = String(output.toolInput['command'] || '');
        if (/\b(test|vitest|jest|npm run build|pnpm build|tsc)\b/i.test(cmd)) {
          s.currentPhase = 'testing';
          changed = true;
        }
      }
    }

    // Parse flow plan markers from text output
    // Text blocks arrive one per content_block_stop, so we accumulate and scan the buffer
    if (output.streamType === 'text') {
      s.textBuffer += output.content + '\n';

      // [FLOW_PLAN] ... N lines ... [/FLOW_PLAN] → parse steps
      // First plan initializes; subsequent plans APPEND to existing steps (e.g., bug fix after completion)
      {
        const flowPlanMatch = s.textBuffer.match(/\[FLOW_PLAN\]([\s\S]*?)\[\/FLOW_PLAN\]/);
        if (flowPlanMatch) {
          const lines = flowPlanMatch[1]!.split('\n').filter(l => /^\s*\d+[.)]\s/.test(l));
          if (lines.length > 0) {
            if (s.flowTotalSteps === 0) {
              // First flow plan — initialize
              s.flowSteps = lines.map(line => {
                const m = /^\s*(\d+)[.)]\s+(.+)/.exec(line.trim());
                return { n: parseInt(m![1]), label: m![2].trim(), status: 'pending' as const };
              });
              logger.info(`Flow plan detected for ${agentId}: ${lines.length} steps`);
            } else {
              // Subsequent flow plan — append with renumbered steps
              const nextN = s.flowSteps.length > 0 ? Math.max(...s.flowSteps.map(st => st.n)) + 1 : 1;
              const newSteps = lines.map((line, i) => {
                const m = /^\s*\d+[.)]\s+(.+)/.exec(line.trim());
                return { n: nextN + i, label: m![1].trim(), status: 'pending' as const };
              });
              s.flowSteps = [...s.flowSteps, ...newSteps];
              logger.info(`Flow plan appended for ${agentId}: +${lines.length} steps (total ${s.flowSteps.length})`);
            }
            s.flowTotalSteps = s.flowSteps.length;
            s.flowDoneSteps = s.flowSteps.filter(st => st.status === 'done').length;
            // Clear textBuffer so the same [FLOW_PLAN] block isn't re-matched
            s.textBuffer = s.textBuffer.slice(flowPlanMatch.index! + flowPlanMatch[0].length);
            changed = true;
          }
        }
      }

      // [STEP:N] → update currentPhase and mark step active (previous ones done)
      const stepActiveMatch = output.content.match(/\[STEP:(\d+)\]/);
      if (stepActiveMatch && s.flowTotalSteps > 0) {
        const n = parseInt(stepActiveMatch[1]);
        s.currentPhase = `step ${n}/${s.flowTotalSteps}`;
        for (const step of s.flowSteps) {
          if (step.n === n) step.status = 'active';
          else if (step.n < n) step.status = 'done';
        }
        changed = true;
      }

      // [STEP_DONE:N] → increment done count and mark step done
      const stepDoneMatches = [...output.content.matchAll(/\[STEP_DONE:(\d+)\]/g)];
      if (stepDoneMatches.length > 0) {
        for (const m of stepDoneMatches) {
          const n = parseInt(m[1]);
          const step = s.flowSteps.find(st => st.n === n);
          if (step) step.status = 'done';
        }
        s.flowDoneSteps = s.flowSteps.filter(st => st.status === 'done').length;
        changed = true;
      }

      // [TASK_COMPLETE] marker — mark all steps done
      if (output.content.includes('[TASK_COMPLETE]')) {
        s.currentPhase = 'completed';
        for (const step of s.flowSteps) step.status = 'done';
        changed = true;
      }
    }

    if (!changed) return null;

    // Compute percentage
    const percentage = this.computePercentage(s);
    const key = `${s.currentPhase}-${percentage}-${s.fileWrites}-${s.completedTodos}`;
    if (key === s.lastEmittedKey) return null;
    s.lastEmittedKey = key;

    return {
      agentId,
      completedSteps: s.flowTotalSteps > 0 ? s.flowDoneSteps : s.completedTodos,
      totalSteps: s.flowTotalSteps > 0 ? s.flowTotalSteps : s.totalTodos,
      currentPhase: s.currentPhase,
      fileWrites: s.fileWrites,
      toolUses: s.toolUses,
      percentage,
    };
  }

  /**
   * Check if the agent's flow plan is fully completed (all steps done).
   * Returns true if no flow plan exists (no steps to track) or all steps are done.
   */
  isFlowComplete(agentId: string): boolean {
    const s = this.state.get(agentId);
    if (!s || s.flowTotalSteps === 0) return true; // no flow plan → treat as complete
    return s.flowDoneSteps >= s.flowTotalSteps;
  }

  /**
   * Get the flow plan state as a JSON-serializable object for DB persistence.
   * Returns null if no flow plan exists.
   */
  getFlowPlanJson(agentId: string): string | null {
    const s = this.state.get(agentId);
    if (!s || s.flowTotalSteps === 0) return null;
    return JSON.stringify({
      steps: s.flowSteps,
    });
  }

  /**
   * Restore flow plan state from DB JSON (e.g., after server restart).
   */
  restoreFlowPlan(agentId: string, json: string): void {
    try {
      const data = JSON.parse(json) as { steps: FlowStepState[] };
      if (!data.steps || data.steps.length === 0) return;
      const s = this.state.get(agentId) || {
        fileWrites: 0, toolUses: 0, completedTodos: 0, totalTodos: 0,
        currentPhase: 'starting', lastEmittedKey: '', flowTotalSteps: 0,
        flowDoneSteps: 0, flowSteps: [], textBuffer: '',
      };
      s.flowSteps = data.steps;
      s.flowTotalSteps = data.steps.length;
      s.flowDoneSteps = data.steps.filter(st => st.status === 'done').length;
      // Derive currentPhase from step statuses
      const activeStep = data.steps.find(st => st.status === 'active');
      if (s.flowDoneSteps >= s.flowTotalSteps) {
        s.currentPhase = 'completed';
      } else if (activeStep) {
        s.currentPhase = `step ${activeStep.n}/${s.flowTotalSteps}`;
      }
      this.state.set(agentId, s);
      logger.info(`Restored flow plan for ${agentId}: ${s.flowDoneSteps}/${s.flowTotalSteps}`);
    } catch (err) {
      logger.warn({ agentId, err }, 'Failed to restore flow plan from JSON');
    }
  }

  /**
   * Get a human-readable summary of the flow plan progress.
   * Used to prepend to resume prompts so the agent knows where it left off.
   */
  getFlowPlanSummary(agentId: string): string | null {
    const s = this.state.get(agentId);
    if (!s || s.flowTotalSteps === 0) return null;

    const lines: string[] = [];
    lines.push(`[執行流程進度 ${s.flowDoneSteps}/${s.flowTotalSteps}]`);
    for (const step of s.flowSteps) {
      const icon = step.status === 'done' ? '✅' : step.status === 'active' ? '🔄' : '⬜';
      lines.push(`${icon} ${step.n}. ${step.label} (${step.status})`);
    }
    return lines.join('\n');
  }

  /**
   * Clear state for an agent (e.g., on completion or restart).
   */
  clear(agentId: string): void {
    this.state.delete(agentId);
  }

  private computePercentage(s: ProgressState): number {
    // Prefer flow plan progress (from [FLOW_PLAN] / [STEP_DONE:N] markers)
    if (s.flowTotalSteps > 0) {
      return Math.round((s.flowDoneSteps / s.flowTotalSteps) * 100);
    }

    // If we have todos, use completion ratio
    if (s.totalTodos > 0) {
      return Math.round((s.completedTodos / s.totalTodos) * 100);
    }

    // Phase-based estimate
    switch (s.currentPhase) {
      case 'starting': return 5;
      case 'analyzing': return 15;
      case 'coding': return Math.min(70, 30 + s.fileWrites * 5);
      case 'testing': return 85;
      case 'completed': return 100;
      default: return 0;
    }
  }
}
