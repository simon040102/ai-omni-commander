/**
 * db_field 對「真的 DB」的核對（規格回對的第三種驗法）。
 *
 * 既有兩層都只看程式碼：程式預檢掃原始碼字面、AI 回對看 Entity/@Column/DDL。
 * 兩層都證明不了「這個欄位在正式資料庫真的存在」——DDL 檔可能沒套用、
 * Entity 可能對到別的表、規格可能寫了一個從沒建過的欄位。
 * 這一層直接查 INFORMATION_SCHEMA，拿實體 schema 當事實來源。
 *
 * 純函式，不碰連線；連線在 db-tools.ts。
 */

/** 一個資料表欄位（來自 INFORMATION_SCHEMA.COLUMNS）。 */
export interface DbColumn {
  table: string;
  column: string;
  dataType: string;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  nullable: boolean;
}

export type DbFieldVerdict =
  /** 表與欄位都在實體 DB 找到 */
  | 'exists'
  /** 表存在，但這張表沒有這個欄位 —— 規格或程式其中一邊錯了 */
  | 'column_not_found'
  /** 整張表在 DB 裡不存在 */
  | 'table_not_found'
  /** 檢查項只寫了欄位名沒寫表名，無法定位；退而找「有沒有任何表有這個欄位」 */
  | 'column_found_unqualified'
  | 'column_not_found_anywhere'
  /** 這次沒把該表的 schema 撈進來，無從判定（不可當成通過） */
  | 'not_checked';

export interface DbFieldCheckResult {
  itemId: string;
  content: string;
  table: string | null;
  column: string;
  verdict: DbFieldVerdict;
  /** 找到時的實體欄位資訊，供與 SD 規格的型別/長度比對 */
  actual?: DbColumn;
  /** 找到的其他候選表（unqualified 命中時列出） */
  foundIn?: string[];
  note: string;
}

/**
 * 從檢查項的 content 拆出「表名.欄位名」。
 *
 * 規格寫法很雜，這裡只認明確的形式，**不猜**：
 *   `ADM_CUST_LOG.OID`      → { table: 'ADM_CUST_LOG', column: 'OID' }
 *   `dbo.ADM_CUST_LOG.OID`  → { table: 'ADM_CUST_LOG', column: 'OID' }（schema 前綴丟掉）
 *   `OID`                   → { table: null, column: 'OID' }
 * 帶空白、中文說明、括號的一律取最後一段識別字當欄位名。
 */
export function parseDbFieldRef(content: string): { table: string | null; column: string } {
  const cleaned = content.trim().replace(/[（(].*?[)）]/g, '').trim();
  const m = cleaned.match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/);
  if (!m) return { table: null, column: cleaned };
  const parts = m[1].split('.');
  const column = parts[parts.length - 1]!;
  // dbo.TABLE.COL → 取倒數第二段當表名；TABLE.COL → 同理；單一段 → 沒有表名
  const table = parts.length >= 2 ? parts[parts.length - 2]! : null;
  return { table, column };
}

/** 大小寫無關的索引：table → Set<column>，外加 column → tables 反查。 */
export function indexSchema(columns: DbColumn[]): {
  byTable: Map<string, Map<string, DbColumn>>;
  byColumn: Map<string, string[]>;
} {
  const byTable = new Map<string, Map<string, DbColumn>>();
  const byColumn = new Map<string, string[]>();
  for (const c of columns) {
    const t = c.table.toUpperCase();
    const col = c.column.toUpperCase();
    if (!byTable.has(t)) byTable.set(t, new Map());
    byTable.get(t)!.set(col, c);
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)!.push(c.table);
  }
  return { byTable, byColumn };
}

export interface DbFieldItem {
  id: string;
  content: string;
}

/**
 * 逐項核對。`checkedTables` 是這次真的撈了 schema 的表（大寫）；
 * 沒撈到的表一律 `not_checked`——**絕不因為「沒查到」就判通過**。
 */
