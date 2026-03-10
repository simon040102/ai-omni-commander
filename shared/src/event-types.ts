export interface BusEvent {
  type: string;
  source?: string;
  target?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export const EventTypes = {
  AGENT_STARTED: 'agent.started',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_ERROR: 'agent.error',
  AGENT_OUTPUT: 'agent.output',
  AGENT_STOPPED: 'agent.stopped',
  AGENT_PAUSED: 'agent.paused',
  AGENT_PLAN_READY: 'agent.planReady',

  TASK_STATUS_CHANGED: 'task.statusChanged',
  TASK_DISPATCHED: 'task.dispatched',
  TASK_COMPLETED: 'task.completed',

  CONTRACT_UPDATED: 'contract.updated',
  CONTRACT_ENTITY_CHANGED: 'contract.entityChanged',

  REVIEW_REQUESTED: 'review.requested',
  REVIEW_COMPLETED: 'review.completed',

  TEST_TRIGGERED: 'test.triggered',
  TEST_COMPLETED: 'test.completed',

  INTERVENTION_NEEDED: 'intervention.needed',
  INTERVENTION_RESOLVED: 'intervention.resolved',

  PROJECT_PHASE_CHANGED: 'project.phaseChanged',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
