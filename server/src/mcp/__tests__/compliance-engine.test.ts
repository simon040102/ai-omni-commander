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

// ════════════════════════════════════════════════════════════
// 假 matched：只在測試碼／只在註解命中 → 降級為 missing
//
// 2026-09-21 一天踩三次。**假 matched 比假 missing 危險**：missing 有人回頭看，
// 綠色的項目沒有人會回頭打開。
// ════════════════════════════════════════════════════════════
describe('假 matched 防線（測試碼／註解）', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-weak-'));
    // 只存在於測試治具的字面（實作根本沒做）
    write(root, 'src/test/java/com/x/UploadTest.java', [
      'class UploadTest {',
      '  static final String MSG = "這份是掃描檔，沒有可擷取的文字";',
      '  void t() { assertEquals(MSG, svc.reject()); }',
      '}',
    ].join('\n'));
    // 只存在於註解的參數名
    write(root, 'src/main/java/com/x/WorkerProps.java', [
      '/**',
      ' * 同一份 SD 的 intervalHours 則有明文固定 6 小時。',
      ' */',
      'public class WorkerProps {',
      '  private int concurrency = 1;',
      '}',
    ].join('\n'));
    // 產品程式碼與測試碼都有 → 必須 matched，且證據要指產品碼
    write(root, 'src/main/java/com/x/RealSvc.java', 'public class RealSvc { private String tenantUuid; }');
    write(root, 'src/test/java/com/x/RealSvcTest.java', 'class RealSvcTest { String tenantUuid = "t"; }');
  });

  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('★ ui_text 只在測試治具命中 → missing，不是 matched', () => {
    const r = runComplianceEngine([
      item({ id: 'w1', itemType: 'ui_text', content: '這份是掃描檔，沒有可擷取的文字', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('missing');
    expect(r.items[0].note).toContain('測試碼');
    expect(r.items[0].note).toContain('查得到字串不等於有實作');
    // 證據仍要附上，讓人查得到是命中在哪
    expect(r.items[0].evidence?.[0].file).toContain('UploadTest');
  });

  it('★ param 只在註解命中 → missing，不是 matched', () => {
    const r = runComplianceEngine([
      item({ id: 'w2', itemType: 'param', content: 'intervalHours', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('missing');
    expect(r.items[0].note).toContain('註解');
  });

  it('★★ 產品碼有、測試碼也有 → 仍是 matched（不可誤降級）', () => {
    const r = runComplianceEngine([
      item({ id: 'w3', itemType: 'param', content: 'tenantUuid', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('matched');
    // 證據只能指產品碼——指測試碼等於把治具當實作
    expect(r.items[0].evidence?.every(e => !e.file.includes('Test'))).toBe(true);
  });

  it('★★ 產品碼裡的「行內尾註」不算註解行（那一行有程式碼）', () => {
    write(root, 'src/main/java/com/x/Inline.java', 'private int maxAttempts = 3; // 重試上限');
    const r = runComplianceEngine([
      item({ id: 'w4', itemType: 'param', content: 'maxAttempts', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('matched');
  });
});

// ════════════════════════════════════════════════════════════
// 收集上限 vs 強弱分類：**收集必須先收滿，才能分強弱**
//
// 2026-09-22 迴歸：matchSubstring／matchIdentifierCandidates 原本以 MAX_EVIDENCE(2)
// 當「收集」上限，一收滿兩筆就 return。前兩筆若落在註解，真正的宣告行根本沒被收進來
// → strong 為空 → 整項降級 missing。
// 實際後果：某一輪只是**補了 javadoc**，註解行因此排在宣告行前面，
// 三個原本 matched 的常數當場變 missing——**程式只有變好，判定卻變差**。
// 誤降級比漏判更難查：實作者會去找一個根本不存在的缺陷。
// ════════════════════════════════════════════════════════════
describe('★★ 註解行數多於 MAX_EVIDENCE 時，仍要看得到後面的產品碼', () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-scanlimit-'));
    // javadoc 連續 4 行提到同一段文字，宣告行排在第 5 行之後
    write(root, 'src/main/java/com/x/Msg.java', [
      '/**',
      ' * 不支援的格式：拒絕並回覆「不支援的格式」。',
      ' * 呼叫端看到「不支援的格式」時應停止重試。',
      ' * 「不支援的格式」不寫入稽核明細。',
      ' * 歷史：前版以「不支援的格式」當 fallback。',
      ' */',
      'public final class Msg {',
      '  public static final String UNSUPPORTED = "不支援的格式";',
      '}',
    ].join('\n'));
    // 同一形狀，但比對的是識別字（param／response_field 走 matchIdentifierCandidates）
    write(root, 'src/main/java/com/x/Props.java', [
      '/**',
      ' * retryLimit 代表重試上限。',
      ' * retryLimit 為 0 時不重試。',
      ' * retryLimit 由設定檔覆寫。',
      ' */',
      'public class Props {',
      '  private int retryLimit = 3;',
      '}',
    ].join('\n'));
  });

  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('★★ ui_text：前 4 筆命中都在 javadoc，第 5 筆才是宣告 → 仍 matched', () => {
    const r = runComplianceEngine([
      item({ id: 's1', itemType: 'ui_text', content: '不支援的格式', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('matched');
    // 回傳筆數仍受 MAX_EVIDENCE 節制（收集上限不等於回傳上限）
    expect((r.items[0].evidence ?? []).length).toBeLessThanOrEqual(2);
    // 證據必須是產品碼那一行，不是註解行
    expect(r.items[0].evidence?.[0].line).toBe(8);
  });

  it('★★ param：前 3 筆命中都在 javadoc，宣告排在後面 → 仍 matched', () => {
    const r = runComplianceEngine([
      item({ id: 's2', itemType: 'param', content: 'retryLimit', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('matched');
    expect(r.items[0].evidence?.[0].line).toBe(7);
  });

  it('★★ response_field 同一條路徑', () => {
    const r = runComplianceEngine([
      item({ id: 's3', itemType: 'response_field', content: 'retryLimit', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('matched');
  });

  it('★ 負向：全篇只有註解時仍要降級（收集放寬不可讓假 matched 回來）', () => {
    write(root, 'src/main/java/com/x/OnlyDoc.java', [
      '/**',
      ' * ghostField 只在文件裡出現。',
      ' * ghostField 沒有任何實作。',
      ' * ghostField 三次也還是註解。',
      ' */',
      'public class OnlyDoc { }',
    ].join('\n'));
    const r = runComplianceEngine([
      item({ id: 's4', itemType: 'param', content: 'ghostField', side: 'backend' }),
    ], { backend: root });
    expect(r.items[0].status).toBe('missing');
    expect(r.items[0].note).toContain('註解');
  });
});


// -- specRoots 只給證據驗證，引擎一律不掃 --------------------------------
//
// 為什麼要有這條測試：規格文件裡逐字寫著 checklist 的 content，一旦把規格 root
// 併進引擎的掃描範圍，每一項都會在規格檔裡命中 → 全部假 matched（拿規格證明規格）。
// WorkspaceRoots.specRoots 是刻意只給 evidence-validator 用的欄位，這裡釘住它。
describe('specRoots 不進引擎掃描', () => {
  let specRoot: string;

  beforeAll(() => {
    specRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-engine-spec-'));
    // 副檔名刻意用 .html（Axure 原型——真的會被登記在 specFolders 裡，且在引擎的掃描白名單內）：
    // 用 .md 的話測試會因為白名單擋掉而假通過，證明不了 specRoots 沒被掃。
    write(specRoot, 'features/F-ONLY-IN-SPEC.html', '<p>訊息：這段字只存在於規格文件裡</p>');
  });

  afterAll(() => {
    fs.rmSync(specRoot, { recursive: true, force: true });
  });

  it('只寫在規格文件裡、程式碼沒做的文字 → 照樣 missing（不可拿規格當程式證據）', () => {
    const result = runComplianceEngine(
      [item({ id: 'spec-only', itemType: 'ui_text', content: '這段字只存在於規格文件裡', side: 'frontend' })],
      { frontend: feRoot, backend: beRoot, specRoots: [specRoot] },
    );
    expect(result.items[0].status).toBe('missing');
    expect(result.items[0].evidence ?? []).toEqual([]);
  });
});
