import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import mammoth from 'mammoth';
import type { SvnConfig, SvnCredentials, DocType, SpecFolderConfig } from '@omni/shared';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { prepareFolder, findSpecFiles, getFileVersion } from '../documents/FolderSpecSource.js';
import { extractChineseNames, decideDedupe, classifyPrepareResult, type ExistingDocInfo } from '../documents/SpecFetchPolicy.js';
import { bindDocumentToTask, getDocumentsForTask } from '../db/queries/taskDocuments.js';
import { recordTaskSpecVersion } from '../db/queries/taskSpecVersions.js';
import { getSvnCredentials } from '../db/queries/globalConfig.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SvnSpecService');

const SPEC_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.md', '.txt']);

export interface RunCommandResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
}

/**
 * Async replacement for spawnSync — runs a command without blocking the event loop.
 * Supports timeout, maxBuffer, and writing secrets to stdin (so they never appear on argv).
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; stdin?: string },
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutTotal = 0;
    let runError: Error | undefined;

    const child = spawn(cmd, args, { windowsHide: true });

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
        ...(runError && { error: runError }),
      });
    };

    const timer = setTimeout(() => {
      runError = new Error(`Command timed out after ${opts.timeout}ms: ${cmd}`);
      child.kill();
    }, opts.timeout);

    child.stdout?.on('data', (d: Buffer) => {
      stdoutTotal += d.length;
      if (stdoutTotal > opts.maxBuffer) {
        runError = new Error(`maxBuffer exceeded (${opts.maxBuffer} bytes): ${cmd}`);
        child.kill();
        return;
      }
      stdoutChunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));

    child.on('error', (err) => {
      runError = err;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    if (child.stdin) {
      child.stdin.on('error', () => { /* EPIPE if process exits early — ignore */ });
      if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

function firstLine(text: string | undefined | null): string {
  return (text || '').split('\n')[0]!.trim();
}

