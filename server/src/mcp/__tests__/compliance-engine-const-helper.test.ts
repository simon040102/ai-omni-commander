/**
 * API 項「路徑常數 ＋ helper 帶動詞」寫法的比對（任務 e6cb66c1）。
 *
 * 【背景】前端通行的寫法是路徑放在常數物件、動詞由呼叫端的 helper 帶：
 *   export const KB01_API = { search: '/main/kb01/search', delete: (id) => `/main/kb01/delete/${id}` }
 *   post(KB01_API.search, cond)  ／  del(KB01_API.delete(row.id))
 * "METHOD /path" 的完整字面永遠不會逐字出現，引擎因此一律回 matched_path_only。
 *
 * 【這一組測試守的是兩個方向】
 * - 真的有接的端點要翻成 matched，而且**理由是解析到了常數與動詞**（note 寫得出是哪個常數、哪一行呼叫）。
 * - ⚠ 本來該報的**還要報得出來**：宣告了沒呼叫、動詞不符、只在測試碼／註解呼叫、
 *   常數值與規格 path 只有尾段相同——這些一律仍是 missing。
 *   只證明誤報變少什麼都沒證明——把規則改成全部回 matched 也能讓誤報歸零。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runComplianceEngine, type EngineItem } from '../compliance-engine.js';

let fe: string;

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function api(id: string, content: string): EngineItem {
  return { id, itemType: 'api', content, side: 'frontend', waived: false, detail: null };
}

function run(...items: EngineItem[]) {
  return runComplianceEngine(items, { frontend: fe }).items;
}

beforeAll(() => {
  fe = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-const-helper-'));

  // ── 常數物件（本案 src/api/kb01.ts 的形狀，含 javadoc 與組路徑函式） ──
  write(fe, 'src/api/kb01.ts', [
    `export const KB01_API = {`,
    `    /** §1 查詢 */`,
    `    search: '/main/kb01/search',`,
    `    create: '/main/kb01/create',`,
    `    update: '/main/kb01/update',`,
    `    resync: '/main/kb01/resync',`,
    `    /** 後端是 @DeleteMapping("/delete/{sourceUuid}") */`,
    `    delete: (sourceUuid: string) => \`/main/kb01/delete/\${sourceUuid}\`,`,
    `    searchMember: '/main/kb01/searchMember',`,
    `} as const;`,
  ].join('\n'));
  // ── 宣告了但沒有任何呼叫端（本案 KB02_API.getOne 的形狀：後端沒做、前端也沒接） ──
  write(fe, 'src/api/kb02.ts', [
    `export const KB02_API = {`,
    `    search: '/main/kb02/search',`,
    `    getOne: '/main/kb02/getOne',`,
    `} as const;`,
  ].join('\n'));
  // ── 以前綴常數組字的刪除路徑（本案 src/api/sm02.ts 的形狀） ──
  write(fe, 'src/api/sm02.ts', [
    `export const SM02_API = {`,
    `    search: '/system/sm02/search',`,
    `    delete: '/system/sm02/delete',`,
    `};`,
    `export const deleteGroupApi = (groupUuid: string): string => \`\${SM02_API.delete}/\${groupUuid}\`;`,
  ].join('\n'));
  // ── 別的模組：自己的 update ＋ 借用 sm02 的查詢路徑（拆分比對陷阱：同檔有 /system/sm02 前綴與 /update 尾段） ──
  write(fe, 'src/api/sm01.ts', [
    `export const SM01_API = {`,
    `    update: '/user/sm01/update',`,
    `    groupOptions: '/system/sm02/search',`,
    `};`,
  ].join('\n'));
  // ── 巢狀常數物件 ──
  write(fe, 'src/api/nested.ts', [
    `export const NEST_API = {`,
    `    folder: {`,
    `        tree: '/main/nest/folder/tree',`,
    `    },`,
    `};`,
  ].join('\n'));
  // ── 頂層單一常數 ──
  write(fe, 'src/api/single.ts', `export const EXPORT_URL = '/main/single/export';`);
  // ── 鍵名前綴陷阱：只有 listAll 被呼叫，list 沒有 ──
  write(fe, 'src/api/prefix.ts', `export const P_API = { list: '/main/p/list', listAll: '/main/p/listAll' };`);
  write(fe, 'src/container/Prefix.tsx', `const r = await post(P_API.listAll, {});`);
  // ── 只在測試碼呼叫的常數 ──
  write(fe, 'src/api/onlytest.ts', `export const T_API = { run: '/main/onlytest/run' };`);
  write(fe, 'src/__tests__/onlytest.test.ts', `await post(T_API.run, {});`);
  // ── 只在註解裡「呼叫」的常數 ──
  write(fe, 'src/api/onlycomment.ts', `export const C_API = { run: '/main/onlycomment/run' };`);
  write(fe, 'src/container/OnlyComment.tsx', [
    `// 之後要改成 post(C_API.run, body)`,
    `export const X = 1;`,
  ].join('\n'));
  // ── 只出現在註解裡的完整規格字面（本案 searchFolderTree 的形狀） ──
  write(fe, 'src/container/KB01/ConnectionModal.tsx', [
    `/**`,
    ` *  \`POST /main/kb01/searchFolderTree\` **後端沒有實作**。`,
    ` */`,
    `export const M = 1;`,
  ].join('\n'));

  // ── 折行呼叫（prettier 把長參數拆行：helper 名稱在上一行） ──
  write(fe, 'src/api/wrap.ts', `export const W_API = { searchMember: '/main/wrap/searchMember', other: '/main/wrap/other' };`);
  write(fe, 'src/container/Wrap.tsx', [
    `const res = await post<Row>(`,
    `    W_API.searchMember,`,
    `    { keyword },`,
    `);`,
    // 上一行是另一支完整的呼叫，不可把它的 post 算到下一行的 other 身上
    `const a = await post(W_API.searchMember, {}); const b = [`,
    `    W_API.other,`,
    `];`,
  ].join('\n'));
  // ── 引用了，但 helper 名稱看不出動詞（本案 SM04 的 onDownloadFileAPI({ api: X.k })） ──
  write(fe, 'src/api/dl.ts', `export const DL_API = { exportCsv: '/main/dl/exportCsv' };`);
  write(fe, 'src/container/Dl.tsx', [
    `const ok = await onDownloadFileAPI({`,
    `    api: DL_API.exportCsv,`,
    `    data: cond,`,
    `});`,
  ].join('\n'));
  // ── e2e 治具（檔名不帶 .spec）裡的呼叫不算 ──
  write(fe, 'src/api/e2eonly.ts', `export const E_API = { run: '/main/e2eonly/run' };`);
  write(fe, 'e2e/helpers/api.ts', `await post(E_API.run, {});`);

  // ── 呼叫端 ──
  write(fe, 'src/container/KB01/Index.tsx', [
    `import { KB01_API } from '../../api/kb01';`,
    `import { SM01_API } from '../../api/sm01';`,
    `import { SM02_API, deleteGroupApi } from '../../api/sm02';`,
    `import { NEST_API } from '../../api/nested';`,
    `import { EXPORT_URL } from '../../api/single';`,
    `const a = await post<Row>(KB01_API.search, body, FAILURE_TITLE.search);`,
    `const b = await put<R>(KB01_API.update, body, FAILURE_TITLE.update);`,
    `const c = await del<unknown>(KB01_API.delete(row.sourceUuid), FAILURE_TITLE.delete);`,
    // resync 在規格是 PUT，這裡故意用 post 呼叫 → 動詞不符
    `const d = await post(KB01_API.resync, { id });`,
    `const e = await del(deleteGroupApi(row.groupUuid), '刪除失敗');`,
    `const f = await put(SM01_API.update, vo);`,
    `const g = await api.post(NEST_API.folder.tree, {});`,
    `const h = await postApi(EXPORT_URL, cond);`,
    `const i = await post(SM01_API.groupOptions, {});`,
    `const j = await post(KB01_API.searchMember, {});`,
  ].join('\n'));
});