export function checkDbFields(
  items: DbFieldItem[],
  columns: DbColumn[],
  checkedTables?: string[],
): DbFieldCheckResult[] {
  const { byTable, byColumn } = indexSchema(columns);
  const checked = checkedTables ? new Set(checkedTables.map(t => t.toUpperCase())) : null;

  return items.map((item) => {
    const { table, column } = parseDbFieldRef(item.content);
    const colU = column.toUpperCase();
    const base = { itemId: item.id, content: item.content, table, column };

    if (table) {
      const tU = table.toUpperCase();
      const cols = byTable.get(tU);
      if (!cols) {
        // 這張表這次有撈但 DB 裡沒有 → 表真的不存在；沒撈 → 無從判定
        const wasChecked = checked ? checked.has(tU) : byTable.size > 0;
        return wasChecked
          ? { ...base, verdict: 'table_not_found' as const, note: `實體 DB 找不到資料表 ${table}` }
          : { ...base, verdict: 'not_checked' as const, note: `未撈取 ${table} 的 schema，無法判定` };
      }
      const actual = cols.get(colU);
      return actual
        ? { ...base, verdict: 'exists' as const, actual, note: `${table}.${actual.column} ${describeColumn(actual)}` }
        : { ...base, verdict: 'column_not_found' as const, note: `資料表 ${table} 實際沒有欄位 ${column}` };
    }

    // 沒寫表名：只能回答「DB 裡有沒有任何表有這個欄位」，資訊量較弱，據實標示
    const foundIn = byColumn.get(colU);
    if (foundIn?.length) {
      const actual = byTable.get(foundIn[0]!.toUpperCase())!.get(colU)!;
      return {
        ...base,
        verdict: 'column_found_unqualified' as const,
        actual,
        foundIn: [...new Set(foundIn)],
        note: `檢查項沒寫表名；欄位 ${column} 出現在 ${[...new Set(foundIn)].slice(0, 5).join(', ')}`,
      };
    }
    return {
      ...base,
      verdict: 'column_not_found_anywhere' as const,
      note: `已撈取的表裡都沒有欄位 ${column}`,
    };
  });
}

/** 把欄位型別寫成人看得懂的一行：`VARCHAR(20) NOT NULL`。 */
export function describeColumn(c: DbColumn): string {
  let t = c.dataType.toUpperCase();
  if (c.maxLength != null && /CHAR|BINARY/i.test(c.dataType)) {
    t += `(${c.maxLength === -1 ? 'MAX' : c.maxLength})`;
  } else if (c.numericPrecision != null && /DECIMAL|NUMERIC/i.test(c.dataType)) {
    t += `(${c.numericPrecision}${c.numericScale != null ? `,${c.numericScale}` : ''})`;
  }
  return `${t} ${c.nullable ? 'NULL' : 'NOT NULL'}`;
}

/** verdict 是否代表「這個欄位在實體 DB 確實存在」。 */
export function isConfirmed(v: DbFieldVerdict): boolean {
  return v === 'exists' || v === 'column_found_unqualified';
}

/** verdict 是否代表「實體 DB 明確說沒有」——這種要判 missing，不是無從判定。 */
export function isRefuted(v: DbFieldVerdict): boolean {
  return v === 'column_not_found' || v === 'table_not_found' || v === 'column_not_found_anywhere';
}

/** 產生 MCP 回應用的摘要文字（人看的，不用工具術語）。 */
export function summarize(results: DbFieldCheckResult[]): string {
  const n = (f: (v: DbFieldVerdict) => boolean) => results.filter(r => f(r.verdict)).length;
  return `共 ${results.length} 個資料表欄位：實體 DB 確實有 ${n(isConfirmed)}　實體 DB 沒有 ${n(isRefuted)}　無從判定 ${n(v => v === 'not_checked')}`;
}
