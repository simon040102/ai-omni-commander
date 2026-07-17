import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { vi } from 'vitest';
import { runMigrations } from '../../db/schema.js';

let testDb: Database.Database;

vi.mock('../db.js', () => ({
  getMcpDb: () => testDb,
}));

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDbTools, validateSelectSql, validateWhereClause, validateTableIdentifier } from '../tools/db-tools.js';
import { callTool } from './test-helpers.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('validateSelectSql (A5 SQL guard)', () => {
  it('allows plain SELECT statements', () => {
    expect(validateSelectSql('SELECT * FROM Users WHERE Id = 1')).toBeNull();
    expect(validateSelectSql('  select TOP 10 Name, Age from People order by Age desc  ')).toBeNull();
    expect(validateSelectSql('WITH cte AS (SELECT 1 AS n) SELECT n FROM cte')).toBeNull();
  });

  it('allows a single trailing semicolon', () => {
    expect(validateSelectSql('SELECT 1;')).toBeNull();
    expect(validateSelectSql('SELECT 1 ;  ')).toBeNull();
  });

  it('allows forbidden keywords inside string literals', () => {
    expect(validateSelectSql("SELECT * FROM Logs WHERE Message = 'DROP TABLE x'")).toBeNull();
    expect(validateSelectSql("SELECT * FROM Logs WHERE Note = 'don''t INSERT here; ok'")).toBeNull();
  });

  it('rejects non-SELECT statements', () => {
    expect(validateSelectSql('DELETE FROM Users')).toContain('Only SELECT');
    expect(validateSelectSql('EXEC sp_who')).toContain('Only SELECT');
  });

  it('rejects SELECT ... INTO (creates a table)', () => {
    expect(validateSelectSql('SELECT * INTO t2 FROM t1')).toContain('INTO');
  });

  it('rejects multi-statement injection', () => {
    expect(validateSelectSql('SELECT 1; DROP TABLE x')).toBeTruthy();
    expect(validateSelectSql('SELECT 1; DELETE FROM Users;')).toBeTruthy();
  });

  it('rejects WAITFOR (time-based attacks)', () => {
    expect(validateSelectSql("SELECT 1 WHERE 1=1 WAITFOR DELAY '0:0:10'")).toContain('WAITFOR');
  });

  it('is not bypassed by doubled-quote escape sequences', () => {
    // 'it''s' is ONE literal — the ; DROP after it must still be caught
    expect(validateSelectSql("SELECT 'it''s'; DROP TABLE x")).toBeTruthy();
    // Unbalanced quote trick must not hide the injected DDL
    expect(validateSelectSql("SELECT 'a''; DROP TABLE x; SELECT '1")).toBeNull(); // fully inside literals → safe
  });

  it('rejects embedded DML keywords outside strings', () => {
    expect(validateSelectSql('SELECT * FROM t WHERE id IN (SELECT id FROM u) UNION SELECT 1 FROM v; TRUNCATE TABLE w')).toBeTruthy();
    expect(validateSelectSql('SELECT 1 MERGE INTO x')).toBeTruthy();
  });

  it('rejects xp_ system procedures', () => {
    expect(validateSelectSql("SELECT 1 WHERE 1=1 OR xp_cmdshell('dir') = 1")).toContain('xp_');
  });
});

describe('validateTableIdentifier (R4 count/sample guard)', () => {
  it('allows plain identifiers and schema-qualified names', () => {
    expect(validateTableIdentifier('Users')).toBeNull();
    expect(validateTableIdentifier('dbo.Users')).toBeNull();
    expect(validateTableIdentifier('_tmp_table_2')).toBeNull();
  });

  it('rejects injection-shaped table names', () => {
    expect(validateTableIdentifier('Users; DROP TABLE x')).toBeTruthy();
    expect(validateTableIdentifier('Users]--')).toBeTruthy();
    expect(validateTableIdentifier('a.b.c')).toBeTruthy();
    expect(validateTableIdentifier('Users WHERE 1=1')).toBeTruthy();
    expect(validateTableIdentifier('')).toBeTruthy();
  });
});