afterAll(() => {
  fs.rmSync(fe, { recursive: true, force: true });
});

describe('路徑常數 ＋ helper 動詞：真的有接 → matched，且理由是解析到了常數與動詞', () => {
  it('post(KB01_API.search) → POST /main/kb01/search matched；note 指名常數與呼叫行', () => {
    const [r] = run(api('s', 'POST /main/kb01/search'));
    expect(r.status).toBe('matched');
    expect(r.note).toContain('matched_const_helper');
    expect(r.note).toContain('KB01_API.search');
    expect(r.evidence![0]).toEqual({ file: 'src/container/KB01/Index.tsx', line: 6 });
    expect(r.evidence).toContainEqual({ file: 'src/api/kb01.ts', line: 3 });
  });

  it('put(KB01_API.update) → PUT matched', () => {
    expect(run(api('u', 'PUT /main/kb01/update'))[0].status).toBe('matched');
  });

  it('組路徑函式 del(KB01_API.delete(x)) → DELETE /main/kb01/delete/{sourceUuid} matched', () => {
    const [r] = run(api('d', 'DELETE /main/kb01/delete/{sourceUuid}'));
    expect(r.status).toBe('matched');
    expect(r.note).toContain('KB01_API.delete');
    expect(r.evidence![0]).toEqual({ file: 'src/container/KB01/Index.tsx', line: 8 });
  });

  it('前綴常數組字 `${SM02_API.delete}/${g}` → DELETE /system/sm02/delete/{groupUuid} matched', () => {
    const [r] = run(api('g', 'DELETE /system/sm02/delete/{groupUuid}'));
    expect(r.status).toBe('matched');
    expect(r.note).toContain('deleteGroupApi');
  });

  it('巢狀常數 api.post(NEST_API.folder.tree) 與頂層常數 postApi(EXPORT_URL) 都認得', () => {
    const [n, s] = run(api('n', 'POST /main/nest/folder/tree'), api('x', 'POST /main/single/export'));
    expect(n.status).toBe('matched');
    expect(n.note).toContain('NEST_API.folder.tree');
    expect(s.status).toBe('matched');
    expect(s.note).toContain('EXPORT_URL');
  });

  it('同一個常數值被別的模組借用（SM01_API.groupOptions）也算有接', () => {
    expect(run(api('o', 'POST /system/sm02/search'))[0].status).toBe('matched');
  });
});

