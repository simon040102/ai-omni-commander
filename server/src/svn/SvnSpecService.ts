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
    // Check if this task already has SVN documents bound
    const existing = getDocumentsForTask(taskId);
    if (existing.some(d => d.source === 'svn')) {
      logger.info({ taskId, count: existing.length }, 'Task already has SVN documents bound');
      return existing.filter(d => d.source === 'svn').map(d => d.documentId);
    }

    // Determine which SVN roots to search based on task label
    // Frontend tasks: SA (frontendSpec) + SD (backendSpec)
    // Backend tasks: SD (backendSpec) only
    // Other: both if available
    const svnRoots = this.resolveSvnRoots(svnConfig, taskLabel);
    if (svnRoots.length === 0) {
      logger.warn({ taskLabel }, 'No SVN root paths configured for this task label');
      return [];
    }

    const rootCode = extractRootCode(parentName);
    if (!rootCode) {
      logger.warn({ parentName }, 'Could not extract root code from parent name');
      return [];
    }

    // Collect matched files from all SVN roots
    const allMatchedFileUrls: string[] = [];

    for (const svnRoot of svnRoots) {
      logger.info({ projectId, taskId, parentName, rootCode, svnRoot, taskLabel }, 'Searching SVN root for specs');

      try {
        // Step 1: Find the matching top-level folder
        const topFolders = this.svnList(svnRoot, svnConfig, false);
        const matchedFolder = this.findMatchingFolder(topFolders, rootCode);

        if (!matchedFolder) {
          logger.warn({ rootCode, svnRoot, available: topFolders.slice(0, 10) }, 'No matching SVN folder found');
          continue;
        }

        const folderUrl = `${svnRoot}/${matchedFolder}`;
        logger.info({ matchedFolder, folderUrl }, 'Found matching SVN folder');

        // Step 2: Recursively list files and find matches for parentName
        const allFiles = this.svnList(folderUrl, svnConfig, true);
        const matchedFiles = this.findMatchingFiles(allFiles, parentName);

        if (matchedFiles.length === 0) {
          logger.info({ parentName, folderUrl }, 'No matching files found, trying 0_共用/ fallback');
          const sharedFiles = allFiles.filter(f =>
            f.startsWith('0_') && !f.endsWith('/') && hasSpecExtension(f)
          );
          if (sharedFiles.length > 0) {
            matchedFiles.push(...sharedFiles);
          }
        }

        for (const file of matchedFiles) {
          allMatchedFileUrls.push(`${folderUrl}/${file}`);
        }

        if (matchedFiles.length > 0) {
          logger.info({ svnRoot, parentName, fileCount: matchedFiles.length, files: matchedFiles }, 'Found matching spec files');
        }
      } catch (err) {
        logger.warn({ err, svnRoot }, 'Failed to search SVN root');
      }
    }

    if (allMatchedFileUrls.length === 0) {
      logger.info({ parentName, svnRoots }, 'No spec files found in any SVN root');
      return [];
    }

    logger.info({ parentName, totalFiles: allMatchedFileUrls.length }, 'Total matched spec files across SVN roots');

    // Step 3: Download/cache each file and bind to task
    const docIds: string[] = [];
    const projectCacheDir = path.join(this.cacheDir, projectId);
    fs.mkdirSync(projectCacheDir, { recursive: true });

    for (const fileUrl of allMatchedFileUrls) {
      try {
        const filename = decodeURIComponent(fileUrl.split('/').pop() || 'unknown');
        const docId = await this.fetchAndCacheFile(projectId, taskId, fileUrl, filename, svnConfig, projectCacheDir);
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
    functionCode: string,
    svnConfig: SvnConfig,
    taskLabel: string,
  ): Array<{ filename: string; svnUrl: string; svnRoot: 'frontend' | 'backend' }> {
    const rootCode = extractRootCode(functionCode);
    if (!rootCode) return [];

    const svnRoots = this.resolveSvnRoots(svnConfig, taskLabel);
    const results: Array<{ filename: string; svnUrl: string; svnRoot: 'frontend' | 'backend' }> = [];

    for (const svnRoot of svnRoots) {
      const isFrontend = svnConfig.frontendSpecPath && normalizeSvnUrl(svnConfig.frontendSpecPath) === svnRoot;
      const rootType: 'frontend' | 'backend' = isFrontend ? 'frontend' : 'backend';

      try {
        const topFolders = this.svnList(svnRoot, svnConfig, false);
        const matchedFolder = this.findMatchingFolder(topFolders, rootCode);
        if (!matchedFolder) continue;

        const folderUrl = `${svnRoot}/${matchedFolder}`;
        const allFiles = this.svnList(folderUrl, svnConfig, true);
        let matchedFiles = this.findMatchingFiles(allFiles, functionCode);

        if (matchedFiles.length === 0) {
          const sharedFiles = allFiles.filter(f =>
            f.startsWith('0_') && !f.endsWith('/') && hasSpecExtension(f)
          );
          matchedFiles.push(...sharedFiles);
        }

        for (const file of matchedFiles) {
          results.push({
            filename: file,
            svnUrl: `${folderUrl}/${file}`,
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

    // If cached and still up to date, just bind to task
    if (cached && svnLastModified && cached.svnLastModified === svnLastModified) {
      logger.info({ fileUrl, docId: cached.id }, 'Using cached SVN document');
      bindDocumentToTask(taskId, cached.id);
      return cached.id;
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

    // New file — save to documents
    const buffer = fs.readFileSync(localPath);
    const parsedText = await this.extractText(localPath, filename);
    const docType: DocType = 'SD'; // SVN specs default to SD

    const doc = await this.documentParser.saveFromBuffer(
      projectId, filename, buffer, docType,
      { source: 'svn', sourceUrl: fileUrl, svnLastModified: svnLastModified || undefined, parsedText: parsedText || undefined },
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
      try {
        const buffer = fs.readFileSync(filePath);
        const result = await mammoth.extractRawText({ buffer });
        return result.value || null;
      } catch (err) {
        logger.warn({ err, filePath }, 'Failed to extract text from DOCX');
        return null;
      }
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
   */
  private findMatchingFiles(allFiles: string[], parentName: string): string[] {
    const code = parentName.toUpperCase();
    const matched: string[] = [];

    for (const file of allFiles) {
      const upper = file.toUpperCase();

      // Skip directories themselves
      if (file.endsWith('/')) continue;

      // Skip files without spec extensions
      if (!hasSpecExtension(file)) continue;

      // Match 1: Filename starts with the code
      const basename = path.basename(file).toUpperCase();
      if (basename.startsWith(code)) {
        matched.push(file);
        continue;
      }

      // Match 2: File is inside a subfolder that starts with the code
      const parts = file.split('/');
      if (parts.length > 1) {
        const parentDir = parts[0]!.toUpperCase();
        if (parentDir.startsWith(code) || parentDir === code) {
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
  // Match: 2+ uppercase letters + optional digits (at least 2 chars total)
  // Must be at word boundary or start of string to avoid matching random substrings
  const match = text.match(/\b([A-Z]{2,}[0-9]*)\b/);
  if (match && match[1]!.length >= 2) {
    return match[1]!;
  }
  return null;
}

function hasSpecExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SPEC_EXTENSIONS.has(ext);
}
