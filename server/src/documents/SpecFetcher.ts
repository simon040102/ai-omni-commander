import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import iconv from 'iconv-lite';
import type { SvnConfig } from '@omni/shared';
import { normalizeSvnUrl } from '../svn/SvnSpecService.js';
import { getSvnCredentials } from '../db/queries/globalConfig.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SpecFetcher');

const MAX_CONTENT_LENGTH = 50000;

/** Binary file extensions that need special handling */
const BINARY_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.xlsx', '.xls', '.pptx']);

/** Supported file extensions for spec documents */
const SPEC_EXTENSIONS = new Set(['.md', '.txt', '.pdf', '.docx', '.doc', '.rst', '.adoc']);

export interface SpecResult {
  type: 'content' | 'directory' | 'svn-root' | 'file';
  content: string;
  path: string;
  /** Local file path for binary files (PDF, DOC) that agent should use Read tool on */
  filePath?: string;
}

/**
 * Fetches spec content from various sources: HTTP URLs, SVN URLs, or local paths.
 * Supports binary document conversion (docx → text via mammoth, PDF → local file).
 */
export class SpecFetcher {
  private svnPath: string | null = null;
  private cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || path.join(process.cwd(), 'data', 'spec-cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Fetch spec content from a URL or local path.
   * For SVN https:// URLs, pass svnConfig for authentication.
   */
  async fetch(specUrl: string, svnConfig?: SvnConfig | null): Promise<SpecResult> {
    const trimmed = specUrl.trim();
    if (!trimmed) throw new Error('Empty spec URL');

    // Normalize VisualSVN web URLs to proper SVN URLs
    const normalized = normalizeSvnUrl(trimmed);
    if (normalized !== trimmed) {
      logger.info({ original: trimmed, normalized }, 'Normalized VisualSVN web URL');
    }

    logger.info({ specUrl: normalized }, 'Fetching spec content');

    // Check if this is an SVN URL (either svn:// or https:// pointing to known SVN server)
    if (/^svn(\+ssh)?:\/\//i.test(normalized)) {
      return this.fetchSvnAuto(normalized, svnConfig);
    }

    // If svnConfig is provided and URL is https://, check if it's an SVN URL
    if (svnConfig && /^https?:\/\//i.test(normalized)) {
      const isSvnUrl = this.looksLikeSvnUrl(normalized, svnConfig);
      if (isSvnUrl) {
        return this.fetchSvnAuto(normalized, svnConfig);
      }
    }

    if (/^https?:\/\//i.test(normalized)) {
      return this.fetchHttp(normalized);
    }

    return this.fetchLocalAuto(normalized);
  }

  /**
   * Check if an https:// URL looks like it's pointing to the configured SVN server.
   */
  private looksLikeSvnUrl(url: string, svnConfig: SvnConfig): boolean {
    try {
      const urlHost = new URL(url).hostname;
      if (svnConfig.frontendSpecPath) {
        try {
          const svnHost = new URL(svnConfig.frontendSpecPath).hostname;
          if (urlHost === svnHost) return true;
        } catch { /* not a URL */ }
      }
      if (svnConfig.backendSpecPath) {
        try {
          const svnHost = new URL(svnConfig.backendSpecPath).hostname;
          if (urlHost === svnHost) return true;
        } catch { /* not a URL */ }
      }
    } catch { /* invalid URL */ }
    return false;
  }

  /**
   * HTTP: detect binary files (docx/PDF) and handle them properly.
   */
  private async fetchHttp(url: string): Promise<SpecResult> {
    const ext = this.getExtFromUrl(url);

    // Binary files: download as buffer, then convert
    if (ext && BINARY_EXTENSIONS.has(ext)) {
      return this.fetchHttpBinary(url, ext);
    }

    // Text files: fetch as text
    const response = await fetch(url, {
      headers: { 'Accept': 'text/plain, text/html, text/markdown, */*' },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content-type for binary responses even if extension wasn't detected
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/vnd.openxmlformats') || ct.includes('application/msword')) {
      const buf = Buffer.from(await response.arrayBuffer());
      return this.convertBinary(buf, url, '.docx');
    }
    if (ct.includes('application/pdf')) {
      const buf = Buffer.from(await response.arrayBuffer());
      return this.convertBinary(buf, url, '.pdf');
    }

    const text = await response.text();
    return { type: 'content', content: this.truncate(text), path: url };
  }

  /**
   * Download a binary file via HTTP, save locally, and convert.
   */
  private async fetchHttpBinary(url: string, ext: string): Promise<SpecResult> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    return this.convertBinary(buf, url, ext);
  }

  /**
   * SVN: detect file vs directory. For files, download binary and convert.
   * Uses svnConfig for authentication if provided.
   */
  private async fetchSvnAuto(url: string, svnConfig?: SvnConfig | null): Promise<SpecResult> {
    const svn = this.getSvnPath();
    const authArgs = svnConfig ? this.buildAuthArgs(svnConfig) : '--non-interactive';
    const ext = this.getExtFromUrl(url);

    // If URL looks like a specific file (has a spec extension), download it directly
    if (ext && SPEC_EXTENSIONS.has(ext)) {
      return this.fetchSvnFile(url, ext, svn, authArgs);
    }

    // Try as a file first (svn cat to check)
    try {
      // Use svn info to check if it's a file
      const infoBuf = execSync(`"${svn}" info "${url}" ${authArgs}`, {
        encoding: 'buffer',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      const info = this.decodeSvnOutput(infoBuf);
      if (info.includes('Node Kind: file') || info.includes('節點類型: 檔案')) {
        // It's a file — detect extension from URL and download
        const fileExt = ext || '.txt';
        return this.fetchSvnFile(url, fileExt, svn, authArgs);
      }
    } catch {
      // svn info failed — try as directory
    }

    // Try as directory listing
    try {
      const listBuf = execSync(`"${svn}" list -R "${url}" ${authArgs}`, {
        encoding: 'buffer',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const listing = this.decodeSvnOutput(listBuf);

      const files = listing
        .split('\n')
        .map(f => f.trim())
        .filter(f => f && !f.endsWith('/'))
        .filter(f => {
          const fExt = path.extname(f).toLowerCase();
          return SPEC_EXTENSIONS.has(fExt);
        });

      const tree = files.length > 0
        ? files.map(f => `- ${f}`).join('\n')
        : '(no spec documents found)';

      logger.info({ url, fileCount: files.length }, 'SVN directory listing');
      return { type: 'svn-root', content: tree, path: url };
    } catch (err) {
      throw new Error(`SVN fetch failed: ${(err as Error).message}`);
    }
  }

  /**
   * Download a specific file from SVN via svn export, then convert.
   */
  private async fetchSvnFile(url: string, ext: string, svn: string, authArgs: string): Promise<SpecResult> {
    const filename = `spec-${Date.now()}${ext}`;
    const localPath = path.join(this.cacheDir, filename);

    try {
      execSync(`"${svn}" export --force "${url}" "${localPath}" ${authArgs}`, {
        encoding: 'buffer',
        timeout: 120000,
        maxBuffer: 50 * 1024 * 1024,
      });

      const buf = fs.readFileSync(localPath);
      return this.convertBinary(buf, url, ext, localPath);
    } catch (err) {
      // Cleanup on failure
      try { fs.unlinkSync(localPath); } catch { /* ignore */ }
      throw new Error(`SVN export failed for ${url}: ${(err as Error).message}`);
    }
  }

  /**
   * Convert a binary buffer to a SpecResult based on file extension.
   * - .docx → mammoth text extraction → inline content
   * - .pdf → save to cache dir → return file path for agent to Read
   * - .doc → save to cache dir → return file path
   * - text-based → read as utf-8
   */
  private async convertBinary(buf: Buffer, sourcePath: string, ext: string, existingLocalPath?: string): Promise<SpecResult> {
    if (ext === '.docx') {
      try {
        const result = await mammoth.extractRawText({ buffer: buf });
        const text = result.value;
        if (text && text.trim().length > 0) {
          logger.info({ sourcePath, textLength: text.length }, 'Extracted text from DOCX');
          // Cleanup temp file if we saved one
          if (existingLocalPath) try { fs.unlinkSync(existingLocalPath); } catch { /* ignore */ }
          return { type: 'content', content: this.truncate(text), path: sourcePath };
        }
      } catch (err) {
        logger.warn({ err, sourcePath }, 'mammoth extraction failed, saving as file');
      }
    }

    if (ext === '.pdf' || ext === '.doc' || ext === '.docx') {
      // Save to cache for agent to read with Read tool
      const localPath = existingLocalPath || path.join(this.cacheDir, `spec-${Date.now()}${ext}`);
      if (!existingLocalPath) {
        fs.writeFileSync(localPath, buf);
      }
      const absPath = path.resolve(localPath);
      logger.info({ sourcePath, localPath: absPath, ext }, 'Saved binary spec file for agent');
      return {
        type: 'file',
        content: `[${ext.toUpperCase().slice(1)} 文件已下載，請使用 Read 工具讀取：${absPath}]`,
        path: sourcePath,
        filePath: absPath,
      };
    }

    // Text-based fallback
    const text = buf.toString('utf-8');
    if (existingLocalPath) try { fs.unlinkSync(existingLocalPath); } catch { /* ignore */ }
    return { type: 'content', content: this.truncate(text), path: sourcePath };
  }

  /**
   * Local: if path is a file, read it (with binary detection). If directory, list files.
   */
  private async fetchLocalAuto(filePath: string): Promise<SpecResult> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Path not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);

    if (stat.isFile()) {
      const ext = path.extname(filePath).toLowerCase();

      // Binary files: convert
      if (BINARY_EXTENSIONS.has(ext)) {
        const buf = fs.readFileSync(filePath);
        return this.convertBinary(buf, filePath, ext, filePath);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      return { type: 'content', content: this.truncate(content), path: filePath };
    }

    if (stat.isDirectory()) {
      const files = this.listSpecFiles(filePath, filePath);
      const tree = files.length > 0
        ? files.map(f => `- ${f}`).join('\n')
        : '(no spec documents found)';

      logger.info({ path: filePath, fileCount: files.length }, 'Local directory listing');
      return { type: 'directory', content: tree, path: filePath };
    }

    throw new Error(`Not a file or directory: ${filePath}`);
  }

  /** Recursively list spec-related files under a directory */
  private listSpecFiles(baseDir: string, currentDir: string, maxDepth = 5, depth = 0): string[] {
    if (depth > maxDepth) return [];

    const results: string[] = [];
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          results.push(...this.listSpecFiles(baseDir, fullPath, maxDepth, depth + 1));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SPEC_EXTENSIONS.has(ext)) {
            results.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
          }
        }
      }
    } catch { /* permission errors, etc. */ }
    return results;
  }

