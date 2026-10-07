/**
 * 每日推送：走真的 schema（in-memory DB）端到端跑 collect → diff → 寫檔 → 通知，
 * 通知用假的 notifier 接住，不真的跳視窗。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../../db/schema.js';
import { runAttentionDigest } from '../attentionDigest.js';

let db: Database.Database;
let dataDir: string;
let calls: Array<{ title: string; body: string; filePath: string }>;
const notify = (title: string, body: string, filePath: string) => { calls.push({ title, body, filePath }); };

function seedTask(id: string, hoursAgo: number, status = 'in_progress', parent: string | null = null) {
  db.prepare(`INSERT INTO tasks (id, project_id, title, label, task_type, status, parent_name) VALUES (?, 'p1', ?, 'frontend', 'feature', ?, ?)`)
    .run(id, `任務${id}`, status, parent);
  db.prepare(`UPDATE tasks SET updated_at = datetime('now', ?) WHERE id = ?`).run(`-${hoursAgo} hours`, id);
}

function seedGap(id: string, taskId: string, daysAgo: number) {
  db.prepare(`INSERT INTO spec_gaps (id, task_id, project_id, category, description) VALUES (?, ?, 'p1', 'logic_unclear', ?)`)
    .run(id, taskId, `缺口 ${id}\n第二行`);
  db.prepare(`UPDATE spec_gaps SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${daysAgo} days`, id);
}

// 固定在「今天上午 10 點」（本地），過了預設 9 點
const today10 = () => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; };
const tomorrow10 = () => { const d = today10(); d.setDate(d.getDate() + 1); return d; };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`INSERT INTO projects (id, name, working_dir) VALUES ('p1', '測試專案', '/tmp')`).run();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-digest-'));
  calls = [];
});
afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('runAttentionDigest', () => {
  it('第一次：建立基線、寫檔、通知', () => {
    seedTask('t1', 48, 'in_progress', '母任務');
    seedGap('g1', 't1', 40);
    const r = runAttentionDigest({ db, dataDir, now: today10(), notify });
    expect(r.ran).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toContain('基線');
    const md = fs.readFileSync(r.wrote!, 'utf8');
    expect(md).toContain('第一次執行');
    expect(md).toContain('母任務 / 任務t1');          // 帶母任務名
    expect(md).toContain('缺口 g1 第二行');           // 換行被壓平
  });

  it('同一天再跑（例如 server 重啟）→ 不跑、不重推', () => {
    seedTask('t1', 48);
    runAttentionDigest({ db, dataDir, now: today10(), notify });
    const r = runAttentionDigest({ db, dataDir, now: today10(), notify });
    expect(r.ran).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('隔天沒有變化 → 跑了但保持安靜（不寫檔、不通知）', () => {
    seedTask('t1', 48);
    runAttentionDigest({ db, dataDir, now: today10(), notify });
    const r = runAttentionDigest({ db, dataDir, now: tomorrow10(), notify });
    expect(r.ran).toBe(true);
    expect(r.wrote).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('隔天有新停滯任務 → 只列新的那個', () => {
    seedTask('t1', 48);
    runAttentionDigest({ db, dataDir, now: today10(), notify });
    seedTask('t2', 30);
    const r = runAttentionDigest({ db, dataDir, now: tomorrow10(), notify });
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain('停滯 +1');
    const md = fs.readFileSync(r.wrote!, 'utf8');
    expect(md).toContain('新停滯的任務');
    expect(md).toContain('任務t2');
    expect(md).not.toContain('任務t1');
  });

  it('還沒到 9 點 → 不跑', () => {
    seedTask('t1', 48);
    const early = today10(); early.setHours(7);
    expect(runAttentionDigest({ db, dataDir, now: early, notify }).ran).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('什麼都沒有 → 第一次也不通知（沒有「一切正常」）', () => {
    const r = runAttentionDigest({ db, dataDir, now: today10(), notify });
    expect(r.ran).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('狀態檔壞掉 → 當成第一次，不 throw', () => {
    fs.mkdirSync(path.join(dataDir, 'attention'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'attention', 'state.json'), '{壞掉');
    seedTask('t1', 48);
    const r = runAttentionDigest({ db, dataDir, now: today10(), notify });
    expect(r.ran).toBe(true);
    expect(calls[0].title).toContain('基線');
  });

  it('DB 出錯 → 回 error，不 throw（不能拖垮 server）', () => {
    db.close();
    const r = runAttentionDigest({ db, dataDir, now: today10(), notify });
    expect(r.ran).toBe(false);
    expect(r.error).toBeTruthy();
    db = new Database(':memory:');   // 讓 afterEach 的 close 有東西可關
  });
});
