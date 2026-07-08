import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runComplianceEngine, scanWorkspace, parseApiContent, buildApiPathRegex,
  type EngineItem,
} from '../compliance-engine.js';

let feRoot: string;
let beRoot: string;

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function item(partial: Partial<EngineItem> & Pick<EngineItem, 'id' | 'itemType' | 'content'>): EngineItem {
  return { side: 'both', waived: false, detail: null, ...partial };
}

beforeAll(() => {
  feRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-compliance-fe-'));
  beRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-compliance-be-'));

  // ── frontend fixtures ──
  write(feRoot, 'src/pages/Wa05/Index.tsx', [
    `export function Wa05Index() {`,
    `  return (`,
    `    <div>`,
    `      <h1>代理人設定作業</h1>`,
    `      <button>查詢（Ｑ）</button>`,
    `      <span>{userName}</span>`,
    `    </div>`,
    `  );`,
    `}`,
  ].join('\n'));
  write(feRoot, 'src/api/wa05.ts', [
    `import axios from 'axios';`,
    `export function saveAgent(id: string) {`,
    `  return axios.post(\`/api/wa05/agents/\${id}/save\`, {});`,
    `}`,
    `export function listAgents() {`,
    `  return axios.get('/api/wa05/agents');`,
    `}`,
  ].join('\n'));
  // excluded dir — content here must never match
  write(feRoot, 'node_modules/some-lib/index.js', `const hidden = '主部門點選儲存'; // /api/hidden/{id}`);
  write(feRoot, 'dist/bundle.js', `const alsoHidden = '主部門點選儲存';`);

  // ── backend fixtures ──
  write(beRoot, 'src/main/java/com/example/Wa05Controller.java', [
    `@RestController`,
    `public class Wa05Controller {`,
    `  @PostMapping("/api/wa05/agents/{id}/save")`,
    `  public Result save(@PathVariable String id) { return ok(); }`,
    ``,
    `  @GetMapping("/api/wa05/agents")`,
    `  public List<Agent> list() { return service.list(); }`,
    `}`,
  ].join('\n'));
  write(beRoot, 'src/main/java/com/example/AgentEntity.java', [
    `@Entity`,
    `public class AgentEntity {`,
    `  @Column(name = "AGENT_USER_ID")`,
    `  private String agentUserId;`,
    `}`,
  ].join('\n'));
  write(beRoot, 'src/main/resources/ddl/agent.sql', [
    `CREATE TABLE AGENT_SETTING (`,
    `  AGENT_USER_ID VARCHAR2(20) NOT NULL`,
    `);`,
  ].join('\n'));
});

afterAll(() => {
  fs.rmSync(feRoot, { recursive: true, force: true });
  fs.rmSync(beRoot, { recursive: true, force: true });
});

describe('scanWorkspace', () => {
  it('excludes node_modules/dist and only picks whitelisted extensions', () => {
    const files = scanWorkspace(feRoot);
    const paths = files.map(f => f.relPath);
    expect(paths).toContain('src/pages/Wa05/Index.tsx');
    expect(paths.some(p => p.startsWith('node_modules/'))).toBe(false);
    expect(paths.some(p => p.startsWith('dist/'))).toBe(false);
  });
});

describe('parseApiContent / buildApiPathRegex', () => {
  it('parses "POST /api/x" into method + path; path-only has null method', () => {
    expect(parseApiContent('POST /api/wa05/save')).toEqual({ method: 'POST', path: '/api/wa05/save' });
    expect(parseApiContent('/api/wa05/save')).toEqual({ method: null, path: '/api/wa05/save' });
  });

  it('detail.method overrides / supplements content', () => {
    expect(parseApiContent('/api/wa05/save', { method: 'put' })).toEqual({ method: 'PUT', path: '/api/wa05/save' });
  });

  it('normalizes {id} / :id / ${id} placeholders as equivalent', () => {
    const re = buildApiPathRegex('/api/user/{id}/detail');
    expect(re.test('/api/user/{id}/detail')).toBe(true);
    expect(re.test('/api/user/:id/detail')).toBe(true);
    expect(re.test('`/api/user/${userId}/detail`')).toBe(true);
    expect(re.test('/api/user/detail')).toBe(false);
  });
});

