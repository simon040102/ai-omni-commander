/**
 * MCP tools for document access.
 * get_documents, read_document, fetch_svn_specs
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import mammoth from 'mammoth';
import iconv from 'iconv-lite';
import { getMcpDb } from '../db.js';
import { getDataDir, getAsanaPat, ASANA_API_BASE, ASANA_FETCH_TIMEOUT_MS, truncateResponse } from '../helpers.js';
import {
  prepareFolder, findSpecFiles, getFileVersion, readSpecFolders, filterSafeSpecFolders,
  type FolderSpecFile, type SpecFolderConfig,
} from '../../documents/FolderSpecSource.js';
import {
  extractChineseNames, decideDedupe, classifyPrepareResult, type ExistingDocInfo,
} from '../../documents/SpecFetchPolicy.js';

interface DocumentRow {
  id: string;
  project_id: string;
  filename: string;
  file_path: string;
  file_type: string | null;
  doc_type: string | null;
  parsed_text: string | null;
  source: string;
  source_url: string | null;
  created_at: string;
}

export function registerDocumentTools(server: McpServer): void {

  // ── get_documents ─────────────────────────────────────────
  server.tool(
    'get_documents',
    'List documents for a project, optionally filtered by task or document type',
    {
      projectId: z.string().describe('The project ID'),
      taskId: z.string().optional().describe('Optional: filter to documents bound to this task'),
      docType: z.enum(['SA', 'SD', 'other', 'verification']).optional().describe('Optional: filter by document type (verification = 驗收證據)'),
    },
    { title: 'Get Documents', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, taskId, docType }) => {
      const db = getMcpDb();

      let docs: DocumentRow[];

      if (taskId) {
        // Get task-bound documents
        const query = docType
          ? `SELECT d.* FROM task_documents td JOIN documents d ON d.id = td.document_id WHERE td.task_id = ? AND d.doc_type = ?`
          : `SELECT d.* FROM task_documents td JOIN documents d ON d.id = td.document_id WHERE td.task_id = ?`;
        docs = (docType
          ? db.prepare(query).all(taskId, docType)
          : db.prepare(query).all(taskId)) as DocumentRow[];
      } else {
        const query = docType
          ? `SELECT * FROM documents WHERE project_id = ? AND doc_type = ? ORDER BY created_at ASC`
          : `SELECT * FROM documents WHERE project_id = ? ORDER BY created_at ASC`;
        docs = (docType
          ? db.prepare(query).all(projectId, docType)
          : db.prepare(query).all(projectId)) as DocumentRow[];
      }

      const result = docs.map(d => ({
        id: d.id,
        filename: d.filename,
        filePath: d.file_path,
        fileType: d.file_type,
        docType: d.doc_type,
        source: d.source,
        createdAt: d.created_at,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ projectId, count: result.length, documents: result }, null, 2),
        }],
      };
    },
  );

  // ── read_document ─────────────────────────────────────────
  server.tool(
    'read_document',
    'Read the content of a document. Returns markdown text for DOCX (already converted), text content for text files, or the file path for PDFs (use Read tool to read PDFs). Oversized documents are truncated — use the Read tool with the returned file path to read them in chunks.',
    { documentId: z.string().describe('The document ID') },
    { title: 'Read Document', readOnlyHint: true, openWorldHint: false },
    async ({ documentId }) => {
      const db = getMcpDb();
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId) as DocumentRow | undefined;
      if (!doc) {
        return { content: [{ type: 'text' as const, text: `Error: Document "${documentId}" not found` }], isError: true };
      }

      // DOCX → MD pointer
      if (doc.parsed_text?.startsWith('[Document saved at:')) {
        const pathMatch = doc.parsed_text.match(/\[Document saved at: (.+?)]/);
        const mdPath = pathMatch ? pathMatch[1] : null;

        if (mdPath && fs.existsSync(mdPath)) {
          const content = fs.readFileSync(mdPath, 'utf-8');
          return { content: [{ type: 'text' as const, text: truncateResponse(`# ${doc.filename}\n\n${content}`, `文件過大，請改用 Read tool 分段讀取：${mdPath}`) }] };
        }
        // Fallback: return the pointer instruction
        return { content: [{ type: 'text' as const, text: `Document converted to markdown. Use Read tool to read: ${mdPath || doc.file_path}` }] };
      }

      // PDF — return path for Claude's Read tool
      if (doc.file_type === 'application/pdf' || doc.filename.endsWith('.pdf')) {
        return { content: [{ type: 'text' as const, text: `PDF document: ${doc.filename}\nFile path: ${doc.file_path}\n\nUse the Read tool to read this PDF file.` }] };
      }

      // Text content available
      if (doc.parsed_text) {
        return { content: [{ type: 'text' as const, text: truncateResponse(`# ${doc.filename}\n\n${doc.parsed_text}`, `文件過大，請改用 Read tool 分段讀取：${doc.file_path}`) }] };
      }

      // Fallback: try to read the file directly
      if (fs.existsSync(doc.file_path)) {
        try {
          const content = fs.readFileSync(doc.file_path, 'utf-8');
          return { content: [{ type: 'text' as const, text: truncateResponse(`# ${doc.filename}\n\n${content}`, `文件過大，請改用 Read tool 分段讀取：${doc.file_path}`) }] };
        } catch {
          return { content: [{ type: 'text' as const, text: `Could not read file. Path: ${doc.file_path}` }], isError: true };
        }
      }

      return { content: [{ type: 'text' as const, text: `File not found at: ${doc.file_path}` }], isError: true };
    },
  );

  // ── fetch_task_attachments ───────────────────────────────────
  server.tool(
    'fetch_task_attachments',
    '從 Asana 任務下載附件圖片。解析任務描述中的 Asana asset URL，下載圖片並存到本地供 subagent 使用。',
    {
      projectId: z.string().describe('專案 ID'),
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Fetch Task Attachments', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ projectId, taskId }) => {
      const db = getMcpDb();

      // Get task description
      const task = db.prepare('SELECT description, title, source_ref FROM tasks WHERE id = ?').get(taskId) as {
        description: string | null; title: string; source_ref: string | null;
      } | undefined;
      if (!task) return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };

      // Get Asana PAT
      const asanaPat = getAsanaPat(db);
      if (!asanaPat) return { content: [{ type: 'text' as const, text: 'Error: Asana PAT not configured.' }], isError: true };

      // Extract asset IDs from description
      const description = task.description || '';
      const assetIds = [...description.matchAll(/get_asset\?asset_id=(\d+)/g)].map(m => m[1]!);

      // Also try fetching attachments via Asana API if we have source_ref (task GID)
      if (task.source_ref) {
        try {
          const attRes = await fetch(`${ASANA_API_BASE}/tasks/${task.source_ref}/attachments?opt_fields=gid,name,download_url`, {
            headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
          });
          if (attRes.ok) {
            const attData = await attRes.json() as { data?: Array<{ gid: string; name: string; download_url: string }> };
            for (const att of attData.data || []) {
              if (!assetIds.includes(att.gid)) assetIds.push(att.gid);
            }
          }
        } catch { /* ignore */ }
      }

      if (assetIds.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No attachments found in this task.' }] };
      }

      // Setup download directory
      const uploadsDir = path.join(getDataDir(), 'uploads', projectId);
      const attachDir = path.join(uploadsDir, `attachments_${taskId.slice(0, 8)}`);
      fs.mkdirSync(attachDir, { recursive: true });

      const results: string[] = [];

      for (let i = 0; i < assetIds.length; i++) {
        const assetId = assetIds[i]!;
        try {
          // Get attachment info
          const res = await fetch(`${ASANA_API_BASE}/attachments/${assetId}`, {
            headers: { 'Authorization': `Bearer ${asanaPat}`, 'Accept': 'application/json' },
            signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS),
          });
          if (!res.ok) continue;

          const data = await res.json() as { data?: { name: string; download_url: string } };
          if (!data.data?.download_url) continue;

          // Sanitize the Asana-provided filename (path traversal / invalid chars)
          const filename = data.data.name || `attachment-${i + 1}.png`;
          const safeFilename = path.basename(filename).replace(/[<>:"|?*\\/]/g, '_');
          const localFilename = `${i + 1}-${safeFilename}`;
          const localPath = path.join(attachDir, localFilename);

          // Skip if already downloaded
          if (fs.existsSync(localPath)) {
            results.push(`${localFilename} (cached)`);
            continue;
          }

          // Download
          const imgRes = await fetch(data.data.download_url, { signal: AbortSignal.timeout(ASANA_FETCH_TIMEOUT_MS) });
          if (!imgRes.ok) continue;
          const buf = Buffer.from(await imgRes.arrayBuffer());
          fs.writeFileSync(localPath, buf);

          results.push(`${localFilename} (${Math.round(buf.length / 1024)}KB)`);
        } catch {
          // Skip failed downloads
        }
      }

      if (results.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Found asset IDs but all downloads failed.' }], isError: true };
      }

      const attachDirNorm = attachDir.replace(/\\/g, '/');
      return {
        content: [{
          type: 'text' as const,
          text: `Downloaded ${results.length} attachments:\n${results.map(r => `- ${r}`).join('\n')}\n\nSaved to: ${attachDirNorm}\nUse Read tool to view images.`,
        }],
      };
    },
  );

  // ── fetch_svn_specs ─────────────────────────────────────────
  server.tool(
    'fetch_svn_specs',
    '從 SVN 與設定的規格資料夾（specFolders）自動抓取任務的 SA/SD 規格文件。根據任務的 parent_name 提取功能代碼，搜尋匹配的規格文件並下載/複製；git 規格資料夾會先安全地 pull --ff-only（dirty 跳過）。',
    {
      projectId: z.string().describe('專案 ID'),
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Fetch SVN Specs', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async ({ projectId, taskId }) => {
      const db = getMcpDb();

      // 1. Get task info
      const task = db.prepare('SELECT parent_name, title, label FROM tasks WHERE id = ?').get(taskId) as
        { parent_name: string | null; title: string; label: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }
      if (!task.parent_name && !task.title) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" has no parent_name or title` }], isError: true };
      }

      // 2. Get project SVN config
      const project = db.prepare('SELECT config_json, frontend_path, backend_path FROM projects WHERE id = ?').get(projectId) as
        { config_json: string | null; frontend_path: string | null; backend_path: string | null } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      let svnConfig: { frontendSpecPath?: string; backendSpecPath?: string } = {};
      let specFolders: SpecFolderConfig[] = [];
      const folderGuardWarnings: string[] = [];
      if (project.config_json) {
        try {
          const config = JSON.parse(project.config_json);
          svnConfig = config.svnConfig || {};
          // Defense-in-depth：workspace 路徑可能在設定後才被改成與規格資料夾重疊
          // （單邊更新繞過設定驗證）——抓取前複查，重疊一律跳過不跑 git。
          const { safe, blockedWarnings } = filterSafeSpecFolders(
            readSpecFolders(config), [project.frontend_path, project.backend_path],
          );
          specFolders = safe;
          folderGuardWarnings.push(...blockedWarnings);
        } catch { /* ignore parse error */ }
      }

      const hasSvn = !!(svnConfig.frontendSpecPath || svnConfig.backendSpecPath);
      if (!hasSvn && specFolders.length === 0) {
        return { content: [{ type: 'text' as const, text: `Error: Project has no spec sources configured. Set svnConfig.frontendSpecPath / svnConfig.backendSpecPath and/or specFolders in project settings.` }], isError: true };
      }

      // 3. Get SVN credentials
      const svnUser = db.prepare("SELECT value FROM global_config WHERE key = 'svn.username'").get() as { value: string } | undefined;
      const svnPass = db.prepare("SELECT value FROM global_config WHERE key = 'svn.password'").get() as { value: string } | undefined;
      const credentials = {
        username: svnUser?.value || '',
        password: svnPass?.value || '',
      };

      // 4. Extract function code and root code
      // Try: parent_name → title → Chinese name fallback
      const searchText = task.parent_name || task.title;
      const functionCode = extractFunctionCode(searchText) || extractFunctionCode(task.title) || searchText;
      let rootCode = extractRootCode(functionCode);

      // If no alphabetic root code (e.g. parent_name is "收文單"), try to extract from title
      if (!rootCode && task.title) {
        const titleCode = extractFunctionCode(task.title);
        if (titleCode) {
          rootCode = extractRootCode(titleCode);
        }
      }

      // If still no root code, use Chinese name to search all folders (no folder filtering)
      const chineseFallback = !rootCode;
      if (!rootCode) {
        rootCode = '__ALL__'; // signal to skip folder matching, search all files
      }

      // 5. Determine SVN roots based on task label (empty when only specFolders are configured)
      const svnRoots = hasSvn ? resolveSvnRoots(svnConfig, task.label) : [];
      if (svnRoots.length === 0 && specFolders.length === 0) {
        return { content: [{ type: 'text' as const, text: `No SVN root paths configured for task label "${task.label}" and no spec folders configured` }], isError: true };
      }

      // Extract Chinese names for fallback matching (e.g. "收文單" from "收文單_前端" or "DF01_收文單")
      // — shared policy function, same behavior as the Web-side SvnSpecService
      const chineseNames = extractChineseNames(task.parent_name, task.title);

      // Detect svn binary and NTLM mode
      const svnPath = detectSvnBinary();
      let ntlmMode = false;

      // Issue buckets（與 Web 端 SvnSpecService 同分級）：
      // errors = 來源完全不可用（資料夾不存在／掃描失敗／檔案處理失敗）；
      // warnings = best-effort 仍繼續（pull 失敗／dirty／重疊被跳過）。
      const sourceErrors: string[] = [];
      const sourceWarnings: string[] = [...folderGuardWarnings];

      // 6. Search SVN for matching files
      const frontendRoot = svnConfig.frontendSpecPath ? normalizeSvnUrl(svnConfig.frontendSpecPath) : null;
      const allMatchedFiles: Array<{ fileUrl: string; isFrontendRoot: boolean }> = [];

      for (const svnRoot of svnRoots) {
        try {
          const listResult = svnList(svnPath, svnRoot, credentials, false, ntlmMode);
          ntlmMode = listResult.ntlmMode;
          const topItems = listResult.items;

          let searchUrl: string;
          let allFiles: string[];
          let matchedFolder: string | null | undefined;

          if (chineseFallback) {
            // No root code — search ALL subfolders recursively
            const subResult = svnList(svnPath, svnRoot, credentials, true, ntlmMode);
            ntlmMode = subResult.ntlmMode;
            allFiles = subResult.items;
            searchUrl = svnRoot;
          } else {
            matchedFolder = findMatchingFolder(topItems, rootCode);
            if (matchedFolder) {
              searchUrl = `${svnRoot}/${matchedFolder.replace(/[^\x00-\x7F]/g, c => encodeURIComponent(c))}`;
              const subResult = svnList(svnPath, searchUrl, credentials, true, ntlmMode);
              ntlmMode = subResult.ntlmMode;
              allFiles = subResult.items;
            } else {
              searchUrl = svnRoot;
              allFiles = topItems;
            }
          }

          const matchedFiles = findMatchingFiles(allFiles, functionCode, chineseNames);

          // Fallback: check 0_共用/ if nothing found
          if (matchedFiles.length === 0 && matchedFolder) {
            const sharedFiles = allFiles.filter(f =>
              f.startsWith('0_') && !f.endsWith('/') && hasSpecExtension(f)
            );
            matchedFiles.push(...sharedFiles);
          }

          const isFrontendRoot = svnRoot === frontendRoot;
          for (const file of matchedFiles) {
            const encodedFile = file.replace(/[^\x00-\x7F]/g, c => encodeURIComponent(c));
            allMatchedFiles.push({ fileUrl: `${searchUrl}/${encodedFile}`, isFrontendRoot });
          }
        } catch (err) {
          // Root unusable → error-level（與 Web 端 fetchSpecsForTask 的 errors 一致）
          sourceErrors.push(`${svnRoot}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 7. Download files and save to DB
      const uploadsDir = path.join(getDataDir(), 'uploads', projectId);
      fs.mkdirSync(uploadsDir, { recursive: true });

      const subFolder = `${functionCode}_${taskId.slice(0, 8)}`;
      const targetDir = path.join(uploadsDir, subFolder);
      fs.mkdirSync(targetDir, { recursive: true });

      const results: Array<{ docType: string; filename: string; mdPath?: string; source: 'svn' | 'folder' }> = [];

      for (const { fileUrl, isFrontendRoot } of allMatchedFiles) {
        try {
          const filename = decodeURIComponent(fileUrl.split('/').pop() || 'unknown');
          const docType = isFrontendRoot ? 'SA' : 'SD';

          // Check if already exists by source_url
          const existing = db.prepare(
            "SELECT id, file_path, svn_last_modified, content_hash FROM documents WHERE project_id = ? AND source_url = ?"
          ).get(projectId, fileUrl) as { id: string; file_path: string; svn_last_modified: string | null; content_hash: string | null } | undefined;
          const existingInfo: ExistingDocInfo | null = existing
            ? { version: existing.svn_last_modified, contentHash: existing.content_hash, fileExists: fs.existsSync(existing.file_path) }
            : null;

          // Step 1: Check SVN last modified date (no download needed)
          let svnLastModified: string | null = null;
          try {
            svnLastModified = svnInfoLastModified(svnPath, fileUrl, credentials, ntlmMode);
          } catch { /* ignore */ }

          // E3: record the spec version this task received, for later change detection (check_spec_changes)
          const recordSpecVersion = () => {
            if (!svnLastModified) return;
            db.prepare(`
              INSERT OR REPLACE INTO task_spec_versions (task_id, file_ref, last_modified, recorded_at)
              VALUES (?, ?, ?, datetime('now'))
            `).run(taskId, fileUrl, svnLastModified);
          };

          // Stage 1 dedupe — date unchanged and file exists → skip (no download)
          if (decideDedupe(existingInfo, svnLastModified, null) === 'skip') {
            db.prepare(
              'INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)'
            ).run(taskId, existing!.id);
            recordSpecVersion();
            results.push({ docType, filename, source: 'svn' });
            continue;
          }

          // Step 2: Date changed or no cache → download
          const tempExt = path.extname(filename);
          const tempPath = path.join(os.tmpdir(), `omni-svn-${Date.now()}-${randomUUID().slice(0, 8)}${tempExt}`);
          svnExport(svnPath, fileUrl, tempPath, credentials, ntlmMode);

          if (!fs.existsSync(tempPath)) {
            sourceErrors.push(`${filename}: SVN export 未產生檔案`);
            continue;
          }

          const buffer = fs.readFileSync(tempPath);
          const newHash = createHash('sha256').update(buffer).digest('hex');
          const decision = decideDedupe(existingInfo, svnLastModified, newHash);

          // Stage 2 dedupe — content identical → just update date and bind
          if (decision === 'bump_version') {
            db.prepare(
              "UPDATE documents SET svn_last_modified = ? WHERE id = ?"
            ).run(svnLastModified || '', existing!.id);
            db.prepare(
              'INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)'
            ).run(taskId, existing!.id);
            recordSpecVersion();
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
            results.push({ docType, filename, source: 'svn' });
            continue;
          }

          // Content changed or cached file missing → overwrite existing document
          if (decision === 'update') {
            fs.writeFileSync(existing!.file_path, buffer);

            let parsedText: string;
            if (filename.toLowerCase().endsWith('.docx')) {
              try {
                const mdPath = await convertDocxToMarkdown(buffer, existing!.id, targetDir, filename);
                parsedText = `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`;
                results.push({ docType, filename, mdPath, source: 'svn' });
              } catch {
                parsedText = `[DOCX file saved at: ${existing!.file_path}]`;
                results.push({ docType, filename, source: 'svn' });
              }
            } else if (filename.toLowerCase().endsWith('.pdf')) {
              parsedText = `[PDF file - use Read tool to view: ${existing!.file_path}]`;
              results.push({ docType, filename, source: 'svn' });
            } else {
              parsedText = fs.readFileSync(existing!.file_path, 'utf-8');
              results.push({ docType, filename, source: 'svn' });
            }

            db.prepare(
              "UPDATE documents SET svn_last_modified = ?, content_hash = ?, parsed_text = ?, created_at = datetime('now') WHERE id = ?"
            ).run(svnLastModified || '', newHash, parsedText, existing!.id);

            db.prepare(
              'INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)'
            ).run(taskId, existing!.id);
            recordSpecVersion();

            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
            continue;
          }

          // New document
          const docId = randomUUID();
          const labeledFilename = `[${docType}] ${filename}`;
          const filePath = path.join(targetDir, `${docId}-${labeledFilename}`);
          fs.writeFileSync(filePath, buffer);

          let parsedText: string;
          if (filename.toLowerCase().endsWith('.docx')) {
            try {
              const mdPath = await convertDocxToMarkdown(buffer, docId, targetDir, filename);
              parsedText = `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`;
              results.push({ docType, filename, mdPath, source: 'svn' });
            } catch {
              parsedText = `[DOCX file saved at: ${filePath}]`;
              results.push({ docType, filename, source: 'svn' });
            }
          } else if (filename.toLowerCase().endsWith('.pdf')) {
            parsedText = `[PDF file - use Read tool to view: ${filePath}]`;
            results.push({ docType, filename, source: 'svn' });
          } else if (['.md', '.txt'].some(ext => filename.toLowerCase().endsWith(ext))) {
            parsedText = buffer.toString('utf-8');
            results.push({ docType, filename, source: 'svn' });
          } else {
            parsedText = `[Binary file saved at: ${filePath}]`;
            results.push({ docType, filename, source: 'svn' });
          }

          db.prepare(`
            INSERT INTO documents (id, project_id, filename, file_path, file_type, doc_type, parsed_text, source, source_url, svn_last_modified, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'svn', ?, ?, ?)
          `).run(docId, projectId, labeledFilename, filePath, 'binary', docType, parsedText, fileUrl, svnLastModified || null, newHash);

          db.prepare(
            'INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)'
          ).run(taskId, docId);
          recordSpecVersion();

          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        } catch (err) {
          // File-level failure → error-level（與 Web 端一致）
          const filename = decodeURIComponent(fileUrl.split('/').pop() || fileUrl);
          sourceErrors.push(`${filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 7b. Local spec folders（與 SVN 並存）— prepare (safe git pull --ff-only) → match → copy/convert
      for (const folder of specFolders) {
        const prep = await prepareFolder(folder);
        // 統一歸類（與 Web 端一致）：資料夾完全不可用 → error；pull 失敗/dirty → warning
        const issues = classifyPrepareResult(folder.path, prep);
        sourceWarnings.push(...issues.warnings);
        if (!prep.ok) {
          sourceErrors.push(...issues.errors);
          continue;
        }

        let folderFiles: FolderSpecFile[];
        try {
          folderFiles = findSpecFiles(folder.path, functionCode, chineseNames);
        } catch (err) {
          sourceErrors.push(`${folder.path}: 掃描失敗：${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        for (const file of folderFiles) {
          try {
            const version = await getFileVersion(folder.path, file.filePath, prep.isGitRepo);
            const fileRef = file.filePath.replace(/\\/g, '/');
            const filename = path.basename(file.filePath);
            const docType = file.docType;

            const recordSpecVersion = () => {
              db.prepare(`
                INSERT OR REPLACE INTO task_spec_versions (task_id, file_ref, last_modified, recorded_at)
                VALUES (?, ?, ?, datetime('now'))
              `).run(taskId, fileRef, version);
            };

            const existing = db.prepare(
              'SELECT id, file_path, svn_last_modified, content_hash FROM documents WHERE project_id = ? AND source_url = ?'
            ).get(projectId, fileRef) as { id: string; file_path: string; svn_last_modified: string | null; content_hash: string | null } | undefined;
            const existingInfo: ExistingDocInfo | null = existing
              ? { version: existing.svn_last_modified, contentHash: existing.content_hash, fileExists: fs.existsSync(existing.file_path) }
              : null;

            // Stage 1 dedupe — same file + same version → just bind (no read)
            if (decideDedupe(existingInfo, version, null) === 'skip') {
              db.prepare('INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, existing!.id);
              recordSpecVersion();
              results.push({ docType, filename, source: 'folder' });
              continue;
            }

            const buffer = fs.readFileSync(file.filePath);
            const newHash = createHash('sha256').update(buffer).digest('hex');
            const decision = decideDedupe(existingInfo, version, newHash);

            // Stage 2 dedupe — content identical → just refresh version and bind
            if (decision === 'bump_version') {
              db.prepare('UPDATE documents SET svn_last_modified = ? WHERE id = ?').run(version, existing!.id);
              db.prepare('INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, existing!.id);
              recordSpecVersion();
              results.push({ docType, filename, source: 'folder' });
              continue;
            }

            if (decision === 'update') {
              // Content changed or cached copy missing → overwrite and re-parse
              fs.writeFileSync(existing!.file_path, buffer);
              const parsed = await buildFolderParsedText(buffer, existing!.id, targetDir, filename, existing!.file_path);
              db.prepare(
                "UPDATE documents SET svn_last_modified = ?, content_hash = ?, parsed_text = ?, created_at = datetime('now') WHERE id = ?"
              ).run(version, newHash, parsed.parsedText, existing!.id);
              db.prepare('INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, existing!.id);
              recordSpecVersion();
              results.push({ docType, filename, ...(parsed.mdPath && { mdPath: parsed.mdPath }), source: 'folder' });
              continue;
            }

            // New document — copy into uploads/{projectId}/{subFolder}/
            const docId = randomUUID();
            const labeledFilename = `[${docType}] ${filename}`;
            const filePath = path.join(targetDir, `${docId}-${labeledFilename}`);
            fs.writeFileSync(filePath, buffer);
            const parsed = await buildFolderParsedText(buffer, docId, targetDir, filename, filePath);

            db.prepare(`
              INSERT INTO documents (id, project_id, filename, file_path, file_type, doc_type, parsed_text, source, source_url, svn_last_modified, content_hash)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'folder', ?, ?, ?)
            `).run(docId, projectId, labeledFilename, filePath, 'binary', docType, parsed.parsedText, fileRef, version, newHash);

            db.prepare('INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, docId);
            recordSpecVersion();
            results.push({ docType, filename, ...(parsed.mdPath && { mdPath: parsed.mdPath }), source: 'folder' });
          } catch (err) {
            // File-level failure → error-level（與 Web 端一致）
            sourceErrors.push(`${file.relPath}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // 8. Format result — 兩級呈現：Errors（來源不可用/檔案失敗）與 Warnings（best-effort 繼續）
      const errorBlock = sourceErrors.length > 0
        ? `\n\nErrors:\n${sourceErrors.map(e => `- ✖ ${e}`).join('\n')}`
        : '';
      const warningBlock = sourceWarnings.length > 0
        ? `\n\nWarnings:\n${sourceWarnings.map(w => `- ⚠ ${w}`).join('\n')}`
        : '';
      const issueBlock = errorBlock + warningBlock;

      if (results.length === 0) {
        if (allMatchedFiles.length > 0) {
          return {
            content: [{ type: 'text' as const, text: `Found ${allMatchedFiles.length} matching files in SVN but all failed to download.${issueBlock}` }],
            isError: true,
          };
        }
        const searched: string[] = [];
        if (svnRoots.length > 0) searched.push(`SVN roots: ${svnRoots.join(', ')}`);
        if (specFolders.length > 0) searched.push(`Spec folders: ${specFolders.map(f => f.path).join(', ')}`);
        return {
          content: [{ type: 'text' as const, text: `No spec files found for "${functionCode}" (rootCode: ${rootCode}).\nSearched ${searched.join(' | ')}${issueBlock}` }],
          ...((sourceErrors.length > 0 || sourceWarnings.length > 0) && { isError: true }),
        };
      }

      const lines = results.map(r => {
        const mdNote = r.mdPath ? ` → ${path.basename(r.mdPath)}` : '';
        return `- [${r.docType}] ${r.filename}${mdNote} (${r.source})`;
      });

      return {
        content: [{
          type: 'text' as const,
          text: `Found ${results.length} spec files for ${functionCode}:\n${lines.join('\n')}\n\nFiles saved to ${targetDir.replace(/\\/g, '/')}${issueBlock}`,
        }],
      };
    },
  );
}

/**
 * Build parsed_text for a folder-source document (mirrors the SVN branch logic):
 * DOCX → convert to Markdown pointer; PDF → Read-tool pointer; MD/TXT → inline text.
 */
async function buildFolderParsedText(
  buffer: Buffer, docId: string, targetDir: string, filename: string, savedPath: string,
): Promise<{ parsedText: string; mdPath?: string }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.docx')) {
    try {
      const mdPath = await convertDocxToMarkdown(buffer, docId, targetDir, filename);
      return { parsedText: `[Document saved at: ${mdPath.replace(/\\/g, '/')}]`, mdPath };
    } catch {
      return { parsedText: `[DOCX file saved at: ${savedPath}]` };
    }
  }
  if (lower.endsWith('.pdf')) return { parsedText: `[PDF file - use Read tool to view: ${savedPath}]` };
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return { parsedText: buffer.toString('utf-8') };
  return { parsedText: `[Binary file saved at: ${savedPath}]` };
}

// =============================================
// SVN helper functions (standalone, no class dependency)
// =============================================

const SPEC_EXTENSIONS = new Set(['.docx', '.doc', '.pdf', '.md', '.txt']);

function hasSpecExtension(filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return SPEC_EXTENSIONS.has(ext);
}

function extractFunctionCode(text: string): string | null {
  const match = text.match(/(?:^|[^A-Za-z])([A-Za-z]{2,}[0-9]+)(?=[^A-Za-z0-9]|$)/);
  if (match && match[1]!.length >= 3) {
    return match[1]!.toUpperCase();
  }
  return null;
}

function extractRootCode(code: string): string | null {
  const match = code.match(/^([A-Za-z]+)/);
  return match ? match[1]!.toUpperCase() : null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSvnUrl(url: string): string {
  const match = url.match(/^(https?:\/\/[^/]+)\/!\/(?:#|%23)([^/]+)\/view\/head\/?(.*)?$/i);
  if (match) {
    const [, origin, repo, rest] = match;
    const decodedRepo = decodeURIComponent(repo!);
    const decodedRest = rest ? decodeURIComponent(rest) : '';
    const encodePath = (s: string) => s.split('/').map(part =>
      part.replace(/[^\x20-\x7E]/g, c => encodeURIComponent(c))
    ).join('/');
    return decodedRest
      ? `${origin}/svn/${encodePath(decodedRepo)}/${encodePath(decodedRest)}`
      : `${origin}/svn/${encodePath(decodedRepo)}`;
  }
  return url.replace(/[^\x00-\x7F]/g, c => encodeURIComponent(c));
}

function resolveSvnRoots(
  svnConfig: { frontendSpecPath?: string; backendSpecPath?: string },
  taskLabel: string,
): string[] {
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

export function detectSvnBinary(): string {
  // PATH 的 svn 優先（正確輸出 CP950），TortoiseSVN 在 pipe 模式下會把中文變成 ?
  try {
    const result = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      [process.platform === 'win32' ? 'svn.exe' : 'svn'],
      { encoding: 'utf-8', timeout: 5000 },
    );
    if (result.status === 0 && result.stdout) return result.stdout.trim().split('\n')[0]!;
  } catch { /* not found */ }
  // Fallback: TortoiseSVN（注意：pipe 模式下中文可能變 ?）
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/TortoiseSVN/bin/svn.exe', 'C:/Program Files (x86)/TortoiseSVN/bin/svn.exe']
    : [];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'svn';
}

function decodeSvnOutput(buf: Buffer): string {
  // Windows 上 svn 指令輸出通常是系統 codepage（CP950/Big5），優先嘗試 CP950
  if (process.platform === 'win32') {
    try {
      const cp950 = iconv.decode(buf, 'cp950');
      // 如果 CP950 解碼結果包含合理的中文字元，就用它
      if (/[\u4e00-\u9fff]/.test(cp950)) return cp950;
    } catch { /* fall through */ }
  }
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return iconv.decode(buf, 'cp950'); } catch { return utf8; }
}

function isNtlmError(msg: string): boolean {
  return /E120190|authentication context|NTLM|Negotiate/i.test(msg);
}

function buildAuthArgs(creds: { username: string; password: string }): string[] {
  const parts = ['--non-interactive', '--trust-server-cert',
    '--trust-server-cert-failures=unknown-ca,cn-mismatch,expired,not-yet-valid,other', '--no-auth-cache'];
  if (creds.username) parts.push('--username', creds.username);
  // Password goes via stdin (svn 1.10+) so it never appears in the process list
  if (creds.password) parts.push('--password-from-stdin');
  return parts;
}

function svnStdin(creds: { username: string; password: string }): string | undefined {
  return creds.password || undefined;
}

function curlAuthArgs(creds: { username: string; password: string }): string[] {
  const args = ['--ntlm', '--silent', '--insecure', '--fail-with-body'];
  // Credentials go via a stdin config file (--config -) so they never appear in the process list
  if (creds.username || creds.password) args.push('--config', '-');
  return args;
}

function curlStdin(creds: { username: string; password: string }): string | undefined {
  if (!creds.username && !creds.password) return undefined;
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `user = "${escape(creds.username || '')}:${escape(creds.password || '')}"\n`;
}

function curlList(url: string, creds: { username: string; password: string }, recursive: boolean, prefix = ''): string[] {
  const listUrl = url.endsWith('/') ? url : url + '/';
  const result = spawnSync('curl', [...curlAuthArgs(creds), listUrl], {
    encoding: 'buffer', timeout: 60000, maxBuffer: 10 * 1024 * 1024, input: curlStdin(creds),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.toString('utf-8') ?? `curl exit ${result.status}`);

  const text = result.stdout.toString('utf-8');
  const items: string[] = [];
  const fileRe = /<file[^>]+name="([^"]+)"/g;
  const dirRe = /<dir[^>]+name="([^"]+)"\s+href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(text)) !== null) items.push(prefix + m[1]);
  while ((m = dirRe.exec(text)) !== null) {
    items.push(prefix + m[1] + '/');
    if (recursive) {
      const subItems = curlList(listUrl + m[2], creds, true, prefix + m[1] + '/');
      items.push(...subItems);
    }
  }
  return items;
}

function svnList(
  svnPath: string, url: string, creds: { username: string; password: string },
  recursive: boolean, ntlmMode: boolean,
): { items: string[]; ntlmMode: boolean } {
  if (!ntlmMode) {
    // Use --xml for proper UTF-8 output (TortoiseSVN's plain text replaces CJK with ?)
    const args = ['list', ...(recursive ? ['-R'] : []), '--xml', url, ...buildAuthArgs(creds)];
    const result = spawnSync(svnPath, args, { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024, input: svnStdin(creds) });
    if (!result.error && result.status === 0) {
      const items = parseSvnListXml(result.stdout, recursive);
      return { items, ntlmMode: false };
    }
    const stderr = result.stderr || '';
    if (isNtlmError(stderr)) {
      ntlmMode = true;
    } else {
      return { items: [], ntlmMode: false };
    }
  }
  try {
    return { items: curlList(url, creds, recursive), ntlmMode: true };
  } catch {
    return { items: [], ntlmMode: true };
  }
}

/**
 * Parse `svn list --xml` output into a list of file/folder names.
 * XML output is always UTF-8, avoiding TortoiseSVN's CJK encoding issues.
 */
function parseSvnListXml(xml: string, recursive: boolean): string[] {
  const items: string[] = [];
  // Match each <entry> element
  const entryPattern = /<entry\s+kind="([^"]+)"[^>]*>\s*<name>([^<]+)<\/name>/g;
  let match;
  while ((match = entryPattern.exec(xml)) !== null) {
    const kind = match[1]; // "file" or "dir"
    const name = match[2]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    if (kind === 'dir') {
      items.push(name + '/');
    } else {
      items.push(name);
    }
  }
  return items;
}

