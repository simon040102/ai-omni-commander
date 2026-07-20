/**
 * FolderSpecSource — 本地資料夾規格來源（與 SVN 並存）。
 *
 * 純函式核心：只依賴 fs / path / child_process，**不 import DB 或 DocumentParser**，
 * 供 Web Server 與 MCP 兩個 process 共用（DB 寫入由各自的整合層負責）。
 * MCP process 內嚴禁 process.cwd() — 資料夾路徑一律來自設定且必須是絕對路徑
 * （相對路徑在 validateSpecFolders 就拒絕）。
 *
 * git 安全鐵律：
 * - 只允許 status / rev-parse / log / pull --ff-only 四種操作，絕不寫入（不 stash / 不 reset）
 * - dirty working tree → 跳過 pull + 警告
 * - pull 逾時 15 秒；失敗 → best-effort 用現有內容 + 明確警告
 * - git 指令一律 spawn 陣列參數（不過 shell）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ── config types ────────────────────────────────────────────

export interface SpecFolderConfig {
  path: string;
  gitPull?: boolean;
}

// ── git runner（可注入，測試用）─────────────────────────────

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type GitRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<GitResult>;

export const GIT_PULL_TIMEOUT_MS = 15_000;
const GIT_QUERY_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 1024 * 1024;

const ALLOWED_GIT_SUBCOMMANDS = new Set(['status', 'rev-parse', 'log', 'pull']);

/**
 * 白名單守衛：git 只允許 status / rev-parse / log / pull，且 pull 必須帶 --ff-only。
 * 所有 runner 呼叫（含測試注入的）都先過這關。
 */
export function assertAllowedGitArgs(args: string[]): void {
  const sub = args[0];
  if (!sub || !ALLOWED_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error(`git subcommand not allowed: ${sub ?? '(none)'}`);
  }
  if (sub === 'pull' && !args.includes('--ff-only')) {
    throw new Error('git pull must use --ff-only');
  }
}

/** 預設 runner：async spawn（不過 shell、陣列參數、windowsHide）。 */
export const defaultGitRunner: GitRunner = (args, cwd, timeoutMs) => {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let total = 0;
    let runError: Error | undefined;

    const child = spawn('git', args, { cwd, windowsHide: true });

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        ...(runError && { error: runError }),
      });
    };

    const timer = setTimeout(() => {
      runError = new Error(`git ${args[0]} timed out after ${timeoutMs}ms`);
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      total += d.length;
      if (total > GIT_MAX_BUFFER) {
        runError = new Error('git output exceeded maxBuffer');
        child.kill();
        return;
      }
      stdoutChunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', (err) => { runError = err; finish(null); });
    child.on('close', (code) => finish(code));
    child.stdin?.end();
  });
};

async function runGitGuarded(runGit: GitRunner, args: string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  assertAllowedGitArgs(args);
  return runGit(args, cwd, timeoutMs);
}

function firstLine(text: string): string {
  return (text || '').split('\n')[0]!.trim();
}

// ── folder preparation ──────────────────────────────────────

export interface PrepareFolderResult {
  /** 資料夾存在且可讀 */
  ok: boolean;
  isGitRepo: boolean;
  /** git repo → HEAD commit hash；非 git → null */
  version: string | null;
  /** pull 被跳過（dirty）/ pull 失敗等警告 — 有警告仍繼續用現有內容 */
  warnings: string[];
  /** ok=false 時的錯誤訊息 */
  error?: string;
}

