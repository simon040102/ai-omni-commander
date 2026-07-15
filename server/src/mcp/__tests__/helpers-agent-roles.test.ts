import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/schema.js';
import { AGENT_ROLES } from '../helpers.js';

/**
 * AGENT_ROLES（helpers.ts）與 agents.role 的 CHECK 白名單（schema.ts）是兩份手抄——
 * 這裡對真實 migrated schema 逐一 INSERT 驗證同步，任一邊改了另一邊沒跟上就會紅。
 * 背景：ensureMcpAgent 用 INSERT OR IGNORE，role 不在 CHECK 內會被靜默吞掉，
 * 後續 agent_outputs 寫入直接 FK 爆炸（fullstack label 曾踩過）。
 */
describe('AGENT_ROLES ↔ schema CHECK 同步', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p1', 'P', '/tmp/p')`).run();
  });

  it('AGENT_ROLES 中每個 role 都能通過 schema CHECK（集合沒有多列）', () => {
    const insert = db.prepare(`
      INSERT INTO agents (id, project_id, role, status, model) VALUES (?, 'p1', ?, 'running', 'external')
    `);
    for (const role of AGENT_ROLES) {
      expect(() => insert.run(`a-${role}`, role), `role "${role}" 應通過 CHECK`).not.toThrow();
    }
  });

  it('CHECK 白名單外的 role 會被拒（fallback 機制存在的理由）', () => {
    const insert = db.prepare(`
      INSERT INTO agents (id, project_id, role, status, model) VALUES ('a-x', 'p1', ?, 'running', 'external')
    `);
    expect(() => insert.run('fullstack')).toThrow(/CHECK/i);
    expect(AGENT_ROLES.has('fullstack')).toBe(false);
  });
});
