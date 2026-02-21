import type { TaskLabel, TaskPlan, TaskPlanItem, BusEvent } from '@omni/shared';
import { EventTypes } from '@omni/shared';
import { DependencyGraph } from './DependencyGraph.js';
import { createTask, updateTask, addDependency, getTask, getTasksByProject, getReadyTasks } from '../db/queries/tasks.js';
import type { EventBus } from '../eventbus/EventBus.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('TaskDispatcher');

export interface DispatchCallback {
  (taskId: string, role: TaskLabel, prompt: string): Promise<void>;
}

/**
 * Parses task plans, manages the dependency graph, and dispatches tasks to agents.
 */
export class TaskDispatcher {
  private graphs = new Map<string, DependencyGraph>();
  private dispatchCallback: DispatchCallback | null = null;

  constructor(
    private eventBus: EventBus,
    private contextSync: ContextSync,
  ) {
    // Listen for task completion to dispatch next tasks
    this.eventBus.on(EventTypes.TASK_COMPLETED, (e) => this.onTaskCompleted(e));

    // Listen for contract changes to notify frontend agents
    this.eventBus.on(EventTypes.CONTRACT_UPDATED, (e) => this.onContractUpdated(e));
  }

  /** Register the callback used to actually start an agent for a task */
  onDispatch(callback: DispatchCallback): void {
    this.dispatchCallback = callback;
  }

  /** Process a task plan (from Master agent or Spec parser) into the DB and dependency graph */
  async processTaskPlan(projectId: string, plan: TaskPlan): Promise<void> {
    const graph = new DependencyGraph();
    const titleToId = new Map<string, string>();

    // Phase 1: Create all task records
    for (const item of plan.tasks) {
      const task = createTask({
        projectId,
        title: item.title,
        description: item.description,
        label: item.label || this.autoLabel(item),
        prompt: item.prompt,
        priority: item.priority || 0,
      });
      titleToId.set(item.title, task.id);
      graph.addTask(task.id);
    }

    // Phase 2: Create dependency edges
    for (const item of plan.tasks) {
      const taskId = titleToId.get(item.title)!;
      for (const depTitle of item.dependencies) {
        const depId = titleToId.get(depTitle);
        if (depId) {
          addDependency(taskId, depId);
          graph.addTask(taskId, [depId]);
        } else {
          logger.warn({ task: item.title, dep: depTitle }, 'Dependency not found');
        }
      }
    }

    // Phase 3: Check for cycles
    const cycle = graph.detectCycles();
    if (cycle) {
      logger.error({ cycle }, 'Dependency cycle detected');
      throw new Error(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }

    this.graphs.set(projectId, graph);

    // Phase 4: Write contracts to .ai_context
    if (plan.apiContracts) {
      for (const contract of plan.apiContracts) {
        await this.contextSync.writeApiContract(contract);
      }
    }
    if (plan.dbSchema) {
      await this.contextSync.writeSchemaSnapshot(plan.dbSchema);
    }

    // Phase 5: Queue tasks with no dependencies (they're ready immediately)
    const completed = new Set<string>();
    const readyIds = graph.getReady(completed);
    for (const taskId of readyIds) {
      updateTask(taskId, { status: 'queued' });
    }

    // Mark tasks with unresolved deps as blocked
    for (const item of plan.tasks) {
      const taskId = titleToId.get(item.title)!;
      if (!readyIds.includes(taskId)) {
        updateTask(taskId, { status: 'blocked' });
      }
    }

    logger.info({ projectId, taskCount: plan.tasks.length, readyCount: readyIds.length }, 'Task plan processed');

    // Phase 6: Dispatch ready tasks
    await this.dispatchReadyTasks(projectId);
  }

  /** Dispatch all currently ready tasks for a project */
  async dispatchReadyTasks(projectId: string): Promise<void> {
    if (!this.dispatchCallback) {
      logger.warn('No dispatch callback registered');
      return;
    }

    const ready = getReadyTasks(projectId);
    for (const task of ready) {
      if (!task.prompt) {
        logger.warn({ taskId: task.id }, 'Task has no prompt, skipping');
        continue;
      }

      logger.info({ taskId: task.id, label: task.label, title: task.title }, 'Dispatching task');
      updateTask(task.id, { status: 'assigned' });

      await this.eventBus.emit({
        type: EventTypes.TASK_DISPATCHED,
        payload: { taskId: task.id, label: task.label, title: task.title },
        timestamp: new Date().toISOString(),
      });

      await this.dispatchCallback(task.id, task.label, task.prompt);
    }
  }

  /** Auto-label a task based on content analysis */
  autoLabel(item: TaskPlanItem): TaskLabel {
    const text = `${item.title} ${item.description}`.toLowerCase();
    if (text.match(/api|endpoint|route|database|model|migration|server|schema/))
      return 'backend';
    if (text.match(/component|page|ui|style|layout|form|button|view|css|html/))
      return 'frontend';
    if (text.match(/docker|deploy|ci|cd|pipeline|infra|kubernetes|nginx/))
      return 'devops';
    if (text.match(/test|spec|assert|coverage|e2e|integration/))
      return 'testing';
    return 'backend'; // default
  }

  private async onTaskCompleted(event: BusEvent): Promise<void> {
    const { taskId, projectId } = event.payload as { taskId: string; projectId: string };
    const graph = this.graphs.get(projectId as string);
    if (!graph) return;

    // Get all completed tasks for this project
    const allTasks = getTasksByProject(projectId as string);
    const completedIds = new Set(
      allTasks.filter(t => t.status === 'completed').map(t => t.id),
    );
    completedIds.add(taskId as string);

    // Find newly ready tasks
    const readyIds = graph.getReady(completedIds);
    for (const id of readyIds) {
      const task = getTask(id);
      if (task && task.status === 'blocked') {
        updateTask(id, { status: 'queued' });
      }
    }

    // Dispatch
    await this.dispatchReadyTasks(projectId as string);
  }

  private async onContractUpdated(event: BusEvent): Promise<void> {
    const { entity } = event.payload as { entity: string };
    logger.info({ entity }, 'Contract updated, will notify relevant agents');
    // The AgentManager will handle the actual notification to running agents
    // by listening to this same event
  }

  /** Get the dependency graph for a project */
  getGraph(projectId: string): DependencyGraph | undefined {
    return this.graphs.get(projectId);
  }
}
