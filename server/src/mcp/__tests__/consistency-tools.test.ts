import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerConsistencyTools } from '../tools/consistency-tools.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seed(db: Database.Database) {
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES (?, ?, ?)`).run('proj-1', 'Test', '/tmp');
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type) VALUES (?, ?, ?, ?, ?)`).run(
    'task-1', 'proj-1', 'WA05 查詢作業', 'frontend', 'feature',
  );
}

function addDoc(db: Database.Database, id: string, filename: string, docType: 'SA' | 'SD' | 'other') {
  db.prepare(`INSERT INTO documents (id, project_id, filename, file_path, doc_type) VALUES (?, 'proj-1', ?, ?, ?)`)
    .run(id, filename, `/tmp/${filename}`, docType);
}

function bindDoc(db: Database.Database, taskId: string, docId: string) {
  db.prepare('INSERT INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, docId);
}

describe('consistency-tools (check_spec_consistency)', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerConsistencyTools(server);
    vi.clearAllMocks();
  });

  it('returns error for non-existent task', async () => {
    const result = await callTool(server, 'check_spec_consistency', { taskId: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('returns guidance (non-error) when SA docs are missing', async () => {
    seed(testDb);
    addDoc(testDb, 'd-sd', 'WA05-SD.md', 'SD');

    const result = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain('缺少 SA 文件');
    expect(text).toContain('fetch_svn_specs');
  });

  it('returns guidance (non-error) when SD docs are missing', async () => {
    seed(testDb);
    addDoc(testDb, 'd-sa', 'WA05-SA.md', 'SA');

    const result = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain('缺少 SD 文件');
    expect(text).toContain('fetch_svn_specs');
  });

  it('mentions both sides when SA and SD are both missing', async () => {
    seed(testDb);
    addDoc(testDb, 'd-other', 'notes.md', 'other');

    const result = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('缺少 SA 與 SD 文件');
  });

  it('returns a full dispatch plan when both SA and SD exist (project-level docs)', async () => {
    seed(testDb);
    addDoc(testDb, 'd-sa', 'WA05-SA.md', 'SA');
    addDoc(testDb, 'd-sd', 'WA05-SD.md', 'SD');

    const result = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;

    // Header: taskId + doc path lists
    expect(text).toContain('taskId=task-1');
    expect(text).toContain('WA05-SA.md — /tmp/WA05-SA.md');
    expect(text).toContain('WA05-SD.md — /tmp/WA05-SD.md');

    // Four comparison dimensions (methodology lives in the MCP, not the session)
    expect(text).toContain('欄位對齊');
    expect(text).toContain('功能覆蓋');
    expect(text).toContain('反向檢查');
    expect(text).toContain('訊息與驗證規則');

    // Judgement discipline: two-sided provenance + explicit "no findings" statistics
    expect(text).toContain('兩邊出處');
    expect(text).toContain('無矛盾');

    // Output actions: sa_sd_mismatch gap call format + independent subagent + no status update
    expect(text).toContain('report_spec_gap(taskId="task-1", category="sa_sd_mismatch"');
    expect(text).toContain('獨立的規格一致性檢查 subagent');
    expect(text).toContain('不得呼叫 update_task_status');
  });

  it('includes dimension two (規格模糊點預檢) in the dispatch plan', async () => {
    seed(testDb);
    addDoc(testDb, 'd-sa', 'WA05-SA.md', 'SA');
    addDoc(testDb, 'd-sd', 'WA05-SD.md', 'SD');

    const result = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;

    // Two-dimension framing: SA↔SD comparison + ambiguity precheck via decision-tree walk
    expect(text).toContain('維度一');
    expect(text).toContain('規格模糊點預檢');
    expect(text).toContain('決策樹');
    expect(text).toContain('唯一答案');

    // Gap description format: provenance + undecided decision + options for the user to pick
    expect(text).toContain('規格出處');
    expect(text).toContain('可能的選項');
    expect(text).toContain('三要素');

    // Check-before-report (anti-noise): all four self-check sources, with concrete calls
    expect(text).toContain('先查再報');
    expect(text).toContain('規格全文其他章節');
    expect(text).toContain('Axure 原型');
    expect(text).toContain('list_project_notes(projectId="proj-1")');
    expect(text).toContain('list_spec_gaps(taskId="task-1")');

    // Explicit exclusions (no nitpicking) + advisory (never blocks gates/dispatch)
    expect(text).toContain('吹毛求疵');
    expect(text).toContain('advisory');
    expect(text).toContain('不影響任何完成閘門');

    // ambiguous_spec gap call bound to this task
    expect(text).toContain('report_spec_gap(taskId="task-1", category="ambiguous_spec"');

    // Orchestrator guidance: suggest user decides first, but execution may proceed
    expect(text).toContain('不強制');
  });

  it('prefers task_documents bindings over project-level docs', async () => {
    seed(testDb);
    // Project level has both SA and SD…
    addDoc(testDb, 'd-sa-proj', 'PROJ-SA.md', 'SA');
    addDoc(testDb, 'd-sd-proj', 'PROJ-SD.md', 'SD');
    // …but the task is only bound to an SA doc → bound set wins → SD missing
    addDoc(testDb, 'd-sa-task', 'TASK-SA.md', 'SA');
    bindDoc(testDb, 'task-1', 'd-sa-task');

    const missing = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    expect(missing.isError).toBeUndefined();
    expect(missing.content[0].text).toContain('缺少 SD 文件');

    // Bind a task-level SD doc → plan lists ONLY the bound docs, not project-level ones
    addDoc(testDb, 'd-sd-task', 'TASK-SD.md', 'SD');
    bindDoc(testDb, 'task-1', 'd-sd-task');

    const plan = await callTool(server, 'check_spec_consistency', { taskId: 'task-1' });
    const text = plan.content[0].text as string;
    expect(text).toContain('TASK-SA.md');
    expect(text).toContain('TASK-SD.md');
    expect(text).not.toContain('PROJ-SA.md');
    expect(text).not.toContain('PROJ-SD.md');
  });
});
