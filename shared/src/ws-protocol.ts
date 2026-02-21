import type { Agent, AgentStatus, AgentOutputEvent } from './agent-types.js';
import type { Task, TaskStatus, DependencyEdge, TaskSummary } from './task-types.js';
import type { Project, Workspace, DocType } from './project-types.js';

// Base envelope for all WebSocket messages
export interface WsMessage {
  type: string;
  id: string;
  timestamp: string;
}

// ============================================
// CLIENT -> SERVER messages
// ============================================

export interface ReviewConfig {
  enabled: boolean;
  skillSource: string; // "auto" or a workspace label
}

export interface WsCreateProject extends WsMessage {
  type: 'project.create';
  payload: {
    projectId?: string;
    name: string;
    mode: 'spec' | 'creative';
    workingDir: string;
    workspaces: Workspace[];
    reviewConfig?: ReviewConfig;
  };
}

export interface WsUploadDocument extends WsMessage {
  type: 'project.uploadDocument';
  payload: {
    projectId: string;
    filename: string;
    content: string; // Base64 encoded
    fileType: string;
    docType?: DocType;
  };
}

export interface WsStartExecution extends WsMessage {
  type: 'project.startExecution';
  payload: {
    projectId: string;
    requirement?: string;
  };
}

export interface WsPauseExecution extends WsMessage {
  type: 'project.pause';
  payload: { projectId: string };
}

export interface WsResumeExecution extends WsMessage {
  type: 'project.resume';
  payload: { projectId: string };
}

export interface WsInterviewResponse extends WsMessage {
  type: 'interview.userResponse';
  payload: {
    projectId: string;
    message: string;
  };
}

export interface WsInterviewConfirm extends WsMessage {
  type: 'interview.confirmSpec';
  payload: {
    projectId: string;
    confirmed: boolean;
    modifications?: string;
  };
}

export interface WsAgentAction extends WsMessage {
  type: 'agent.action';
  payload: {
    agentId: string;
    action: 'stop' | 'restart' | 'pause';
  };
}

export interface WsAgentCommand extends WsMessage {
  type: 'agent.command';
  payload: {
    agentId: string;
    command: string;
  };
}

export interface WsInterventionResolve extends WsMessage {
  type: 'intervention.resolve';
  payload: {
    interventionId: string;
    decision: 'approve' | 'reject' | 'modify';
    userInput?: string;
  };
}

export interface WsTaskOverride extends WsMessage {
  type: 'task.override';
  payload: {
    taskId: string;
    action: 'retry' | 'skip' | 'reassign';
    newAgentRole?: string;
  };
}

export interface WsDeleteProject extends WsMessage {
  type: 'project.delete';
  payload: {
    projectId: string;
  };
}

export interface WsUpdateProject extends WsMessage {
  type: 'project.update';
  payload: {
    projectId: string;
    name?: string;
    workspaces?: Workspace[];
  };
}

export interface WsDeleteAgent extends WsMessage {
  type: 'agent.delete';
  payload: {
    agentId: string;
  };
}

export interface WsAddAgent extends WsMessage {
  type: 'agent.add';
  payload: {
    projectId: string;
    role: string;
    prompt: string;
    model?: string;
  };
}

export type ClientMessage =
  | WsCreateProject
  | WsUploadDocument
  | WsStartExecution
  | WsPauseExecution
  | WsResumeExecution
  | WsInterviewResponse
  | WsInterviewConfirm
  | WsAgentAction
  | WsAgentCommand
  | WsInterventionResolve
  | WsTaskOverride
  | WsDeleteProject
  | WsUpdateProject
  | WsDeleteAgent
  | WsAddAgent;

// ============================================
// SERVER -> CLIENT messages
// ============================================

export interface WsProjectState extends WsMessage {
  type: 'project.state';
  payload: {
    project: Project;
    tasks: Task[];
    agents: Agent[];
    dependencies: DependencyEdge[];
  };
}

export interface WsProjectsList extends WsMessage {
  type: 'projects.list';
  payload: {
    projects: Project[];
  };
}

export interface WsAgentOutput extends WsMessage {
  type: 'agent.output';
  payload: AgentOutputEvent;
}

export interface WsAgentStatusChange extends WsMessage {
  type: 'agent.statusChange';
  payload: {
    agentId: string;
    previousStatus: AgentStatus;
    newStatus: AgentStatus;
    reason?: string;
  };
}

export interface WsTaskStatusChange extends WsMessage {
  type: 'task.statusChange';
  payload: {
    taskId: string;
    previousStatus: TaskStatus;
    newStatus: TaskStatus;
    assignedAgentId?: string;
  };
}

export interface WsEventBusNotification extends WsMessage {
  type: 'eventbus.notification';
  payload: {
    eventType: string;
    source: string;
    target: string;
    data: Record<string, unknown>;
  };
}

export interface WsInterventionRequest extends WsMessage {
  type: 'intervention.request';
  payload: {
    interventionId: string;
    agentId: string;
    agentRole: string;
    taskId: string | null;
    reason: string;
    context: string;
    suggestedActions: string[];
  };
}

export interface WsInterviewQuestion extends WsMessage {
  type: 'interview.question';
  payload: {
    projectId: string;
    question: string;
    questionIndex: number;
    totalEstimated: number;
  };
}

export interface WsSpecDraft extends WsMessage {
  type: 'interview.specDraft';
  payload: {
    projectId: string;
    saDocument: string;
    sdDocument: string;
    extractedTasks: TaskSummary[];
  };
}

export interface WsError extends WsMessage {
  type: 'error';
  payload: {
    code: string;
    message: string;
    relatedEntity?: string;
  };
}

export type ServerMessage =
  | WsProjectState
  | WsProjectsList
  | WsAgentOutput
  | WsAgentStatusChange
  | WsTaskStatusChange
  | WsEventBusNotification
  | WsInterventionRequest
  | WsInterviewQuestion
  | WsSpecDraft
  | WsError;
