import type { Config } from '../config.js';
import type { AsanaTask, AsanaConnectionStatus, AsanaFetchTasksOptions } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';
import { fetchAsanaSubtasksTree } from '../utils/asanaSubtasks.js';
import { normalizeDueDate } from '../utils/dueDate.js';

const logger = createChildLogger('AsanaMcpClient');

const ASANA_API_BASE = 'https://app.asana.com/api/1.0';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 3;

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

  /**
   * Authenticated fetch against the Asana API with timeout,
   * 429 Retry-After backoff (max 3 retries), and a clear 401 error.
   */
  private async apiFetch(url: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.config.asanaPat}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.status === 401) {
        throw new Error('Asana PAT 無效或過期，請至全域設定更新');
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterRaw = response.headers.get('Retry-After');
        const retryAfterSec = Number.parseInt(retryAfterRaw || '1', 10);
        const waitMs = Math.min((Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 1) * 1000, 60_000);
        logger.warn({ url, attempt: attempt + 1, waitMs }, 'Asana rate limited (429) — backing off');
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      return response;
    }
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
      const response = await this.apiFetch(`${ASANA_API_BASE}/users/me`);

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
      const userResponse = await this.apiFetch(`${ASANA_API_BASE}/users/me`);

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

      const tasksResponse = await this.apiFetch(tasksUrl);

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
      const userResponse = await this.apiFetch(`${ASANA_API_BASE}/users/me`);

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
          const response: Response = await this.apiFetch(nextUrl);

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
          // next_page.uri is already a full URL — use it as-is
          nextUrl = data.next_page?.uri ?? null;
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

      const response = await this.apiFetch(url);

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

  /** Fetch tasks assigned to the current user in a specific Asana project (subtasks included) */
  async getMyTasksForProject(projectGid: string, options?: { limit?: number; includeCompleted?: boolean; includeSubtasks?: boolean }): Promise<AsanaTask[]> {
    return (await this.getMyTasksForProjectDetailed(projectGid, options)).tasks;
  }

  /**
   * Same as getMyTasksForProject but also returns subtask-fetch metadata,
   * so callers (AsanaSyncService) can tell whether the remote task set is
   * complete — 截斷/部分失敗時不可拿結果去判斷「任務已不存在」而刪除本地任務。
   */
  async getMyTasksForProjectDetailed(
    projectGid: string,
    options?: { limit?: number; includeCompleted?: boolean; includeSubtasks?: boolean },
  ): Promise<{ tasks: AsanaTask[]; subtaskCount: number; subtaskFetchIncomplete: boolean; subtaskWarnings: string[] }> {
    if (!this.config.asanaPat) {
      throw new Error('ASANA_PAT not configured');
    }

    logger.info({ projectGid }, 'Fetching my tasks for Asana project...');

    try {
      // Get current user GID for client-side assignee filtering
      const userResponse = await this.apiFetch(`${ASANA_API_BASE}/users/me`);

      if (!userResponse.ok) {
        throw new Error(`Failed to get user info: ${userResponse.status}`);
      }

      const userData = await userResponse.json();
      const userGid = userData.data?.gid as string | undefined;

      const completedSince = options?.includeCompleted ? '' : '&completed_since=now';
      const limit = options?.limit || 100;
      // section 在 memberships[].section.name（配 memberships.project.gid 挑出本專案）；custom_fields 用 display_value 落地
      // num_subtasks → subtask 遞迴抓取的種子判斷
      const optFields = 'name,notes,due_on,completed,num_subtasks,permalink_url,projects.name,projects.gid,tags.name,parent.gid,parent.name,parent.notes,assignee.gid,assignee.name,memberships.section.name,memberships.project.gid,custom_fields.name,custom_fields.display_value';

      // Fetch all project tasks with pagination (to avoid missing tasks beyond first page)
      let allTasks: Record<string, unknown>[] = [];
      let nextPageUrl: string | null = `${ASANA_API_BASE}/tasks?project=${projectGid}&limit=${limit}${completedSince}&opt_fields=${optFields}`;

      while (nextPageUrl) {
        const response: Response = await this.apiFetch(nextPageUrl);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to fetch tasks: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        allTasks.push(...(data.data || []));
        nextPageUrl = data.next_page?.uri || null;
      }

      // --- Subtask 遞迴抓取（先抓全樹、後過濾 assignee）---
      // 專案任務清單抓不到未 multi-home 進專案的 subtask；共用邏輯見
      // utils/asanaSubtasks.ts（深度 ≤3、只抓未完成、gid 去重、≤300 支/次）。
      // apiFetch 已含 429 退避，注入後模組內的單次退避只是保險。
      let subtaskCount = 0;
      let subtaskFetchIncomplete = false;
      let subtaskWarnings: string[] = [];
      // subtask 沒有 memberships → section 繼承根任務（下游依 section 分組才有意義）
      const inheritedSection = new Map<string, string | null>();
      if (options?.includeSubtasks !== false) {
        const tree = await fetchAsanaSubtasksTree(allTasks, {
          fetchFn: (url: string) => this.apiFetch(url),
          optFields,
        });
        const rootSections = new Map(allTasks.map(t => {
          const memberships = t['memberships'] as Array<{ project?: { gid?: string }; section?: { name?: string } }> | undefined;
          const match = (memberships && (memberships.find(m => m.project?.gid === projectGid) || memberships[0])) || undefined;
          return [String(t['gid'] || ''), match?.section?.name || null] as const;
        }));
        for (const entry of tree.entries) {
          const gid = String(entry.task['gid'] || '');
          if (!gid) continue;
          inheritedSection.set(gid, rootSections.get(entry.rootGid) ?? null);
          allTasks.push(entry.task);
        }
        subtaskCount = tree.entries.length;
        subtaskFetchIncomplete = tree.truncated || tree.warnings.length > 0;
        subtaskWarnings = tree.warnings;
        if (tree.warnings.length > 0) {
          logger.warn({ projectGid, warnings: tree.warnings, requestCount: tree.requestCount }, 'Asana subtask fetch warnings');
        }
      }

      // Assignee 過濾以「任務本身的 assignee」判：工作項目 subtask 指派給我、
      // 其母任務指派別人 → 仍要收（樹已先抓全再過濾）
      const filtered = userGid
        ? allTasks.filter(t => (t['assignee'] as Record<string, unknown> | null)?.['gid'] === userGid)
        : allTasks;
      const tasks = filtered.map(task => this.mapToAsanaTask(task, projectGid));
      for (const t of tasks) {
        if (inheritedSection.has(t.gid)) t.section = inheritedSection.get(t.gid) ?? null;
      }

      logger.info({ projectGid, count: tasks.length, subtaskCount }, 'Fetched my tasks for Asana project');
      this._connected = true;
      return { tasks, subtaskCount, subtaskFetchIncomplete, subtaskWarnings };
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
      const response = await this.apiFetch(url);

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

  /**
   * Map raw Asana API response to AsanaTask interface.
   * @param boundProjectGid the project we're syncing — used to pick the right Section from memberships[]
   */
  private mapToAsanaTask(raw: Record<string, unknown>, boundProjectGid?: string): AsanaTask {
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

    // Extract assignee
    const assigneeRaw = raw['assignee'] as { gid?: string; name?: string } | null | undefined;
    const assignee = assigneeRaw?.gid
      ? { gid: String(assigneeRaw.gid), name: String(assigneeRaw.name || '') }
      : null;

    // Extract Section from memberships — a task can belong to multiple projects,
    // so pick the membership whose project matches the project we're syncing.
    const memberships = raw['memberships'] as Array<{ project?: { gid?: string }; section?: { name?: string } }> | undefined;
    let section: string | null = null;
    if (memberships && memberships.length > 0) {
      const match = (boundProjectGid && memberships.find(m => m.project?.gid === boundProjectGid)) || memberships[0];
      section = match?.section?.name || null;
    }

    // Extract custom fields → { name: display_value }
    const customFields: Record<string, string> = {};
    const cfs = raw['custom_fields'] as Array<{ name?: string; display_value?: string | null }> | undefined;
    for (const cf of cfs || []) {
      if (cf.name && cf.display_value !== null && cf.display_value !== undefined && String(cf.display_value) !== '') {
        customFields[cf.name] = String(cf.display_value);
      }
    }

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
      dueOn: normalizeDueDate(raw['due_on']),
      completed: Boolean(raw['completed']),
      permalink_url: String(raw['permalink_url'] || ''),
      tags,
      section,
      assignee,
      customFields,
      parent,
    };
  }
}
