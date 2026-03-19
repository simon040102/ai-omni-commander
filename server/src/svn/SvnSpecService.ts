import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import iconv from 'iconv-lite';
import mammoth from 'mammoth';
import type { SvnConfig, SvnCredentials, DocType } from '@omni/shared';
import type { DocumentParser } from '../documents/DocumentParser.js';
import { bindDocumentToTask, getDocumentsForTask } from '../db/queries/taskDocuments.js';
import { getSvnCredentials } from '../db/queries/globalConfig.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SvnSpecService');

const SPEC_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.md', '.txt']);

/**
 * Service for fetching specification documents from SVN repositories.
 * Handles authentication, Big5 encoding, caching, and DOCX conversion.
 */
export class SvnSpecService {
  private svnPath: string;

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

    // Collect matched files from all SVN roots, tracking which root each came from
    const allMatchedFiles: Array<{ fileUrl: string; isFrontendRoot: boolean }> = [];
    const frontendRoot = svnConfig.frontendSpecPath ? normalizeSvnUrl(svnConfig.frontendSpecPath) : null;

    for (const svnRoot of svnRoots) {
      logger.info({ projectId, taskId, parentName, functionCode, rootCode, svnRoot, taskLabel }, 'Searching SVN root for specs');

      try {
        // Step 1: Find the matching top-level folder
        const topItems = this.svnList(svnRoot, svnConfig, false);
        const matchedFolder = this.findMatchingFolder(topItems, rootCode);

        let searchUrl: string;
        let allFiles: string[];

        if (matchedFolder) {
          // Has subfolder structure (e.g., "OV.銷項發票管理/")
          searchUrl = `${svnRoot}/${matchedFolder}`;
          logger.info({ matchedFolder, searchUrl }, 'Found matching SVN folder');
          allFiles = this.svnList(searchUrl, svnConfig, true);
        } else {
          // Flat structure — all files in root directory (common for backend specs)
          searchUrl = svnRoot;
          logger.info({ rootCode, svnRoot }, 'No subfolder found, searching root directly');
          allFiles = topItems;
        }

        // Step 2: Find matching files by function code
        const matchedFiles = this.findMatchingFiles(allFiles, functionCode);

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
      }
    }

