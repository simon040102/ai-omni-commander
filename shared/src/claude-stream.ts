// Messages FROM Claude CLI (stdout, NDJSON lines)

export interface ClaudeStreamInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: string[];
  model?: string;
}

export interface ClaudeStreamAssistantMessage {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    >;
    stop_reason: string | null;
  };
  session_id: string;
}

export interface ClaudeStreamUserMessage {
  type: 'user';
  message: {
    id: string;
    role: 'user';
    content: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }>;
  };
  session_id: string;
}

export interface ClaudeStreamResult {
  type: 'result';
  subtype: 'success' | 'error';
  session_id: string;
  result?: string;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  is_error: boolean;
  input_tokens?: number;
  output_tokens?: number;
}

export interface ClaudeStreamRaw {
  type: 'raw';
  content: string;
}

export type ClaudeStreamMessage =
  | ClaudeStreamInit
  | ClaudeStreamAssistantMessage
  | ClaudeStreamUserMessage
  | ClaudeStreamResult
  | ClaudeStreamRaw;

// Messages TO Claude CLI (stdin, --input-format stream-json)
export interface ClaudeStreamInput {
  type: 'user';
  content: string;
}
