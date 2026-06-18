/**
 * MCP tools for querying external databases.
 * query_external_db
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import mssql from 'mssql';
import { getMcpDb } from '../db.js';

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

export function registerDbTools(server: McpServer): void {

  // ── query_external_db ─────────────────────────────────────
  server.tool(
    'query_external_db',
    '查詢專案綁定的外部資料庫。可列出所有表、查表結構、或執行唯讀 SELECT。',
    {
      projectId: z.string().describe('專案 ID'),
      connectionLabel: z.string().describe('DB 連線標籤（如 TYL_DOC、NaNa）'),
      action: z.enum(['list_tables', 'describe_table', 'select']).describe('操作類型'),
      tableName: z.string().optional().describe('表名（describe_table 時必填）'),
      sql: z.string().optional().describe('SELECT SQL（select 時必填，只允許 SELECT）'),
    },
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

      // Security: only allow SELECT for sql action
      if (action === 'select' && sql) {
        const trimmed = sql.trim().toUpperCase();
        const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'EXEC', 'EXECUTE', 'MERGE', 'GRANT', 'REVOKE'];
        if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
          return { content: [{ type: 'text' as const, text: 'Error: Only SELECT (or WITH ... SELECT) statements are allowed' }], isError: true };
        }
        // Check for forbidden keywords that might be injected after SELECT
        for (const kw of forbidden) {
          // Match keyword as a whole word (not inside identifiers)
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          // Allow these inside subqueries for SELECT, but block standalone DML/DDL
          if (['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'EXEC', 'EXECUTE', 'MERGE', 'GRANT', 'REVOKE'].includes(kw)) {
            // Check if keyword appears outside of string literals (simple heuristic)
            const withoutStrings = sql.replace(/'[^']*'/g, '');
            if (regex.test(withoutStrings)) {
              return { content: [{ type: 'text' as const, text: `Error: Forbidden keyword "${kw}" detected in SQL` }], isError: true };
            }
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

          case 'select':
            result = await pool.request().query(sql!);
            // Limit output to prevent huge responses
            const rows = result.recordset.slice(0, 500);
            const truncated = result.recordset.length > 500;
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  rowCount: result.recordset.length,
                  truncated,
                  ...(truncated ? { note: `Showing first 500 of ${result.recordset.length} rows` } : {}),
                  rows,
                }, null, 2),
              }],
            };

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
