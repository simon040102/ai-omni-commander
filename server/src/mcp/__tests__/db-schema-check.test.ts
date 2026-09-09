import { describe, it, expect } from 'vitest';
import {
  parseDbFieldRef, checkDbFields, describeColumn, isConfirmed, isRefuted, summarize,
  type DbColumn,
} from '../db-schema-check.js';

const col = (table: string, column: string, over: Partial<DbColumn> = {}): DbColumn => ({
  table, column, dataType: 'varchar', maxLength: 20,
  numericPrecision: null, numericScale: null, nullable: false, ...over,
});

describe('parseDbFieldRef', () => {
  it('拆出表名與欄位名', () => {
    expect(parseDbFieldRef('ADM_CUST_LOG.OID')).toEqual({ table: 'ADM_CUST_LOG', column: 'OID' });
  });
  it('丟掉 schema 前綴，只留表名', () => {
    expect(parseDbFieldRef('dbo.ADM_CUST_LOG.OID')).toEqual({ table: 'ADM_CUST_LOG', column: 'OID' });
  });
  it('只有欄位名時表名為 null', () => {
    expect(parseDbFieldRef('OID')).toEqual({ table: null, column: 'OID' });
  });
  it('括號說明不影響解析', () => {
    expect(parseDbFieldRef('FEDI_ESTATUS.PAY_DATE（付款日期）')).toEqual({ table: 'FEDI_ESTATUS', column: 'PAY_DATE' });
  });
});

describe('checkDbFields', () => {
  const schema = [col('FEDI_ESTATUS', 'PAY_DATE'), col('FEDI_ESTATUS', 'MSG_ID'), col('FEDI_PAYEXT', 'REF_DTM_1')];

  it('表與欄位都在 → exists', () => {
    const [r] = checkDbFields([{ id: '1', content: 'FEDI_ESTATUS.PAY_DATE' }], schema, ['FEDI_ESTATUS']);
    expect(r.verdict).toBe('exists');
    expect(isConfirmed(r.verdict)).toBe(true);
    expect(r.actual?.column).toBe('PAY_DATE');
  });

  it('表在但欄位不在 → column_not_found（要判 missing）', () => {
    const [r] = checkDbFields([{ id: '1', content: 'FEDI_ESTATUS.NO_SUCH_COL' }], schema, ['FEDI_ESTATUS']);
    expect(r.verdict).toBe('column_not_found');
    expect(isRefuted(r.verdict)).toBe(true);
  });

  it('有撈但整張表不存在 → table_not_found', () => {
    const [r] = checkDbFields([{ id: '1', content: 'NO_SUCH_TABLE.COL' }], schema, ['NO_SUCH_TABLE']);
    expect(r.verdict).toBe('table_not_found');
    expect(isRefuted(r.verdict)).toBe(true);
  });

  it('沒撈該表 → not_checked，且絕不算通過也不算否定', () => {
    const [r] = checkDbFields([{ id: '1', content: 'OTHER_TABLE.COL' }], schema, ['FEDI_ESTATUS']);
    expect(r.verdict).toBe('not_checked');
    expect(isConfirmed(r.verdict)).toBe(false);
    expect(isRefuted(r.verdict)).toBe(false);
  });

  it('沒寫表名但某張表有該欄位 → 弱命中，並列出是哪些表', () => {
    const [r] = checkDbFields([{ id: '1', content: 'REF_DTM_1' }], schema, ['FEDI_ESTATUS', 'FEDI_PAYEXT']);
    expect(r.verdict).toBe('column_found_unqualified');
    expect(isConfirmed(r.verdict)).toBe(true);
    expect(r.foundIn).toEqual(['FEDI_PAYEXT']);
  });

  it('沒寫表名且沒有任何表有該欄位 → 判否定', () => {
    const [r] = checkDbFields([{ id: '1', content: 'NOPE' }], schema, ['FEDI_ESTATUS']);
    expect(r.verdict).toBe('column_not_found_anywhere');
    expect(isRefuted(r.verdict)).toBe(true);
  });

  it('大小寫不影響比對', () => {
    const [r] = checkDbFields([{ id: '1', content: 'fedi_estatus.pay_date' }], schema, ['FEDI_ESTATUS']);
    expect(r.verdict).toBe('exists');
  });
});

describe('describeColumn', () => {
  it('字串型別帶長度', () => {
    expect(describeColumn(col('T', 'C', { dataType: 'varchar', maxLength: 14 }))).toBe('VARCHAR(14) NOT NULL');
  });
  it('MAX 長度顯示成 MAX', () => {
    expect(describeColumn(col('T', 'C', { dataType: 'varchar', maxLength: -1 }))).toBe('VARCHAR(MAX) NOT NULL');
  });
  it('數值型別帶精度與位數', () => {
    expect(describeColumn(col('T', 'C', {
      dataType: 'numeric', maxLength: null, numericPrecision: 18, numericScale: 0, nullable: true,
    }))).toBe('NUMERIC(18,0) NULL');
  });
});

describe('summarize', () => {
  it('無從判定單獨計數，不併進符合', () => {
    const schema = [col('T', 'A')];
    const results = checkDbFields(
      [{ id: '1', content: 'T.A' }, { id: '2', content: 'T.B' }, { id: '3', content: 'OTHER.C' }],
      schema, ['T'],
    );
    expect(summarize(results)).toContain('確實有 1');
    expect(summarize(results)).toContain('沒有 1');
    expect(summarize(results)).toContain('無從判定 1');
  });
});