describe('runComplianceEngine', () => {
  it('ui_text: exact substring hit with evidence, miss otherwise', () => {
    const result = runComplianceEngine([
      item({ id: 'i1', itemType: 'ui_text', content: '代理人設定作業', side: 'frontend' }),
      item({ id: 'i2', itemType: 'ui_text', content: '不存在的文字', side: 'frontend' }),
    ], { frontend: feRoot });

    const r1 = result.items.find(r => r.itemId === 'i1')!;
    expect(r1.status).toBe('matched');
    expect(r1.evidence![0]).toEqual({ file: 'src/pages/Wa05/Index.tsx', line: 4 });

    const r2 = result.items.find(r => r.itemId === 'i2')!;
    expect(r2.status).toBe('missing');

    expect(result.summary).toMatchObject({ total: 2, matched: 1, missing: 1, autoTotal: 2, score: 50 });
  });

  it('identifier types with pure-CJK content fall back to substring (no \\b false-negative)', () => {
    const result = runComplianceEngine([
      // 純中文 content 存成 db_field（subagent 誤分類的情境）：\b 對 CJK 永不成立，須退回 substring
      item({ id: 'cjk', itemType: 'db_field', content: '代理人設定作業', side: 'frontend' }),
    ], { frontend: feRoot });

    const r = result.items.find(x => x.itemId === 'cjk')!;
    expect(r.status).toBe('matched');
    expect(r.evidence!.length).toBeGreaterThan(0);
  });

  it('ui_text: multi-line content matched via file content gets evidence from first line', () => {
    const result = runComplianceEngine([
      item({ id: 'ml', itemType: 'ui_text', content: '<h1>代理人設定作業</h1>\n      <button>查詢（Ｑ）</button>', side: 'frontend' }),
    ], { frontend: feRoot });

    const r = result.items.find(x => x.itemId === 'ml')!;
    expect(r.status).toBe('matched');
    expect(r.evidence![0].file).toBe('src/pages/Wa05/Index.tsx');
  });

  it('ui_text: fullwidth and halfwidth are distinct (no normalization)', () => {
    const result = runComplianceEngine([
      item({ id: 'full', itemType: 'ui_text', content: '查詢（Ｑ）', side: 'frontend' }), // fullwidth as in fixture
      item({ id: 'half', itemType: 'ui_text', content: '查詢(Q)', side: 'frontend' }),   // halfwidth — must NOT match
    ], { frontend: feRoot });

    expect(result.items.find(r => r.itemId === 'full')!.status).toBe('matched');
    expect(result.items.find(r => r.itemId === 'half')!.status).toBe('missing');
  });

  it('api: {id} in spec matches ${id} template literal in frontend and {id} in Java', () => {
    const result = runComplianceEngine([
      item({ id: 'api1', itemType: 'api', content: 'POST /api/wa05/agents/{id}/save' }),
    ], { frontend: feRoot, backend: beRoot });

    const r = result.items[0];
    expect(r.status).toBe('matched');
    expect(r.evidence!.length).toBeGreaterThan(0);
  });

  it('api: path found but method mismatch → missing with matched_path_only note', () => {
    const result = runComplianceEngine([
      item({ id: 'api2', itemType: 'api', content: 'DELETE /api/wa05/agents' }),
    ], { frontend: feRoot, backend: beRoot });

    const r = result.items[0];
    expect(r.status).toBe('missing');
    expect(r.note).toContain('matched_path_only');
    expect(r.note).toContain('DELETE');
    expect(r.evidence!.length).toBeGreaterThan(0); // path hits still reported as context
  });

  it('api: path not found at all → missing without matched_path_only', () => {
    const result = runComplianceEngine([
      item({ id: 'api3', itemType: 'api', content: 'GET /api/nonexistent/route' }),
    ], { frontend: feRoot, backend: beRoot });

    expect(result.items[0].status).toBe('missing');
    expect(result.items[0].note).not.toContain('matched_path_only');
  });

  it('param: word-boundary match, no substring false positives', () => {
    const result = runComplianceEngine([
      item({ id: 'p1', itemType: 'param', content: 'userName', side: 'frontend' }),
      item({ id: 'p2', itemType: 'param', content: 'userNam', side: 'frontend' }), // substring of userName — must NOT match
    ], { frontend: feRoot });

    expect(result.items.find(r => r.itemId === 'p1')!.status).toBe('matched');
    expect(result.items.find(r => r.itemId === 'p2')!.status).toBe('missing');
  });

  it('db_field: matched in .sql and .java, evidence prioritizes .sql', () => {
    const result = runComplianceEngine([
      item({ id: 'db1', itemType: 'db_field', content: 'AGENT_USER_ID', side: 'backend' }),
    ], { backend: beRoot });

    const r = result.items[0];
    expect(r.status).toBe('matched');
    expect(r.evidence![0].file.endsWith('.sql')).toBe(true);
  });

  it('logic → manual (not counted as missing)', () => {
    const result = runComplianceEngine([
      item({ id: 'l1', itemType: 'logic', content: '查詢結果依建立日期倒序排列' }),
    ], { frontend: feRoot });

    expect(result.items[0].status).toBe('manual');
    expect(result.summary).toMatchObject({ total: 1, manual: 1, missing: 0, autoTotal: 0, score: 100 });
  });

  it('waived items are skipped (not compared, not counted in autoTotal)', () => {
    const result = runComplianceEngine([
      item({ id: 'w1', itemType: 'ui_text', content: '不存在的文字', side: 'frontend', waived: true }),
    ], { frontend: feRoot });

    expect(result.items[0].status).toBe('waived');
    expect(result.summary).toMatchObject({ waived: 1, missing: 0, autoTotal: 0 });
  });

  it('content inside excluded dirs (node_modules) never matches', () => {
    const result = runComplianceEngine([
      item({ id: 'x1', itemType: 'ui_text', content: '主部門點選儲存', side: 'frontend' }),
    ], { frontend: feRoot });

    expect(result.items[0].status).toBe('missing');
  });

  it('side routing: frontend-side item is not searched in backend workspace and vice versa', () => {
    const result = runComplianceEngine([
      // AGENT_USER_ID exists only in backend — a frontend-side item must miss
      item({ id: 's1', itemType: 'db_field', content: 'AGENT_USER_ID', side: 'frontend' }),
      // 代理人設定作業 exists only in frontend — a backend-side item must miss
      item({ id: 's2', itemType: 'ui_text', content: '代理人設定作業', side: 'backend' }),
      // both → found
      item({ id: 's3', itemType: 'ui_text', content: '代理人設定作業', side: 'both' }),
    ], { frontend: feRoot, backend: beRoot });

    expect(result.items.find(r => r.itemId === 's1')!.status).toBe('missing');
    expect(result.items.find(r => r.itemId === 's2')!.status).toBe('missing');
    expect(result.items.find(r => r.itemId === 's3')!.status).toBe('matched');
  });

  it('side with no corresponding workspace root → missing with explanatory note', () => {
    const result = runComplianceEngine([
      item({ id: 'n1', itemType: 'ui_text', content: '代理人設定作業', side: 'backend' }),
    ], { frontend: feRoot }); // no backend root provided

    expect(result.items[0].status).toBe('missing');
    expect(result.items[0].note).toContain('workspace');
  });
});
