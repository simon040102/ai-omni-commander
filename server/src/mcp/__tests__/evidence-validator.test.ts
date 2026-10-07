import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateReviewEvidence, resolveEvidenceFile, checkRelevance, resolveProjectSpecRoots, RELEVANCE_WINDOW,
  type EvidenceCheckInput,
} from '../evidence-validator.js';
import type { WorkspaceRoots } from '../compliance-engine.js';

let feRoot: string;
let beRoot: string;

function write(root: string, relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

function input(partial: Partial<EvidenceCheckInput> & Pick<EvidenceCheckInput, 'itemType' | 'content' | 'evidence'>): EvidenceCheckInput {
  return { itemId: 'item-1', side: 'both', detail: null, ...partial };
}

beforeAll(() => {
  feRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-evidence-fe-'));
  beRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-evidence-be-'));

  write(feRoot, 'src/Index.tsx', [
    `export function Index() {`,
    `  return (`,
    `    <div>`,
    `      <h1>代理人設定作業</h1>`,
    `      <button>查詢</button>`,
    `    </div>`,
    `  );`,
    `}`,
  ].join('\n'));
  write(feRoot, 'src/api.ts', [
    `import axios from 'axios';`,
    `export function saveAgent(id: string) {`,
    '  return axios.post(`/api/wa05/agents/${id}/save`, {});',
    `}`,
  ].join('\n'));
  // 40 行檔案：目標文字只在第 1 行，行尾遠處引用會超出 ±10 窗口
  write(feRoot, 'src/Long.tsx', [
    `// 深處文字`,
    ...Array.from({ length: 39 }, (_, i) => `const filler_${i} = ${i};`),
  ].join('\n'));

  write(beRoot, 'src/main/java/AgentEntity.java', [
    `@Entity`,
    `public class AgentEntity {`,
    `  @Column(name = "AGENT_USER_ID")`,
    `  private String agentUserId;`,
    `}`,
  ].join('\n'));
  // 只含 AGENT_USER_IDX（不含 AGENT_USER_ID 這個獨立識別字）— word-boundary 測試用
  write(beRoot, 'src/main/java/Other.java', [
    `public class Other {`,
    `  private String AGENT_USER_IDX;`,
    `}`,
  ].join('\n'));

  // ── 字面比對盲點修正用 fixtures ──
  // Spring 拆分式註解：類別層 prefix 與方法層 suffix 相隔 >±10 行（超出相關性窗口）
  write(beRoot, 'src/main/java/CustLogController.java', [
    `@RestController`,
    `@RequestMapping("/fedi/cm004")`,
    `public class CustLogController {`,
    ...Array.from({ length: 12 }, (_, i) => `  private int filler${i};`),
    `  @PostMapping("/search")`,
    `  public Result search(@RequestBody CustLogQueryVo vo) {`,
    `    return Result.ok(service.search(vo));`,
    `  }`,
    `}`,
  ].join('\n'));
  // 只有尾段 /search、沒有 /fedi/cm004 prefix 的檔案 — 拆分比對不可誤放
  write(beRoot, 'src/main/java/UnrelatedSearch.java', [
    `public class UnrelatedSearch {`,
    `  private static final String PATH = "/search";`,
    `}`,
  ].join('\n'));
  write(beRoot, 'src/main/java/CustLogVo.java', [
    `public class CustLogVo {`,
    `  private String oid;`,
    `  private String uuid;`,
    `}`,
  ].join('\n'));
  write(beRoot, 'src/main/java/AdmCustLogEntity.java', [
    `@Entity`,
    `@Table(name = "ADM_CUST_LOG")`,
    `public class AdmCustLogEntity {`,
    `  @Column(name = "OID")`,
    `  private String oid;`,
    `}`,
  ].join('\n'));
  // asteroid 含 'oid' 子字串 — 葉節點比對的 word-boundary 護欄用
  write(feRoot, 'src/misc.ts', [
    `const asteroid = 1;`,
    `export const OPTION_TAG = "[OPTION]";`,
  ].join('\n'));
});

afterAll(() => {
  fs.rmSync(feRoot, { recursive: true, force: true });
  fs.rmSync(beRoot, { recursive: true, force: true });
});

describe('evidence-validator', () => {
  const roots = (): WorkspaceRoots => ({ frontend: feRoot, backend: beRoot });

  describe('valid evidence passes', () => {
    it('ui_text / api / db_field / logic 各一筆合法證據 → 無 failures', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'ui-1', itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 4 }] }),
        // api：規格寫 {id}，程式寫 ${id} — 引擎的佔位正規化視為等價
        input({ itemId: 'api-1', itemType: 'api', content: 'POST /api/wa05/agents/{id}/save', side: 'frontend', evidence: [{ file: 'src/api.ts', line: 3 }] }),
        input({ itemId: 'db-1', itemType: 'db_field', content: 'AGENT_USER_ID', side: 'backend', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 3 }] }),
        // logic：語意無法字串驗，檔案+行號有效即可
        input({ itemId: 'lg-1', itemType: 'logic', content: '查詢結果依建立日期倒序', side: 'frontend', evidence: [{ file: 'src/Long.tsx', line: 30 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('±10 行窗口：證據行不是內容所在行，但在窗口內 → 通過', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 8 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('絕對路徑在 workspace 之下 → 通過', () => {
      const abs = path.join(feRoot, 'src', 'Index.tsx');
      const failures = validateReviewEvidence([
        input({ itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: abs, line: 4 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('side=both：檔案只在 backend root 也解析得到', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'db_field', content: 'AGENT_USER_ID', side: 'both', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 3 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('side 指定的 root 未設定時退回可用 root（side 標錯不誤殺真實證據）', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'ui_text', content: '代理人設定作業', side: 'backend', evidence: [{ file: 'src/Index.tsx', line: 4 }] }),
      ], { frontend: feRoot }); // 沒有 backend root
      expect(failures).toEqual([]);
    });

    it('純 CJK 識別字（無 \\w 字元）退回 substring 比對', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'param', content: '代理人', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 4 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });
  });

  describe('invalid evidence rejected', () => {
    it('引用 node_modules 等產物目錄 → 拒（logic 也不能躲進去）', () => {
      write(feRoot, 'node_modules/some-lib/index.js', `const hidden = '代理人設定作業';`);
      const failures = validateReviewEvidence([
        input({ itemId: 'nm-1', itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'node_modules/some-lib/index.js', line: 1 }] }),
        input({ itemId: 'nm-2', itemType: 'logic', content: '任意邏輯', side: 'frontend', evidence: [{ file: 'node_modules/some-lib/index.js', line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(2);
      for (const f of failures) expect(f.reason).toContain('產物/相依目錄');
    });

    it('檔案超過 2MB 上限 → 拒', () => {
      write(feRoot, 'src/huge.txt', '代理人設定作業\n' + 'x'.repeat(2 * 1024 * 1024 + 10));
      const failures = validateReviewEvidence([
        input({ itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/huge.txt', line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('檔案過大');
    });

    it('檔案不存在 → 拒', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/Nope.tsx', line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('檔案不存在');
    });

    it('行號超界（0 / 超過檔案行數 / 非整數）→ 拒', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'a', itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 0 }] }),
        input({ itemId: 'b', itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 999 }] }),
        input({ itemId: 'c', itemType: 'logic', content: '任意邏輯', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 1.5 }] }),
      ], roots());
      expect(failures).toHaveLength(3);
      for (const f of failures) expect(f.reason).toContain('行號超界');
    });

    it(`±${RELEVANCE_WINDOW} 行窗口找不到內容 → 拒（同檔遠處引用不算）`, () => {
      // '深處文字' 只在 Long.tsx 第 1 行；引用第 30 行 → 窗口 20~40 找不到
      const failures = validateReviewEvidence([
        input({ itemType: 'ui_text', content: '深處文字', side: 'frontend', evidence: [{ file: 'src/Long.tsx', line: 30 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('找不到文字');
    });

    it('logic 免相關性：同樣的遠處引用對 logic 是合法的', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'logic', content: '深處文字相關的邏輯', side: 'frontend', evidence: [{ file: 'src/Long.tsx', line: 30 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('識別字 word-boundary：窗口內只有 AGENT_USER_IDX 時 AGENT_USER_ID 不算命中（不誤中子字串）', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'db_field', content: 'AGENT_USER_ID', side: 'backend', evidence: [{ file: 'src/main/java/Other.java', line: 2 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('識別字');
    });

    it('`..` 逃出 workspace → 拒', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'logic', content: 'x', side: 'frontend', evidence: [{ file: '../outside.txt', line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('逃出 root');
    });

    it('絕對路徑不在任何 workspace 之下 → 拒', () => {
      const outside = path.join(os.tmpdir(), 'omni-evidence-outside.txt');
      const failures = validateReviewEvidence([
        input({ itemType: 'logic', content: 'x', side: 'frontend', evidence: [{ file: outside, line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('不在 workspace');
    });

    it('api：窗口內找不到 path → 拒', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'api', content: 'POST /api/other/path', side: 'frontend', evidence: [{ file: 'src/api.ts', line: 3 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('API path');
    });
  });

  describe('helpers', () => {
    it('resolveEvidenceFile：roots 為空 → 明確失敗', () => {
      const res = resolveEvidenceFile('src/Index.tsx', []);
      expect(res.ok).toBe(false);
    });

    it('resolveEvidenceFile：目錄不算檔案', () => {
      const res = resolveEvidenceFile('src', [feRoot]);
      expect(res.ok).toBe(false);
    });

    it('checkRelevance：多行 ui_text 取首個非空行', () => {
      const reason = checkRelevance('ui_text', '\n代理人設定作業\n第二行', null, ['<h1>代理人設定作業</h1>']);
      expect(reason).toBeNull();
    });
  });

  describe('字面比對盲點修正（候選識別字 + API path 拆分）', () => {
    it('response_field resultList[].oid：證據指向 Java field 行 → 通過（葉節點候選）', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'response_field', content: 'resultList[].oid', side: 'backend', evidence: [{ file: 'src/main/java/CustLogVo.java', line: 2 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('db_field ADM_CUST_LOG.OID：證據指向 @Column 行 → 通過', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'db_field', content: 'ADM_CUST_LOG.OID', side: 'backend', evidence: [{ file: 'src/main/java/AdmCustLogEntity.java', line: 4 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('葉節點仍守 word-boundary：x[].oid 指向只有 asteroid 的行 → 拒', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'response_field', content: 'x[].oid', side: 'frontend', evidence: [{ file: 'src/misc.ts', line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
    });

    it('中括號字面 [OPTION]：證據指向字面所在行 → 通過（\\b 修正）', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'param', content: '[OPTION]', side: 'frontend', evidence: [{ file: 'src/misc.ts', line: 2 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('結構寫法 items:[{uuid}]：證據指向 uuid field 行 → 通過（token 候選）', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'param', content: 'items:[{uuid}]', side: 'backend', evidence: [{ file: 'src/main/java/CustLogVo.java', line: 3 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('API 拆分：證據指向 @PostMapping("/search") 行、類別層 prefix 在窗口外 → 通過（同檔補齊 prefix）', () => {
      const failures = validateReviewEvidence([
        // @PostMapping("/search") 在第 16 行；@RequestMapping("/fedi/cm004") 在第 2 行，超出 ±10 窗口
        input({ itemType: 'api', content: 'POST /fedi/cm004/search', side: 'backend', evidence: [{ file: 'src/main/java/CustLogController.java', line: 16 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('API 拆分：檔內只有尾段、沒有 prefix → 拒（不可只憑尾段）', () => {
      const failures = validateReviewEvidence([
        input({ itemType: 'api', content: 'POST /fedi/cm004/search', side: 'backend', evidence: [{ file: 'src/main/java/UnrelatedSearch.java', line: 2 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('API path');
    });
  });

  // ── db_field 不分大小寫，而 param / response_field 照樣分 ──────────
  //
  // 起因（2026-09-21，PF05 的 CODE_TYPE_UUID 實例）：規格寫資料庫欄位一律大寫，
  // 而 SQL 與 Java 寫小寫。大小寫敏感讓整個 db_field 型別系統性假 missing——
  // 欄位明明在，卻引不到任何一行通得過驗證的證據，於是只剩兩條路：豁免（等於把
  // 「這一項不用做」寫進紀錄，而它其實做了），或讓 missing 永遠掛著。兩條都是假的。
  //
  // 這一組真正要釘的是**第三支與第四支**：放寬不得擴散到程式識別字。
  describe('db_field 大小寫', () => {
    it('規格寫小寫、程式寫大寫 → db_field 通過', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'db-lower', itemType: 'db_field', content: 'agent_user_id', side: 'backend', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 3 }] }),
      ], roots());
      expect(failures).toEqual([]);
    });

    it('不分大小寫不代表放棄 word-boundary：AGENT_USER_IDX 不能頂替 AGENT_USER_ID', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'db-wb', itemType: 'db_field', content: 'agent_user_id', side: 'backend', evidence: [{ file: 'src/main/java/Other.java', line: 2 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
    });

    it('★ param 不比照辦理：大小寫對不上就是真的對不上', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'param-case', itemType: 'param', content: 'agentuserid', side: 'backend', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 4 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).not.toContain('不分大小寫');
    });

    it('★ response_field 同樣不比照辦理', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'resp-case', itemType: 'response_field', content: 'AGENTUSERID', side: 'backend', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 4 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
    });

    it('db_field 的失敗訊息要講明它已經不分大小寫（否則下一個人會以為是大小寫問題）', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'db-msg', itemType: 'db_field', content: 'no_such_column', side: 'backend', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 3 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('不分大小寫');
    });
  });
});


// -- 規格來源 root（交付物是規格文件的任務）------------------------------
//
// 釘住的缺陷：架構/規格類任務（architect：SA/SD 改寫、知識庫維護）的交付物不在
// frontend/backend workspace 裡（實例：專案 workspace 在 C 槽，規格在 D 槽的知識庫，
// 沒有任何相對路徑走得過去）。證據驗證只認 workspace root 時，回對員每一筆證據都被
// 「絕對路徑不在 workspace 之下」拒收、整批不寫入 run，而完工閘要求「最新 ai_review
// missing=0」——這支任務結構性地永遠結不了案，逼回對員在假證據（引 workspace 裡湊得到
// 的檔）／假 missing／誠實卡死之間選。
describe('spec roots（規格來源證據 root）', () => {
  const PROJ_A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const PROJ_B = 'bbbbbbbb-1111-2222-3333-444444444444';
  let kbRoot: string;       // 多專案共用知識庫：<kb>/<projectId>/...
  let ownSpecDir: string;   // 專案自己的規格夾（非知識庫版面）
  let aFeature: string;
  let bFeature: string;

  beforeAll(() => {
    kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-spec-kb-'));
    ownSpecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-spec-own-'));

    write(kbRoot, path.join(PROJ_A, 'features', 'F-AUDIT.md'), [
      '# F-AUDIT 稽核欄位',
      '',
      '| 參數 | 說明 |',
      '| --- | --- |',
      '| auditColumnKey | 稽核欄位鍵值 |',
      '',
      '訊息：稽核欄位設定已更新',
    ].join('\n'));
    // 產物目錄在規格 root 底下一樣不可當證據
    write(kbRoot, path.join(PROJ_A, 'node_modules', 'leaked.md'), '稽核欄位設定已更新');
    // 另一個專案的規格（同一個知識庫根底下）
    write(kbRoot, path.join(PROJ_B, 'features', 'F-OTHER.md'), [
      '# F-OTHER 別的專案',
      '訊息：稽核欄位設定已更新',
    ].join('\n'));
    write(ownSpecDir, path.join('sd', 'SD-WA05.md'), '# SD-WA05');

    aFeature = path.join(kbRoot, PROJ_A, 'features', 'F-AUDIT.md');
    bFeature = path.join(kbRoot, PROJ_B, 'features', 'F-OTHER.md');
  });

  afterAll(() => {
    fs.rmSync(kbRoot, { recursive: true, force: true });
    fs.rmSync(ownSpecDir, { recursive: true, force: true });
  });

  describe('resolveProjectSpecRoots：root 綁定專案', () => {
    it('知識庫版面：只收 <kb>/<本專案 id>，不是整個知識庫根', () => {
      expect(resolveProjectSpecRoots(PROJ_A, [kbRoot], [PROJ_A, PROJ_B]))
        .toEqual([path.join(kbRoot, PROJ_A)]);
    });

    it('★ 知識庫底下沒有本專案的子資料夾（只有別人的）→ 整個 root 不收', () => {
      const PROJ_C = 'cccccccc-1111-2222-3333-444444444444';
      expect(resolveProjectSpecRoots(PROJ_C, [kbRoot], [PROJ_A, PROJ_B, PROJ_C])).toEqual([]);
    });

    it('★ 外部工具的知識庫（子資料夾是它自己的專案編號，omni 認不得）→ 整個 root 不收', () => {
      // 真實情境：spec-agent 知識庫底下一個專案一個 UUID 目錄，那些 UUID 是 spec-agent
      // 自己的專案 id，跟 omni 的 project id 不同號。只比對「omni 已知的 project id」時
      // 這種 root 會整個被收下 → 本專案的回對員就能引用別人的規格當證據。
      const extKb = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-spec-extkb-'));
      try {
        fs.mkdirSync(path.join(extKb, '1b38d597-a9df-4d50-b2b7-2a1a9169cbba', 'features'), { recursive: true });
        fs.mkdirSync(path.join(extKb, '2a8f2dc9-6d7c-4ce1-9ffe-c13a39a7d8ca', 'features'), { recursive: true });
        expect(resolveProjectSpecRoots(PROJ_A, [extKb], [PROJ_A, PROJ_B])).toEqual([]);
        // 要用就登記自己那一棵的完整路徑（登記到哪裡就只認哪裡）
        const mine = path.join(extKb, '1b38d597-a9df-4d50-b2b7-2a1a9169cbba');
        expect(resolveProjectSpecRoots(PROJ_A, [mine], [PROJ_A, PROJ_B])).toEqual([path.normalize(mine)]);
      } finally {
        fs.rmSync(extKb, { recursive: true, force: true });
      }
    });

    it('專案自己的規格夾（底下沒有任何專案 id 子夾）→ 收資料夾本身', () => {
      expect(resolveProjectSpecRoots(PROJ_A, [ownSpecDir], [PROJ_A, PROJ_B]))
        .toEqual([path.normalize(ownSpecDir)]);
    });

    it('相對路徑、不存在的路徑、重複路徑都不進 root 清單', () => {
      const roots = resolveProjectSpecRoots(
        PROJ_A,
        ['relative/specs', path.join(kbRoot, 'no-such-dir'), ownSpecDir, ownSpecDir, '', null, undefined],
        [PROJ_A, PROJ_B],
      );
      expect(roots).toEqual([path.normalize(ownSpecDir)]);
    });
  });

  describe('證據解析', () => {
    const specRootsA = (): string[] => resolveProjectSpecRoots(PROJ_A, [kbRoot], [PROJ_A, PROJ_B]);
    const rootsWithSpec = (): WorkspaceRoots => ({ frontend: feRoot, backend: beRoot, specRoots: specRootsA() });

    it('★ 規格 root 下的檔案可通過（絕對路徑 + root 相對路徑）', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'spec-abs', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'both', evidence: [{ file: aFeature, line: 7 }] }),
        input({ itemId: 'spec-rel', itemType: 'param', content: 'auditColumnKey', side: 'both', evidence: [{ file: 'features/F-AUDIT.md', line: 5 }] }),
      ], rootsWithSpec());
      expect(failures).toEqual([]);
    });

    it('★ 不屬於本專案的規格路徑被擋下（同一個知識庫根底下的別的專案）', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'spec-other', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'both', evidence: [{ file: bFeature, line: 2 }] }),
      ], rootsWithSpec());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('不在 workspace');
    });

    it('★ 從規格 root 用 .. 逃到別的專案 → 擋下', () => {
      const escape = path.join('..', PROJ_B, 'features', 'F-OTHER.md');
      const failures = validateReviewEvidence([
        input({ itemId: 'spec-escape', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'both', evidence: [{ file: escape, line: 2 }] }),
      ], rootsWithSpec());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toMatch(/逃出|不存在/);
    });

    it('★ 規格 root 底下的產物目錄一樣不可當證據', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'spec-nm', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'both', evidence: [{ file: path.join(kbRoot, PROJ_A, 'node_modules', 'leaked.md'), line: 1 }] }),
      ], rootsWithSpec());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('產物/相依目錄');
    });

    it('★ 規格 root 存在也不放行「哪裡都不屬於」的絕對路徑', () => {
      const outside = path.join(os.tmpdir(), 'omni-nowhere-evidence.md');
      fs.writeFileSync(outside, '稽核欄位設定已更新', 'utf-8');
      try {
        const failures = validateReviewEvidence([
          input({ itemId: 'spec-nowhere', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'both', evidence: [{ file: outside, line: 1 }] }),
        ], rootsWithSpec());
        expect(failures).toHaveLength(1);
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });

    it('★ 規格 root 內的內容相關性照驗（±10 行窗口不是免驗通道）', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'spec-irrelevant', itemType: 'ui_text', content: '這句話規格裡沒有', side: 'both', evidence: [{ file: aFeature, line: 1 }] }),
      ], rootsWithSpec());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('找不到文字');
    });

    it('workspace 既有行為不回歸：加了 specRoots，workspace 內證據照樣通過、假證據照樣被擋', () => {
      const ok = validateReviewEvidence([
        input({ itemId: 'ws-1', itemType: 'ui_text', content: '代理人設定作業', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 4 }] }),
        input({ itemId: 'ws-2', itemType: 'db_field', content: 'AGENT_USER_ID', side: 'backend', evidence: [{ file: 'src/main/java/AgentEntity.java', line: 3 }] }),
      ], rootsWithSpec());
      expect(ok).toEqual([]);
      const bad = validateReviewEvidence([
        // 規格文字拿 workspace 裡湊得到的檔當證據 → 照樣不通過（假證據沒有變好過）
        input({ itemId: 'ws-fake', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'frontend', evidence: [{ file: 'src/Index.tsx', line: 4 }] }),
      ], rootsWithSpec());
      expect(bad).toHaveLength(1);
    });

    it('沒有 specRoots 時行為與修改前完全相同（規格路徑被拒）', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'no-spec-root', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'both', evidence: [{ file: aFeature, line: 7 }] }),
      ], { frontend: feRoot, backend: beRoot });
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('不在 workspace');
    });

    it('只有 specRoots、沒有 workspace 也解析得到（architect 專案）', () => {
      const failures = validateReviewEvidence([
        input({ itemId: 'spec-only', itemType: 'ui_text', content: '稽核欄位設定已更新', side: 'frontend', evidence: [{ file: 'features/F-AUDIT.md', line: 7 }] }),
      ], { specRoots: specRootsA() });
      expect(failures).toEqual([]);
    });
  });
});
