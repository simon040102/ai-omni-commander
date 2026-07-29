import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateReviewEvidence, resolveEvidenceFile, checkRelevance, RELEVANCE_WINDOW,
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
      expect(failures[0].reason).toContain('逃出 workspace');
    });

    it('絕對路徑不在任何 workspace 之下 → 拒', () => {
      const outside = path.join(os.tmpdir(), 'omni-evidence-outside.txt');
      const failures = validateReviewEvidence([
        input({ itemType: 'logic', content: 'x', side: 'frontend', evidence: [{ file: outside, line: 1 }] }),
      ], roots());
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('不在 workspace 之下');
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
});
