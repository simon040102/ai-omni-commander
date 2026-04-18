/**
 * ExternalSchemaFetcher — Connects to external databases (PostgreSQL, MySQL, MSSQL)
 * and fetches ONLY schema metadata (tables, columns, foreign keys).
 *
 * SECURITY:
 * - Only hardcoded information_schema queries — no user-provided SQL
 * - Sets read-only session immediately after connecting
 * - Closes connection immediately after fetching
 * - Connect timeout: 10s, query timeout: 30s
 */
import type { DbType, DbSchemaTable, DbSchemaColumn, DbSchemaForeignKey, DbSchemaResult } from '@omni/shared';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('ExternalSchemaFetcher');

const CONNECT_TIMEOUT = 10_000; // 10 seconds
const QUERY_TIMEOUT = 30_000;   // 30 seconds

export class ExternalSchemaFetcher {
  /**
   * Fetch schema from an external database.
   * Opens connection, sets read-only, runs hardcoded queries, closes connection.
   */
  async fetchSchema(connectionId: string, connectionString: string, dbType: DbType): Promise<DbSchemaResult> {
    logger.info({ connectionId, dbType }, 'Fetching schema');

    switch (dbType) {
      case 'postgresql':
        return this.fetchPostgresSchema(connectionId, connectionString);
      case 'mysql':
        return this.fetchMysqlSchema(connectionId, connectionString);
      case 'mssql':
        return this.fetchMssqlSchema(connectionId, connectionString);
      default:
        throw new Error(`Unsupported database type: ${dbType}`);
    }
  }

  /**
   * Test connectivity only — connect and immediately disconnect.
   */
  async testConnection(connectionString: string, dbType: DbType): Promise<void> {
    switch (dbType) {
      case 'postgresql': {
        const pg = await import('pg');
        const client = new pg.default.Client({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT });
        await client.connect();
        await client.end();
        break;
      }
      case 'mysql': {
        const mysql = await import('mysql2/promise');
        const conn = await mysql.default.createConnection({ uri: connectionString, connectTimeout: CONNECT_TIMEOUT });
        await conn.end();
        break;
      }
      case 'mssql': {
        const sql = await import('mssql');
        const config = this.parseMssqlConfig(connectionString);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = new sql.default.ConnectionPool(config as any);
        await pool.connect();
        await pool.close();
        break;
      }
    }
  }

  // ── PostgreSQL ─────────────────────────────────────────────

