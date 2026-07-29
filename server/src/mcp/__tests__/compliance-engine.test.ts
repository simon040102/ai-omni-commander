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

  // ── 字面比對盲點修正用 fixtures（CM004 四類失敗模式的真實形狀）──
  // Spring 拆分式註解：類別層 @RequestMapping + 方法層 @PostMapping，中間隔超過 ±3 行
  write(beRoot, 'src/main/java/com/example/CustLogController.java', [
    `@RestController`,
    `@RequestMapping("/fedi/cm004")`,
    `public class CustLogController {`,
    ``,
    `  private final CustLogService service;`,
    ``,
    `  public CustLogController(CustLogService service) {`,
    `    this.service = service;`,
    `  }`,
    ``,
    `  @PostMapping("/search")`,
    `  public Result search(@RequestBody CustLogQueryVo vo) {`,
    `    return Result.ok(service.search(vo));`,
    `  }`,
    `}`,
  ].join('\n'));
  // 巢狀路徑葉節點：response 欄位只以 Java field 存在
  write(beRoot, 'src/main/java/com/example/CustLogVo.java', [
    `public class CustLogVo {`,
    `  private String oid;`,
    `  private int pageSize;`,
    `  private String uuid;`,
    `}`,
  ].join('\n'));
  // 表.欄位：專案無 DDL，欄位只存在於 Entity 的 @Column
  write(beRoot, 'src/main/java/com/example/AdmCustLogEntity.java', [
    `@Entity`,
    `@Table(name = "ADM_CUST_LOG")`,
    `public class AdmCustLogEntity {`,
    `  @Column(name = "OID")`,
    `  private String oid;`,
    `}`,
  ].join('\n'));
  // 完整字面優先驗證用：這個檔案有完整的 pagination.pageSize 字面
  write(feRoot, 'src/hooks/usePagination.ts', [
    `export function usePagination(state: State) {`,
    `  return state.pagination.pageSize;`,
    `}`,
  ].join('\n'));
  // 中括號字面 + word-boundary 陷阱字（asteroid 含 'oid' 子字串）
  write(feRoot, 'src/constants.ts', [
    `export const OPTION_TAG = "[OPTION]";`,
    `const asteroid = 1;`,
  ].join('\n'));
  // method 隱含在 hook 名稱（getApi=GET、putApi=PUT）
  write(feRoot, 'src/api/common.ts', [
    `export async function loadReasons() {`,
    `  const res = await getApi('/main/fedi/common/getList/getRejectReasonList');`,
    `  return res.data;`,
    `}`,
  ].join('\n'));
  // targetApi 是 \bgetapi\( 的陷阱字——獨立檔案，±3 行內無真正的 getApi
  write(feRoot, 'src/api/trap.ts', [
    `const other = targetApi('/main/fedi/common/other');`,
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

describe('字面比對盲點修正（候選識別字推導 + API path 拆分）', () => {
  it('巢狀路徑 resultList[].oid / pagination.pageSize → 以葉節點命中（規格寫法不會出現在原始碼）', () => {
    const result = runComplianceEngine([
      item({ id: 'nest1', itemType: 'response_field', content: 'resultList[].oid', side: 'backend' }),
      item({ id: 'nest2', itemType: 'response_field', content: 'pagination.pageSize', side: 'backend' }),
    ], { backend: beRoot });

    const r1 = result.items.find(r => r.itemId === 'nest1')!;
    expect(r1.status).toBe('matched');
    expect(r1.note).toContain('oid'); // note 揭露用了哪個候選命中，reviewer 可辨識

    expect(result.items.find(r => r.itemId === 'nest2')!.status).toBe('matched');
  });

  it('巢狀路徑：完整字面存在時優先命中完整字面（不降級）', () => {
    const result = runComplianceEngine([
      item({ id: 'full-first', itemType: 'response_field', content: 'pagination.pageSize', side: 'frontend' }),
    ], { frontend: feRoot });

    const r = result.items[0];
    expect(r.status).toBe('matched');
    expect(r.evidence![0].file).toBe('src/hooks/usePagination.ts'); // 完整字面所在檔
    expect(r.note ?? '').not.toContain('候選'); // 完整命中不需降級註記
  });

  it('巢狀路徑：葉節點也不存在 → 仍 missing（不可放寬成 substring）', () => {
    const result = runComplianceEngine([
      item({ id: 'nest-miss', itemType: 'response_field', content: 'resultList[].nonexistField', side: 'backend' }),
    ], { backend: beRoot });
    expect(result.items[0].status).toBe('missing');
  });

  it('葉節點維持 word-boundary：x[].oid 不誤中 asteroid（含 oid 子字串）', () => {
    const result = runComplianceEngine([
      item({ id: 'wb', itemType: 'response_field', content: 'x[].oid', side: 'frontend' }),
    ], { frontend: feRoot }); // frontend 只有 asteroid，沒有獨立的 oid
    expect(result.items[0].status).toBe('missing');
  });

  it('表.欄位 ADM_CUST_LOG.OID → 以欄位名命中 @Column 行；表名單獨存在不算欄位命中', () => {
    const result = runComplianceEngine([
      item({ id: 'db-nest', itemType: 'db_field', content: 'ADM_CUST_LOG.OID', side: 'backend' }),
      // 表名存在（@Table）但該欄位不存在 → 必須 missing，表名命中不可頂替欄位
      item({ id: 'db-nocol', itemType: 'db_field', content: 'ADM_CUST_LOG.NOT_A_COLUMN', side: 'backend' }),
    ], { backend: beRoot });

    const hit = result.items.find(r => r.itemId === 'db-nest')!;
    expect(hit.status).toBe('matched');
    expect(hit.evidence!.some(e => e.file.endsWith('AdmCustLogEntity.java'))).toBe(true);

    expect(result.items.find(r => r.itemId === 'db-nocol')!.status).toBe('missing');
  });

  it('API path 拆在類別/方法兩層註解（相隔 >±3 行）→ 拆分命中', () => {
    const result = runComplianceEngine([
      item({ id: 'api-split', itemType: 'api', content: 'POST /fedi/cm004/search', side: 'backend' }),
    ], { backend: beRoot });

    const r = result.items[0];
    expect(r.status).toBe('matched');
    expect(r.evidence!.some(e => e.file.endsWith('CustLogController.java'))).toBe(true);
  });

  it('API 拆分比對：prefix 不在同檔 → 仍 missing（不可只憑尾段命中）', () => {
    const result = runComplianceEngine([
      item({ id: 'api-noprefix', itemType: 'api', content: 'POST /other/module/search', side: 'backend' }),
    ], { backend: beRoot });
    expect(result.items[0].status).toBe('missing');
  });

  it('API 拆分比對：method 仍要驗（拆分命中行 ±3 行內找不到 method → missing）', () => {
    const result = runComplianceEngine([
      item({ id: 'api-wrongmethod', itemType: 'api', content: 'DELETE /fedi/cm004/search', side: 'backend' }),
    ], { backend: beRoot });
    const r = result.items[0];
    expect(r.status).toBe('missing');
    expect(r.note).toContain('matched_path_only');
  });

  it('method 隱含在 hook 名稱：getApi(path) 對 GET item 算 method 命中', () => {
    const result = runComplianceEngine([
      item({ id: 'hook1', itemType: 'api', content: 'GET /main/fedi/common/getList/getRejectReasonList', side: 'frontend' }),
    ], { frontend: feRoot });
    expect(result.items[0].status).toBe('matched');
  });

  it('hook 名稱比對守 word-boundary：targetApi( 不可誤判為 getApi(', () => {
    const result = runComplianceEngine([
      item({ id: 'hook2', itemType: 'api', content: 'GET /main/fedi/common/other', side: 'frontend' }),
    ], { frontend: feRoot });
    const r = result.items[0];
    expect(r.status).toBe('missing');
    expect(r.note).toContain('matched_path_only');
  });

  it('中括號字面 [OPTION] → 完整字面直接命中（\\b 只加在頭尾為 word char 的一側）', () => {
    const result = runComplianceEngine([
      item({ id: 'brk1', itemType: 'param', content: '[OPTION]', side: 'frontend' }),
    ], { frontend: feRoot });
    expect(result.items[0].status).toBe('matched');
  });

  it('結構寫法 items:[{uuid}] → 以 token 候選命中', () => {
    const result = runComplianceEngine([
      item({ id: 'brk2', itemType: 'param', content: 'items:[{uuid}]', side: 'backend' }),
    ], { backend: beRoot });
    expect(result.items[0].status).toBe('matched');
  });
});
