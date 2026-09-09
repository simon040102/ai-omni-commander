/**
 * MCP tools for querying external databases.
 * query_external_db, verify_db_schema
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import mssql from 'mssql';
import { getMcpDb } from '../db.js';
import { CHARACTER_LIMIT } from '../helpers.js';
import {
  checkDbFields, describeColumn, isConfirmed, isRefuted, parseDbFieldRef, summarize,
  type DbColumn, type DbFieldItem,
} from '../db-schema-check.js';

/** verify_db_schema 一次最多撈幾張表的 schema（避免一次拉爆整個資料庫）。 */
export const VERIFY_SCHEMA_MAX_TABLES = 40;

interface DbConnection {
  label: string;
  server?: string;
  database?: string;
  user?: string;
  password?: string;
  port?: number;
  connectionString?: string;
  dbType?: string;
}

function parseConnectionString(connStr: string): { server: string; database: string; user: string; password: string; port?: number } {
  const parts: Record<string, string> = {};
  for (const part of connStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.substring(0, eq).trim().toLowerCase();
      const val = part.substring(eq + 1).trim();
      parts[key] = val;
    }
  }
  const server = parts['server'] || parts['data source'] || '';
  const database = parts['database'] || parts['initial catalog'] || '';
  const user = parts['user id'] || parts['uid'] || parts['user'] || '';
  const password = parts['password'] || parts['pwd'] || '';
  const portMatch = server.match(/,(\d+)$/);
  return {
    server: portMatch ? server.replace(/,\d+$/, '') : server,
    database,
    user,
    password,
    port: portMatch ? parseInt(portMatch[1], 10) : undefined,
  };
}

const FORBIDDEN_SQL_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE',
  'EXEC', 'EXECUTE', 'MERGE', 'GRANT', 'REVOKE', 'INTO', 'WAITFOR',
];

/** Strip string literals (handles '' escaping) so keywords/semicolons inside strings don't count. */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Shared forbidden-keyword scan over an already-literal-stripped SQL body. */
function findForbiddenKeyword(body: string): string | null {
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(body)) return kw;
  }
  // xp_ 擴充系統程序（xp_cmdshell 等）——即使沒有 EXEC 也擋。
  // sp_ 不在此列：sp_ 需 EXEC 才能執行，而 EXEC 已在上方關鍵字禁列。
  if (/\bxp_\w+/i.test(body)) return 'xp_*';
  return null;
}

/**
 * Guard for the select action: must be a single read-only SELECT statement.
 * Exported for tests. NOTE: this is a defensive aid only — the connection
 * account itself should be read-only (db_datareader).
 */
export function validateSelectSql(sql: string): string | null {
  const trimmed = sql.trim();
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return 'Error: Only SELECT (or WITH ... SELECT) statements are allowed';
  }
  const withoutStrings = stripStringLiterals(trimmed);
  // Reject multiple statements — a single trailing semicolon is allowed
  const body = withoutStrings.replace(/;\s*$/, '');
  if (body.includes(';')) {
    return 'Error: Multiple SQL statements are not allowed';
  }
  const kw = findForbiddenKeyword(body);
  if (kw) return `Error: Forbidden keyword "${kw}" detected in SQL`;
  return null;
}

/**
 * Guard for count/sample 的 tableName：僅允許單純識別字（可含 schema 前綴），
 * 通過後仍會用 INFORMATION_SCHEMA 參數綁定確認表存在（雙重防線）。
 */
export function validateTableIdentifier(tableName: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(tableName.trim())) {
    return `Error: Invalid table name "${tableName}" — only plain identifiers (optionally schema.table) are allowed`;
  }
  return null;
}

/**
 * Guard for count/sample 的 where 條件片段（不含 WHERE 關鍵字本身）：
 * 禁分號、註解（-- 與 slash-star）、與 validateSelectSql 同一組破壞性關鍵字（含 xp_）。
 * Exported for tests。同樣僅為輔助防線——連線帳號本身應為唯讀。
 */
export function validateWhereClause(where: string): string | null {
  const trimmed = where.trim();
  if (!trimmed) return null;
  const withoutStrings = stripStringLiterals(trimmed);
  if (withoutStrings.includes(';')) {
    return 'Error: Semicolons are not allowed in the where clause';
  }
  if (withoutStrings.includes('--') || withoutStrings.includes('/*')) {
    return 'Error: SQL comments are not allowed in the where clause';
  }
  const kw = findForbiddenKeyword(withoutStrings);
  if (kw) return `Error: Forbidden keyword "${kw}" detected in the where clause`;
  return null;
}