describe('⚠ 本來該報的還要報得出來（正對照）', () => {
  it('★ 宣告了但沒有任何呼叫端（KB02_API.getOne）→ 仍 missing，note 講明「宣告不等於有接」', () => {
    const [r] = run(api('g1', 'POST /main/kb02/getOne'));
    expect(r.status).toBe('missing');
    expect(r.note).toContain('matched_path_only');
    expect(r.note).toContain('KB02_API.getOne');
    expect(r.note).toContain('沒有任何呼叫端');
  });

  it('★ 完整字面只出現在註解（searchFolderTree）→ 仍 missing', () => {
    const [r] = run(api('f1', 'POST /main/kb01/searchFolderTree'));
    expect(r.status).toBe('missing');
    expect(r.note ?? '').not.toContain('matched_const_helper');
  });

  it('★ 動詞不符：規格 PUT，呼叫端用 post(KB01_API.resync) → missing，note 寫出實際動詞', () => {
    const [r] = run(api('r1', 'PUT /main/kb01/resync'));
    expect(r.status).toBe('missing');
    expect(r.note).toContain('POST');
    expect(r.note).toContain('KB01_API.resync');
  });

  it('★ 拆分比對陷阱：PUT /system/sm02/update 不可被 put(SM01_API.update)（/user/sm01/update）頂成 matched', () => {
    // sm01.ts 同檔有 /system/sm02 前綴與 /update 尾段 → 既有拆分比對會命中 sm01.ts 的 update 行；
    // 常數解析必須以「常數完整值 = 規格 path」為準，不能沿用拆分命中的那一行。
    const [r] = run(api('t1', 'PUT /system/sm02/update'));
    expect(r.status).toBe('missing');
  });

  it('★ 呼叫端只在測試碼 → missing', () => {
    expect(run(api('o1', 'POST /main/onlytest/run'))[0].status).toBe('missing');
  });

  it('★ 呼叫端只在註解行 → missing', () => {
    expect(run(api('c1', 'POST /main/onlycomment/run'))[0].status).toBe('missing');
  });

  it('★ 鍵名／路徑前綴不可誤中：post(P_API.listAll) 不能頂替 POST /main/p/list', () => {
    // 規格 path 的正則不錨定，/main/p/list 會命中 listAll 那一行；常數解析必須以完整值相等為準
    expect(run(api('p1', 'POST /main/p/list'))[0].status).toBe('missing');
    expect(run(api('p2', 'POST /main/p/listAll'))[0].status).toBe('matched');
  });

  it('★ 宣告了、別的常數有呼叫，但這一個沒有（KB02_API.search）→ missing', () => {
    expect(run(api('p3', 'POST /main/kb02/search'))[0].status).toBe('missing');
  });

  it('★ GET 規格不因 post 呼叫而成立（動詞一定要對得上）', () => {
    expect(run(api('m1', 'GET /main/kb01/search'))[0].status).toBe('missing');
  });
});

