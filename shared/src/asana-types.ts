/**
 * Asana MCP Integration Types
 *
 * Types for Asana task management integration via MCP
 */

/** Asana task data structure */
export interface AsanaTask {
  /** Asana global ID */
  gid: string;
  /** Task name/title */
  name: string;
  /** Task description/notes (markdown) */
  notes: string;
  /** Project name this task belongs to */
  projectName: string;
  /** Project GID */
  projectGid: string;
  /** Due date in YYYY-MM-DD format, or null if not set */
  dueOn: string | null;
  /** Whether the task is completed */
  completed: boolean;
  /** Direct link to the task in Asana */
  permalink_url: string;
  /** Tag names attached to this task */
  tags: string[];
  /** Parent task (if this is a subtask) */
  parent?: {
    gid: string;
    name: string;
    notes?: string;
  } | null;
}

/** Asana MCP connection status */
export interface AsanaConnectionStatus {
  /** Whether MCP server is connected and responding */
  connected: boolean;
  /** Whether ASANA_PAT is configured on the server */
  configured: boolean;
  /** Last successful connection check timestamp */
  lastChecked: string | null;
  /** Error message if connection failed */
  error: string | null;
}

/** Options for fetching tasks */
export interface AsanaFetchTasksOptions {
  /** Filter by workspace GID */
  workspace?: string;
  /** Maximum number of tasks to return */
  limit?: number;
  /** Include completed tasks */
  includeCompleted?: boolean;
}