/** count/sample 的 sample 上限（預設 5、上限 50）。 */
export const SAMPLE_DEFAULT_LIMIT = 5;
export const SAMPLE_MAX_LIMIT = 50;

/** Split an optionally schema-qualified table name into [schema?, table], both validated identifiers. */
function splitTableName(tableName: string): { schema: string | null; table: string } {
  const parts = tableName.trim().split('.');
  return parts.length === 2 ? { schema: parts[0]!, table: parts[1]! } : { schema: null, table: parts[0]! };
}

/** Quote a validated identifier for T-SQL. */
function quoteIdent(name: string): string {
  return `[${name}]`;
}

/**
 * 從專案設定解出一組 mssql 連線參數。兩個 DB 工具共用，
 * 免得連線邏輯（connectionString fallback、預設 port、憑證選項）分兩份走鐘。
 */
function resolveDbConnection(
  db: BetterSqlite3.Database,
  projectId: string,
  connectionLabel: string,
): { config: mssql.config; database: string } | { error: string } {
  const project = db.prepare('SELECT config_json FROM projects WHERE id = ?').get(projectId) as { config_json: string | null } | undefined;
  if (!project) return { error: `Error: Project "${projectId}" not found` };

  let dbConnections: DbConnection[] = [];
  if (project.config_json) {
    try {
      dbConnections = (JSON.parse(project.config_json) as { dbConnections?: DbConnection[] }).dbConnections || [];
    } catch {
      return { error: 'Error: Failed to parse project config_json' };
    }
  }
  const conn = dbConnections.find(c => c.label === connectionLabel);
  if (!conn) {
    const available = dbConnections.map(c => c.label).join(', ') || '(none)';
    return { error: `Error: DB connection "${connectionLabel}" not found. Available: ${available}` };
  }

  const parsed = conn.connectionString ? parseConnectionString(conn.connectionString) : null;
  const server = conn.server || parsed?.server;
  if (!server) return { error: `Error: DB connection "${connectionLabel}" has no server configured. Check project DB settings.` };
  const database = conn.database || parsed?.database || '';

  return {
    database,
    config: {
      server,
      database,
      user: conn.user || parsed?.user || '',
      password: conn.password || parsed?.password || '',
      port: conn.port || parsed?.port || 1433,
      options: { encrypt: false, trustServerCertificate: true },
      requestTimeout: 30000,
      connectionTimeout: 10000,
    },
  };
}

