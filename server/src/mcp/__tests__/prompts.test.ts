import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPrompts, buildStartTaskText } from '../prompts.js';

describe('mcp prompts', () => {
  it('registers the start_task prompt', () => {
    const server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {}, prompts: {} } });
    expect(() => registerPrompts(server)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prompts = (server as any)._registeredPrompts as Record<string, unknown>;
    expect(prompts['start_task']).toBeTruthy();
  });

  it('start_task text with taskId covers the full workflow', () => {
    const text = buildStartTaskText('task-abc');
    expect(text).toContain('get_execution_plan(taskId="task-abc")');
    expect(text).toContain('status="in_progress"');
    expect(text).toContain('fetch_svn_specs');
    expect(text).toContain('search_documents');
    expect(text).toContain('report_spec_gap');
    expect(text).toContain('get_verification_plan');
    expect(text).toContain('report_verification_result');
    expect(text).toContain('status="completed"');
    expect(text).toContain('status="failed"');
    expect(text).not.toContain('第 0 步');
  });

  it('start_task text without taskId instructs locating the task first', () => {
    const text = buildStartTaskText(undefined);
    expect(text).toContain('list_pending_tasks');
    expect(text).toContain('next_task');
    expect(text).toContain('第 0 步');
  });
});
