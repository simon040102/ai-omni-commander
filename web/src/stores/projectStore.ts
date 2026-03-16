import { create } from 'zustand';

export interface Project {
  id: string;
  name: string;
  mode: 'spec' | 'creative';
  status: string;
  workingDir: string;
  configJson: string | null;
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
  totalInputTokens?: number;
  totalOutputTokens?: number;
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

export interface DocumentInfo {
  id: string;
  filename: string;
  docType: 'SA' | 'SD';
}

export interface AgentPlan {
  id: string;
  agentId: string;
  projectId: string;
  content: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  approvedAt?: string;
}

interface ProjectState {
  projects: Project[];
  currentProjectId: string | null;
  tasks: Task[];
  agents: Agent[];
  dependencies: DependencyEdge[];
  interventions: Intervention[];
  documents: DocumentInfo[];
  plans: AgentPlan[];
  /** Projects that have new activity since last viewed */
  projectsWithActivity: Set<string>;

  setProjects: (projects: Project[]) => void;
  setCurrentProject: (id: string | null) => void;
  setProjectState: (data: {
    project: Project;
    tasks: Task[];
    agents: Agent[];
    dependencies: DependencyEdge[];
  }, switchTo?: boolean) => void;
  setDocuments: (projectId: string, documents: DocumentInfo[]) => void;
  setPlans: (projectId: string, plans: AgentPlan[]) => void;
  addPlan: (plan: AgentPlan) => void;
  updateTaskStatus: (taskId: string, status: string, agentId?: string) => void;
  updateAgentStatus: (agentId: string, status: string) => void;
  addOrUpdateAgent: (agent: Agent) => void;
  addIntervention: (intervention: Intervention) => void;
  resolveIntervention: (id: string) => void;
  markProjectActivity: (projectId: string) => void;
  clearProjectActivity: (projectId: string) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  currentProjectId: null,
  tasks: [],
  agents: [],
  dependencies: [],
  interventions: [],
  documents: [],
  plans: [],
  projectsWithActivity: new Set<string>(),

  setProjects: (projects) => set((state) => {
    // If current project was deleted, clear selection
    if (state.currentProjectId && !projects.some(p => p.id === state.currentProjectId)) {
      return { projects, currentProjectId: null, tasks: [], agents: [], dependencies: [], interventions: [] };
    }
    return { projects };
  }),

  setCurrentProject: (id) => set((state) => {
    // Clear activity indicator when switching to a project
    const newActivity = new Set(state.projectsWithActivity);
    if (id) newActivity.delete(id);
    // Clear project-scoped state when switching projects
    return { currentProjectId: id, projectsWithActivity: newActivity, documents: [], plans: [] };
  }),

  setProjectState: (data, switchTo = false) => set((state) => {
    const isCurrentProject = state.currentProjectId === data.project.id;
    const shouldSwitch = switchTo || !state.currentProjectId;

    // If this is for the current project or we should switch, update all state
    if (isCurrentProject || shouldSwitch) {
      // Merge agents: use server data as base, but preserve any running agents
      // already in the store that might not be in the server snapshot yet (race condition)
      const serverAgentIds = new Set(data.agents.map(a => a.id));
      const preservedAgents = state.agents.filter(
        a => a.projectId === data.project.id && !serverAgentIds.has(a.id)
      );
      return {
        currentProjectId: shouldSwitch ? data.project.id : state.currentProjectId,
        projects: [
          ...state.projects.filter(p => p.id !== data.project.id),
          data.project,
        ],
        tasks: data.tasks,
        agents: [...data.agents, ...preservedAgents],
        dependencies: data.dependencies,
        interventions: [],
        documents: [], // Clear documents, will be populated by project.documents message
        plans: [], // Clear plans, will be populated by agent.plans message
      };
    }

    // Otherwise, just update the project in the list (don't switch)
    return {
      projects: [
        ...state.projects.filter(p => p.id !== data.project.id),
        data.project,
      ],
    };
  }),

  setDocuments: (projectId, documents) => set((state) => {
    // Only update if this is for the current project
    if (state.currentProjectId === projectId) {
      return { documents };
    }
    return {};
  }),

  setPlans: (projectId, plans) => set((state) => {
    // Only update if this is for the current project
    if (state.currentProjectId === projectId) {
      return { plans };
    }
    return {};
  }),

  addPlan: (plan) => set((state) => {
    // Only add if this is for the current project
    if (state.currentProjectId === plan.projectId) {
      // Replace existing plan for this agent if any, or add new
      const existing = state.plans.find(p => p.agentId === plan.agentId);
      if (existing) {
        return { plans: state.plans.map(p => p.agentId === plan.agentId ? plan : p) };
      }
      return { plans: [...state.plans, plan] };
    }
    return {};
  }),

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
      // Filter out undefined values to avoid overwriting existing fields (e.g. role, model on completion)
      const filtered = Object.fromEntries(
        Object.entries(agent).filter(([, v]) => v !== undefined)
      );
      return { agents: state.agents.map(a => a.id === agent.id ? { ...a, ...filtered } : a) };
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

  markProjectActivity: (projectId) => set((state) => {
    // Don't mark activity for the currently viewed project
    if (state.currentProjectId === projectId) return {};
    const newActivity = new Set(state.projectsWithActivity);
    newActivity.add(projectId);
    return { projectsWithActivity: newActivity };
  }),

  clearProjectActivity: (projectId) => set((state) => {
    const newActivity = new Set(state.projectsWithActivity);
    newActivity.delete(projectId);
    return { projectsWithActivity: newActivity };
  }),
}));
