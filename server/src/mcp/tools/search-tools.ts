/**
 * MCP tools for spec search & prototype lookup.
 * search_documents, find_axure_snapshot
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getMcpDb } from '../db.js';
import { getDataDir, truncateResponse } from '../helpers.js';

interface DocRow {
  id: string;
  filename: string;
  file_path: string;
  parsed_text: string | null;
}

export interface SearchHit {
  filename: string;
  documentId: string;
  line: number;
  snippet: string;
}

/** Resolve searchable text for a document; returns null (with error string) when unreadable. */
function resolveDocText(doc: DocRow): { text: string | null; error: string | null } {
  const pointer = doc.parsed_text?.match(/^\[Document saved at: (.+?)]/);
  if (pointer) {
    const mdPath = pointer[1]!;
    try {
      return { text: fs.readFileSync(mdPath, 'utf-8'), error: null };
    } catch (err) {
      return { text: null, error: `${doc.filename}: 無法讀取 ${mdPath}（${err instanceof Error ? err.message : String(err)}）` };
    }
  }
  if (doc.parsed_text && doc.parsed_text.length > 0) {
    return { text: doc.parsed_text, error: null };
  }
  return { text: null, error: null }; // nothing searchable (e.g. binary without parsed text) — not an error
}

export function registerSearchTools(server: McpServer): void {

  // ── search_documents ──────────────────────────────────────
  server.tool(
    'search_documents',
    '全文搜尋專案的規格文件（documents 表，DOCX 已轉 Markdown 的會讀轉檔後內容）。大小寫不敏感。回傳每個命中的文件名 + 行號 + 前後各 2 行片段。找欄位名、API 路徑、訊息文字時用這個，不要憑記憶。',
    {
      projectId: z.string().describe('專案 ID'),
      query: z.string().min(1).describe('搜尋字串（literal 子字串比對，大小寫不敏感）'),
      maxResults: z.number().int().positive().max(100).optional().describe('最多回傳幾個命中（預設 20）'),
    },
    { title: 'Search Documents', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, query, maxResults }) => {
      const db = getMcpDb();

      const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) as { id: string } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      const docs = db.prepare(
        'SELECT id, filename, file_path, parsed_text FROM documents WHERE project_id = ? ORDER BY created_at ASC'
      ).all(projectId) as DocRow[];

      if (docs.length === 0) {
        return { content: [{ type: 'text' as const, text: `專案 "${projectId}" 沒有任何文件。先用 fetch_svn_specs 抓規格。` }] };
      }

      const limit = maxResults ?? 20;
      const needle = query.toLowerCase();
      const hits: SearchHit[] = [];
      const errors: string[] = [];
      let searchedDocs = 0;

      for (const doc of docs) {
        if (hits.length >= limit) break;
        const { text, error } = resolveDocText(doc);
        if (error) errors.push(error);
        if (!text) continue;
        searchedDocs++;

        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (!lines[i]!.toLowerCase().includes(needle)) continue;
          const from = Math.max(0, i - 2);
          const to = Math.min(lines.length - 1, i + 2);
          const snippet = lines.slice(from, to + 1)
            .map((l, idx) => `${from + idx === i ? '>' : ' '} ${from + idx + 1}| ${l}`)
            .join('\n');
          hits.push({ filename: doc.filename, documentId: doc.id, line: i + 1, snippet });
        }
      }

      const text = JSON.stringify({
        projectId,
        query,
        searchedDocuments: searchedDocs,
        totalDocuments: docs.length,
        hitCount: hits.length,
        truncated: hits.length >= limit,
        hits,
        errors: errors.length > 0 ? errors : undefined,
      }, null, 2);

      return { content: [{ type: 'text' as const, text: truncateResponse(text, '命中過多，縮小 query 或降低 maxResults。') }] };
    },
  );

  // ── find_axure_snapshot ───────────────────────────────────
  server.tool(
    'find_axure_snapshot',
    '找任務對應的 Axure 原型 HTML。列出 docs/axure-snapshots/{projectId}/ 下檔名以功能代碼開頭（大小寫不敏感）的 .html 檔，回傳絕對路徑（用 Read tool 讀取對照 UI 結構）。',
    {
      projectId: z.string().describe('專案 ID（axure-snapshots 下的子目錄名）'),
      code: z.string().min(1).describe('功能代碼（如 WA05、DF01），比對檔名開頭'),
    },
    { title: 'Find Axure Snapshot', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, code }) => {
      // Guard against path traversal in path segments
      if (/[\\/]|\.\./.test(projectId) || /[\\/]|\.\./.test(code)) {
        return { content: [{ type: 'text' as const, text: 'Error: projectId / code 不可包含路徑分隔符或 ".."' }], isError: true };
      }

      // Project root convention: dataDir (= dirname of DB_PATH) 的上一層 + docs/axure-snapshots
      // (same as index.ts: path.join(path.dirname(config.dbPath), '..', 'docs', 'axure-snapshots'))
      const snapshotsRoot = path.resolve(getDataDir(), '..', 'docs', 'axure-snapshots');
      const dir = path.join(snapshotsRoot, projectId);

      if (!fs.existsSync(dir)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Axure snapshot 目錄不存在：${dir.replace(/\\/g, '/')}\n此專案尚未產生 Axure snapshots（用 crawl-axure-snapshots skill 產生）。`,
          }],
        };
      }

      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Error: 無法讀取目錄 ${dir.replace(/\\/g, '/')}: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }

      const prefix = code.toLowerCase();
      const matched = files
        .filter(f => f.toLowerCase().endsWith('.html') && f.toLowerCase().startsWith(prefix))
        .sort()
        .map(f => path.join(dir, f).replace(/\\/g, '/'));

      if (matched.length === 0) {
        const available = files.filter(f => f.toLowerCase().endsWith('.html')).length;
        return {
          content: [{
            type: 'text' as const,
            text: `目錄存在但沒有以 "${code}" 開頭的 .html（目錄內共 ${available} 個 .html）。確認功能代碼是否正確，或此功能尚未 snapshot。\n目錄：${dir.replace(/\\/g, '/')}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ projectId, code, count: matched.length, files: matched }, null, 2),
        }],
      };
    },
  );
}