/** 資料夾是否為 git repo（.git 目錄或檔案 — worktree/submodule 也算）。 */
export function isGitRepo(folderPath: string): boolean {
  // 往上找 .git（目錄或 worktree 的 .git 檔案皆可）：規格資料夾常指向 git repo 的
  // 「子資料夾」（如 hn_doc/FEDI_ADM）——git 指令以子資料夾為 cwd 一樣正常運作
  // （pull 更新整個 repo、status 看整個 working tree），偵測不該只看自己這層。
  try {
    let dir = path.resolve(folderPath);
    for (let depth = 0; depth < 30; depth++) {
      if (fs.existsSync(path.join(dir, '.git'))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) return false; // 到磁碟根了
      dir = parent;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 準備規格資料夾：存在檢查 → （git repo 且 gitPull）dirty 檢查 → git pull --ff-only。
 * pull 失敗或 dirty 都只警告不失敗（best-effort 用現有內容）。
 */
export async function prepareFolder(
  folder: SpecFolderConfig,
  runGit: GitRunner = defaultGitRunner,
): Promise<PrepareFolderResult> {
  const warnings: string[] = [];
  const folderPath = folder.path;

  if (!folderPath || !path.isAbsolute(folderPath)) {
    return { ok: false, isGitRepo: false, version: null, warnings, error: `規格資料夾必須是絕對路徑：${folderPath || '(空)'}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    return { ok: false, isGitRepo: false, version: null, warnings, error: `規格資料夾不存在或無法存取：${folderPath}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, isGitRepo: false, version: null, warnings, error: `規格資料夾路徑不是目錄：${folderPath}` };
  }

  const git = isGitRepo(folderPath);

  if (git && folder.gitPull) {
    const status = await runGitGuarded(runGit, ['status', '--porcelain'], folderPath, GIT_QUERY_TIMEOUT_MS);
    if (status.error || status.status !== 0) {
      warnings.push(`git status 失敗，跳過 pull（使用現有內容）：${firstLine(status.error?.message || status.stderr) || `exit ${status.status}`}`);
    } else if (status.stdout.trim().length > 0) {
      warnings.push('git working tree 有未提交變更（dirty），跳過 pull（使用現有內容，絕不 stash/reset）');
    } else {
      const pull = await runGitGuarded(runGit, ['pull', '--ff-only'], folderPath, GIT_PULL_TIMEOUT_MS);
      if (pull.error || pull.status !== 0) {
        warnings.push(`git pull --ff-only 失敗（使用現有內容）：${firstLine(pull.error?.message || pull.stderr) || `exit ${pull.status}`}`);
      }
    }
  }

  let version: string | null = null;
  if (git) {
    const rp = await runGitGuarded(runGit, ['rev-parse', 'HEAD'], folderPath, GIT_QUERY_TIMEOUT_MS);
    if (!rp.error && rp.status === 0 && rp.stdout.trim()) {
      version = rp.stdout.trim();
    }
  }

  return { ok: true, isGitRepo: git, version, warnings };
}

// ── file version ────────────────────────────────────────────

/**
 * 檔案版本值（寫進 task_spec_versions.last_modified）：
 * git repo → 該檔最後一次 commit 的 committer date（ISO，`git log -1 --format=%cI -- <file>`），
 * 取不到（未追蹤檔等）或非 git → 檔案 mtime ISO。
 */
export async function getFileVersion(
  folderPath: string,
  absFilePath: string,
  gitRepo: boolean,
  runGit: GitRunner = defaultGitRunner,
): Promise<string> {
  if (gitRepo) {
    const rel = path.relative(folderPath, absFilePath);
    const r = await runGitGuarded(runGit, ['log', '-1', '--format=%cI', '--', rel], folderPath, GIT_QUERY_TIMEOUT_MS);
    const out = r.stdout.trim();
    if (!r.error && r.status === 0 && out) return firstLine(out);
  }
  try {
    return fs.statSync(absFilePath).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// ── spec file matching（沿用 SVN 的 root code 比對邏輯）──────

const SPEC_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.md', '.txt']);
const EXCLUDED_DIRS = new Set(['.git', '.svn', 'node_modules']);

export function hasSpecExtension(filename: string): boolean {
  return SPEC_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/** 從功能代碼取字母前綴：OV0101 → OV。 */
export function extractRootCode(code: string): string | null {
  const match = code.match(/^([A-Za-z]+)/);
  return match ? match[1]!.toUpperCase() : null;
}

/** 從任務標題/父名擷取功能代碼（如 "DF04_發文單" → "DF04"）。 */
export function extractFunctionCode(text: string): string | null {
  const match = text.match(/(?:^|[^A-Za-z])([A-Za-z]{2,}[0-9]+)(?=[^A-Za-z0-9]|$)/);
  if (match && match[1]!.length >= 3) return match[1]!.toUpperCase();
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 檔名 SA/SD 慣例推斷：
 * 檔名（或路徑段）含獨立的 SA/SD token、或中文「系統分析/需求規格 vs 系統設計」字樣。
 * 判斷不到時預設 SD（與 DocumentParser 預設一致）。
 */
export function inferDocTypeFromFilename(filename: string): 'SA' | 'SD' {
  const upper = filename.toUpperCase();
  if (/(?<![A-Z0-9])SD(?![A-Z0-9])/.test(upper)) return 'SD';
  if (/(?<![A-Z0-9])SA(?![A-Z0-9])/.test(upper)) return 'SA';
  if (/系統設計/.test(filename)) return 'SD';
  if (/需求規格|系統分析/.test(filename)) return 'SA';
  return 'SD';
}

export interface FolderSpecFile {
  /** 絕對路徑 */
  filePath: string;
  /** 相對於規格資料夾的路徑（forward slash） */
  relPath: string;
  /** 檔案 mtime（ISO） */
  mtimeIso: string;
  docType: 'SA' | 'SD';
}

/** 遞迴列出資料夾下所有規格副檔名檔案的相對路徑（排除 .git / node_modules / old）。 */
function walkSpecFiles(folderPath: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, relPrefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.toLowerCase() === 'old') continue;
        walk(path.join(dir, entry.name), relPrefix + entry.name + '/');
      } else if (entry.isFile() && hasSpecExtension(entry.name)) {
        results.push(relPrefix + entry.name);
      }
    }
  };
  walk(folderPath, '');
  return results;
}

/**
 * 在規格資料夾中找出符合功能代碼的規格檔（同 SVN findMatchingFiles 邏輯）：
 * - code 前不可為英數字、後不可為數字（OV02 不會誤中 OV020）
 * - 檔名或任一路徑段含 code 都算命中
 * - chineseNames（選填）：檔名含中文功能名也算命中（Asana parent 無代碼時的 fallback）
 * - 全部沒中且存在 rootCode 開頭的頂層資料夾時，fallback 收 `0_` 開頭的共用檔（同 SVN）
 */
export function findSpecFiles(
  folderPath: string,
  functionCode: string,
  chineseNames?: string[],
): FolderSpecFile[] {
  const relPaths = walkSpecFiles(folderPath);
  const code = functionCode.toUpperCase();
  const codePattern = new RegExp(`(?<![A-Z0-9])${escapeRegex(code)}(?![0-9])`, 'i');

  const matched: string[] = [];
  for (const rel of relPaths) {
    const segments = rel.split('/');
    const basename = segments[segments.length - 1]!;
    if (codePattern.test(basename) || segments.slice(0, -1).some(seg => codePattern.test(seg))) {
      matched.push(rel);
      continue;
    }
    if (chineseNames?.length) {
      if (chineseNames.some(cn => cn && basename.includes(cn))) matched.push(rel);
    }
  }

  // Fallback: 0_共用（僅當 rootCode 對得到頂層資料夾、但沒有任何檔案命中時 — 同 SVN 行為）
  if (matched.length === 0) {
    const rootCode = extractRootCode(functionCode);
    if (rootCode) {
      const hasRootFolder = relPaths.some(rel => {
        const top = rel.split('/')[0]!.toUpperCase();
        return rel.includes('/') && (top === rootCode || top.startsWith(rootCode + '.') || top.startsWith(rootCode + '_'));
      });
      if (hasRootFolder) {
        matched.push(...relPaths.filter(rel => rel.split('/')[0]!.startsWith('0_')));
      }
    }
  }

  return matched.map(rel => {
    const filePath = path.join(folderPath, rel);
    let mtimeIso = '';
    try { mtimeIso = fs.statSync(filePath).mtime.toISOString(); } catch { /* keep empty */ }
    return { filePath, relPath: rel, mtimeIso, docType: inferDocTypeFromFilename(rel) };
  });
}

// ── config validation ───────────────────────────────────────

function normalizeForCompare(p: string): string {
  let n = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

/** 兩路徑相同或互為父子。 */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  return na === nb || na.startsWith(nb + path.sep) || nb.startsWith(na + path.sep);
}

/** childPath 是否等於 parentPath 或位於其之下（單向包含檢查）。 */
export function isPathUnder(childPath: string, parentPath: string): boolean {
  const nc = normalizeForCompare(childPath);
  const np = normalizeForCompare(parentPath);
  return nc === np || nc.startsWith(np + path.sep);
}

export interface SpecFoldersValidation {
  folders: SpecFolderConfig[];
  /** 非阻擋性警告（如路徑目前不存在） */
  warnings: string[];
}

/**
 * 抓取期的 defense-in-depth：過濾掉與 workspace 重疊的規格資料夾。
 * 設定寫入時已有 validateSpecFolders 擋，但 workspace 路徑可能在設定之後
 * 才被改成與規格資料夾重疊（單邊更新）——抓取前必須複查，絕不對程式碼
 * workspace 跑 git 操作。被擋的資料夾以警告回報。
 */
export function filterSafeSpecFolders(
  folders: SpecFolderConfig[],
  workspacePaths: Array<string | null | undefined>,
): { safe: SpecFolderConfig[]; blockedWarnings: string[] } {
  const safe: SpecFolderConfig[] = [];
  const blockedWarnings: string[] = [];
  const workspaces = workspacePaths.filter((p): p is string => !!p);
  for (const folder of folders) {
    const hit = workspaces.find(ws => pathsOverlap(folder.path, ws));
    if (hit) {
      blockedWarnings.push(`規格資料夾 ${folder.path} 與 workspace ${hit} 重疊，已跳過（安全防護：不對程式碼 workspace 執行 git 操作）`);
    } else {
      safe.push(folder);
    }
  }
  return { safe, blockedWarnings };
}

/**
 * 驗證 config_json.specFolders（設定儲存時呼叫；不合法直接 throw）：
 * - 必須是陣列；每項 path 為非空字串且為絕對路徑（相對路徑拒絕）
 * - gitPull 若有必須是 boolean
 * - 與該專案 frontendPath / backendPath 相同或互為父子 → 拒絕（防誤 pull 程式碼 workspace）
 * - 路徑不存在 → 只給警告不拒絕（NAS 可能暫時離線）
 */
export function validateSpecFolders(
  input: unknown,
  workspacePaths: Array<string | null | undefined>,
): SpecFoldersValidation {
  if (input === undefined || input === null) return { folders: [], warnings: [] };
  if (!Array.isArray(input)) {
    throw new Error('specFolders 必須是陣列');
  }

  const warnings: string[] = [];
  const folders: SpecFolderConfig[] = [];
  const workspaces = workspacePaths.filter((w): w is string => !!w && w.trim().length > 0);

  for (const item of input) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('specFolders 每一項必須是 { path, gitPull? } 物件');
    }
    const { path: p, gitPull } = item as { path?: unknown; gitPull?: unknown };
    if (typeof p !== 'string' || p.trim().length === 0) {
      throw new Error('specFolders 每一項必須有非空字串 path');
    }
    const trimmed = p.trim();
    if (!path.isAbsolute(trimmed)) {
      throw new Error(`規格資料夾必須是絕對路徑：${trimmed}`);
    }
    if (gitPull !== undefined && typeof gitPull !== 'boolean') {
      throw new Error(`規格資料夾 gitPull 必須是 boolean：${trimmed}`);
    }
    for (const ws of workspaces) {
      if (pathsOverlap(trimmed, ws)) {
        throw new Error(`規格資料夾不可與專案 workspace（frontendPath/backendPath）相同或互為父子：${trimmed} ↔ ${ws}`);
      }
    }
    try {
      if (!fs.statSync(trimmed).isDirectory()) {
        warnings.push(`規格資料夾路徑不是目錄：${trimmed}`);
      }
    } catch {
      warnings.push(`規格資料夾目前不存在（將於抓取時再試）：${trimmed}`);
    }
    folders.push({ path: trimmed, gitPull: gitPull === true });
  }

  return { folders, warnings };
}

/** 從 config_json 物件安全取出 specFolders（未驗證前的寬鬆讀取，抓取時用）。 */
export function readSpecFolders(config: unknown): SpecFolderConfig[] {
  if (typeof config !== 'object' || config === null) return [];
  const raw = (config as { specFolders?: unknown }).specFolders;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is { path: string; gitPull?: boolean } =>
      typeof f === 'object' && f !== null && typeof (f as { path?: unknown }).path === 'string' && (f as { path: string }).path.trim().length > 0)
    .map(f => ({ path: f.path.trim(), gitPull: f.gitPull === true }));
}
