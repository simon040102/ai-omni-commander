/**
 * 證據的補充 root（extraRoots）與禁區（excludedRoots）。
 *
 * 實測回饋：前端項目引用後端的遷移檔、repo 根目錄的 docs/.github/tools/shared，一律被拒，
 * 7 張做完、審查通過的任務卡在結案。補充 root 只**接在原本順序的最後**：原本解析得到的路徑
 * 照舊解析到同一個檔案，只有原本被拒的才有機會找到；內容比對、`..` 防護、大小上限不變。
 * omni 自己的資料目錄（派工計畫、裁決全文、下載的附件＝規格原文的複本）一律不收，
 * 否則就是拿規格證明規格。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateReviewEvidence, type EvidenceCheckInput } from '../evidence-validator.js';
import type { WorkspaceRoots } from '../compliance-engine.js';

let proj: string;
let spec: string;
const w = (root: string, rel: string, content: string) => {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
};
const item = (p: Partial<EvidenceCheckInput> & Pick<EvidenceCheckInput, 'itemType' | 'content' | 'evidence'>): EvidenceCheckInput =>
  ({ itemId: 'i', side: 'frontend', detail: null, ...p });

beforeAll(() => {
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-proj-'));
  spec = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-spec-'));
  w(proj, 'web/src/App.tsx', 'export const App = () => null;\n');
  w(proj, 'server/db/V123__add_col.sql', 'ALTER TABLE agent ADD COLUMN AGENT_NOTE VARCHAR(200);\n');
  w(proj, 'docs/deploy.md', '# 部署\n執行 deploy.sh 後確認容器健康檢查通過\n');
  w(proj, 'shared/src/messages.ts', "export const MSG = '資料已儲存';\n");
  w(proj, 'data/plans/t-1-frontend-full.md', '規格原文：資料已儲存\n');
  // 同一相對路徑同時存在於規格 root 與專案根目錄：原本解析到規格 root，加了補充 root 後不可變
  w(spec, 'docs/same.md', '規格版本：唯一字樣甲\n');
  w(proj, 'docs/same.md', '專案版本：唯一字樣乙\n');
});

afterAll(() => {
  fs.rmSync(proj, { recursive: true, force: true });
  fs.rmSync(spec, { recursive: true, force: true });
});

const base = (): WorkspaceRoots => ({ frontend: path.join(proj, 'web'), specRoots: [spec] });
const withExtra = (): WorkspaceRoots => ({
  ...base(),
  extraRoots: [path.join(proj, 'server'), proj],
  excludedRoots: [path.join(proj, 'data')],
});

describe('evidence extraRoots / excludedRoots', () => {
  it('前端項目引用後端的遷移檔：沒有補充 root 照舊拒收；有補充 root 就收', () => {
    const ev = [item({ itemType: 'db_field', content: 'AGENT_NOTE', evidence: [{ file: 'db/V123__add_col.sql', line: 1 }] })];
    expect(validateReviewEvidence(ev, base())).toHaveLength(1);
    expect(validateReviewEvidence(ev, withExtra())).toEqual([]);
    // 絕對路徑也一樣
    const abs = [item({ itemType: 'db_field', content: 'AGENT_NOTE', evidence: [{ file: path.join(proj, 'server', 'db', 'V123__add_col.sql'), line: 1 }] })];
    expect(validateReviewEvidence(abs, withExtra())).toEqual([]);
  });

  it('repo 根目錄的 docs／shared 可以引用（相對專案根目錄）', () => {
    expect(validateReviewEvidence([
      item({ itemType: 'logic', content: '部署後容器健康檢查', evidence: [{ file: 'docs/deploy.md', line: 2 }] }),
      item({ itemType: 'ui_text', content: '資料已儲存', evidence: [{ file: 'shared/src/messages.ts', line: 1 }] }),
    ], withExtra())).toEqual([]);
  });

  it('原本能解析的路徑結果不變：規格 root 先於補充 root', () => {
    // docs/same.md 在規格 root 與專案根目錄都有；原本解析到規格 root（甲），補充 root 不可搶走
    expect(validateReviewEvidence([item({ itemType: 'ui_text', content: '唯一字樣甲', evidence: [{ file: 'docs/same.md', line: 1 }] })], withExtra())).toEqual([]);
    expect(validateReviewEvidence([item({ itemType: 'ui_text', content: '唯一字樣乙', evidence: [{ file: 'docs/same.md', line: 1 }] })], withExtra())).toHaveLength(1);
  });

  it('omni 資料目錄（計畫檔、裁決、附件）一律拒收——相對或絕對路徑都一樣', () => {
    const rel = validateReviewEvidence([item({ itemType: 'ui_text', content: '資料已儲存', evidence: [{ file: 'data/plans/t-1-frontend-full.md', line: 1 }] })], withExtra());
    expect(rel).toHaveLength(1);
    expect(rel[0]!.reason).toContain('omni 的資料目錄');
    const abs = validateReviewEvidence([item({ itemType: 'ui_text', content: '資料已儲存', evidence: [{ file: path.join(proj, 'data', 'plans', 't-1-frontend-full.md'), line: 1 }] })], withExtra());
    expect(abs).toHaveLength(1);
    expect(abs[0]!.reason).toContain('omni 的資料目錄');
  });

  it('`..` 逃出所有 root 照舊拒收', () => {
    expect(validateReviewEvidence([item({ itemType: 'logic', content: 'x', evidence: [{ file: '../../../etc/hosts', line: 1 }] })], withExtra())).toHaveLength(1);
  });
});