export function svnInfoLastModified(
  svnPath: string, url: string, creds: { username: string; password: string }, ntlmMode: boolean,
): string | null {
  if (!ntlmMode) {
    const args = ['info', url, ...buildAuthArgs(creds)];
    const result = spawnSync(svnPath, args, { encoding: 'buffer', timeout: 30000, maxBuffer: 1024 * 1024, input: svnStdin(creds) });
    if (!result.error && result.status === 0) {
      const text = decodeSvnOutput(result.stdout);
      const m = text.match(/Last Changed Date:\s*(.+)/i);
      return m ? m[1]!.trim() : null;
    }
    const stderr = result.stderr ? decodeSvnOutput(result.stderr) : '';
    if (!isNtlmError(stderr)) return null;
  }
  // PROPFIND fallback
  const body = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:getlastmodified/></D:prop></D:propfind>';
  const result = spawnSync('curl', [
    ...curlAuthArgs(creds), '-X', 'PROPFIND', '-H', 'Depth: 0',
    '-H', 'Content-Type: text/xml; charset=utf-8', '-d', body, url,
  ], { encoding: 'buffer', timeout: 30000, maxBuffer: 1024 * 1024, input: curlStdin(creds) });
  if (result.error || result.status !== 0) return null;
  const text = result.stdout.toString('utf-8');
  const m = text.match(/<[Dd]:getlastmodified[^>]*>([^<]+)<\/[Dd]:getlastmodified>/);
  return m ? m[1]!.trim() : null;
}

