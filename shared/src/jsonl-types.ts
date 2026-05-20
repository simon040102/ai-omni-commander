/**
 * Types for Claude Code JSONL session file messages.
 * These files are stored at: ~/.claude/projects/{project-hash}/{session-id}.jsonl
 */

/** Content block inside a user or assistant message */
export type JsonlContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; caller?: { type: string } }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Token usage stats from an assistant message */
export interface JsonlUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number };
}

/** Base fields shared by all JSONL messages */
export interface JsonlMessageBase {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
}

/** User message (prompt or tool result) */
export interface JsonlUserMessage extends JsonlMessageBase {
  type: 'user';
  promptId?: string;
  message: {
    role: 'user';
    content: JsonlContentBlock[];
  };
  permissionMode?: string;
  toolUseResult?: { success: boolean; commandName?: string };
  sourceToolAssistantUUID?: string;
}

/** Assistant message (response with text, tool_use, thinking) */
export interface JsonlAssistantMessage extends JsonlMessageBase {
  type: 'assistant';
  requestId?: string;
  message: {
    model?: string;
    id?: string;
    type?: string;
    role: 'assistant';
    content: JsonlContentBlock[];
    stop_reason: string | null;
    stop_sequence?: string | null;
    usage?: JsonlUsage;
  };
}

/** Queue operation (session start/end indicator) */
export interface JsonlQueueOperation extends JsonlMessageBase {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue';
}

/** AI-generated session title */
export interface JsonlAiTitle extends JsonlMessageBase {
  type: 'ai-title';
  aiTitle: string;
}

/** File history snapshot */
export interface JsonlFileHistorySnapshot extends JsonlMessageBase {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: Record<string, unknown>;
  isSnapshotUpdate?: boolean;
}

/** Progress event (hook execution) */
export interface JsonlProgress extends JsonlMessageBase {
  type: 'progress';
  data: {
    type: string;
    hookEvent?: string;
    hookName?: string;
    command?: string;
  };
}

/** Union of all JSONL message types */
export type JsonlMessage =
  | JsonlUserMessage
  | JsonlAssistantMessage
  | JsonlQueueOperation
  | JsonlAiTitle
  | JsonlFileHistorySnapshot
  | JsonlProgress;