export function registerDbTools(server: McpServer): void {

  // ── query_external_db ─────────────────────────────────────
  server.tool(
    'query_external_db',
    '查詢專案綁定的外部資料庫（唯讀）。action：list_tables=列出所有表；describe_table=查表結構（欄位名以此為準，嚴禁猜）；select=執行唯讀 SELECT；count=回指定表筆數（選填 where 過濾）；sample=回指定表前 N 筆（選填 where，limit 預設 5、上限 50）。count/sample 用於 CRUD 後驗證資料真實落地：新增查得到、修改欄位值正確、刪除查不到。建議連線帳號本身設為唯讀（db_datareader），程式面的 SQL 檢查僅為輔助防線。',
    {
      projectId: z.string().describe('專案 ID'),
      connectionLabel: z.string().describe('DB 連線標籤（專案設定 dbConnections 裡的 label）'),
      action: z.enum(['list_tables', 'describe_table', 'select', 'count', 'sample']).describe('操作類型'),
      tableName: z.string().optional().describe('表名（describe_table / count / sample 時必填；僅允許識別字，可含 schema 前綴）'),
      sql: z.string().optional().describe('SELECT SQL（select 時必填，只允許單一 SELECT 敘述）'),
      where: z.string().optional().describe('count / sample 的過濾條件（不含 WHERE 關鍵字；禁分號/註解/破壞性關鍵字）'),
      limit: z.number().int().positive().max(SAMPLE_MAX_LIMIT).optional().describe(`sample 回傳筆數（預設 ${SAMPLE_DEFAULT_LIMIT}、上限 ${SAMPLE_MAX_LIMIT}）`),
    },
    { title: 'Query External DB', readOnlyHint: true, openWorldHint: true },
    async ({ projectId, connectionLabel, action, tableName, sql, where, limit }) => {
      const db = getMcpDb();

      // Get project config
      const project = db.prepare('SELECT config_json FROM projects WHERE id = ?').get(projectId) as { config_json: string | null } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      // Parse dbConnections from config_json
      let dbConnections: DbConnection[] = [];
      if (project.config_json) {
        try {
          const config = JSON.parse(project.config_json) as { dbConnections?: DbConnection[] };
          dbConnections = config.dbConnections || [];
        } catch {
          return { content: [{ type: 'text' as const, text: 'Error: Failed to parse project config_json' }], isError: true };
        }
      }

      const conn = dbConnections.find(c => c.label === connectionLabel);
      if (!conn) {
        const available = dbConnections.map(c => c.label).join(', ') || '(none)';
        return { content: [{ type: 'text' as const, text: `Error: DB connection "${connectionLabel}" not found. Available: ${available}` }], isError: true };
      }

      // Validate action-specific params
      if ((action === 'describe_table' || action === 'count' || action === 'sample') && !tableName) {
        return { content: [{ type: 'text' as const, text: `Error: tableName is required for ${action} action` }], isError: true };
      }
      if (action === 'select' && !sql) {
        return { content: [{ type: 'text' as const, text: 'Error: sql is required for select action' }], isError: true };
      }

      // Security: only allow a single read-only SELECT statement for the sql action.
      // Defense-in-depth only — the DB account should be read-only (db_datareader).
      if (action === 'select' && sql) {
        const guardError = validateSelectSql(sql);
        if (guardError) {
          return { content: [{ type: 'text' as const, text: guardError }], isError: true };
        }
      }

      // count/sample：tableName 識別字白名單 + where 片段守衛（比照 validateSelectSql 模式）
      if (action === 'count' || action === 'sample') {
        const identError = validateTableIdentifier(tableName!);
        if (identError) {
          return { content: [{ type: 'text' as const, text: identError }], isError: true };
        }
        if (where) {
          const whereError = validateWhereClause(where);
          if (whereError) {
            return { content: [{ type: 'text' as const, text: whereError }], isError: true };
          }
        }
      }

      // Resolve connection params: prefer explicit fields, fall back to connectionString parsing
      const parsed = conn.connectionString ? parseConnectionString(conn.connectionString) : null;
      const connServer = conn.server || parsed?.server;
      const connDatabase = conn.database || parsed?.database;
      const connUser = conn.user || parsed?.user;
      const connPassword = conn.password || parsed?.password;
      const connPort = conn.port || parsed?.port;

      if (!connServer) {
        return { content: [{ type: 'text' as const, text: `Error: DB connection "${connectionLabel}" has no server configured. Check project DB settings.` }], isError: true };
      }

      // Connect and execute
      let pool: mssql.ConnectionPool | null = null;
      try {
        pool = await mssql.connect({
          server: connServer,
          database: connDatabase || '',
          user: connUser || '',
          password: connPassword || '',
          port: connPort || 1433,
          options: {
            encrypt: false,
            trustServerCertificate: true,
          },
          requestTimeout: 30000,
          connectionTimeout: 10000,
        });

        let result: mssql.IResult<Record<string, unknown>>;

        switch (action) {
          case 'list_tables':
            result = await pool.request().query(
              "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME"
            );
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ count: result.recordset.length, tables: result.recordset }, null, 2),
              }],
            };

          case 'describe_table':
            result = await pool.request()
              .input('tableName', mssql.NVarChar, tableName!)
              .query(
                "SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName ORDER BY ORDINAL_POSITION"
              );
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ tableName, count: result.recordset.length, columns: result.recordset }, null, 2),
              }],
            };

          case 'count':
          case 'sample': {
            // 表存在確認（INFORMATION_SCHEMA + 參數綁定）——識別字白名單之外的第二道防線
            const { schema, table } = splitTableName(tableName!);
            const existsReq = pool.request().input('tableName', mssql.NVarChar, table);
            let existsSql = 'SELECT TABLE_SCHEMA FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @tableName';
            if (schema) {
              existsReq.input('schemaName', mssql.NVarChar, schema);
              existsSql += ' AND TABLE_SCHEMA = @schemaName';
            }
            const existsResult = await existsReq.query(existsSql);
            if (existsResult.recordset.length === 0) {
              return { content: [{ type: 'text' as const, text: `Error: Table "${tableName}" not found in INFORMATION_SCHEMA.TABLES. 用 action="list_tables" 確認表名。` }], isError: true };
            }

            const qualified = (schema ? `${quoteIdent(schema)}.` : '') + quoteIdent(table);
            const whereSql = where && where.trim() ? ` WHERE ${where.trim()}` : '';

            if (action === 'count') {
              const countResult = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${qualified}${whereSql}`);
              const count = (countResult.recordset[0] as { cnt: number } | undefined)?.cnt ?? 0;
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({ tableName, where: where?.trim() || null, count }, null, 2),
                }],
              };
            }

            const effLimit = Math.min(limit ?? SAMPLE_DEFAULT_LIMIT, SAMPLE_MAX_LIMIT);
            const sampleResult = await pool.request().query(`SELECT TOP (${effLimit}) * FROM ${qualified}${whereSql}`);
            let rows = sampleResult.recordset as Array<Record<string, unknown>>;
            const buildSampleText = (shrunk: boolean) => JSON.stringify({
              tableName,
              where: where?.trim() || null,
              limit: effLimit,
              rowCount: rows.length,
              ...(shrunk ? { note: `回應過大，已縮至 ${rows.length} 筆` } : {}),
              rows,
            }, null, 2);
            let sampleText = buildSampleText(false);
            while (sampleText.length > CHARACTER_LIMIT && rows.length > 1) {
              rows = rows.slice(0, Math.ceil(rows.length / 2));
              sampleText = buildSampleText(true);
            }
            return { content: [{ type: 'text' as const, text: sampleText }] };
          }

          case 'select': {
            result = await pool.request().query(sql!);
            // Limit output to prevent huge responses: max 500 rows AND max CHARACTER_LIMIT chars
            const totalRows = result.recordset.length;
            let rows = result.recordset.slice(0, 500);
            const buildText = (truncatedFlag: boolean) => JSON.stringify({
              rowCount: totalRows,
              truncated: truncatedFlag,
              ...(truncatedFlag ? { note: `Showing first ${rows.length} of ${totalRows} rows` } : {}),
              rows,
            }, null, 2);
            let truncated = totalRows > rows.length;
            let text = buildText(truncated);
            while (text.length > CHARACTER_LIMIT && rows.length > 1) {
              rows = rows.slice(0, Math.ceil(rows.length / 2));
              truncated = true;
              text = buildText(truncated);
            }
            return { content: [{ type: 'text' as const, text }] };
          }

          default:
            return { content: [{ type: 'text' as const, text: `Error: Unknown action "${action}"` }], isError: true };
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `DB error: ${msg}` }], isError: true };
      } finally {
        if (pool) {
          try { await pool.close(); } catch { /* ignore close errors */ }
        }
      }
    },
  );

  // ── verify_db_schema ──────────────────────────────────────
  // 規格回對的第三種驗法：db_field 對「真的 DB」核對。
  // 程式預檢與 AI 回對都只看得到程式碼——DDL 沒套用、Entity 對錯表、
  // 規格寫了從沒建過的欄位，這三種情況在程式碼層面都看不出來。
  server.tool(
    'verify_db_schema',
    '把規格檢查表的 db_field 項目拿去跟**實體資料庫**的 INFORMATION_SCHEMA 逐欄核對（唯讀）。程式預檢與 AI 回對都只看程式碼（Entity/@Column/DDL），證明不了欄位在正式 DB 真的存在——DDL 沒套用、Entity 對到別的表、規格寫了從沒建過的欄位，這三種在程式碼層面都看不出來。回傳每項的判定（實體 DB 有 / 實體 DB 沒有 / 無從判定）與實際型別長度，供 reviewer 與 SD 規格的型別定義比對。**「無從判定」絕不可當成通過**。',
    {
      taskId: z.string().describe('任務 ID（取該任務規格檢查表的 db_field 項目）'),
      connectionLabel: z.string().describe('DB 連線標籤（專案設定 dbConnections 裡的 label）'),
      tables: z.array(z.string()).optional().describe('要撈 schema 的資料表清單（省略=從 db_field 檢查項的「表名.欄位名」自動推導；檢查項只寫欄位名時必須明確指定）'),
    },
    { title: 'Verify DB Schema', readOnlyHint: true, openWorldHint: true },
    async ({ taskId, connectionLabel, tables }) => {
      const db = getMcpDb();

      const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const items = db.prepare(
        "SELECT id, content FROM spec_checklist_items WHERE task_id = ? AND item_type = 'db_field' AND waived = 0 ORDER BY created_at ASC, rowid ASC"
      ).all(taskId) as DbFieldItem[];
      if (items.length === 0) {
        return { content: [{ type: 'text' as const, text: '此任務的規格檢查表沒有未豁免的 db_field 項目，無需核對實體 DB。' }] };
      }

      const conn = resolveDbConnection(db, task.project_id, connectionLabel);
      if ('error' in conn) {
        return { content: [{ type: 'text' as const, text: conn.error }], isError: true };
      }

      // 表名來源：明確指定優先，否則從檢查項自動推導
      const derived = [...new Set(items.map(i => parseDbFieldRef(i.content).table).filter((t): t is string => !!t))];
      const wanted = tables?.length ? tables : derived;
      if (wanted.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '無法判定要核對哪些資料表——db_field 檢查項都只寫了欄位名沒有表名。請用 tables 參數明確指定（例：tables=["FEDI_ESTATUS","FEDI_PAYEXT"]）。',
          }],
          isError: true,
        };
      }
      if (wanted.length > VERIFY_SCHEMA_MAX_TABLES) {
        return {
          content: [{ type: 'text' as const, text: `一次最多核對 ${VERIFY_SCHEMA_MAX_TABLES} 張表（本次推導出 ${wanted.length} 張）。請用 tables 參數分批。` }],
          isError: true,
        };
      }
      for (const t of wanted) {
        const err = validateTableIdentifier(t);
        if (err) return { content: [{ type: 'text' as const, text: err }], isError: true };
      }

      let pool: mssql.ConnectionPool | null = null;
      try {
        pool = await mssql.connect(conn.config);
        const req = pool.request();
        // 表名全部參數綁定，不拼字串
        const params = wanted.map((t, i) => { req.input(`t${i}`, mssql.NVarChar, t); return `@t${i}`; });
        const result = await req.query(
          `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE
             FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN (${params.join(', ')})`
        );

        const columns: DbColumn[] = (result.recordset as Array<Record<string, unknown>>).map(r => ({
          table: String(r.TABLE_NAME),
          column: String(r.COLUMN_NAME),
          dataType: String(r.DATA_TYPE),
          maxLength: r.CHARACTER_MAXIMUM_LENGTH == null ? null : Number(r.CHARACTER_MAXIMUM_LENGTH),
          numericPrecision: r.NUMERIC_PRECISION == null ? null : Number(r.NUMERIC_PRECISION),
          numericScale: r.NUMERIC_SCALE == null ? null : Number(r.NUMERIC_SCALE),
          nullable: String(r.IS_NULLABLE).toUpperCase() === 'YES',
        }));

        const foundTables = [...new Set(columns.map(c => c.table))];
        const notFoundTables = wanted.filter(t => !foundTables.some(f => f.toUpperCase() === t.toUpperCase()));
        const results = checkDbFields(items, columns, wanted);

        const refuted = results.filter(r => isRefuted(r.verdict));
        const unknown = results.filter(r => r.verdict === 'not_checked');

        const lines = [
          `# 實體 DB schema 核對（連線 ${connectionLabel}／資料庫 ${conn.database}）`,
          '',
          summarize(results),
          '',
          `撈取的資料表：${foundTables.join(', ') || '(無)'}${notFoundTables.length ? `\n**實體 DB 找不到的表：${notFoundTables.join(', ')}**` : ''}`,
        ];
        if (refuted.length) {
          lines.push('', `## 實體 DB 沒有這些欄位（${refuted.length} 項——對應的 db_field 一律判 missing）`, '');
          for (const r of refuted) lines.push(`- ${r.itemId}「${r.content}」：${r.note}`);
        }
        if (unknown.length) {
          lines.push('', `## 無從判定（${unknown.length} 項——**不可當成通過**）`, '');
          for (const r of unknown) lines.push(`- ${r.itemId}「${r.content}」：${r.note}`);
        }
        const confirmed = results.filter(r => isConfirmed(r.verdict));
        if (confirmed.length) {
          lines.push('', `## 實體 DB 確實有（${confirmed.length} 項，附實際型別供與 SD 規格比對）`, '');
          for (const r of confirmed) {
            lines.push(`- ${r.itemId}「${r.content}」：${r.actual ? `${r.actual.table}.${r.actual.column} ${describeColumn(r.actual)}` : r.note}${r.verdict === 'column_found_unqualified' ? '　⚠ 檢查項沒寫表名，命中的是同名欄位' : ''}`);
          }
        }
        lines.push(
          '',
          '> 型別／長度／可否為空與 SD 規格定義不符時，用 report_spec_gap(category="field_undefined") 記錄交使用者裁決——那是規格與實體 DB 的落差，不是程式的錯。',
        );

        let text = lines.join('\n');
        if (text.length > CHARACTER_LIMIT) {
          text = text.slice(0, CHARACTER_LIMIT) + '\n\n…（內容過長已截斷，請用 tables 參數分批核對）';
        }
        return { content: [{ type: 'text' as const, text }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `DB error: ${msg}` }], isError: true };
      } finally {
        if (pool) {
          try { await pool.close(); } catch { /* ignore close errors */ }
        }
      }
    },
  );
}