  // =============================================
  // Helpers
  // =============================================

  private getExtFromUrl(url: string): string | null {
    try {
      // Remove query params and hash
      const cleaned = url.split('?')[0]!.split('#')[0]!;
      const ext = path.extname(cleaned).toLowerCase();
      return ext || null;
    } catch {
      return null;
    }
  }

  private getSvnPath(): string {
    if (this.svnPath) return this.svnPath;

    const candidates = [
      'C:/Program Files/TortoiseSVN/bin/svn.exe',
      'C:/Program Files (x86)/TortoiseSVN/bin/svn.exe',
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        this.svnPath = c;
        return c;
      }
    }

    try {
      const result = execSync(
        process.platform === 'win32' ? 'where svn.exe' : 'which svn',
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      if (result) {
        this.svnPath = result.split('\n')[0]!;
        return this.svnPath;
      }
    } catch { /* not found */ }

    this.svnPath = 'svn';
    return 'svn';
  }

  private buildAuthArgs(_config?: SvnConfig): string {
    const { username, password } = getSvnCredentials();
    const parts = ['--non-interactive', '--trust-server-cert', '--no-auth-cache'];
    if (username) parts.push(`--username "${username}"`);
    if (password) parts.push(`--password "${password}"`);
    return parts.join(' ');
  }

  private decodeSvnOutput(buf: Buffer): string {
    const utf8 = buf.toString('utf-8');
    if (!utf8.includes('\uFFFD') && !/[\x80-\xFF]/.test(utf8.replace(/[\u0080-\uFFFF]/g, ''))) {
      return utf8;
    }
    try {
      return iconv.decode(buf, 'cp950');
    } catch {
      return utf8;
    }
  }

  private truncate(content: string): string {
    if (content.length > MAX_CONTENT_LENGTH) {
      logger.warn({ originalLength: content.length }, 'Spec content truncated');
      return content.substring(0, MAX_CONTENT_LENGTH) + '\n\n... (truncated)';
    }
    return content;
  }
}
