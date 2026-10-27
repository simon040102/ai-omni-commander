/**
 * Superpowers 方法論 .md 的位置：tsc 只編 .ts、不會把 .md 複製進 dist。
 * Web Server 以 tsx 從 src 跑所以一直讀得到；MCP 從 dist 跑、改在自己 process 組執行計畫後
 * 讀不到（驗收時實際踩到：每個 get_execution_plan 都 ENOENT）。dist 旁沒有就退回 src 的對應位置。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveSkillDir, loadSuperpowersPrompt } from '../index.js';

// 用 resolve（Windows 會補磁碟代號）——與實作同一種路徑形式
const SRC = path.resolve('/repo', 'server', 'src', 'skills', 'superpowers');
const DIST = path.resolve('/repo', 'server', 'dist', 'skills', 'superpowers');

describe('resolveSkillDir', () => {
  it('模組旁就有 .md（從 src 跑）→ 用模組目錄', () => {
    expect(resolveSkillDir(SRC, (p) => p.startsWith(SRC))).toBe(SRC);
  });

  it('從 dist 跑、dist 旁沒有 .md → 退回 server/src/skills/superpowers', () => {
    expect(resolveSkillDir(DIST, (p) => p.startsWith(SRC))).toBe(SRC);
  });

  it('dist 旁有 .md（之後若加了複製步驟）→ 用 dist 的', () => {
    expect(resolveSkillDir(DIST, () => true)).toBe(DIST);
  });

  it('兩邊都沒有 → 回模組目錄（讓讀檔時報出原本的 ENOENT，不吞錯）', () => {
    expect(resolveSkillDir(DIST, () => false)).toBe(DIST);
  });
});

describe('loadSuperpowersPrompt（實際讀檔）', () => {
  it('三份方法論都讀得到、內容非空', () => {
    const p = loadSuperpowersPrompt(['brainstorm', 'tdd', 'debugging']);
    expect(p).toContain('# Superpowers Development Methodology');
    expect(p.length).toBeGreaterThan(500);
  });
});