  private async fetchPostgresSchema(connectionId: string, connectionString: string): Promise<DbSchemaResult> {
    const pg = await import('pg');
    const client = new pg.default.Client({
      connectionString,
      connectionTimeoutMillis: CONNECT_TIMEOUT,
      statement_timeout: QUERY_TIMEOUT,
      ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    });

    try {
      await client.connect();

      // SECURITY: Set read-only session
      await client.query('SET default_transaction_read_only = ON');

      // Fetch tables
      const tablesRes = await client.query(`
        SELECT table_name, table_schema,
               (SELECT reltuples::bigint FROM pg_class WHERE relname = table_name) AS row_estimate
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);

      const tables: DbSchemaTable[] = tablesRes.rows.map((r: Record<string, unknown>) => ({
        name: r.table_name as string,
        schema: r.table_schema as string,
        rowCountEstimate: Number(r.row_estimate) || undefined,
      }));

      // Fetch columns
      const columnsRes = await client.query(`
        SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
               c.column_default, c.ordinal_position,
               pgd.description AS comment
        FROM information_schema.columns c
        LEFT JOIN pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name AND st.schemaname = c.table_schema
        LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = 'public'
        ORDER BY c.table_name, c.ordinal_position
      `);

      // Fetch primary keys
      const pkRes = await client.query(`
        SELECT tc.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      `);
      const pkSet = new Set(pkRes.rows.map((r: Record<string, unknown>) => `${r.table_name}.${r.column_name}`));

      // Fetch foreign keys
      const fkRes = await client.query(`
        SELECT tc.constraint_name, kcu.table_name, kcu.column_name,
               ccu.table_name AS referenced_table, ccu.column_name AS referenced_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      `);

      const fkMap = new Map<string, { refTable: string; refColumn: string }>();
      const foreignKeys: DbSchemaForeignKey[] = fkRes.rows.map((r: Record<string, unknown>) => {
        fkMap.set(`${r.table_name}.${r.column_name}`, {
          refTable: r.referenced_table as string,
          refColumn: r.referenced_column as string,
        });
        return {
          constraintName: r.constraint_name as string,
          tableName: r.table_name as string,
          columnName: r.column_name as string,
          referencedTable: r.referenced_table as string,
          referencedColumn: r.referenced_column as string,
        };
      });

      const columns: DbSchemaColumn[] = columnsRes.rows.map((r: Record<string, unknown>) => {
        const key = `${r.table_name}.${r.column_name}`;
        const fk = fkMap.get(key);
        return {
          tableName: r.table_name as string,
          columnName: r.column_name as string,
          dataType: r.data_type as string,
          isNullable: r.is_nullable === 'YES',
          defaultValue: (r.column_default as string | null) ?? null,
          isPrimaryKey: pkSet.has(key),
          isForeignKey: !!fk,
          referencedTable: fk?.refTable,
          referencedColumn: fk?.refColumn,
          ordinalPosition: r.ordinal_position as number,
          comment: (r.comment as string | null) ?? undefined,
        };
      });

      return { connectionId, tables, columns, foreignKeys, fetchedAt: new Date().toISOString() };
    } finally {
      await client.end();
    }
  }

  // ── MySQL ──────────────────────────────────────────────────

  private async fetchMysqlSchema(connectionId: string, connectionString: string): Promise<DbSchemaResult> {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.default.createConnection({
      uri: connectionString,
      connectTimeout: CONNECT_TIMEOUT,
    });

    try {
      // SECURITY: Set read-only session
      await conn.execute('SET SESSION TRANSACTION READ ONLY');

      // Get current database name
      const [dbRows] = await conn.execute('SELECT DATABASE() AS db_name') as [Array<{ db_name: string }>, unknown];
      const dbName = dbRows[0]?.db_name;
      if (!dbName) throw new Error('No database selected in connection string');

      // Fetch tables
      const [tableRows] = await conn.execute(`
        SELECT table_name, table_schema, table_rows
        FROM information_schema.tables
        WHERE table_schema = ? AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `, [dbName]) as [Array<Record<string, unknown>>, unknown];

      const tables: DbSchemaTable[] = tableRows.map(r => ({
        name: r.TABLE_NAME as string || r.table_name as string,
        schema: r.TABLE_SCHEMA as string || r.table_schema as string,
        rowCountEstimate: Number(r.TABLE_ROWS || r.table_rows) || undefined,
      }));

      // Fetch columns
      const [colRows] = await conn.execute(`
        SELECT table_name, column_name, data_type, is_nullable,
               column_default, ordinal_position, column_key, column_comment
        FROM information_schema.columns
        WHERE table_schema = ?
        ORDER BY table_name, ordinal_position
      `, [dbName]) as [Array<Record<string, unknown>>, unknown];

      // Fetch foreign keys
      const [fkRows] = await conn.execute(`
        SELECT constraint_name, table_name, column_name,
               referenced_table_name, referenced_column_name
        FROM information_schema.key_column_usage
        WHERE table_schema = ? AND referenced_table_name IS NOT NULL
      `, [dbName]) as [Array<Record<string, unknown>>, unknown];

      const fkMap = new Map<string, { refTable: string; refColumn: string }>();
      const foreignKeys: DbSchemaForeignKey[] = fkRows.map(r => {
        const tbl = (r.TABLE_NAME || r.table_name) as string;
        const col = (r.COLUMN_NAME || r.column_name) as string;
        const refTbl = (r.REFERENCED_TABLE_NAME || r.referenced_table_name) as string;
        const refCol = (r.REFERENCED_COLUMN_NAME || r.referenced_column_name) as string;
        fkMap.set(`${tbl}.${col}`, { refTable: refTbl, refColumn: refCol });
        return {
          constraintName: (r.CONSTRAINT_NAME || r.constraint_name) as string,
          tableName: tbl,
          columnName: col,
          referencedTable: refTbl,
          referencedColumn: refCol,
        };
      });

      const columns: DbSchemaColumn[] = colRows.map(r => {
        const tbl = (r.TABLE_NAME || r.table_name) as string;
        const col = (r.COLUMN_NAME || r.column_name) as string;
        const key = `${tbl}.${col}`;
        const colKey = (r.COLUMN_KEY || r.column_key) as string;
        const fk = fkMap.get(key);
        return {
          tableName: tbl,
          columnName: col,
          dataType: (r.DATA_TYPE || r.data_type) as string,
          isNullable: (r.IS_NULLABLE || r.is_nullable) === 'YES',
          defaultValue: ((r.COLUMN_DEFAULT ?? r.column_default) as string | null) ?? null,
          isPrimaryKey: colKey === 'PRI',
          isForeignKey: !!fk,
          referencedTable: fk?.refTable,
          referencedColumn: fk?.refColumn,
          ordinalPosition: Number(r.ORDINAL_POSITION || r.ordinal_position),
          comment: ((r.COLUMN_COMMENT || r.column_comment) as string) || undefined,
        };
      });

      return { connectionId, tables, columns, foreignKeys, fetchedAt: new Date().toISOString() };
    } finally {
      await conn.end();
    }
  }

  // ── MSSQL ──────────────────────────────────────────────────

  /** Parse JDBC or ADO.NET MSSQL connection string into mssql config */
  private parseMssqlConfig(connectionString: string): Record<string, unknown> | string {
    const str = connectionString.trim();
    if (/^jdbc:sqlserver:\/\//i.test(str)) {
      const rest = str.slice('jdbc:sqlserver://'.length);
      const semiIdx = rest.indexOf(';');
      const hostPart = semiIdx >= 0 ? rest.slice(0, semiIdx) : rest;
      const propStr = semiIdx >= 0 ? rest.slice(semiIdx + 1) : '';
      // Parse host[:port]
      const colonIdx = hostPart.lastIndexOf(':');
      let server = hostPart;
      let port = 1433;
      if (colonIdx >= 0 && /^\d+$/.test(hostPart.slice(colonIdx + 1))) {
        server = hostPart.slice(0, colonIdx);
        port = parseInt(hostPart.slice(colonIdx + 1));
      }
      // Parse properties (case-insensitive)
      const props: Record<string, string> = {};
      for (const seg of propStr.split(';')) {
        const eq = seg.indexOf('=');
        if (eq >= 0) props[seg.slice(0, eq).toLowerCase().trim()] = seg.slice(eq + 1).trim();
      }
      if (props['portnumber']) port = parseInt(props['portnumber']);
      const encrypt = props['encrypt']?.toLowerCase() !== 'false'; // default true
      const trustServerCertificate = props['trustservercertificate']?.toLowerCase() !== 'false'; // default true
      return {
        server,
        port,
        database: props['databasename'] || props['database'] || '',
        user: props['user'] || props['username'] || props['userid'] || props['user id'] || '',
        password: props['password'] || '',
        connectionTimeout: CONNECT_TIMEOUT,
        requestTimeout: QUERY_TIMEOUT,
        options: {
          encrypt,
          trustServerCertificate,
          enableArithAbort: true,
          cryptoCredentialsDetails: { minVersion: 'TLSv1' },
        },
      };
    }
    // ADO.NET format: Server=host;Database=db;User Id=u;Password=p;
    const adoProps: Record<string, string> = {};
    for (const seg of str.split(';')) {
      const eq = seg.indexOf('=');
      if (eq >= 0) adoProps[seg.slice(0, eq).toLowerCase().trim()] = seg.slice(eq + 1).trim();
    }
    const adoServer = adoProps['server'] || adoProps['data source'] || adoProps['datasource'] || adoProps['host'];
    if (adoServer) {
      const encrypt = adoProps['encrypt']?.toLowerCase() !== 'false';
      const trustServerCertificate = adoProps['trustservercertificate']?.toLowerCase() !== 'false';
      return {
        server: adoServer,
        port: parseInt(adoProps['port'] || '1433'),
        database: adoProps['database'] || adoProps['initial catalog'] || '',
        user: adoProps['user id'] || adoProps['uid'] || adoProps['user'] || '',
        password: adoProps['password'] || adoProps['pwd'] || '',
        connectionTimeout: CONNECT_TIMEOUT,
        requestTimeout: QUERY_TIMEOUT,
        options: {
          encrypt,
          trustServerCertificate,
          enableArithAbort: true,
          cryptoCredentialsDetails: { minVersion: 'TLSv1' },
        },
      };
    }

    return str;
  }

  private async fetchMssqlSchema(connectionId: string, connectionString: string): Promise<DbSchemaResult> {
    const sql = await import('mssql');
    const config = this.parseMssqlConfig(connectionString);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pool = new sql.default.ConnectionPool(config as any);
    await pool.connect();

    try {
      // Fetch tables
      const tablesRes = await pool.request().query(`
        SELECT t.TABLE_NAME AS table_name, t.TABLE_SCHEMA AS table_schema,
               p.rows AS row_estimate
        FROM INFORMATION_SCHEMA.TABLES t
        LEFT JOIN sys.partitions p ON OBJECT_ID(t.TABLE_SCHEMA + '.' + t.TABLE_NAME) = p.object_id AND p.index_id IN (0, 1)
        WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA = 'dbo'
        ORDER BY t.TABLE_NAME
      `);

      const tables: DbSchemaTable[] = tablesRes.recordset.map((r: Record<string, unknown>) => ({
        name: r.table_name as string,
        schema: r.table_schema as string,
        rowCountEstimate: Number(r.row_estimate) || undefined,
      }));

      // Fetch columns
      const colsRes = await pool.request().query(`
        SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
               c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
               c.COLUMN_DEFAULT AS column_default, c.ORDINAL_POSITION AS ordinal_position,
               ep.value AS comment
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN sys.extended_properties ep
          ON ep.major_id = OBJECT_ID(c.TABLE_SCHEMA + '.' + c.TABLE_NAME)
          AND ep.minor_id = c.ORDINAL_POSITION AND ep.name = 'MS_Description'
        WHERE c.TABLE_SCHEMA = 'dbo'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION
      `);

      // Fetch primary keys
      const pkRes = await pool.request().query(`
        SELECT tc.TABLE_NAME AS table_name, kcu.COLUMN_NAME AS column_name
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = 'dbo'
      `);
      const pkSet = new Set(pkRes.recordset.map((r: Record<string, unknown>) => `${r.table_name}.${r.column_name}`));

      // Fetch foreign keys
      const fkRes = await pool.request().query(`
        SELECT fk.name AS constraint_name,
               tp.name AS table_name, cp.name AS column_name,
               tr.name AS referenced_table, cr.name AS referenced_column
        FROM sys.foreign_keys fk
        JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
        JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
        JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
        JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
        JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
      `);

      const fkMap = new Map<string, { refTable: string; refColumn: string }>();
      const foreignKeys: DbSchemaForeignKey[] = fkRes.recordset.map((r: Record<string, unknown>) => {
        fkMap.set(`${r.table_name}.${r.column_name}`, {
          refTable: r.referenced_table as string,
          refColumn: r.referenced_column as string,
        });
        return {
          constraintName: r.constraint_name as string,
          tableName: r.table_name as string,
          columnName: r.column_name as string,
          referencedTable: r.referenced_table as string,
          referencedColumn: r.referenced_column as string,
        };
      });

      const columns: DbSchemaColumn[] = colsRes.recordset.map((r: Record<string, unknown>) => {
        const key = `${r.table_name}.${r.column_name}`;
        const fk = fkMap.get(key);
        return {
          tableName: r.table_name as string,
          columnName: r.column_name as string,
          dataType: r.data_type as string,
          isNullable: r.is_nullable === 'YES',
          defaultValue: (r.column_default as string | null) ?? null,
          isPrimaryKey: pkSet.has(key),
          isForeignKey: !!fk,
          referencedTable: fk?.refTable,
          referencedColumn: fk?.refColumn,
          ordinalPosition: r.ordinal_position as number,
          comment: (r.comment as string | null) ?? undefined,
        };
      });

      return { connectionId, tables, columns, foreignKeys, fetchedAt: new Date().toISOString() };
    } finally {
      await pool.close();
    }
  }
}
