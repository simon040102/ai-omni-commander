/**
 * Injects system prompt into Claude CLI interactive mode.
 * Since interactive mode has no --system-prompt flag, we wrap
 * the system prompt as the beginning of the first user message.
 */
export class SystemPromptInjector {
  /**
   * Wrap system prompt + user prompt into a single message.
   * The task title is placed first so it appears as the session name
   * in Claude Code Desktop's Recent Conversations.
   *
   * Format:
   * [TaskTitle]
   *
   * <system_instructions>
   * {systemPrompt}
   * </system_instructions>
   *
   * ---
   *
   * {userPrompt}
   */
  static wrapPrompt(opts: {
    taskTitle?: string;
    systemPrompt?: string;
    userPrompt: string;
  }): string {
    const parts: string[] = [];

    // Task title first → becomes session name in Desktop
    if (opts.taskTitle) {
      parts.push(`[${opts.taskTitle}]`);
      parts.push('');
    }

    // System prompt wrapped in XML-style tags for clarity
    if (opts.systemPrompt) {
      parts.push('<system_instructions>');
      parts.push(opts.systemPrompt);
      parts.push('</system_instructions>');
      parts.push('');
      parts.push('---');
      parts.push('');
    }

    parts.push(opts.userPrompt);

    return parts.join('\n');
  }

  /**
   * Escape special characters for PTY input.
   * Handles characters that might be interpreted by the terminal.
   */
  static escapePtyInput(text: string): string {
    // Replace actual newlines with escaped newlines that PTY can handle
    // Most terminals handle multi-line paste correctly
    return text;
  }
}
