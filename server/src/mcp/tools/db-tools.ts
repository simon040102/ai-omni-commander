/**
 * MCP tools for querying external databases.
 * query_external_db
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import mssql from 'mssql';
import { getMcpDb } from '../db.js';
import { CHARACTER_LIMIT } from '../helpers.js';

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
}
