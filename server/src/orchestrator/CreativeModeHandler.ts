import type { AgentManager } from '../agent/AgentManager.js';
import type { TaskDispatcher } from './TaskDispatcher.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { getAgentRoleConfig } from '../agent/AgentRoles.js';
import { updateProject, getProject } from '../db/queries/projects.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('CreativeModeHandler');

export interface InterviewCallback {
  (type: 'question' | 'specDraft', data: Record<string, unknown>): void;
}

/**
 * Handles the Creative Mode workflow:
 * 1. Start interview with Architect agent
 * 2. Relay user responses back and forth
 * 3. Generate SA/SD documents
 * 4. On confirmation, transition to SpecMode execution
 */
export class CreativeModeHandler {
  private architectAgentId: string | null = null;
  private interviewCallback: InterviewCallback | null = null;
  private specDraft: { sa: string; sd: string } | null = null;
  private unsubscribeOutput: (() => void) | null = null;

  constructor(
    private agentManager: AgentManager,
    private dispatcher: TaskDispatcher,
    private contextSync: ContextSync,
    private eventBus: EventBus,
  ) {}

  /** Set the callback for interview events (questions and spec drafts) */
  onInterview(callback: InterviewCallback): void {
    this.interviewCallback = callback;
  }

  /** Start the interview process with an initial requirement */
  async startInterview(projectId: string, requirement: string): Promise<void> {
    const project = getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);

    updateProject(projectId, { status: 'planning' });

    const roleConfig = getAgentRoleConfig('architect');

    const initialPrompt = `A user has a new project idea. Here is their initial requirement:

"${requirement}"

Start by asking clarifying questions ONE AT A TIME to understand:
1. What exactly they want to build
2. Who are the target users
3. What are the key features (prioritized)
4. Any technical preferences or constraints
5. Integration requirements

Ask your first question now.`;

    // Use AgentManager so the agent correctly routes to PTY or SDK backend
    const agentId = await this.agentManager.startAgent({
      projectId,
      role: 'architect',
      prompt: initialPrompt,
      model: roleConfig.model,
    });

    this.architectAgentId = agentId;

    // Listen for output events via EventBus to detect questions and spec drafts
    let accumulatedText = '';
    this.unsubscribeOutput = this.eventBus.on('agent.output', (event) => {
      if (event.source !== agentId) return;
      const payload = event.payload as { streamType?: string; content?: string };
      if (payload.streamType === 'text' && payload.content) {
        accumulatedText += payload.content;

        if (payload.content.includes('?')) {
          this.interviewCallback?.('question', {
            projectId,
            question: accumulatedText.trim(),
          });
          accumulatedText = '';
        }

        if (payload.content.includes('[SPEC_READY]')) {
          this.specDraft = this.extractSpecDraft(accumulatedText);
          this.interviewCallback?.('specDraft', {
            projectId,
            saDocument: this.specDraft.sa,
            sdDocument: this.specDraft.sd,
          });
          accumulatedText = '';
        }
      }
    });

    logger.info({ projectId, agentId }, 'Creative mode interview started');
  }

  /** Send a user's response to the architect agent */
  handleUserResponse(projectId: string, message: string): void {
    if (!this.architectAgentId) {
      logger.warn({ projectId }, 'No architect agent to send response to');
      return;
    }
    this.agentManager.sendInputToAgent(this.architectAgentId, message);
  }

  /** Handle spec confirmation or modification request */
  async handleSpecConfirmation(
    projectId: string,
    confirmed: boolean,
    modifications?: string,
  ): Promise<void> {
    if (confirmed && this.specDraft) {
      updateProject(projectId, { status: 'planning' });

      await this.stop();

      await this.contextSync.init();

      const planPrompt = `You have the following SA/SD documents. Parse them and produce a structured task plan.

## System Analysis (SA)
${this.specDraft.sa}

## System Design (SD)
${this.specDraft.sd}

OUTPUT: Respond with ONLY a valid JSON object with this schema:
{
  "tasks": [{ "title": "...", "description": "...", "label": "backend|frontend|devops|testing", "prompt": "...", "dependencies": ["..."], "priority": 0 }],
  "apiContracts": [{ "entity": "...", "basePath": "/api/...", "endpoints": [...], "updatedAt": "${new Date().toISOString()}", "updatedBy": "master" }],
  "dbSchema": { "entities": [...], "updatedAt": "${new Date().toISOString()}", "updatedBy": "master" }
}`;

      await this.agentManager.startAgent({
        projectId,
        role: 'master',
        prompt: planPrompt,
        model: 'opus',
      });

      logger.info({ projectId }, 'Transitioning from creative mode to task planning');
    } else if (modifications) {
      if (this.architectAgentId) {
        this.agentManager.sendInputToAgent(
          this.architectAgentId,
          `The user wants modifications to the spec:\n${modifications}\n\nPlease update the SA/SD documents accordingly and present the updated version. End with [SPEC_READY] when done.`,
        );
      }
    }
  }

  /** Stop the interview process */
  async stop(): Promise<void> {
    if (this.unsubscribeOutput) {
      this.unsubscribeOutput();
      this.unsubscribeOutput = null;
    }
    if (this.architectAgentId) {
      await this.agentManager.stopAgent(this.architectAgentId);
      this.architectAgentId = null;
    }
  }

  private extractSpecDraft(text: string): { sa: string; sd: string } {
    let sa = '';
    let sd = '';

    const saMatch = text.match(/(?:##?\s*(?:System Analysis|SA)[\s\S]*?)(?=##?\s*(?:System Design|SD)|$)/i);
    const sdMatch = text.match(/(?:##?\s*(?:System Design|SD)[\s\S]*?)(?=\[SPEC_READY\]|$)/i);

    sa = saMatch ? saMatch[0].trim() : text;
    sd = sdMatch ? sdMatch[0].trim() : '';

    return { sa, sd };
  }
}
