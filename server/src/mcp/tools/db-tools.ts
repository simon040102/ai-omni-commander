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
  // Strip string literals (handles '' escaping) so keywords/semicolons inside strings don't count
  const withoutStrings = trimmed.replace(/'(?:[^']|'')*'/g, "''");
  // Reject multiple statements — a single trailing semicolon is allowed
  const body = withoutStrings.replace(/;\s*$/, '');
  if (body.includes(';')) {
    return 'Error: Multiple SQL statements are not allowed';
  }
  for (const kw of FORBIDDEN_SQL_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(body)) {
      return `Error: Forbidden keyword "${kw}" detected in SQL`;
    }
  }
  return null;
}

export function registerDbTools(server: McpServer): void {

  // ── query_external_db ─────────────────────────────────────
  server.tool(
    'query_external_db',
    '查詢專案綁定的外部資料庫。可列出所有表、查表結構、或執行唯讀 SELECT。建議連線帳號本身設為唯讀（db_datareader），程式面的 SELECT 檢查僅為輔助防線。',
    {
      projectId: z.string().describe('專案 ID'),
      connectionLabel: z.string().describe('DB 連線標籤（如 TYL_DOC、NaNa）'),
      action: z.enum(['list_tables', 'describe_table', 'select']).describe('操作類型'),
      tableName: z.string().optional().describe('表名（describe_table 時必填）'),
      sql: z.string().optional().describe('SELECT SQL（select 時必填，只允許單一 SELECT 敘述）'),
    },
    { title: 'Query External DB', readOnlyHint: true, openWorldHint: true },
    async ({ projectId, connectionLabel, action, tableName, sql }) => {
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
      if (action === 'describe_table' && !tableName) {
        return { content: [{ type: 'text' as const, text: 'Error: tableName is required for describe_table action' }], isError: true };
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
