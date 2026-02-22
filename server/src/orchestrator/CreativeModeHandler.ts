import type { AgentManager } from '../agent/AgentManager.js';
import type { TaskDispatcher } from './TaskDispatcher.js';
import type { ContextSync } from '../eventbus/ContextSync.js';
import type { EventBus } from '../eventbus/EventBus.js';
import { AgentProcess } from '../agent/AgentProcess.js';
import { getAgentRoleConfig } from '../agent/AgentRoles.js';
import { updateProject, getProject } from '../db/queries/projects.js';
import { getConfig } from '../config.js';
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
  private architectProcess: AgentProcess | null = null;
  private interviewCallback: InterviewCallback | null = null;
  private specDraft: { sa: string; sd: string } | null = null;

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

    updateProject(projectId, { status: 'interviewing' });

    const config = getConfig();
    const roleConfig = getAgentRoleConfig('architect');

    this.architectProcess = new AgentProcess(
      `architect-${projectId}`,
      'architect',
      {
        workingDir: project.workingDir || config.projectRoot,
        systemPrompt: roleConfig.systemPrompt,
        model: roleConfig.model,
        allowedTools: roleConfig.allowedTools,
      },
    );

    // Listen for output to detect questions and spec drafts
    let accumulatedText = '';
    this.architectProcess.on('output', (output: { streamType: string; content: string }) => {
      if (output.streamType === 'text') {
        accumulatedText += output.content;

        // Check if this is a question (ends with ?)
        if (output.content.includes('?')) {
          this.interviewCallback?.('question', {
            projectId,
            question: accumulatedText.trim(),
          });
          accumulatedText = '';
        }

        // Check for spec ready marker
        if (output.content.includes('[SPEC_READY]')) {
          this.specDraft = this.extractSpecDraft(accumulatedText);
          this.interviewCallback?.('specDraft', {
            projectId,
            saDocument: this.specDraft.sa,
            sdDocument: this.specDraft.sd,
          });
          accumulatedText = '';
        }
      }

      // Forward to event bus for WebSocket broadcast
      this.eventBus.emit({
        type: 'agent.output',
        source: `architect-${projectId}`,
        payload: output as unknown as Record<string, unknown>,
        timestamp: new Date().toISOString(),
      });
    });

    this.architectProcess.on('result', () => {
      logger.info({ projectId }, 'Architect agent completed');
    });

    // Start with the user's requirement
    const initialPrompt = `A user has a new project idea. Here is their initial requirement:

"${requirement}"

Start by asking clarifying questions ONE AT A TIME to understand:
1. What exactly they want to build
2. Who are the target users
3. What are the key features (prioritized)
4. Any technical preferences or constraints
5. Integration requirements

Ask your first question now.`;

    await this.architectProcess.spawn(initialPrompt);
    logger.info({ projectId }, 'Creative mode interview started');
  }

  /** Send a user's response to the architect agent */
  handleUserResponse(projectId: string, message: string): void {
    if (!this.architectProcess) {
      logger.warn({ projectId }, 'No architect process to send response to');
      return;
    }
    this.architectProcess.sendInput(message);
  }

  /** Handle spec confirmation or modification request */
  async handleSpecConfirmation(
    projectId: string,
    confirmed: boolean,
    modifications?: string,
  ): Promise<void> {
    if (confirmed && this.specDraft) {
      // Transition to planning phase
      updateProject(projectId, { status: 'planning' });

      // Stop the architect process
      if (this.architectProcess) {
        await this.architectProcess.stop();
        this.architectProcess = null;
      }

      // Use the spec draft as input for the task planning phase
      // Similar to SpecMode: spawn Master agent to create task plan from the generated specs
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
      // Send modifications back to architect
      this.architectProcess?.sendInput(
        `The user wants modifications to the spec:\n${modifications}\n\nPlease update the SA/SD documents accordingly and present the updated version. End with [SPEC_READY] when done.`,
      );
    }
  }

  /** Stop the interview process */
  async stop(): Promise<void> {
    if (this.architectProcess) {
      await this.architectProcess.stop();
      this.architectProcess = null;
    }
  }

  private extractSpecDraft(text: string): { sa: string; sd: string } {
    // Try to find SA and SD sections in the text
    let sa = '';
    let sd = '';

    const saMatch = text.match(/(?:##?\s*(?:System Analysis|SA)[\s\S]*?)(?=##?\s*(?:System Design|SD)|$)/i);
    const sdMatch = text.match(/(?:##?\s*(?:System Design|SD)[\s\S]*?)(?=\[SPEC_READY\]|$)/i);

    sa = saMatch ? saMatch[0].trim() : text;
    sd = sdMatch ? sdMatch[0].trim() : '';

    return { sa, sd };
  }
}
