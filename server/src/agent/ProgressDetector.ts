import type { AgentOutputEvent, AgentProgress } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ProgressDetector');

interface ProgressState {
  fileWrites: number;
  toolUses: number;
  completedTodos: number;
  totalTodos: number;
  currentPhase: string;
  lastEmittedKey: string; // dedup
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

    // Check for [TASK_COMPLETE] marker in text
    if (output.streamType === 'text' && output.content.includes('[TASK_COMPLETE]')) {
      s.currentPhase = 'completed';
      changed = true;
    }

    if (!changed) return null;

    // Compute percentage
    const percentage = this.computePercentage(s);
    const key = `${s.currentPhase}-${percentage}-${s.fileWrites}-${s.completedTodos}`;
    if (key === s.lastEmittedKey) return null;
    s.lastEmittedKey = key;

    return {
      agentId,
      completedSteps: s.completedTodos,
      totalSteps: s.totalTodos,
      currentPhase: s.currentPhase,
      fileWrites: s.fileWrites,
      toolUses: s.toolUses,
      percentage,
    };
  }

  /**
   * Clear state for an agent (e.g., on completion or restart).
   */
  clear(agentId: string): void {
    this.state.delete(agentId);
  }

  private computePercentage(s: ProgressState): number {
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
