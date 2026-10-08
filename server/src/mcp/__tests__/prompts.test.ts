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

  // 原本流程從「驗收」直接跳「結案」——漏了檢查表、程式預檢、獨立 AI 回對，照它走必在結案被閘門擋下
  it('start_task 涵蓋結案閘門要的每一步，而且順序對（檢查表→預檢→驗收→獨立 AI 回對→結案）', () => {
    const text = buildStartTaskText('task-abc');
    const at = (s: string) => text.indexOf(s);
    for (const s of ['save_spec_checklist', 'run_spec_compliance', 'get_compliance_review_plan', 'save_compliance_review', 'missing=0']) {
      expect(text, s).toContain(s);
    }
    expect(text).toContain('獨立');   // 回對不可由寫 code 的人自評
    expect(at('save_spec_checklist')).toBeLessThan(at('run_spec_compliance'));
    expect(at('run_spec_compliance')).toBeLessThan(at('get_compliance_review_plan'));
    expect(at('get_compliance_review_plan')).toBeLessThan(at('status="completed"'));
  });

  it('start_task text without taskId instructs locating the task first', () => {
    const text = buildStartTaskText(undefined);
    expect(text).toContain('list_pending_tasks');
    expect(text).toContain('next_task');
    expect(text).toContain('第 0 步');
  });
});