describe('折行呼叫、看不出動詞的引用、e2e 治具', () => {
  it('post<T>(\n X.k, …) 折行呼叫 → matched', () => {
    const [r] = run(api('w1', 'POST /main/wrap/searchMember'));
    expect(r.status).toBe('matched');
    expect(r.evidence![0]).toEqual({ file: 'src/container/Wrap.tsx', line: 2 });
  });

  it('★ 上一行是另一支完整呼叫，不可借它的 helper：W_API.other 仍 missing', () => {
    expect(run(api('w2', 'POST /main/wrap/other'))[0].status).toBe('missing');
  });

  it('★ onDownloadFileAPI({ api: X.k }) → missing，note 講明「有引用、動詞判不出來、需人工查證」', () => {
    const [r] = run(api('d1', 'POST /main/dl/exportCsv'));
    expect(r.status).toBe('missing');
    expect(r.note).toContain('src/container/Dl.tsx:2');
    expect(r.note).toContain('需人工查證');
  });

  it('★ 呼叫端只在 e2e/helpers（非 .spec 檔）→ missing', () => {
    expect(run(api('e1', 'POST /main/e2eonly/run'))[0].status).toBe('missing');
  });
});

describe('證據收集不可在弱命中上截斷（ui_text／param 同型誤判）', () => {
  let root: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-trunc-'));
    // 60 行 e2e 測試碼都寫著「查詢」，排在產品碼前面（目錄字母序 e2e < src）
    write(root, 'e2e/a11y.spec.ts', Array.from({ length: 60 }, (_, i) => `await page.click('查詢'); const page${i} = page;`).join('\n'));
    write(root, 'src/constants.ts', `export const FILTER = { search: '查詢' };\nexport const pageField = 'page';`);
    write(root, 'onlyweak/e2e/x.spec.ts', Array.from({ length: 60 }, () => `'只在測試'`).join('\n'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('★★ ui_text：前 60 筆命中都在測試碼，產品碼排在後面 → 仍 matched', () => {
    const [r] = runComplianceEngine([{ id: 'u', itemType: 'ui_text', content: '查詢', side: 'frontend', waived: false }], { frontend: root }).items;
    expect(r.status).toBe('matched');
    expect(r.evidence![0].file).toBe('src/constants.ts');
  });

  it('★★ param：同上', () => {
    const [r] = runComplianceEngine([{ id: 'p', itemType: 'param', content: 'page', side: 'frontend', waived: false }], { frontend: root }).items;
    expect(r.status).toBe('matched');
    expect(r.evidence![0].file).toBe('src/constants.ts');
  });

  it('★ 負向：命中全在測試碼（>50 筆）→ 仍 missing', () => {
    const [r] = runComplianceEngine([{ id: 'w', itemType: 'ui_text', content: '只在測試', side: 'frontend', waived: false }], { frontend: root }).items;
    expect(r.status).toBe('missing');
    expect(r.note).toContain('測試碼');
  });
});