function svnExport(
  svnPath: string, url: string, localPath: string,
  creds: { username: string; password: string }, ntlmMode: boolean,
): void {
  if (!ntlmMode) {
    const args = ['export', '--force', url, localPath, ...buildAuthArgs(creds)];
    const result = spawnSync(svnPath, args, { encoding: 'buffer', timeout: 120000, maxBuffer: 50 * 1024 * 1024, input: svnStdin(creds) });
    if (!result.error && result.status === 0) return;
    const stderr = result.stderr ? decodeSvnOutput(result.stderr) : '';
    if (!isNtlmError(stderr)) throw new Error(stderr || `exit ${result.status}`);
  }
  // curl fallback
  const result = spawnSync('curl', [...curlAuthArgs(creds), '-o', localPath, '-L', url], {
    encoding: 'buffer', timeout: 120000, maxBuffer: 50 * 1024 * 1024, input: curlStdin(creds),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.toString('utf-8') ?? `curl exit ${result.status}`);
}

function findMatchingFolder(folders: string[], rootCode: string): string | null {
  const code = rootCode.toUpperCase();
  const dirs = folders.filter(f => f.endsWith('/')).map(f => f.slice(0, -1));
  const prefixMatch = dirs.find(d => {
    const upper = d.toUpperCase();
    return upper === code || upper.startsWith(code + '.') || upper.startsWith(code + '_');
  });
  if (prefixMatch) return prefixMatch;
  const containsMatch = dirs.find(d => d.toUpperCase().includes(code));
  return containsMatch || null;
}

function findMatchingFiles(allFiles: string[], functionCode: string, chineseNames?: string[]): string[] {
  const code = functionCode.toUpperCase();
  const codePattern = new RegExp(`(?<![A-Z0-9])${escapeRegex(code)}(?![0-9])`, 'i');
  const matched: string[] = [];
  for (const file of allFiles) {
    if (file.endsWith('/')) continue;
    if (!hasSpecExtension(file)) continue;
    const parts = file.split('/');
    if (parts.some(p => p.toLowerCase() === 'old')) continue;
    const basename = path.basename(file);
    // Match by code (e.g. DF01, WA03)
    if (codePattern.test(basename)) { matched.push(file); continue; }
    if (parts.length > 1) {
      const parentDir = parts[0]!;
      if (codePattern.test(parentDir)) { matched.push(file); continue; }
    }
    // Match by Chinese name (e.g. 收文單, 部門代碼)
    if (chineseNames && chineseNames.length > 0) {
      for (const cn of chineseNames) {
        if (cn && basename.includes(cn)) { matched.push(file); break; }
      }
    }
  }
  return matched;
}

async function convertDocxToMarkdown(buffer: Buffer, docId: string, outDir: string, filename: string): Promise<string> {
  fs.mkdirSync(outDir, { recursive: true });
  const images: string[] = [];
  let imgIdx = 0;

  const result = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const imageBuffer = await image.read();
        const ext = (image.contentType?.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const imgFilename = `${docId}-img-${imgIdx++}.${ext}`;
        const imgPath = path.join(outDir, imgFilename);
        fs.writeFileSync(imgPath, imageBuffer);
        images.push(imgPath);
        return { src: imgFilename };
      }),
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TurndownService = ((await import('turndown')) as any).default ?? (await import('turndown'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gfm = ((await import('turndown-plugin-gfm')) as any).gfm ?? (await import('turndown-plugin-gfm'));
  const td = new TurndownService({ headingStyle: 'atx' });
  td.use(gfm);

  // Strip <p> inside table cells for correct GFM tables
  const cleanedHtml = result.value.replace(
    /(<(?:td|th)[^>]*>)([\s\S]*?)(<\/(?:td|th)>)/gi,
    (_match: string, open: string, content: string, close: string) => {
      const cleaned = content.replace(/<p>([\s\S]*?)<\/p>/gi, '$1 ').replace(/<br\s*\/?>/gi, ' ').trim();
      return `${open}${cleaned}${close}`;
    },
  );

  // Custom table rule (mammoth doesn't produce <thead>)
  td.addRule('htmlTableToGfm', {
    filter: 'table',
    replacement(_content: string, node: Node) {
      const el = node as HTMLElement;
      const rows = Array.from(el.querySelectorAll('tr'));
      if (rows.length === 0) return '';
      const parseRow = (tr: Element): string[] =>
        Array.from(tr.querySelectorAll('td, th')).map(cell => cell.textContent?.trim().replace(/\|/g, '\\|').replace(/\n/g, ' ') || '');
      const headerCells = parseRow(rows[0]!);
      const header = `| ${headerCells.join(' | ')} |`;
      const separator = `| ${headerCells.map(() => '---').join(' | ')} |`;
      const bodyRows = rows.slice(1).map(tr => `| ${parseRow(tr).join(' | ')} |`);
      return `\n\n${header}\n${separator}\n${bodyRows.join('\n')}\n\n`;
    },
  });

  let markdown = td.turndown(cleanedHtml);
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  for (const absPath of images) {
    const relName = path.basename(absPath);
    markdown = markdown.replaceAll(relName, absPath.replace(/\\/g, '/'));
  }

  const mdFilename = `${docId}-${path.parse(filename).name}.md`;
  const mdPath = path.join(outDir, mdFilename);
  fs.writeFileSync(mdPath, markdown, 'utf-8');
  return mdPath;
}
