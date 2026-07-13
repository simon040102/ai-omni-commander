/**
 * SpecFetchPolicy — 規格抓取共用決策純函式單元測試。
 * 三個對齊點各自固定行為：中文名 fallback、content_hash 去重決策、prepare 失敗歸類。
 */
import { describe, it, expect } from 'vitest';
import {
  extractChineseNames,
  decideDedupe,
  classifyPrepareResult,
  type ExistingDocInfo,
} from '../SpecFetchPolicy.js';

describe('extractChineseNames', () => {
  it('strips leading function code: "DF01_收文單" → ["收文單"]', () => {
    expect(extractChineseNames('DF01_收文單')).toEqual(['收文單']);
  });

  it('strips trailing 前端/後端/串接 suffixes', () => {
    expect(extractChineseNames('收文單_前端')).toEqual(['收文單']);
    expect(extractChineseNames('收文單_後端')).toEqual(['收文單']);
    expect(extractChineseNames('收文單 串接')).toEqual(['收文單']);
  });

  it('strips both code prefix and role suffix: "DF01_收文單_前端" → ["收文單"]', () => {
    expect(extractChineseNames('DF01_收文單_前端')).toEqual(['收文單']);
  });

  it('returns empty for pure-ASCII text (no CJK)', () => {
    expect(extractChineseNames('DF01_frontend')).toEqual([]);
  });

  it('handles multiple sources with dedupe, preserving order', () => {
    expect(extractChineseNames('DF01_收文單', 'DF01_收文單_前端')).toEqual(['收文單']);
    expect(extractChineseNames('DF01_收文單', 'DF02_發文單')).toEqual(['收文單', '發文單']);
  });

  it('skips null / undefined / empty sources', () => {
    expect(extractChineseNames(null, undefined, '', 'DF01_收文單')).toEqual(['收文單']);
    expect(extractChineseNames(null, undefined)).toEqual([]);
  });
});

describe('decideDedupe', () => {
  const existing = (over: Partial<ExistingDocInfo> = {}): ExistingDocInfo => ({
    version: 'v1',
    contentHash: 'hash-a',
    fileExists: true,
    ...over,
  });

  it('no existing row → insert', () => {
    expect(decideDedupe(null, 'v1', null)).toBe('insert');
    expect(decideDedupe(null, 'v1', 'hash-a')).toBe('insert');
  });

  it('version unchanged + file on disk → skip (stage 1, no content needed)', () => {
    expect(decideDedupe(existing(), 'v1', null)).toBe('skip');
  });

  it('version unchanged but cached file missing → not skip (must re-fetch)', () => {
    expect(decideDedupe(existing({ fileExists: false }), 'v1', null)).toBe('update');
  });

  it('unknown new version (null/empty) never skips', () => {
    expect(decideDedupe(existing({ version: null }), null, null)).toBe('update');
    expect(decideDedupe(existing({ version: '' }), '', null)).toBe('update');
  });

  it('version changed + identical content hash → bump_version', () => {
    expect(decideDedupe(existing(), 'v2', 'hash-a')).toBe('bump_version');
  });

  it('version changed + different content hash → update', () => {
    expect(decideDedupe(existing(), 'v2', 'hash-b')).toBe('update');
  });

  it('identical hash but cached file missing → update (rewrite file)', () => {
    expect(decideDedupe(existing({ fileExists: false }), 'v2', 'hash-a')).toBe('update');
  });

  it('legacy row without content_hash → update (cannot prove identity)', () => {
    expect(decideDedupe(existing({ contentHash: null }), 'v2', 'hash-a')).toBe('update');
  });
});

describe('classifyPrepareResult', () => {
  it('ok with pull/dirty warnings → warnings (path-prefixed), no errors', () => {
    const issues = classifyPrepareResult('D:\\specs', {
      ok: true,
      warnings: ['git pull --ff-only 失敗（使用現有內容）：timeout', 'git working tree 有未提交變更（dirty），跳過 pull（使用現有內容，絕不 stash/reset）'],
    });
    expect(issues.errors).toEqual([]);
    expect(issues.warnings).toHaveLength(2);
    expect(issues.warnings[0]).toBe('D:\\specs: git pull --ff-only 失敗（使用現有內容）：timeout');
    expect(issues.warnings[1]).toContain('dirty');
  });

  it('folder completely unusable → error (uses prepare error message)', () => {
    const issues = classifyPrepareResult('D:\\missing', {
      ok: false,
      warnings: [],
      error: '規格資料夾不存在或無法存取：D:\\missing',
    });
    expect(issues.errors).toEqual(['規格資料夾不存在或無法存取：D:\\missing']);
    expect(issues.warnings).toEqual([]);
  });

  it('unusable without a specific message → fallback error text with the path', () => {
    const issues = classifyPrepareResult('D:\\missing', { ok: false, warnings: [] });
    expect(issues.errors).toEqual(['規格資料夾無法使用：D:\\missing']);
  });

  it('unusable folder can still carry warnings collected before failing', () => {
    const issues = classifyPrepareResult('D:\\x', { ok: false, warnings: ['w1'], error: 'e1' });
    expect(issues.errors).toEqual(['e1']);
    expect(issues.warnings).toEqual(['D:\\x: w1']);
  });
});