describe('validateWhereClause (R4 count/sample guard)', () => {
  it('allows ordinary filter fragments', () => {
    expect(validateWhereClause("STATUS = 'A' AND CREATE_DATE >= '2026-01-01'")).toBeNull();
    expect(validateWhereClause('AMOUNT > 100 OR (QTY BETWEEN 1 AND 5)')).toBeNull();
    expect(validateWhereClause('')).toBeNull();
  });

  it('allows forbidden keywords inside string literals', () => {
    expect(validateWhereClause("MESSAGE = 'please do not DELETE me'")).toBeNull();
  });

  it('rejects semicolons and comments', () => {
    expect(validateWhereClause("1=1; DROP TABLE x")).toContain('Semicolon');
    expect(validateWhereClause("1=1 -- comment")).toContain('comments');
    expect(validateWhereClause('1=1 /* block */')).toContain('comments');
  });

  it('rejects destructive keywords and xp_ procedures', () => {
    expect(validateWhereClause('1=1 OR (DELETE FROM x)')).toBeTruthy();
    expect(validateWhereClause("EXISTS (SELECT 1 FROM t) AND UPDATE x SET y = 1")).toBeTruthy();
    expect(validateWhereClause("xp_cmdshell('dir') = 1")).toContain('xp_');
    expect(validateWhereClause("1=1 WAITFOR DELAY '0:0:10'")).toContain('WAITFOR');
  });
});

describe('query_external_db tool wiring', () => {
  let server: McpServer;

  beforeEach(() => {
    testDb = freshDb();
    server = new McpServer({ name: 'test', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerDbTools(server);
  });

  function seedProjectWithDb() {
    const config = JSON.stringify({
      dbConnections: [{ label: 'TYL_DOC', server: 'localhost', database: 'x', user: 'u', password: 'p' }],
    });
    testDb.prepare(`INSERT INTO projects (id, name, working_dir, config_json) VALUES (?, ?, ?, ?)`).run('p1', 'Test', '/tmp', config);
  }

  it('rejects forbidden SQL before attempting any connection', async () => {
    seedProjectWithDb();
    const result = await callTool(server, 'query_external_db', {
      projectId: 'p1', connectionLabel: 'TYL_DOC', action: 'select', sql: 'SELECT 1; DROP TABLE x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Multiple SQL statements|Forbidden keyword/);
  });

  it('rejects SELECT INTO before attempting any connection', async () => {
    seedProjectWithDb();
    const result = await callTool(server, 'query_external_db', {
      projectId: 'p1', connectionLabel: 'TYL_DOC', action: 'select', sql: 'SELECT * INTO t2 FROM t1',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('INTO');
  });

  it('errors for unknown connection label', async () => {
    seedProjectWithDb();
    const result = await callTool(server, 'query_external_db', {
      projectId: 'p1', connectionLabel: 'nope', action: 'list_tables',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });

  it('count/sample require tableName', async () => {
    seedProjectWithDb();
    for (const action of ['count', 'sample']) {
      const result = await callTool(server, 'query_external_db', {
        projectId: 'p1', connectionLabel: 'TYL_DOC', action,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tableName is required');
    }
  });

  it('count rejects an injection-shaped tableName before attempting any connection', async () => {
    seedProjectWithDb();
    const result = await callTool(server, 'query_external_db', {
      projectId: 'p1', connectionLabel: 'TYL_DOC', action: 'count', tableName: 'Users; DROP TABLE x',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid table name');
  });

  it('count/sample reject a hostile where clause before attempting any connection', async () => {
    seedProjectWithDb();
    const semi = await callTool(server, 'query_external_db', {
      projectId: 'p1', connectionLabel: 'TYL_DOC', action: 'count', tableName: 'Users', where: "1=1; DROP TABLE x",
    });
    expect(semi.isError).toBe(true);
    expect(semi.content[0].text).toContain('Semicolon');

    const kw = await callTool(server, 'query_external_db', {
      projectId: 'p1', connectionLabel: 'TYL_DOC', action: 'sample', tableName: 'Users', where: 'DELETE FROM x',
    });
    expect(kw.isError).toBe(true);
    expect(kw.content[0].text).toContain('Forbidden keyword');
  });
});
