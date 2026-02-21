import { create } from 'zustand';

export interface Project {
  id: string;
  name: string;
  mode: 'spec' | 'creative';
  status: string;
  workingDir: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  label: string;
  status: string;
  assignedAgentId: string | null;
  priority: number;
  retryCount: number;
  createdAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  role: string;
  status: string;
  currentTaskId: string | null;
  model: string;
  totalCostUsd: number;
  totalTurns: number;
}

export interface DependencyEdge {
  taskId: string;
  dependsOnId: string;
}

export interface Intervention {
  id: string;
  agentId: string;
  agentRole: string;
  taskId: string | null;
  reason: string;
  context: string;
  status: 'pending' | 'resolved';
}

interface ProjectState {
  projects: Project[];
  currentProjectId: string | null;
  tasks: Task[];
  agents: Agent[];
  dependencies: DependencyEdge[];
  interventions: Intervention[];

  setProjects: (projects: Project[]) => void;
  setCurrentProject: (id: string | null) => void;
  setProjectState: (data: {
    project: Project;
    tasks: Task[];
    agents: Agent[];
    dependencies: DependencyEdge[];
  }) => void;
  updateTaskStatus: (taskId: string, status: string, agentId?: string) => void;
  updateAgentStatus: (agentId: string, status: string) => void;
  addOrUpdateAgent: (agent: Agent) => void;
  addIntervention: (intervention: Intervention) => void;
  resolveIntervention: (id: string) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProjectId: null,
  tasks: [],
  agents: [],
  dependencies: [],
  interventions: [],

  setProjects: (projects) => set((state) => {
    // If current project was deleted, clear selection
    if (state.currentProjectId && !projects.some(p => p.id === state.currentProjectId)) {
      return { projects, currentProjectId: null, tasks: [], agents: [], dependencies: [], interventions: [] };
    }
    return { projects };
  }),
  setCurrentProject: (id) => set({ currentProjectId: id }),

  setProjectState: (data) => set((state) => ({
    currentProjectId: data.project.id,
    projects: [
      ...state.projects.filter(p => p.id !== data.project.id),
      data.project,
    ],
    tasks: data.tasks,
    agents: data.agents,
    dependencies: data.dependencies,
    // Clear old interventions when loading fresh project state
    interventions: [],
  })),

  updateTaskStatus: (taskId, status, agentId) => set((state) => ({
    tasks: state.tasks.map(t =>
      t.id === taskId ? { ...t, status, assignedAgentId: agentId ?? t.assignedAgentId } : t
    ),
  })),

  updateAgentStatus: (agentId, status) => set((state) => {
    // If status is 'deleted', remove the agent from the store
    if (status === 'deleted') {
      return { agents: state.agents.filter(a => a.id !== agentId) };
    }
    const exists = state.agents.some(a => a.id === agentId);
    if (exists) {
      return { agents: state.agents.map(a => a.id === agentId ? { ...a, status } : a) };
    }
    // Agent not in store yet — ignore (will be added by addOrUpdateAgent)
    return {};
  }),

  addOrUpdateAgent: (agent) => set((state) => {
    const exists = state.agents.some(a => a.id === agent.id);
    if (exists) {
      return { agents: state.agents.map(a => a.id === agent.id ? { ...a, ...agent } : a) };
    }
    return {
      agents: [...state.agents, agent],
      // Auto-select project if none selected
      currentProjectId: state.currentProjectId || agent.projectId,
    };
  }),

  addIntervention: (intervention) => set((state) => ({
    interventions: [...state.interventions, intervention],
  })),

  resolveIntervention: (id) => set((state) => ({
    interventions: state.interventions.map(i =>
      i.id === id ? { ...i, status: 'resolved' as const } : i
    ),
  })),
}));
