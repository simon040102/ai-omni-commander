import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  prepareFolder, findSpecFiles, getFileVersion, inferDocTypeFromFilename,
  isGitRepo, assertAllowedGitArgs, validateSpecFolders, readSpecFolders,
  pathsOverlap, isPathUnder, filterSafeSpecFolders,
  type GitRunner, type GitResult,
} from '../FolderSpecSource.js';

let tmpBase: string;

beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'folderspec-'));
});

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkdir(rel: string): string {
  const p = path.join(tmpBase, rel);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(base: string, rel: string, content = 'x'): string {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** GitRunner that records calls and replies from a per-subcommand response table. */
function recordingRunner(responses: Record<string, Partial<GitResult>> = {}): { calls: string[][]; runner: GitRunner } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push([...args]);
    const r = responses[args[0]!] || {};
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error && { error: r.error }) };
  };
  return { calls, runner };
}

const gitAvailable = (() => {
  try {
    return spawnSync('git', ['--version'], { timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
})();

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@test.local', ...args], { cwd, encoding: 'utf-8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

// ── git command whitelist ───────────────────────────────────

describe('assertAllowedGitArgs（git 安全白名單）', () => {
  it('accepts the four allowed operations', () => {
    expect(() => assertAllowedGitArgs(['status', '--porcelain'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['rev-parse', 'HEAD'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['log', '-1', '--format=%cI', '--', 'a.md'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['pull', '--ff-only'])).not.toThrow();
  });

  it('rejects any write operation', () => {
    for (const bad of [['push'], ['reset', '--hard'], ['stash'], ['checkout', '.'], ['fetch'], ['clean', '-fd'], []]) {
      expect(() => assertAllowedGitArgs(bad as string[])).toThrow(/not allowed/);
    }
  });

  it('rejects pull without --ff-only', () => {
    expect(() => assertAllowedGitArgs(['pull'])).toThrow(/--ff-only/);
    expect(() => assertAllowedGitArgs(['pull', '--rebase'])).toThrow(/--ff-only/);
  });
});

// ── prepareFolder ───────────────────────────────────────────

describe('prepareFolder', () => {
  it('nonexistent path → ok=false with explicit error', async () => {
    const { calls, runner } = recordingRunner();
    const result = await prepareFolder({ path: path.join(tmpBase, 'does-not-exist'), gitPull: true }, runner);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不存在');
    expect(calls).toHaveLength(0);
  });

  it('relative path → ok=false', async () => {
    const result = await prepareFolder({ path: 'relative/specs', gitPull: false });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('絕對路徑');
  });

  it('non-git folder → scanned directly, no git calls, version null', async () => {
    const dir = mkdir('plain-folder');
    const { calls, runner } = recordingRunner();
    const result = await prepareFolder({ path: dir, gitPull: true }, runner);
    expect(result.ok).toBe(true);
    expect(result.isGitRepo).toBe(false);
    expect(result.version).toBeNull();
    expect(result.warnings).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('git repo + gitPull + clean tree → pull --ff-only is called', async () => {
    const dir = mkdir('git-clean');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const { calls, runner } = recordingRunner({ 'rev-parse': { stdout: 'abc123\n' } });
    const result = await prepareFolder({ path: dir, gitPull: true }, runner);
    expect(result.ok).toBe(true);
    expect(result.isGitRepo).toBe(true);
    expect(result.version).toBe('abc123');
    expect(result.warnings).toHaveLength(0);
    expect(calls.map(c => c[0])).toEqual(['status', 'pull', 'rev-parse']);
    const pullCall = calls.find(c => c[0] === 'pull')!;
    expect(pullCall).toContain('--ff-only');
  });

  it('git repo + gitPull + dirty tree → pull skipped with warning', async () => {
    const dir = mkdir('git-dirty');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const { calls, runner } = recordingRunner({
      status: { stdout: ' M spec.md\n' },
      'rev-parse': { stdout: 'def456\n' },
    });
    const result = await prepareFolder({ path: dir, gitPull: true }, runner);
    expect(result.ok).toBe(true);
    expect(calls.map(c => c[0])).toEqual(['status', 'rev-parse']); // no pull
    expect(result.warnings.some(w => w.includes('dirty') && w.includes('跳過 pull'))).toBe(true);
    expect(result.version).toBe('def456');
  });

  it('git pull failure → warning, best-effort continues with existing content', async () => {
    const dir = mkdir('git-pullfail');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const { runner } = recordingRunner({
      pull: { status: 1, stderr: 'fatal: Not possible to fast-forward, aborting.' },
      'rev-parse': { stdout: 'aaa111\n' },
    });
    const result = await prepareFolder({ path: dir, gitPull: true }, runner);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.includes('git pull --ff-only 失敗') && w.includes('fast-forward'))).toBe(true);
    expect(result.version).toBe('aaa111');
  });

  it('git repo without gitPull → no status/pull, only rev-parse', async () => {
    const dir = mkdir('git-nopull');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const { calls, runner } = recordingRunner({ 'rev-parse': { stdout: 'bbb222\n' } });
    const result = await prepareFolder({ path: dir, gitPull: false }, runner);
    expect(calls.map(c => c[0])).toEqual(['rev-parse']);
    expect(result.version).toBe('bbb222');
  });

  it.runIf(gitAvailable)('real git init fixture → isGitRepo + HEAD version + per-file git date', async () => {
    const dir = mkdir('git-real');
    git(dir, 'init');
    writeFile(dir, 'SPEC_WA05_test.md', '# spec');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'initial');

    expect(isGitRepo(dir)).toBe(true);
    const result = await prepareFolder({ path: dir, gitPull: false });
    expect(result.ok).toBe(true);
    expect(result.isGitRepo).toBe(true);
    expect(result.version).toMatch(/^[0-9a-f]{40}$/);

    const version = await getFileVersion(dir, path.join(dir, 'SPEC_WA05_test.md'), true);
    // committer date in ISO format
    expect(version).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── getFileVersion ──────────────────────────────────────────

describe('getFileVersion', () => {
  it('non-git folder → file mtime ISO', async () => {
    const dir = mkdir('version-plain');
    const file = writeFile(dir, 'a.md');
    const version = await getFileVersion(dir, file, false);
    expect(version).toBe(fs.statSync(file).mtime.toISOString());
  });

  it('git repo but file untracked (git log empty) → falls back to mtime', async () => {
    const dir = mkdir('version-untracked');
    const file = writeFile(dir, 'b.md');
    const { runner } = recordingRunner({ log: { stdout: '' } });
    const version = await getFileVersion(dir, file, true, runner);
    expect(version).toBe(fs.statSync(file).mtime.toISOString());
  });
});

// ── findSpecFiles（功能代碼比對）─────────────────────────────

describe('findSpecFiles', () => {
  let specDir: string;

  beforeAll(() => {
    specDir = mkdir('matching');
    writeFile(specDir, 'SPEC_OV02_(電)銷項發票彙開_v1.6.docx');
    writeFile(specDir, 'OV.銷項發票管理/SPEC_OV06_範例.md');
    writeFile(specDir, 'OV02.範例資料夾/inner.pdf');
    writeFile(specDir, 'OV020_similar-code.md');   // OV02 followed by digit → must NOT match OV02
    writeFile(specDir, 'old/SPEC_OV02_old-version.md'); // old/ excluded
    writeFile(specDir, 'readme.txt');
    writeFile(specDir, '收文單規格.md');
    writeFile(specDir, 'notes/SPEC_OV02.exe');     // non-spec extension
    writeFile(specDir, '.git/SPEC_OV02_in-git.md'); // .git excluded
    writeFile(specDir, '0_共用/共用元件.md');
  });

  it('matches by function code in basename or path segment', () => {
    const files = findSpecFiles(specDir, 'OV02');
    const rels = files.map(f => f.relPath).sort();
    expect(rels).toEqual([
      'OV02.範例資料夾/inner.pdf',
      'SPEC_OV02_(電)銷項發票彙開_v1.6.docx',
    ]);
  });

  it('does not match codes followed by digits (OV02 vs OV020) and skips old/ + .git/', () => {
    const files = findSpecFiles(specDir, 'OV02');
    const rels = files.map(f => f.relPath);
    expect(rels.some(r => r.includes('OV020'))).toBe(false);
    expect(rels.some(r => r.startsWith('old/'))).toBe(false);
    expect(rels.some(r => r.includes('.git'))).toBe(false);
  });

  it('matches by Chinese name fallback', () => {
    const files = findSpecFiles(specDir, 'DF99', ['收文單']);
    expect(files.map(f => f.relPath)).toEqual(['收文單規格.md']);
  });

  it('falls back to 0_ shared files when root folder exists but no code match', () => {
    const files = findSpecFiles(specDir, 'OV99');
    expect(files.map(f => f.relPath)).toEqual(['0_共用/共用元件.md']);
  });

  it('returns absolute filePath + mtime + inferred docType', () => {
    const files = findSpecFiles(specDir, 'OV02');
    for (const f of files) {
      expect(path.isAbsolute(f.filePath)).toBe(true);
      expect(f.mtimeIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(['SA', 'SD']).toContain(f.docType);
    }
  });
});

// ── docType inference ───────────────────────────────────────

describe('inferDocTypeFromFilename', () => {
  it('SA/SD token conventions', () => {
    expect(inferDocTypeFromFilename('[SA] SPEC_WA05.docx')).toBe('SA');
    expect(inferDocTypeFromFilename('[SD] SPEC_WA05.docx')).toBe('SD');
    expect(inferDocTypeFromFilename('WA05_SA_查詢.docx')).toBe('SA');
    expect(inferDocTypeFromFilename('WA05.SD.設計.docx')).toBe('SD');
  });

  it('Chinese conventions', () => {
    expect(inferDocTypeFromFilename('WA05_需求規格書.docx')).toBe('SA');
    expect(inferDocTypeFromFilename('WA05_系統分析.docx')).toBe('SA');
    expect(inferDocTypeFromFilename('WA05_系統設計書.docx')).toBe('SD');
  });

  it('no token → defaults to SD, and SAMPLE-like words are not treated as SA', () => {
    expect(inferDocTypeFromFilename('SPEC_OV02_發票.docx')).toBe('SD');
    expect(inferDocTypeFromFilename('SAMPLE_OV02.docx')).toBe('SD');
  });
});

// ── path helpers ────────────────────────────────────────────

describe('pathsOverlap / isPathUnder', () => {
  it('detects equal / parent / child', () => {
    const a = path.join(tmpBase, 'ws');
    expect(pathsOverlap(a, a)).toBe(true);
    expect(pathsOverlap(path.join(a, 'sub'), a)).toBe(true);
    expect(pathsOverlap(a, path.join(a, 'sub'))).toBe(true);
    expect(pathsOverlap(path.join(tmpBase, 'ws2'), a)).toBe(false);
    // prefix similarity is not containment
    expect(pathsOverlap(path.join(tmpBase, 'ws-extra'), a)).toBe(false);
  });

  it('isPathUnder is directional', () => {
    const parent = path.join(tmpBase, 'p');
    expect(isPathUnder(path.join(parent, 'c', 'f.md'), parent)).toBe(true);
    expect(isPathUnder(parent, path.join(parent, 'c'))).toBe(false);
  });
});

// ── validateSpecFolders（設定驗證）──────────────────────────

describe('validateSpecFolders', () => {
  it('accepts valid absolute folders and warns on nonexistent paths', () => {
    const existing = mkdir('validate-ok');
    const missing = path.join(tmpBase, 'validate-missing');
    const { folders, warnings } = validateSpecFolders(
      [{ path: existing, gitPull: true }, { path: missing }],
      [path.join(tmpBase, 'fe'), null],
    );
    expect(folders).toEqual([
      { path: existing, gitPull: true },
      { path: missing, gitPull: false },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('不存在');
  });

  it('rejects relative paths', () => {
    expect(() => validateSpecFolders([{ path: 'specs/docs' }], [])).toThrow(/絕對路徑/);
  });

  it('rejects empty/invalid entries', () => {
    expect(() => validateSpecFolders('not-an-array', [])).toThrow(/陣列/);
    expect(() => validateSpecFolders([{ gitPull: true }], [])).toThrow(/path/);
    expect(() => validateSpecFolders(['D:\\x'], [])).toThrow(/物件/);
    expect(() => validateSpecFolders([{ path: path.join(tmpBase, 'x'), gitPull: 'yes' }], [])).toThrow(/boolean/);
  });

  it('rejects overlap with workspace paths (equal / child / parent)', () => {
    const ws = mkdir('validate-ws');
    // equal
    expect(() => validateSpecFolders([{ path: ws }], [ws])).toThrow(/workspace/);
    // spec folder is child of workspace
    expect(() => validateSpecFolders([{ path: path.join(ws, 'docs') }], [ws])).toThrow(/workspace/);
    // spec folder is parent of workspace
    expect(() => validateSpecFolders([{ path: tmpBase }], [ws])).toThrow(/workspace/);
    // sibling is fine
    expect(() => validateSpecFolders([{ path: path.join(tmpBase, 'validate-sibling') }], [ws])).not.toThrow();
  });

  it('undefined/null → empty result (no folders configured)', () => {
    expect(validateSpecFolders(undefined, [])).toEqual({ folders: [], warnings: [] });
    expect(validateSpecFolders(null, [])).toEqual({ folders: [], warnings: [] });
  });
});

// ── readSpecFolders（config_json 寬鬆讀取）───────────────────

describe('readSpecFolders', () => {
  it('reads valid entries and drops malformed ones', () => {
    const folders = readSpecFolders({
      specFolders: [
        { path: 'D:\\specs\\a', gitPull: true },
        { path: '  ' },              // blank → dropped
        { gitPull: true },           // no path → dropped
        'D:\\x',                     // not an object → dropped
        { path: 'D:\\specs\\b' },    // gitPull defaults false
      ],
    });
    expect(folders).toEqual([
      { path: 'D:\\specs\\a', gitPull: true },
      { path: 'D:\\specs\\b', gitPull: false },
    ]);
  });

  it('missing/invalid config → empty', () => {
    expect(readSpecFolders(null)).toEqual([]);
    expect(readSpecFolders({})).toEqual([]);
    expect(readSpecFolders({ specFolders: 'x' })).toEqual([]);
  });
});

// ── filterSafeSpecFolders（抓取期 defense-in-depth）──────────

describe('filterSafeSpecFolders', () => {
  const specA = { path: 'D:\\specs\\a', gitPull: true };
  const specB = { path: 'D:\\specs\\b', gitPull: false };

  it('blocks folders overlapping a workspace and reports warnings', () => {
    const { safe, blockedWarnings } = filterSafeSpecFolders(
      [specA, { path: 'D:\\fork\\tvedi\\docs', gitPull: true }, specB],
      ['D:\\fork\\tvedi', null],
    );
    expect(safe).toEqual([specA, specB]);
    expect(blockedWarnings).toHaveLength(1);
    expect(blockedWarnings[0]).toContain('重疊');
  });

  it('case-insensitive and trailing-slash tolerant on Windows', () => {
    if (process.platform !== 'win32') return;
    const { safe, blockedWarnings } = filterSafeSpecFolders(
      [{ path: 'd:\\FORK\\Tvedi\\', gitPull: true }],
      ['D:\\fork\\tvedi'],
    );
    expect(safe).toEqual([]);
    expect(blockedWarnings).toHaveLength(1);
  });

  it('no workspaces configured → everything passes', () => {
    const { safe, blockedWarnings } = filterSafeSpecFolders([specA], [null, undefined]);
    expect(safe).toEqual([specA]);
    expect(blockedWarnings).toEqual([]);
  });
});
