import { describe, it, expect } from 'vitest';
import { extractFunctionCode, extractFunctionCodeFromSpecFilenames } from '../SvnSpecService.js';

describe('extractFunctionCode', () => {
  it('從任務名/檔名抽代碼', () => {
    expect(extractFunctionCode('DF08_公文查詢')).toBe('DF08');
    expect(extractFunctionCode('OV0101 銷項發票')).toBe('OV0101');
    expect(extractFunctionCode('SM002_系統參數')).toBe('SM002');
  });
  it('純中文任務名 → null（正是要靠檔名 fallback 的情況）', () => {
    expect(extractFunctionCode('系統參數')).toBeNull();
    expect(extractFunctionCode('前端')).toBeNull();
    expect(extractFunctionCode('系統參數放行')).toBeNull();
  });
});

describe('extractFunctionCodeFromSpecFilenames（純中文任務名的 fallback）', () => {
  it('從綁定規格檔名抽代碼（去 [SA] 前綴與副檔名）', () => {
    expect(extractFunctionCodeFromSpecFilenames(['[SA] SM002_系統參數.md'])).toBe('SM002');
    expect(extractFunctionCodeFromSpecFilenames(['SM002_系統參數.md'])).toBe('SM002');
  });

  it('過度綁定時以任務名精確吻合檔名中文名者優先（系統參數→SM002、系統參數放行→SM09）', () => {
    const bound = ['[SA] SM002_系統參數.md', '[SA] SM009_系統參數放行.md'];
    expect(extractFunctionCodeFromSpecFilenames(bound, '系統參數')).toBe('SM002');
    expect(extractFunctionCodeFromSpecFilenames(bound, '系統參數放行')).toBe('SM009');
  });

  it('無精確吻合 → 字典序最小（穩定、偏好主功能）', () => {
    const bound = ['[SA] SM009_系統參數放行.md', '[SA] SM002_系統參數.md'];
    expect(extractFunctionCodeFromSpecFilenames(bound, '不吻合的名字')).toBe('SM002');
    expect(extractFunctionCodeFromSpecFilenames(bound, null)).toBe('SM002');
  });

  it('沒有任何檔名含代碼 → null（真正的共用）', () => {
    expect(extractFunctionCodeFromSpecFilenames(['共用元件說明.md'])).toBeNull();
    expect(extractFunctionCodeFromSpecFilenames([])).toBeNull();
  });
});
