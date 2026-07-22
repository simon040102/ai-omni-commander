import { describe, it, expect } from 'vitest';
import { taskFunctionCode, type FunctionCodeDb } from '../taskFunctionCode.js';

/**
 * Fake better-sqlite3 surface: distinguishes the two prepared statements by SQL —
 * the custom_fields lookup vs the task_documents (spec filename) join.
 */
function makeDb(opts: { customFields?: Record<string, string> | null; filenames?: string[] }): FunctionCodeDb {
  return {
    prepare(sql: string) {
      if (sql.includes('task_documents')) {
        return {
          all: () => (opts.filenames || []).map(f => ({ filename: f })),
          get: () => undefined,
        };
      }
      // SELECT custom_fields FROM tasks
      return {
        get: () => (opts.customFields === undefined
          ? { custom_fields: null }
          : { custom_fields: opts.customFields === null ? null : JSON.stringify(opts.customFields) }),
        all: () => [],
      };
    },
  };
}

describe('taskFunctionCode 來源優先序', () => {
  it('custom field「功能代碼」最優先（勝過 parent_name 與 title）', () => {
    const db = makeDb({ customFields: { 功能代碼: 'SM07' } });
    expect(taskFunctionCode(db, 'task-1', 'DF08_公文查詢', 'CM00 客戶')).toBe('SM07');
  });

  it('custom field 值夾雜文字 → 用 extractFunctionCode 正規化', () => {
    const db = makeDb({ customFields: { 功能代碼: 'SM07 系統管理' } });
    expect(taskFunctionCode(db, 'task-1', null, null)).toBe('SM07');
  });

  it('custom field 為模組層粗碼（純字母，如 LM）→ 照用（比 UUID 短碼好）', () => {
    const db = makeDb({ customFields: { 功能代碼: 'LM' } });
    expect(taskFunctionCode(db, 'task-1', null, null)).toBe('LM');
  });

  it('custom field 為細碼 LM01 → 原樣', () => {
    const db = makeDb({ customFields: { 功能代碼: 'LM01' } });
    expect(taskFunctionCode(db, 'task-1', null, null)).toBe('LM01');
  });

  it('custom field 空字串 / 非代碼樣式（純中文）→ 退回 parent_name', () => {
    const dbEmpty = makeDb({ customFields: { 功能代碼: '' } });
    expect(taskFunctionCode(dbEmpty, 'task-1', 'DF08_公文', null)).toBe('DF08');
    const dbChinese = makeDb({ customFields: { 功能代碼: '系統管理' } });
    expect(taskFunctionCode(dbChinese, 'task-1', 'DF08_公文', null)).toBe('DF08');
  });

  it('無 custom field → parent_name 優先於 title', () => {
    const db = makeDb({ customFields: null });
    expect(taskFunctionCode(db, 'task-1', 'DF08_發文', 'OV0101 銷項')).toBe('DF08');
  });

  it('無 custom field、parent_name 無碼 → 退回 title 抽取', () => {
    const db = makeDb({ customFields: null });
    expect(taskFunctionCode(db, 'task-1', '純中文母任務', 'OV0101 銷項')).toBe('OV0101');
  });

  it('林同棪案例：無 custom field、純中文任務名 → 從綁定規格檔名抽（精確吻合優先），不被打壞', () => {
    const db = makeDb({
      customFields: null,
      filenames: ['[SA] SM002_系統參數.md', '[SA] SM009_系統參數放行.md'],
    });
    expect(taskFunctionCode(db, 'task-1', '系統參數', '系統參數')).toBe('SM002');
    const db2 = makeDb({
      customFields: null,
      filenames: ['[SA] SM002_系統參數.md', '[SA] SM009_系統參數放行.md'],
    });
    expect(taskFunctionCode(db2, 'task-2', '系統參數放行', '系統參數放行')).toBe('SM009');
  });

  it('全部落空（無 cf、純中文、無綁定規格）→ null（真正的共用）', () => {
    const db = makeDb({ customFields: null, filenames: [] });
    expect(taskFunctionCode(db, 'task-1', '系統參數', '系統參數')).toBeNull();
  });

  it('custom_fields JSON 損毀 → 不炸，退回既有鏈', () => {
    const db: FunctionCodeDb = {
      prepare(sql: string) {
        if (sql.includes('task_documents')) return { all: () => [], get: () => undefined };
        return { get: () => ({ custom_fields: '{not json' }), all: () => [] };
      },
    };
    expect(taskFunctionCode(db, 'task-1', 'DF08_公文', null)).toBe('DF08');
  });

  it('自訂欄位名可覆寫', () => {
    const db = makeDb({ customFields: { 'Feature Code': 'AB01' } });
    expect(taskFunctionCode(db, 'task-1', null, null, 'Feature Code')).toBe('AB01');
  });
});