/** Build curl auth via stdin config (`--config -`) so credentials never appear on argv. */
export function buildCurlAuth(username: string, password: string): { args: string[]; stdin?: string } {
  const args = ['--ntlm', '--silent', '--insecure', '--fail-with-body'];
  if (username || password) {
    const escaped = `${username || ''}:${password || ''}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    args.push('--config', '-');
    return { args, stdin: `user = "${escaped}"\n` };
  }
  return { args };
}

/** Build svn auth args with `--password-from-stdin` so the password never appears on argv. */
export function buildSvnAuth(creds?: SvnCredentials): { args: string[]; stdin?: string } {
  const { username, password } = creds || getSvnCredentials();
  const args = [
    '--non-interactive',
    '--trust-server-cert',
    '--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other',
    '--no-auth-cache',
  ];
  if (username) args.push('--username', username);
  if (password) {
    args.push('--password-from-stdin');
    return { args, stdin: password };
  }
  return { args };
}

/**
 * Service for fetching specification documents from SVN repositories.
 * Handles authentication, Big5 encoding, caching, and DOCX conversion.
 */
export class SvnSpecService {
  private svnPath: string;
  private ntlmMode = false; // auto-set when svn fails with NTLM auth error

  constructor(
    private documentParser: DocumentParser,
    private cacheDir: string,
  ) {
    this.svnPath = this.detectSvnPath();
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  /**
   * Fetch all spec documents from SVN that match the given parent name (function code).
   * Returns document IDs of fetched/cached documents.
   */
  async fetchSpecsForTask(
    projectId: string,
    taskId: string,
    parentName: string,
    svnConfig: SvnConfig,
    taskLabel: string,
    taskTitle?: string,
  ): Promise<string[]> {
    // Note: we do NOT short-circuit here even if SVN docs are already bound —
    // execution always checks SVN for the latest version (svnLastModified cache handles no-op re-downloads).

    // Determine which SVN roots to search based on task label
    // Frontend tasks: SA (frontendSpec) + SD (backendSpec)
    // Backend tasks: SD (backendSpec) only
    // Other: both if available
    const svnRoots = this.resolveSvnRoots(svnConfig, taskLabel);
    if (svnRoots.length === 0) {
      logger.warn({ taskLabel }, 'No SVN root paths configured for this task label');
      return [];
    }

    // Extract function code (e.g., "OV02") from full parentName (e.g., "OV02.需檢核有相同匯率...")
    const functionCode = extractFunctionCode(parentName) || parentName;
    const rootCode = extractRootCode(functionCode);
    if (!rootCode) {
      logger.warn({ parentName, functionCode }, 'Could not extract root code from parent name');
      return [];
    }

    // Chinese-name fallback (shared policy — same behavior as MCP fetch_svn_specs)
    const chineseNames = extractChineseNames(parentName, taskTitle);

    // Collect matched files from all SVN roots, tracking which root each came from
    const allMatchedFiles: Array<{ fileUrl: string; isFrontendRoot: boolean }> = [];
    const frontendRoot = svnConfig.frontendSpecPath ? normalizeSvnUrl(svnConfig.frontendSpecPath) : null;
    const errors: string[] = [];

    for (const svnRoot of svnRoots) {
      logger.info({ projectId, taskId, parentName, functionCode, rootCode, svnRoot, taskLabel }, 'Searching SVN root for specs');

      try {
        // Step 1: Find the matching top-level folder
        const topItems = await this.svnList(svnRoot, svnConfig, false);
        const matchedFolder = this.findMatchingFolder(topItems, rootCode);

        let searchUrl: string;
        let allFiles: string[];

        if (matchedFolder) {
          // Has subfolder structure (e.g., "OV.銷項發票管理/")
          searchUrl = `${svnRoot}/${matchedFolder}`;
          logger.info({ matchedFolder, searchUrl }, 'Found matching SVN folder');
          allFiles = await this.svnList(searchUrl, svnConfig, true);
        } else {
          // Flat structure — all files in root directory (common for backend specs)
          searchUrl = svnRoot;
          logger.info({ rootCode, svnRoot }, 'No subfolder found, searching root directly');
          allFiles = topItems;
        }

        // Step 2: Find matching files by function code (with Chinese-name fallback)
        const matchedFiles = this.findMatchingFiles(allFiles, functionCode, chineseNames);

        if (matchedFiles.length === 0 && matchedFolder) {
          logger.info({ parentName, searchUrl }, 'No matching files found, trying 0_共用/ fallback');
          const sharedFiles = allFiles.filter(f =>
            f.startsWith('0_') && !f.endsWith('/') && hasSpecExtension(f)
          );
          if (sharedFiles.length > 0) {
            matchedFiles.push(...sharedFiles);
          }
        }

        const isFrontendRoot = svnRoot === frontendRoot;
        for (const file of matchedFiles) {
          allMatchedFiles.push({ fileUrl: `${searchUrl}/${file}`, isFrontendRoot });
        }

        if (matchedFiles.length > 0) {
          logger.info({ svnRoot, parentName, fileCount: matchedFiles.length, files: matchedFiles }, 'Found matching spec files');
        }
      } catch (err) {
        logger.warn({ err, svnRoot }, 'Failed to search SVN root');
        errors.push(`${svnRoot}: ${firstLine((err as Error).message)}`);
      }
    }

    if (allMatchedFiles.length === 0) {
      if (errors.length > 0) {
        throw new Error(`SVN 規格搜尋失敗（非「無規格文件」，請檢查 SVN 連線/帳密）: ${errors.join('; ')}`);
      }
      logger.info({ parentName, svnRoots }, 'No spec files found in any SVN root');
      return [];
    }

    logger.info({ parentName, totalFiles: allMatchedFiles.length }, 'Total matched spec files across SVN roots');

    // Step 3: Download/cache each file and bind to task
    // Frontend SVN root = SA, Backend SVN root = SD
    const docIds: string[] = [];
    const tempCacheDir = path.join(this.cacheDir, projectId);
    fs.mkdirSync(tempCacheDir, { recursive: true });

    // Subfolder inside uploads/{projectId}/ for this task's SVN docs
    const subFolder = `${functionCode}_${taskId.slice(0, 8)}`;

    for (const { fileUrl, isFrontendRoot } of allMatchedFiles) {
      try {
        const filename = decodeURIComponent(fileUrl.split('/').pop() || 'unknown');
        const docType: DocType = isFrontendRoot ? 'SA' : 'SD';
        const docId = await this.fetchAndCacheFile(projectId, taskId, fileUrl, filename, svnConfig, tempCacheDir, docType, subFolder);
        if (docId) {
          docIds.push(docId);
        }
      } catch (err) {
        logger.error({ err, fileUrl }, 'Failed to fetch SVN file');
        errors.push(`${decodeURIComponent(fileUrl.split('/').pop() || fileUrl)}: ${firstLine((err as Error).message)}`);
      }
    }

    if (docIds.length === 0 && errors.length > 0) {
      throw new Error(`SVN 規格下載失敗: ${errors.join('; ')}`);
    }
    if (errors.length > 0) {
      logger.warn({ errors }, 'Some SVN spec files failed to download');
    }

    return docIds;
  }

  /**
   * Fetch spec documents from configured local spec folders (specFolders in
   * project config) — the folder-source counterpart of fetchSpecsForTask.
   *
   * Per folder: prepareFolder (safe git pull --ff-only when configured) →
   * findSpecFiles by function code → copy/convert into uploads/{projectId}/ →
   * documents upsert (source='folder', dedupe by source_url + version) →
   * task_documents binding → task_spec_versions record (file_ref = absolute path).
   *
   * Never throws for per-folder problems: prepare/pull issues become warnings,
   * unreachable folders become errors — the caller decides how to present them
   * (docs found + warnings → doc-section warnings; nothing at all → error banner).
   */
  async fetchFolderSpecsForTask(
    projectId: string,
    taskId: string,
    parentName: string,
    specFolders: SpecFolderConfig[],
    _taskLabel: string,
    taskTitle?: string,
  ): Promise<{ docIds: string[]; warnings: string[]; errors: string[] }> {
    const functionCode = extractFunctionCode(parentName) || parentName;
    const chineseNames = extractChineseNames(parentName, taskTitle);
    const subFolder = `${functionCode}_${taskId.slice(0, 8)}`;
    const docIds: string[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];

    for (const folder of specFolders) {
      const prep = await prepareFolder(folder);
      const issues = classifyPrepareResult(folder.path, prep);
      warnings.push(...issues.warnings);
      if (!prep.ok) {
        errors.push(...issues.errors);
        continue;
      }

      let files;
      try {
        files = findSpecFiles(folder.path, functionCode, chineseNames);
      } catch (err) {
        errors.push(`${folder.path}: 掃描失敗：${firstLine((err as Error).message)}`);
        continue;
      }
      if (files.length === 0) continue;

      logger.info({ projectId, taskId, folder: folder.path, functionCode, fileCount: files.length }, 'Found matching spec files in local folder');

      for (const file of files) {
        try {
          const version = await getFileVersion(folder.path, file.filePath, prep.isGitRepo);
          const sourceRef = file.filePath.replace(/\\/g, '/');
          const filename = path.basename(file.filePath);

          const cached = this.documentParser.findBySourceUrl(projectId, sourceRef);
          const existing: ExistingDocInfo | null = cached
            ? { version: cached.svnLastModified, contentHash: cached.contentHash, fileExists: fs.existsSync(cached.filePath) }
            : null;

          // Stage 1 — version unchanged & file on disk → just re-bind (no read)
          if (decideDedupe(existing, version, null) === 'skip') {
            bindDocumentToTask(taskId, cached!.id);
            recordTaskSpecVersion(taskId, sourceRef, version);
            docIds.push(cached!.id);
            continue;
          }

          // Stage 2 — read content, decide by content hash
          const buffer = fs.readFileSync(file.filePath);
          const newHash = createHash('sha256').update(buffer).digest('hex');
          const decision = decideDedupe(existing, version, newHash);

          if (decision === 'bump_version') {
            // Content identical → just refresh version and bind
            this.documentParser.updateDocumentVersion(cached!.id, version);
            bindDocumentToTask(taskId, cached!.id);
            recordTaskSpecVersion(taskId, sourceRef, version);
            docIds.push(cached!.id);
            continue;
          }

          const parsedText = await this.extractText(file.filePath, filename);

          if (decision === 'update') {
            await this.documentParser.updateSvnDocument(cached!.id, buffer, version, parsedText || undefined);
            bindDocumentToTask(taskId, cached!.id);
            recordTaskSpecVersion(taskId, sourceRef, version);
            docIds.push(cached!.id);
            continue;
          }

          const labeledFilename = `[${file.docType}] ${filename}`;
          const doc = await this.documentParser.saveFromBuffer(
            projectId, labeledFilename, buffer, file.docType,
            { source: 'folder', sourceUrl: sourceRef, svnLastModified: version, parsedText: parsedText || undefined, subFolder },
          );
          bindDocumentToTask(taskId, doc.id);
          recordTaskSpecVersion(taskId, sourceRef, version);
          docIds.push(doc.id);
          logger.info({ docId: doc.id, filename, sourceRef }, 'Folder spec document saved and bound to task');
        } catch (err) {
          errors.push(`${file.relPath}: ${firstLine((err as Error).message)}`);
        }
      }
    }

    return { docIds, warnings, errors };
  }

  /**
   * Preview which SVN spec files would be fetched for a given function code.
   * Does NOT download anything — just lists matching files.
   */
  async previewSpecsForCode(
    rawFunctionCode: string,
    svnConfig: SvnConfig,
    taskLabel: string,
  ): Promise<{ files: Array<{ filename: string; svnUrl: string; svnRoot: 'frontend' | 'backend' }>; errors: string[] }> {
    // Extract clean function code from full parent name (e.g., "OV02.需檢核..." → "OV02")
    const functionCode = extractFunctionCode(rawFunctionCode) || rawFunctionCode;
    const rootCode = extractRootCode(functionCode);
    if (!rootCode) return { files: [], errors: [] };

    logger.info({ rawFunctionCode, functionCode, rootCode }, 'Preview: extracted codes');

    const svnRoots = this.resolveSvnRoots(svnConfig, taskLabel);
    const results: Array<{ filename: string; svnUrl: string; svnRoot: 'frontend' | 'backend' }> = [];
    const errors: string[] = [];

    for (const svnRoot of svnRoots) {
      const isFrontend = svnConfig.frontendSpecPath && normalizeSvnUrl(svnConfig.frontendSpecPath) === svnRoot;
      const rootType: 'frontend' | 'backend' = isFrontend ? 'frontend' : 'backend';

      try {
        const topItems = await this.svnList(svnRoot, svnConfig, false);
        const matchedFolder = this.findMatchingFolder(topItems, rootCode);

        let searchUrl: string;
        let allFiles: string[];

        if (matchedFolder) {
          searchUrl = `${svnRoot}/${matchedFolder}`;
          allFiles = await this.svnList(searchUrl, svnConfig, true);
        } else {
          // Flat structure — search root directly
          searchUrl = svnRoot;
          allFiles = topItems;
        }

        let matchedFiles = this.findMatchingFiles(allFiles, functionCode);

        if (matchedFiles.length === 0 && matchedFolder) {
          const sharedFiles = allFiles.filter(f =>
            f.startsWith('0_') && !f.endsWith('/') && hasSpecExtension(f)
          );
          matchedFiles.push(...sharedFiles);
        }

        for (const file of matchedFiles) {
          results.push({
            filename: file,
            svnUrl: `${searchUrl}/${file}`,
            svnRoot: rootType,
          });
        }
      } catch (err) {
        logger.warn({ err, svnRoot }, 'Preview: failed to search SVN root');
        errors.push(`${svnRoot}: ${firstLine((err as Error).message)}`);
      }
    }

    return { files: results, errors };
  }

  /**
   * Fetch a single file from SVN, using cache if valid.
   */
  private async fetchAndCacheFile(
    projectId: string,
    taskId: string,
    fileUrl: string,
    relativePath: string,
    svnConfig: SvnConfig,
    projectCacheDir: string,
    docType: DocType = 'SD',
    subFolder?: string,
  ): Promise<string | null> {
    const filename = path.basename(relativePath);

    // Check if already cached in documents table
    const cached = this.documentParser.findBySourceUrl(projectId, fileUrl);
    const existing: ExistingDocInfo | null = cached
      ? { version: cached.svnLastModified, contentHash: cached.contentHash, fileExists: fs.existsSync(cached.filePath) }
      : null;

    // Get SVN last modified date
    let svnLastModified: string | null = null;
    try {
      svnLastModified = await this.svnInfoLastModified(fileUrl, svnConfig);
    } catch (err) {
      logger.warn({ err, fileUrl }, 'Failed to get SVN info');
    }

    // Stage 1 — version unchanged & file on disk → just bind to task (no download)
    if (decideDedupe(existing, svnLastModified, null) === 'skip') {
      logger.info({ fileUrl, docId: cached!.id }, 'Using cached SVN document');
      bindDocumentToTask(taskId, cached!.id);
      if (svnLastModified) recordTaskSpecVersion(taskId, fileUrl, svnLastModified);
      return cached!.id;
    }
    if (existing && !existing.fileExists) {
      logger.warn({ fileUrl, docId: cached!.id, filePath: cached!.filePath }, 'Cached SVN document file missing on disk, re-downloading');
    }

    // Download the file via svn export
    const localPath = path.join(projectCacheDir, `${Date.now()}-${filename}`);
    await this.svnExport(fileUrl, localPath, svnConfig);

    if (!fs.existsSync(localPath)) {
      logger.warn({ fileUrl, localPath }, 'SVN export did not create file');
      return null;
    }

    // Stage 2 — decide by content hash (identical content → bump version only)
    const buffer = fs.readFileSync(localPath);
    const newHash = createHash('sha256').update(buffer).digest('hex');
    const decision = decideDedupe(existing, svnLastModified, newHash);

    if (decision === 'bump_version') {
      logger.info({ fileUrl, docId: cached!.id }, 'SVN document content unchanged — bumping version only');
      this.documentParser.updateDocumentVersion(cached!.id, svnLastModified || '');
      bindDocumentToTask(taskId, cached!.id);
      if (svnLastModified) recordTaskSpecVersion(taskId, fileUrl, svnLastModified);
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      return cached!.id;
    }

    if (decision === 'update') {
      const parsedText = await this.extractText(localPath, filename);
      await this.documentParser.updateSvnDocument(cached!.id, buffer, svnLastModified || '', parsedText || undefined);
      bindDocumentToTask(taskId, cached!.id);
      if (svnLastModified) recordTaskSpecVersion(taskId, fileUrl, svnLastModified);
      // Clean up temp file
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      return cached!.id;
    }

    // New file — save original binary to documents (keep .docx for images support)
    const parsedText = await this.extractText(localPath, filename);

    // Prefix filename with [SA] or [SD] so agent can distinguish doc types on disk
    const labeledFilename = `[${docType}] ${filename}`;

    const doc = await this.documentParser.saveFromBuffer(
      projectId, labeledFilename, buffer, docType,
      { source: 'svn', sourceUrl: fileUrl, svnLastModified: svnLastModified || undefined, parsedText: parsedText || undefined, subFolder },
    );

    bindDocumentToTask(taskId, doc.id);
    if (svnLastModified) recordTaskSpecVersion(taskId, fileUrl, svnLastModified);

    // Clean up temp file
    try { fs.unlinkSync(localPath); } catch { /* ignore */ }

    logger.info({ docId: doc.id, filename, fileUrl }, 'SVN document saved and bound to task');
    return doc.id;
  }

  /**
   * Extract text from a document file.
   * DOCX → mammoth, PDF → placeholder, others → read as text.
   */
  private async extractText(filePath: string, filename: string): Promise<string | null> {
    const ext = path.extname(filename).toLowerCase();

    if (ext === '.docx') {
      // DocumentParser.saveFromBuffer handles DOCX→Markdown conversion internally
      return null;
    }

    if (ext === '.pdf') {
      return `[PDF file - use Read tool to view: ${filePath}]`;
    }

    if (ext === '.doc') {
      // Old binary Word format — mammoth doesn't support it
      return `[DOC file - binary Word format at: ${filePath}]`;
    }

    // Text-based files
    if (['.md', '.txt', '.rst', '.adoc'].includes(ext)) {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    }

    return null;
  }

  // =============================================
  // SVN root resolution
  // =============================================

  /**
   * Resolve which SVN root paths to search based on task label.
   * - frontend: SA (frontendSpecPath) + SD (backendSpecPath) — frontend needs both
   * - backend: SD (backendSpecPath) only
   * - other (testing, review, etc.): both if available
   */
  private resolveSvnRoots(svnConfig: SvnConfig, taskLabel: string): string[] {
    const roots: string[] = [];

    if (taskLabel === 'backend') {
      if (svnConfig.backendSpecPath) roots.push(normalizeSvnUrl(svnConfig.backendSpecPath));
    } else if (taskLabel === 'frontend') {
      if (svnConfig.frontendSpecPath) roots.push(normalizeSvnUrl(svnConfig.frontendSpecPath));
      if (svnConfig.backendSpecPath) roots.push(normalizeSvnUrl(svnConfig.backendSpecPath));
    } else {
      if (svnConfig.frontendSpecPath) roots.push(normalizeSvnUrl(svnConfig.frontendSpecPath));
      if (svnConfig.backendSpecPath) roots.push(normalizeSvnUrl(svnConfig.backendSpecPath));
    }

    return roots;
  }

  // =============================================
  // SVN command helpers
  // =============================================

  private async svnList(url: string, _config: SvnConfig, recursive: boolean): Promise<string[]> {
    if (!this.ntlmMode) {
      const auth = buildSvnAuth();
      const args = ['list', ...(recursive ? ['-R'] : []), url, ...auth.args];
      const result = await runCommand(this.svnPath, args, {
        timeout: 60000, maxBuffer: 10 * 1024 * 1024, ...(auth.stdin !== undefined && { stdin: auth.stdin }),
      });
      if (!result.error && result.status === 0) {
        return this.decodeSvnOutput(result.stdout).split('\n').map(l => l.trim()).filter(Boolean);
      }
      const stderr = result.stderr.length > 0 ? this.decodeSvnOutput(result.stderr) : (result.error?.message ?? '');
      if (isNtlmError(stderr)) {
        logger.info({ url }, 'svn NTLM error detected, switching to curl fallback');
        this.ntlmMode = true;
      } else {
        logger.error({ stderr, url }, 'svn list failed');
        throw new Error(`svn list failed: ${firstLine(stderr) || `exit ${result.status}`}`);
      }
    }
    // curl NTLM fallback
    try {
      return await this.curlList(url, recursive);
    } catch (err) {
      logger.error({ err, url }, 'curl list failed');
      throw new Error(`curl list failed: ${firstLine((err as Error).message)}`);
    }
  }

  private async svnInfoLastModified(url: string, _config: SvnConfig): Promise<string | null> {
    if (!this.ntlmMode) {
      const auth = buildSvnAuth();
      const args = ['info', url, ...auth.args];
      const result = await runCommand(this.svnPath, args, {
        timeout: 30000, maxBuffer: 1024 * 1024, ...(auth.stdin !== undefined && { stdin: auth.stdin }),
      });
      if (!result.error && result.status === 0) {
        const text = this.decodeSvnOutput(result.stdout);
        const match = text.match(/Last Changed Date:\s*(.+)/i);
        return match ? match[1].trim() : null;
      }
      const stderr = result.stderr.length > 0 ? this.decodeSvnOutput(result.stderr) : (result.error?.message ?? '');
      if (isNtlmError(stderr)) {
        this.ntlmMode = true;
      } else {
        logger.warn({ stderr, url }, 'svn info failed');
        return null;
      }
    }
    try {
      return await this.curlInfoLastModified(url);
    } catch (err) {
      logger.warn({ err, url }, 'curl info failed');
      return null;
    }
  }

  private async svnExport(url: string, localPath: string, _config: SvnConfig): Promise<void> {
    if (!this.ntlmMode) {
      const auth = buildSvnAuth();
      const args = ['export', '--force', url, localPath, ...auth.args];
      const result = await runCommand(this.svnPath, args, {
        timeout: 120000, maxBuffer: 50 * 1024 * 1024, ...(auth.stdin !== undefined && { stdin: auth.stdin }),
      });
      if (!result.error && result.status === 0) return;
      const stderr = result.stderr.length > 0 ? this.decodeSvnOutput(result.stderr) : (result.error?.message ?? '');
      if (isNtlmError(stderr)) {
        this.ntlmMode = true;
      } else {
        throw new Error(firstLine(stderr) || `exit ${result.status}`);
      }
    }
    await this.curlExport(url, localPath);
  }

  // =============================================
  // curl NTLM fallback (for servers that require NTLM/Negotiate auth)
  // =============================================

  private curlAuthArgs(): { args: string[]; stdin?: string } {
    const { username, password } = getSvnCredentials();
    return buildCurlAuth(username, password);
  }

  private async curlList(url: string, recursive: boolean, prefix = ''): Promise<string[]> {
    const listUrl = url.endsWith('/') ? url : url + '/';
    const auth = this.curlAuthArgs();
    const result = await runCommand('curl', [...auth.args, listUrl], {
      timeout: 60000, maxBuffer: 10 * 1024 * 1024, ...(auth.stdin !== undefined && { stdin: auth.stdin }),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(firstLine(result.stderr.toString('utf-8')) || `curl exit ${result.status}`);

    const text = result.stdout.toString('utf-8');
    const items: string[] = [];

    // Parse VisualSVN index XML: <file name="..." href="..."/> and <dir name="..." href="..."/>
    const fileRe = /<file[^>]+name="([^"]+)"/g;
    const dirRe = /<dir[^>]+name="([^"]+)"\s+href="([^"]+)"/g;
    let m: RegExpExecArray | null;

    while ((m = fileRe.exec(text)) !== null) {
      items.push(prefix + m[1]);
    }

    while ((m = dirRe.exec(text)) !== null) {
      const dirName = m[1];
      const dirHref = m[2]; // URL-encoded, relative
      items.push(prefix + dirName + '/');
      if (recursive) {
        const subUrl = listUrl + dirHref;
        const subItems = await this.curlList(subUrl, true, prefix + dirName + '/');
        items.push(...subItems);
      }
    }

    return items;
  }

  private async curlInfoLastModified(url: string): Promise<string | null> {
    // Use PROPFIND to get DAV last-modified date
    const body = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/></D:prop></D:propfind>';
    const auth = this.curlAuthArgs();
    const result = await runCommand('curl', [
      ...auth.args,
      '-X', 'PROPFIND',
      '-H', 'Depth: 0',
      '-H', 'Content-Type: text/xml; charset=utf-8',
      '-d', body,
      url,
    ], { timeout: 30000, maxBuffer: 1024 * 1024, ...(auth.stdin !== undefined && { stdin: auth.stdin }) });

    if (result.error || result.status !== 0) return null;
    const text = result.stdout.toString('utf-8');
    const match = text.match(/<[Dd]:getlastmodified[^>]*>([^<]+)<\/[Dd]:getlastmodified>/);
    return match ? match[1].trim() : null;
  }

  private async curlExport(url: string, localPath: string): Promise<void> {
    const auth = this.curlAuthArgs();
    const result = await runCommand('curl', [...auth.args, '-o', localPath, '-L', url], {
      timeout: 120000, maxBuffer: 50 * 1024 * 1024, ...(auth.stdin !== undefined && { stdin: auth.stdin }),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(firstLine(result.stderr.toString('utf-8')) || `curl exit ${result.status}`);
  }

  /**
   * Decode SVN output buffer. Try UTF-8 first, fallback to Big5 (CP950).
   */
  private decodeSvnOutput(buf: Buffer): string {
    // Windows 上 svn 指令輸出通常是系統 codepage（CP950/Big5），優先嘗試 CP950
    if (process.platform === 'win32') {
      try {
        const cp950 = iconv.decode(buf, 'cp950');
        if (/[\u4e00-\u9fff]/.test(cp950)) return cp950;
      } catch { /* fall through */ }
    }
    const utf8 = buf.toString('utf-8');
    if (!utf8.includes('\uFFFD')) return utf8;
    try {
      return iconv.decode(buf, 'cp950');
    } catch {
      return utf8;
    }
  }

  // =============================================
  // Matching helpers
  // =============================================

  /**
   * Find a top-level SVN folder that matches the root code.
   * E.g., rootCode = "OV" matches "OV.銷項發票管理/"
   */
  private findMatchingFolder(folders: string[], rootCode: string): string | null {
    const code = rootCode.toUpperCase();

    // Only consider directories (ending with /)
    const dirs = folders.filter(f => f.endsWith('/')).map(f => f.slice(0, -1));

    // Priority 1: Exact match on code prefix (e.g., "OV.xxx" or "OV_xxx")
    const prefixMatch = dirs.find(d => {
      const upper = d.toUpperCase();
      return upper === code || upper.startsWith(code + '.') || upper.startsWith(code + '_');
    });
    if (prefixMatch) return prefixMatch;

    // Priority 2: Contains the code
    const containsMatch = dirs.find(d => d.toUpperCase().includes(code));
    if (containsMatch) return containsMatch;

    return null;
  }

  /**
   * Find files that match the parent name (function code) within a folder listing.
   * Handles both flat files and subfolder structures.
   *
   * Real SVN examples:
   *   - SPEC_OV02_(電)銷項發票彙開(AR)_v1.6.docx  ← filename contains "OV02"
   *   - SPEC_OV06.(電)銷項發票(非AR_匯入)範例/SPEC_OV06...docx  ← subfolder contains "OV06"
   *   - old/SPEC_OV02_...docx  ← in "old/" subfolder, filename contains code
   *
   * Strategy: match if filename or any parent directory CONTAINS the code (not just startsWith).
   * Use word-boundary-like matching: code must be preceded by non-alphanumeric or start of string,
   * to avoid "OV02" matching "OV020x" files (but "SPEC_OV02_" is fine).
   * chineseNames (optional): filename containing the Chinese function name also matches —
   * fallback when Asana parent has no function code (same behavior as MCP fetch_svn_specs).
   */
  private findMatchingFiles(allFiles: string[], parentName: string, chineseNames?: string[]): string[] {
    const code = parentName.toUpperCase();
    // Regex: code preceded by non-alphanumeric (or start) and followed by non-digit (or end)
    // This ensures OV02 matches "SPEC_OV02_xxx" but not "OV020_xxx"
    const codePattern = new RegExp(`(?<![A-Z0-9])${escapeRegex(code)}(?![0-9])`, 'i');
    const matched: string[] = [];

    for (const file of allFiles) {
      // Skip directories themselves
      if (file.endsWith('/')) continue;

      // Skip files without spec extensions
      if (!hasSpecExtension(file)) continue;

      // Skip old/ versions — only match latest (top-level or in code-named subfolder)
      const parts = file.split('/');
      if (parts.some(p => p.toLowerCase() === 'old')) continue;

      // Match: filename or any path segment contains the function code
      const basename = path.basename(file);
      if (codePattern.test(basename)) {
        matched.push(file);
        continue;
      }

      // Match: file is inside a subfolder that contains the code
      if (parts.length > 1) {
        const parentDir = parts[0]!;
        if (codePattern.test(parentDir)) {
          matched.push(file);
          continue;
        }
      }

      // Match: filename contains the Chinese function name (fallback)
      if (chineseNames && chineseNames.length > 0) {
        if (chineseNames.some(cn => cn && basename.includes(cn))) {
          matched.push(file);
          continue;
        }
      }
    }

    return matched;
  }

  private detectSvnPath(): string {
    return detectSvnBinary();
  }
}

/**
 * Extract the alphabetic prefix from a function code.
 * E.g., "OV0101" → "OV", "MF01" → "MF", "SB" → "SB"
 */
export function extractRootCode(parentName: string): string | null {
  const match = parentName.match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Normalize a VisualSVN Server web UI URL to a proper SVN protocol URL.
 * Converts: https://svn01.xxx/!/#RepoName/view/head/path/to/folder
 * To:       https://svn01.xxx/svn/RepoName/path/to/folder
 *
 * Also handles URL-encoded variants. Returns the original URL if no conversion needed.
 */
export function normalizeSvnUrl(url: string): string {
  // Pattern: https://host/!/#RepoName/view/head/remaining/path
  // or URL-encoded: https://host/!/%23RepoName/view/head/remaining/path
  const match = url.match(/^(https?:\/\/[^/]+)\/!\/(?:#|%23)([^/]+)\/view\/head\/?(.*)?$/i);
  if (match) {
    const [, origin, repo, rest] = match;
    const decodedRepo = decodeURIComponent(repo!);
    const decodedRest = rest ? decodeURIComponent(rest) : '';
    const normalized = decodedRest
      ? `${origin}/svn/${encodeSvnPath(decodedRepo)}/${encodeSvnPath(decodedRest)}`
      : `${origin}/svn/${encodeSvnPath(decodedRepo)}`;
    return normalized;
  }
  // Already a direct svn URL — still encode any raw non-ASCII chars in the path
  return encodeSvnUrlNonAscii(url);
}

/** Encode each path segment's non-ASCII characters, preserving slashes and already-encoded sequences. */
function encodeSvnPath(segment: string): string {
  return segment.split('/').map(part =>
    part.replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c))
  ).join('/');
}

/** Encode non-ASCII characters in a full URL without touching the scheme/host or already-encoded sequences. */
function encodeSvnUrlNonAscii(url: string): string {
  return url.replace(/[^\x00-\x7F]/g, c => encodeURIComponent(c));
}

/**
 * Extract a function code (e.g., IC01, OV0101, MF01, SB) from text like a task title.
 * Looks for patterns: 2+ uppercase letters followed by optional digits (e.g., IC01, OV0101).
 * Returns the first match, or null if none found.
 */
export function extractFunctionCode(text: string): string | null {
  // Match: 2+ letters + digits (e.g., DF04, OV0101, IC01)
  // Use lookahead for non-alphanumeric or end-of-string to handle cases like "DF04_發文單"
  const match = text.match(/(?:^|[^A-Za-z])([A-Za-z]{2,}[0-9]+)(?=[^A-Za-z0-9]|$)/);
  if (match && match[1]!.length >= 3) {
    return match[1]!.toUpperCase();
  }
  return null;
}

function hasSpecExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SPEC_EXTENSIONS.has(ext);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNtlmError(msg: string): boolean {
  return /E120190|authentication context|NTLM|Negotiate/i.test(msg);
}

/**
 * Detect the svn binary path on the current platform.
 * PATH 的 svn 優先（正確輸出 CP950），TortoiseSVN 在 pipe 模式下會把中文變成 ?
 */
export function detectSvnBinary(): string {
  // PATH svn first — outputs CP950 correctly in pipe mode
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      [process.platform === 'win32' ? 'svn.exe' : 'svn'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim().split('\n')[0]!;
    }
  } catch { /* not found */ }

  // Fallback: TortoiseSVN（注意：pipe 模式下中文可能變 ?）
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/TortoiseSVN/bin/svn.exe',
          'C:/Program Files (x86)/TortoiseSVN/bin/svn.exe',
        ]
      : [];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'svn';
}

/**
 * Check whether the svn binary is actually available on this machine.
 */
export function isSvnAvailable(): boolean {
  const bin = detectSvnBinary();
  const result = spawnSync(bin, ['--version', '--quiet'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  return result.status === 0 && !result.error;
}