    if (allMatchedFiles.length === 0) {
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
      }
    }

    return docIds;
  }

  /**
   * Preview which SVN spec files would be fetched for a given function code.
   * Does NOT download anything — just lists matching files.
   */
  previewSpecsForCode(
    rawFunctionCode: string,
    svnConfig: SvnConfig,
    taskLabel: string,
  ): Array<{ filename: string; svnUrl: string; svnRoot: 'frontend' | 'backend' }> {
    // Extract clean function code from full parent name (e.g., "OV02.需檢核..." → "OV02")
    const functionCode = extractFunctionCode(rawFunctionCode) || rawFunctionCode;
    const rootCode = extractRootCode(functionCode);
    if (!rootCode) return [];

    logger.info({ rawFunctionCode, functionCode, rootCode }, 'Preview: extracted codes');

    const svnRoots = this.resolveSvnRoots(svnConfig, taskLabel);
    const results: Array<{ filename: string; svnUrl: string; svnRoot: 'frontend' | 'backend' }> = [];

    for (const svnRoot of svnRoots) {
      const isFrontend = svnConfig.frontendSpecPath && normalizeSvnUrl(svnConfig.frontendSpecPath) === svnRoot;
      const rootType: 'frontend' | 'backend' = isFrontend ? 'frontend' : 'backend';

      try {
        const topItems = this.svnList(svnRoot, svnConfig, false);
        const matchedFolder = this.findMatchingFolder(topItems, rootCode);

        let searchUrl: string;
        let allFiles: string[];

        if (matchedFolder) {
          searchUrl = `${svnRoot}/${matchedFolder}`;
          allFiles = this.svnList(searchUrl, svnConfig, true);
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
      }
    }

    return results;
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

    // Get SVN last modified date
    let svnLastModified: string | null = null;
    try {
      svnLastModified = this.svnInfoLastModified(fileUrl, svnConfig);
    } catch (err) {
      logger.warn({ err, fileUrl }, 'Failed to get SVN info');
    }

    // If cached and still up to date AND file exists on disk, just bind to task
    if (cached && svnLastModified && cached.svnLastModified === svnLastModified) {
      if (fs.existsSync(cached.filePath)) {
        logger.info({ fileUrl, docId: cached.id }, 'Using cached SVN document');
        bindDocumentToTask(taskId, cached.id);
        return cached.id;
      }
      // File missing on disk — treat as cache miss, fall through to re-download
      logger.warn({ fileUrl, docId: cached.id, filePath: cached.filePath }, 'Cached SVN document file missing on disk, re-downloading');
    }

    // Download the file via svn export
    const localPath = path.join(projectCacheDir, `${Date.now()}-${filename}`);
    this.svnExport(fileUrl, localPath, svnConfig);

    if (!fs.existsSync(localPath)) {
      logger.warn({ fileUrl, localPath }, 'SVN export did not create file');
      return null;
    }

    // If cached but outdated, update it
    if (cached) {
      const buffer = fs.readFileSync(localPath);
      const parsedText = await this.extractText(localPath, filename);
      await this.documentParser.updateSvnDocument(cached.id, buffer, svnLastModified || '', parsedText || undefined);
      bindDocumentToTask(taskId, cached.id);
      // Clean up temp file
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      return cached.id;
    }

    // New file — save original binary to documents (keep .docx for images support)
    const buffer = fs.readFileSync(localPath);
    const parsedText = await this.extractText(localPath, filename);

    // Prefix filename with [SA] or [SD] so agent can distinguish doc types on disk
    const labeledFilename = `[${docType}] ${filename}`;

    const doc = await this.documentParser.saveFromBuffer(
      projectId, labeledFilename, buffer, docType,
      { source: 'svn', sourceUrl: fileUrl, svnLastModified: svnLastModified || undefined, parsedText: parsedText || undefined, subFolder },
    );

    bindDocumentToTask(taskId, doc.id);

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

  private svnList(url: string, _config: SvnConfig, recursive: boolean): string[] {
    const args = this.buildAuthArgs();
    const rFlag = recursive ? ' -R' : '';
    const cmd = `"${this.svnPath}" list${rFlag} "${url}" ${args}`;

    try {
      const buf = execSync(cmd, {
        encoding: 'buffer',
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const text = this.decodeSvnOutput(buf);
      return text.split('\n').map(l => l.trim()).filter(Boolean);
    } catch (err) {
      logger.error({ err, url }, 'svn list failed');
      return [];
    }
  }

  private svnInfoLastModified(url: string, _config: SvnConfig): string | null {
    const args = this.buildAuthArgs();
    const cmd = `"${this.svnPath}" info "${url}" ${args}`;

    try {
      const buf = execSync(cmd, {
        encoding: 'buffer',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      const text = this.decodeSvnOutput(buf);
      // Look for "Last Changed Date:" line
      const match = text.match(/Last Changed Date:\s*(.+)/i);
      return match ? match[1].trim() : null;
    } catch (err) {
      logger.warn({ err, url }, 'svn info failed');
      return null;
    }
  }

  private svnExport(url: string, localPath: string, _config: SvnConfig): void {
    const args = this.buildAuthArgs();
    const cmd = `"${this.svnPath}" export --force "${url}" "${localPath}" ${args}`;

    execSync(cmd, {
      encoding: 'buffer',
      timeout: 120000,
      maxBuffer: 50 * 1024 * 1024,
    });
  }

  private buildAuthArgs(creds?: SvnCredentials): string {
    const { username, password } = creds || getSvnCredentials();
    const parts = [
      '--non-interactive',
      '--trust-server-cert',
      '--no-auth-cache',
    ];
    if (username) parts.push(`--username "${username}"`);
    if (password) parts.push(`--password "${password}"`);
    return parts.join(' ');
  }

  /**
   * Decode SVN output buffer. Try UTF-8 first, fallback to Big5 (CP950).
   */
  private decodeSvnOutput(buf: Buffer): string {
    // Try UTF-8 first
    const utf8 = buf.toString('utf-8');
    // Check for replacement characters — indicates it wasn't valid UTF-8
    if (!utf8.includes('\uFFFD') && !/[\x80-\xFF]/.test(utf8.replace(/[\u0080-\uFFFF]/g, ''))) {
      return utf8;
    }
    // Fallback to Big5/CP950
    try {
      return iconv.decode(buf, 'cp950');
    } catch {
      return utf8; // Give up, return raw
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
   */
  private findMatchingFiles(allFiles: string[], parentName: string): string[] {
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
    }

    return matched;
  }

  private detectSvnPath(): string {
    // Check common locations
    const candidates = [
      'C:/Program Files/TortoiseSVN/bin/svn.exe',
      'C:/Program Files (x86)/TortoiseSVN/bin/svn.exe',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // Try finding in PATH
    try {
      const result = execSync(
        process.platform === 'win32' ? 'where svn.exe' : 'which svn',
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (result) return result.split('\n')[0]!;
    } catch { /* not found */ }

    // Fallback
    return 'svn';
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
      ? `${origin}/svn/${decodedRepo}/${decodedRest}`
      : `${origin}/svn/${decodedRepo}`;
    return normalized;
  }
  return url;
}

/**
 * Extract a function code (e.g., IC01, OV0101, MF01, SB) from text like a task title.
 * Looks for patterns: 2+ uppercase letters followed by optional digits (e.g., IC01, OV0101).
 * Returns the first match, or null if none found.
 */
export function extractFunctionCode(text: string): string | null {
  // Match: 2+ letters (case-insensitive) + optional digits (at least 2 chars total)
  // Must be at word boundary or start of string to avoid matching random substrings
  const match = text.match(/\b([A-Za-z]{2,}[0-9]*)\b/);
  if (match && match[1]!.length >= 2) {
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
