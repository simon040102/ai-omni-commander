/**
 * Directed Acyclic Graph (DAG) for task dependency management.
 * Supports topological sort, cycle detection, and ready-task queries.
 */
export class DependencyGraph {
  // taskId -> set of taskIds it depends on
  private dependencies = new Map<string, Set<string>>();
  // taskId -> set of taskIds that depend on it (reverse edges)
  private dependents = new Map<string, Set<string>>();

  /** Add a task with its dependencies */
  addTask(taskId: string, dependsOn: string[] = []): void {
    if (!this.dependencies.has(taskId)) {
      this.dependencies.set(taskId, new Set());
    }
    if (!this.dependents.has(taskId)) {
      this.dependents.set(taskId, new Set());
    }

    for (const dep of dependsOn) {
      this.dependencies.get(taskId)!.add(dep);
      if (!this.dependents.has(dep)) {
        this.dependents.set(dep, new Set());
      }
      this.dependents.get(dep)!.add(taskId);
    }
  }

  /** Remove a task and all its edges */
  removeTask(taskId: string): void {
    // Remove from other tasks' dependency lists
    const deps = this.dependencies.get(taskId);
    if (deps) {
      for (const dep of deps) {
        this.dependents.get(dep)?.delete(taskId);
      }
    }

    // Remove from other tasks' dependent lists
    const dpts = this.dependents.get(taskId);
    if (dpts) {
      for (const dpt of dpts) {
        this.dependencies.get(dpt)?.delete(taskId);
      }
    }

    this.dependencies.delete(taskId);
    this.dependents.delete(taskId);
  }

  /** Get tasks with all dependencies in the completed set */
  getReady(completedIds: Set<string>): string[] {
    const ready: string[] = [];
    for (const [taskId, deps] of this.dependencies) {
      if (completedIds.has(taskId)) continue;
      let allSatisfied = true;
      for (const dep of deps) {
        if (!completedIds.has(dep)) {
          allSatisfied = false;
          break;
        }
      }
      if (allSatisfied) {
        ready.push(taskId);
      }
    }
    return ready;
  }

  /** Get all downstream tasks affected by a task's completion */
  getDownstream(taskId: string): string[] {
    return Array.from(this.dependents.get(taskId) || []);
  }

  /** Get all dependencies of a task */
  getDependencies(taskId: string): string[] {
    return Array.from(this.dependencies.get(taskId) || []);
  }

  /** Topological sort (Kahn's algorithm) */
  topologicalSort(): string[] {
    const inDegree = new Map<string, number>();
    for (const [taskId, deps] of this.dependencies) {
      if (!inDegree.has(taskId)) inDegree.set(taskId, 0);
      inDegree.set(taskId, deps.size);
      // Ensure all dependency nodes are in the map
      for (const dep of deps) {
        if (!inDegree.has(dep)) inDegree.set(dep, 0);
      }
    }

    const queue: string[] = [];
    for (const [taskId, degree] of inDegree) {
      if (degree === 0) queue.push(taskId);
    }

    const sorted: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);

      for (const dependent of this.dependents.get(current) || []) {
        const newDegree = (inDegree.get(dependent) || 0) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    return sorted;
  }

  /** Detect cycles. Returns the cycle path if found, null otherwise. */
  detectCycles(): string[] | null {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    for (const taskId of this.dependencies.keys()) {
      const cycle = this.dfs(taskId, visited, recursionStack, path);
      if (cycle) return cycle;
    }

    return null;
  }

  private dfs(
    node: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[],
  ): string[] | null {
    if (recursionStack.has(node)) {
      const cycleStart = path.indexOf(node);
      return [...path.slice(cycleStart), node];
    }
    if (visited.has(node)) return null;

    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    for (const dep of this.dependents.get(node) || []) {
      const cycle = this.dfs(dep, visited, recursionStack, path);
      if (cycle) return cycle;
    }

    path.pop();
    recursionStack.delete(node);
    return null;
  }

  /** Get all task IDs in the graph */
  getAllTasks(): string[] {
    return Array.from(this.dependencies.keys());
  }

  /** Get the total number of tasks */
  size(): number {
    return this.dependencies.size;
  }
}
