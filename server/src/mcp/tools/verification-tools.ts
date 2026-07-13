/**
 * MCP tools for acceptance verification.
 * get_verification_plan, report_verification_result, report_verification_evidence
 *
 * Checklist content mirrors CLAUDE.md「subagent 完成後的 orchestrator 驗證」:
 * backend = 撈全表靜態檢查 / DDL 比對 / API 煙霧測試 / seed SQL 檢查;
 * frontend = tsc --noEmit / Playwright 瀏覽器測試; fullstack = both.
 * 通用（stack 中性）——專案特有慣例走 extraPrompt / 專案筆記，不寫死在此。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMcpDb } from '../db.js';
import { notifyWebServer } from '../notify.js';
import { ensureMcpAgent, getDataDir } from '../helpers.js';

export interface VerificationItem {
  id: string;
  item: string;
  how: string;
}

const BACKEND_ITEMS: VerificationItem[] = [
  {
    id: 'be-no-findall',
    item: '靜態檢查：沒有「撈全表 + 記憶體過濾」的查詢',
    how: 'grep 本次修改的資料存取層，確認沒有先撈整張表回來再用程式過濾的寫法（Legacy 大表可能有數十萬筆）——過濾/分頁必須下推到查詢層。專案技術棧的具體禁用寫法見專案額外指示/專案筆記',
  },
  {
    id: 'be-ddl-match',
    item: 'DDL 比對：CREATE TABLE 欄位名與 ORM/模型定義一致',
    how: '逐欄比對 DDL 與 ORM 欄位定義（Entity/Model 對應），含系統共用欄位（如建立/修改時間、備註欄）——共用欄位的確切名稱以專案慣例為準',
  },
  {
    id: 'be-api-smoke',
    item: 'API 煙霧測試：每個新 API 回 200 不是 500',
    how: '啟動服務後 curl 每個新增/修改的 API endpoint，確認回 200（單元測試只驗邏輯，煙霧測試才驗 SQL 和欄位名）',
  },
  {
    id: 'be-seed-sql',
    item: 'seed SQL 檢查：INSERT 欄位數量與 VALUES 參數數量一致',
    how: '檢查所有 seed/migration SQL 的 INSERT 欄位清單與 VALUES 個數逐一對應',
  },
];

const FRONTEND_ITEMS: VerificationItem[] = [
  {
    id: 'fe-tsc',
    item: 'TypeScript 檢查：tsc --noEmit 零錯誤',
    how: '在前端 workspace 執行 npx tsc --noEmit，確認零錯誤',
  },
  {
    id: 'fe-browser',
    item: '瀏覽器測試：頁面能正常操作',
    how: '用 Playwright 開啟頁面實際操作（查詢/新增/儲存等主要流程），確認無 console error、畫面符合規格（服務有跑的話）',
  },
];

export function getVerificationItems(label: string): { items: VerificationItem[]; note: string | null } {
  switch (label) {
    case 'backend':
      return { items: BACKEND_ITEMS, note: null };
    case 'frontend':
      return { items: FRONTEND_ITEMS, note: null };
    case 'fullstack':
      return { items: [...BACKEND_ITEMS, ...FRONTEND_ITEMS], note: null };
    default:
      return {
        items: [...BACKEND_ITEMS, ...FRONTEND_ITEMS],
        note: `label "${label}" 沒有專屬驗收清單，回傳前端+後端完整清單，請挑適用項目執行（不適用的項目回報 passed=true + note="N/A"）。`,
      };
  }
}

export function registerVerificationTools(server: McpServer): void {

  // ── get_verification_plan ─────────────────────────────────
  server.tool(
    'get_verification_plan',
    '取得任務的驗收清單（依 task label 決定：backend=撈全表靜態檢查/DDL 比對/API 煙霧測試/seed SQL；frontend=tsc --noEmit/Playwright；fullstack=兩者）。**標記 completed 之前必須逐項執行並用 report_verification_result 回報結果。**',
    {
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Get Verification Plan', readOnlyHint: true, openWorldHint: false },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, label, title FROM tasks WHERE id = ?').get(taskId) as { id: string; label: string; title: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const { items, note } = getVerificationItems(task.label);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            taskId: task.id,
            label: task.label,
            note,
            instruction: '逐項執行後呼叫 report_verification_result(taskId, results=[{item, passed, note?}]) 回報，item 用清單中的 id 或 item 文字。截圖等證據檔案用 report_verification_evidence(taskId, filePath, description) 上傳。',
            items,
          }, null, 2),
        }],
      };
    },
  );

  // ── report_verification_result ────────────────────────────
  server.tool(
    'report_verification_result',
    '回報驗收清單的執行結果。寫入任務輸出紀錄並在 Web UI 顯示「驗收：X/Y 通過」里程碑。有未通過項目時應修復後重新驗收，不要直接標 completed。',
    {
      taskId: z.string().describe('任務 ID'),
      results: z.array(z.object({
        item: z.string().describe('驗收項目（get_verification_plan 回傳的 id 或 item 文字）'),
        passed: z.boolean().describe('是否通過'),
        note: z.string().optional().describe('補充說明（失敗原因 / N/A 原因 / 實測結果）'),
      })).min(1).describe('各驗收項目的結果'),
    },
    { title: 'Report Verification Result', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, results }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      const passedCount = results.filter(r => r.passed).length;
      const summary = `驗收：${passedCount}/${results.length} 通過`;
      const lines = results.map(r => `- [${r.passed ? 'PASS' : 'FAIL'}] ${r.item}${r.note ? ` — ${r.note}` : ''}`);
      const outputText = `[VERIFICATION] ${summary}\n${lines.join('\n')}`;

      // Store in agent_outputs under the synthetic mcp-{taskId} agent (same channel as report_output)
      const { agentId, created, role, title } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: task.project_id, taskId, role, title, model: 'external (MCP)' },
        });
      }
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, taskId, outputText);

      // Log as milestone event (mirrors report_milestone)
      db.prepare(`
        INSERT INTO events (id, project_id, event_type, source, target, payload_json)
        VALUES (?, ?, 'task.milestone', ?, ?, ?)
      `).run(crypto.randomUUID(), task.project_id, `task:${taskId}`, null,
        JSON.stringify({ milestone: summary, details: lines.join('\n') }));

      const notifyOk = await notifyWebServer({
        event: 'task.milestone',
        data: { taskId, projectId: task.project_id, milestone: summary, details: lines.join('\n') },
      });

      const failWarning = passedCount < results.length
        ? `\n⚠ 有 ${results.length - passedCount} 項未通過——請修復後重新驗收，未全數通過不要標記 completed。`
        : '\n全部通過。可以 update_task_status(taskId, "completed", summary) 結案。';
      const notifyWarning = notifyOk ? '' : ' (warning: Web UI notification failed)';

      return { content: [{ type: 'text' as const, text: `${summary}${notifyWarning}${failWarning}` }] };
    },
  );

  // ── report_verification_evidence ──────────────────────────
  server.tool(
    'report_verification_evidence',
    '上傳驗收證據檔案（截圖、測試報告等）。檔案會複製到專案上傳區的 verification 目錄、寫入 documents 表（doc_type=verification）並綁定任務，Web UI 顯示「驗收證據」里程碑。get_documents 可列出。',
    {
      taskId: z.string().describe('任務 ID'),
      filePath: z.string().describe('證據檔案的絕對路徑（必須已存在，例如 Playwright 截圖 PNG、測試報告 md）'),
      description: z.string().optional().describe('證據說明（例如「WA05 查詢結果截圖 — 3 筆資料正常顯示」）'),
    },
    { title: 'Report Verification Evidence', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async ({ taskId, filePath, description }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId) as { project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      let isFile = false;
      try { isFile = fs.statSync(filePath).isFile(); } catch { /* missing */ }
      if (!isFile) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 檔案不存在或不是一般檔案：${filePath}。請確認傳入「已存在檔案」的絕對路徑（截圖請先存檔再呼叫此工具）。`,
          }],
          isError: true,
        };
      }

      // Copy to {dataDir}/uploads/{projectId}/verification/{taskId}/ with a sanitized, de-duplicated name
      const destDir = path.join(getDataDir(), 'uploads', task.project_id, 'verification', taskId);
      fs.mkdirSync(destDir, { recursive: true });

      const rawName = path.basename(filePath);
      const safeName = rawName.replace(/[<>:"|?*\\/]/g, '_') || 'evidence';
      const ext = path.extname(safeName);
      const stem = ext ? safeName.slice(0, -ext.length) : safeName;
      let finalName = safeName;
      for (let i = 1; fs.existsSync(path.join(destDir, finalName)); i++) {
        finalName = `${stem}-${i}${ext}`;
      }
      const destPath = path.join(destDir, finalName);
      fs.copyFileSync(filePath, destPath);

      // documents record (doc_type = verification) + task binding
      const docId = randomUUID();
      const extLower = ext.toLowerCase();
      const mimeByExt: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain',
      };
      db.prepare(`
        INSERT INTO documents (id, project_id, filename, file_path, file_type, doc_type, parsed_text, source)
        VALUES (?, ?, ?, ?, ?, 'verification', ?, 'upload')
      `).run(docId, task.project_id, finalName, destPath, mimeByExt[extLower] || 'binary',
        `[Verification evidence${description ? `: ${description}` : ''} — use Read tool to view: ${destPath.replace(/\\/g, '/')}]`);
      db.prepare('INSERT OR IGNORE INTO task_documents (task_id, document_id) VALUES (?, ?)').run(taskId, docId);

      // agent_outputs [EVIDENCE] line (same channel as report_output)
      const { agentId, created, role, title } = ensureMcpAgent(db, taskId, task.project_id);
      if (created) {
        await notifyWebServer({
          event: 'agent.started',
          data: { agentId, projectId: task.project_id, taskId, role, title, model: 'external (MCP)' },
        });
      }
      db.prepare(`
        INSERT INTO agent_outputs (agent_id, task_id, stream_type, content)
        VALUES (?, ?, 'system', ?)
      `).run(agentId, taskId, `[EVIDENCE] ${description || finalName}`);

      // Milestone event + notify (mirrors report_verification_result)
      const milestone = `驗收證據：${finalName}`;
      db.prepare(`
        INSERT INTO events (id, project_id, event_type, source, target, payload_json)
        VALUES (?, ?, 'task.milestone', ?, ?, ?)
      `).run(randomUUID(), task.project_id, `task:${taskId}`, null,
        JSON.stringify({ milestone, details: description || null }));

      const notifyOk = await notifyWebServer({
        event: 'task.milestone',
        data: { taskId, projectId: task.project_id, milestone, details: description || null },
      });

      const warning = notifyOk ? '' : ' (warning: Web UI notification failed)';
      return {
        content: [{
          type: 'text' as const,
          text: `Verification evidence saved (documentId: ${docId})${warning}\n檔案：${destPath.replace(/\\/g, '/')}\nget_documents(projectId, taskId) 可列出此證據。`,
        }],
      };
    },
  );
}
