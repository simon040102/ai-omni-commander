import { useProjectStore } from '../../stores/projectStore';
import { useAgentStore } from '../../stores/agentStore';
import type { Project, Task, Agent, DependencyEdge } from '../../stores/projectStore';
import type { HandlerMap } from './types';

/**
 * project.* / projects.* WS message handlers.
 */
export const projectHandlers: HandlerMap = {
  'projects.list': (payload, { client }) => {
    const incomingProjects = payload['projects'] as Project[];
    useProjectStore.getState().setProjects(incomingProjects);
    // Restore previously selected project after page refresh
    const savedId = useProjectStore.getState().currentProjectId;
    if (savedId && incomingProjects.some(p => p.id === savedId)) {
      client.send({ type: 'project.getState', payload: { projectId: savedId } });
    }
  },

  'project.state': (payload) => {
    // Clear all cached outputs on reconnect — fresh outputs will be loaded via project.agentOutputs
    useAgentStore.getState().clearAll();
    useProjectStore.getState().setProjectState(payload as unknown as {
      project: Project;
      tasks: Task[];
      agents: Agent[];
      dependencies: DependencyEdge[];
    });
  },

  'project.documents': (payload) => {
    const docProjectId = payload['projectId'] as string;
    const documents = payload['documents'] as Array<{
      id: string;
      filename: string;
      docType: 'SA' | 'SD';
    }>;
    useProjectStore.getState().setDocuments(docProjectId, documents);
  },

  // Server cleared all documents for a project (project.clearDocuments) — clear the store too
  'project.documentsCleared': (payload) => {
    const clearedProjectId = payload['projectId'] as string;
    if (clearedProjectId) {
      useProjectStore.getState().setDocuments(clearedProjectId, []);
    }
  },

  'project.agentOutputs': (payload) => {
    // Bulk load historical outputs for an agent (from DB)
    const bulkAgentId = payload['agentId'] as string;
    const bulkOutputs = payload['outputs'] as Array<{ streamType: string; content: string; timestamp: string }>;
    if (bulkAgentId && bulkOutputs) {
      useAgentStore.getState().setOutputsBulk(bulkAgentId, bulkOutputs.map(o => ({
        streamType: o.streamType as 'text',
        content: o.content,
        timestamp: o.timestamp,
      })));
    }
  },

  // Project note saved/archived (MCP or REST) — notify listening panels (ProjectNotesPanel)
  'project.noteSaved': (payload) => {
    window.dispatchEvent(new CustomEvent('omni:project-note', { detail: payload }));
  },
};
