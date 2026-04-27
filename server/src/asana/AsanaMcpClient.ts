import type { Config } from '../config.js';
import type { AsanaTask, AsanaConnectionStatus, AsanaFetchTasksOptions } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('AsanaMcpClient');

const ASANA_API_BASE = 'https://app.asana.com/api/1.0';

/**
 * Client for communicating with the Asana API.
 * Uses direct REST API calls instead of MCP for better reliability.
 */
export class AsanaMcpClient {
  private config: Config;
  private _connected = false;

  constructor(config: Config) {
    this.config = config;
  }

  /** Check if Asana PAT is configured */
  isConfigured(): boolean {
    return !!this.config.asanaPat;
  }

  /** Check if client is connected to Asana API */
  isConnected(): boolean {
    return this._connected;
  }

  /** Test connection to Asana API */
  async connect(): Promise<void> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured. Please set the ASANA_PAT environment variable.');
    }

    logger.info('Testing Asana API connection...');

    try {
      // Test by fetching user info
      const response = await fetch(`${ASANA_API_BASE}/users/me`, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Asana API error: ${response.status} ${JSON.stringify(errorData)}`);
      }

      this._connected = true;
      const userData = await response.json();
      logger.info({ user: userData.data?.name }, 'Connected to Asana API');
    } catch (error) {
      logger.error({ error }, 'Failed to connect to Asana API');
      this._connected = false;
      throw error;
    }
  }

  /** Disconnect (no-op for REST API) */
  async disconnect(): Promise<void> {
    this._connected = false;
    logger.info('Disconnected from Asana API');
  }

  /** Check connection status */
  async checkConnection(): Promise<AsanaConnectionStatus> {
    const status: AsanaConnectionStatus = {
      connected: false,
      configured: this.isConfigured(),
      lastChecked: new Date().toISOString(),
      error: null,
    };

    if (!this.isConfigured()) {
      status.error = 'ASANA_PAT environment variable not set';
      return status;
    }

    try {
      await this.connect();
      status.connected = true;
    } catch (error) {
      status.error = (error as Error).message;
      status.connected = false;
    }

    return status;
  }

  /** Fetch tasks assigned to the current user */
  async getMyTasks(options?: AsanaFetchTasksOptions): Promise<AsanaTask[]> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured');
    }

    logger.info({ options }, 'Fetching Asana tasks...');

    try {
      // First get user info to get workspace
      const userResponse = await fetch(`${ASANA_API_BASE}/users/me`, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!userResponse.ok) {
        throw new Error(`Failed to get user info: ${userResponse.status}`);
      }

      const userData = await userResponse.json();
      const userGid = userData.data?.gid;
      const workspaces = userData.data?.workspaces || [];

      if (!userGid) {
        throw new Error('Could not get user GID');
      }

      // Use provided workspace or first available
      const workspaceGid = options?.workspace || this.config.asanaWorkspace || workspaces[0]?.gid;

      if (!workspaceGid) {
        throw new Error('No workspace found');
      }

      // Fetch tasks assigned to user in workspace
      const limit = options?.limit || 50;
      const completedSince = options?.includeCompleted ? '' : '&completed_since=now';

      const tasksUrl = `${ASANA_API_BASE}/tasks?assignee=${userGid}&workspace=${workspaceGid}&limit=${limit}${completedSince}&opt_fields=name,notes,due_on,completed,permalink_url,projects.name,projects.gid,tags.name,parent.gid,parent.name,parent.notes`;

      const tasksResponse = await fetch(tasksUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!tasksResponse.ok) {
        const errorText = await tasksResponse.text();
        throw new Error(`Failed to fetch tasks: ${tasksResponse.status} ${errorText}`);
      }

      const tasksData = await tasksResponse.json();
      const tasks = (tasksData.data || []).map((task: Record<string, unknown>) => this.mapToAsanaTask(task));

      logger.info({ count: tasks.length }, 'Fetched Asana tasks');
      this._connected = true;
      return tasks;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch Asana tasks');
      throw error;
    }
  }

  /** Fetch projects in the workspace */
  async getProjects(workspace?: string): Promise<Array<{ gid: string; name: string }>> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured');
    }

    logger.info('Fetching Asana projects...');

    try {
      // Get workspace GID
      const userResponse = await fetch(`${ASANA_API_BASE}/users/me`, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!userResponse.ok) {
        throw new Error(`Failed to get user info: ${userResponse.status}`);
      }

      const userData = await userResponse.json();
      const workspaces = userData.data?.workspaces || [];
      const workspaceGid = workspace || this.config.asanaWorkspace || workspaces[0]?.gid;

      if (!workspaceGid) {
        throw new Error('No workspace found');
      }

      const allProjects: Array<{ gid: string; name: string }> = [];
      for (const ws of workspaces) {
        let nextUrl: string | null = `${ASANA_API_BASE}/projects?workspace=${ws.gid}&limit=100&opt_fields=name,archived`;
        while (nextUrl) {
          const response: Response = await fetch(nextUrl, {
            headers: {
              'Authorization': `Bearer ${this.config.asanaPat}`,
              'Accept': 'application/json',
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch projects: ${response.status} ${errorText}`);
          }

          const data = await response.json() as { data?: Record<string, unknown>[]; next_page?: { uri?: string } };
          const page = (data.data || [])
            .filter((p: Record<string, unknown>) => !p['archived'])
            .map((p: Record<string, unknown>) => ({
              gid: String(p['gid'] || ''),
              name: String(p['name'] || ''),
            }));
          allProjects.push(...page);
          nextUrl = data.next_page?.uri ? `${ASANA_API_BASE.replace('/api/1.0', '')}${data.next_page.uri}` : null;
        }
      }

      logger.info({ count: allProjects.length }, 'Fetched Asana projects');
      this._connected = true;
      return allProjects;
    } catch (error) {
      logger.error({ error }, 'Failed to fetch Asana projects');
      throw error;
    }
  }

  /** Fetch tasks for a specific Asana project */
  async getProjectTasks(projectGid: string, options?: { limit?: number; includeCompleted?: boolean }): Promise<AsanaTask[]> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured');
    }

    logger.info({ projectGid }, 'Fetching Asana project tasks...');

    try {
      const limit = options?.limit || 100;
      const completedSince = options?.includeCompleted ? '' : '&completed_since=now';

      const url = `${ASANA_API_BASE}/tasks?project=${projectGid}&limit=${limit}${completedSince}&opt_fields=name,notes,due_on,completed,permalink_url,projects.name,projects.gid,tags.name,parent.gid,parent.name,parent.notes`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch project tasks: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const tasks = (data.data || []).map((task: Record<string, unknown>) => this.mapToAsanaTask(task));

      logger.info({ projectGid, count: tasks.length }, 'Fetched Asana project tasks');
      this._connected = true;
      return tasks;
    } catch (error) {
      logger.error({ error, projectGid }, 'Failed to fetch Asana project tasks');
      throw error;
    }
  }

  /** Fetch tasks assigned to the current user in a specific Asana project */
  async getMyTasksForProject(projectGid: string, options?: { limit?: number; includeCompleted?: boolean }): Promise<AsanaTask[]> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured');
    }

    logger.info({ projectGid }, 'Fetching my tasks for Asana project...');

    try {
      // Get current user GID for client-side assignee filtering
      const userResponse = await fetch(`${ASANA_API_BASE}/users/me`, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!userResponse.ok) {
        throw new Error(`Failed to get user info: ${userResponse.status}`);
      }

      const userData = await userResponse.json();
      const userGid = userData.data?.gid as string | undefined;

      const completedSince = options?.includeCompleted ? '' : '&completed_since=now';
      const limit = options?.limit || 100;
      const optFields = 'name,notes,due_on,completed,permalink_url,projects.name,projects.gid,tags.name,parent.gid,parent.name,parent.notes,assignee.gid';

      // Fetch all project tasks with pagination (to avoid missing tasks beyond first page)
      let allTasks: Record<string, unknown>[] = [];
      let nextPageUrl: string | null = `${ASANA_API_BASE}/tasks?project=${projectGid}&limit=${limit}${completedSince}&opt_fields=${optFields}`;

      while (nextPageUrl) {
        const response: Response = await fetch(nextPageUrl, {
          headers: {
            'Authorization': `Bearer ${this.config.asanaPat}`,
            'Accept': 'application/json',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to fetch tasks: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        allTasks.push(...(data.data || []));
        nextPageUrl = data.next_page?.uri || null;
      }

      const filtered = userGid
        ? allTasks.filter(t => (t['assignee'] as Record<string, unknown> | null)?.['gid'] === userGid)
        : allTasks;
      const tasks = filtered.map(task => this.mapToAsanaTask(task));

      logger.info({ projectGid, count: tasks.length }, 'Fetched my tasks for Asana project');
      this._connected = true;
      return tasks;
    } catch (error) {
      logger.error({ error, projectGid }, 'Failed to fetch my tasks for Asana project');
      throw error;
    }
  }

  /** Fetch stories (comments) for a specific task */
  async getTaskStories(taskGid: string): Promise<Array<{ author: string; text: string; createdAt: string }>> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured');
    }

    logger.info({ taskGid }, 'Fetching Asana task stories...');

    try {
      const url = `${ASANA_API_BASE}/tasks/${taskGid}/stories?opt_fields=type,text,created_by.name,created_at`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch task stories: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const stories = (data.data || [])
        .filter((s: Record<string, unknown>) => s['type'] === 'comment' && s['text'])
        .map((s: Record<string, unknown>) => ({
          author: (s['created_by'] as { name?: string })?.name || 'Unknown',
          text: String(s['text'] || ''),
          createdAt: String(s['created_at'] || ''),
        }));

      logger.info({ taskGid, count: stories.length }, 'Fetched Asana task stories');
      return stories;
    } catch (error) {
      logger.error({ error, taskGid }, 'Failed to fetch Asana task stories');
      throw error;
    }
  }

  /** Map raw Asana API response to AsanaTask interface */
  private mapToAsanaTask(raw: Record<string, unknown>): AsanaTask {
    // Extract project info
    let projectName = 'No Project';
    let projectGid = '';

    const projects = raw['projects'] as Array<{ gid: string; name: string }> | undefined;
    if (projects && projects.length > 0) {
      projectName = projects[0]!.name;
      projectGid = projects[0]!.gid;
    }

    // Extract tags
    const tags = (raw['tags'] as Array<{ name: string }> | undefined)?.map(t => t.name) || [];

    // Extract parent task info
    const parentRaw = raw['parent'] as { gid?: string; name?: string; notes?: string } | null | undefined;
    const parent = parentRaw?.gid ? {
      gid: String(parentRaw.gid),
      name: String(parentRaw.name || ''),
      notes: parentRaw.notes ? String(parentRaw.notes) : undefined,
    } : undefined;

    return {
      gid: String(raw['gid'] || ''),
      name: String(raw['name'] || ''),
      notes: String(raw['notes'] || ''),
      projectName,
      projectGid,
      dueOn: raw['due_on'] as string | null,
      completed: Boolean(raw['completed']),
      permalink_url: String(raw['permalink_url'] || ''),
      tags,
      parent,
    };
  }
}
