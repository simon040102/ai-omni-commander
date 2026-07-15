/**
 * MCP tools for acceptance verification.
 * get_verification_plan, get_test_baseline_plan, report_verification_result, report_verification_evidence
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
import { ensureMcpAgent, getDataDir, parseJson, truncateResponse } from '../helpers.js';

export interface VerificationItem {
  id: string;
  item: string;
  how: string;
}

/** 專案設定的單元測試指令（config_json.frontendTestCommand / backendTestCommand） */
export interface VerificationTestCommands {
  frontend?: string;
  backend?: string;
}

/**
 * 無關失敗回報規則——與 ExecutionPipeline 的 buildUnitTestSection 同文
 * （web/MCP 邊界不互相 import，靠測試釘住兩處同步）：既有無關失敗存在時，
 * agent 不會被別人的債卡死，但必須誠實揭露。
 */
export const UNRELATED_TEST_FAILURE_RULE =
  '自己任務相關的測試全綠即可回報 passed=true，note 必列無關失敗清單';

/**
 * 禁裝擋板——與 ExecutionPipeline 的 buildUnitTestSection 同文
 * （web/MCP 邊界不互相 import，靠測試釘住兩處同步）：測試框架不存在代表
 * 專案設定與 workspace 實況不符，agent 自行裝框架會污染 workspace。
 */
export const NO_INSTALL_GUARD_RULE =
  '測試指令執行失敗且原因是**框架/套件不存在**（command not found、找不到模組/類別路徑）→ **嚴禁自行安裝任何套件或修改建置檔**（package.json / pom.xml / build.gradle / lockfile 一律不可動）。這代表專案設定與 workspace 實況不符：report_output 記錄後標 failed，由使用者處理。「修復重試最多 3 次」僅適用於**測試本身的失敗**（斷言不過、程式 bug）';

/** config_json 字串 → 測試指令（trim；非字串/空白視為未設定；壞 JSON 安全回空） */
export function parseTestCommands(configJson: string | null | undefined): VerificationTestCommands {
  const config = parseJson<{ frontendTestCommand?: unknown; backendTestCommand?: unknown }>(configJson ?? null, {});
  const fe = config.frontendTestCommand;
  const be = config.backendTestCommand;
  return {
    frontend: typeof fe === 'string' && fe.trim() ? fe.trim() : undefined,
    backend: typeof be === 'string' && be.trim() ? be.trim() : undefined,
  };
}

/** 單一 side 的必要單測驗收項（id 與 get_verification_plan 的清單項一致） */
export interface RequiredUnitTestItem {
  id: 'fe-unit-tests' | 'be-unit-tests';
  side: 'frontend' | 'backend';
  command: string;
}

/**
 * 判定任務需要哪些單元測試驗收項——get_verification_plan 的清單前置與
 * update_task_status 的單元測試閘門**共用此 helper**（單一真相，避免規則漂移）：
 * label=frontend 且設 frontendTestCommand → fe-unit-tests；backend 同理；
 * fullstack/其他 label → 兩側有設的都要。沒設 testCommand 的 side 不出現。
 */
export function getRequiredUnitTestItems(label: string, testCommands?: VerificationTestCommands): RequiredUnitTestItem[] {
  const fe: RequiredUnitTestItem[] = testCommands?.frontend
    ? [{ id: 'fe-unit-tests', side: 'frontend', command: testCommands.frontend }]
    : [];
  const be: RequiredUnitTestItem[] = testCommands?.backend
    ? [{ id: 'be-unit-tests', side: 'backend', command: testCommands.backend }]
    : [];
  switch (label) {
    case 'frontend': return fe;
    case 'backend': return be;
    default: return [...be, ...fe]; // fullstack / 其他 label：兩側有設的都要
  }
}

/** 單元測試驗收項的 item 文字（閘門的文字比對也用同一個組字函式） */
export function unitTestItemText(command: string): string {
  return `單元測試全數通過（指令：${command}）`;
}

/**
 * 單元測試驗收項（testCommand 有設定才出現，前置在清單最前面）。
 * 單元測試只驗邏輯，不驗 SQL 和欄位名——API 煙霧測試照舊，是補強不是取代。
 */
function unitTestItem(req: RequiredUnitTestItem): VerificationItem {
  return {
    id: req.id,
    item: unitTestItemText(req.command),
    how: `在 ${req.side} workspace 執行 \`${req.command}\`，確認全數通過。單元測試只驗邏輯，不驗 SQL 和欄位名——API 煙霧測試照舊執行，是補強不是取代。跑全套撞到既有的**無關失敗**（非本任務造成）→ 不可順手修：${UNRELATED_TEST_FAILURE_RULE}，並建議使用者執行 get_test_baseline_plan 做基線修復`,
  };
}

/**
 * 從 agent_outputs 找此任務**最新一筆**針對指定單測驗收項的 report_verification_result
 * 回報（解析 report_verification_result 寫入的 [VERIFICATION] 文字格式；item 欄位
 * 支援 id 或 item 文字，與該工具的回報約定一致）。找不到 → null。
 */
export function findLatestUnitTestVerification(
  db: ReturnType<typeof getMcpDb>,
  taskId: string,
  req: RequiredUnitTestItem,
): { passed: boolean } | null {
  const rows = db.prepare(`
    SELECT content FROM agent_outputs
    WHERE task_id = ? AND stream_type = 'system' AND content LIKE '[VERIFICATION]%'
    ORDER BY id DESC
  `).all(taskId) as Array<{ content: string }>;
  const itemText = unitTestItemText(req.command);
  for (const row of rows) {
    for (const line of row.content.split('\n')) {
      const m = /^- \[(PASS|FAIL)\] (.*)$/.exec(line);
      if (!m) continue;
      // 格式：`- [PASS|FAIL] {item}[ — {note}]`——只比對 item 部分，避免 note 誤中
      const itemField = (m[2] ?? '').split(' — ')[0]!.trim();
      if (itemField === req.id || itemField === itemText) {
        return { passed: m[1] === 'PASS' };
      }
    }
  }
  return null;
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

export function getVerificationItems(label: string, testCommands?: VerificationTestCommands): { items: VerificationItem[]; note: string | null } {
  // 該任務 side 的 testCommand 有設定 → 驗收清單自動前置「單元測試全數通過」項；沒設定不出現。
  // 前置哪些項與 update_task_status 的單元測試閘門共用 getRequiredUnitTestItems（單一真相）。
  const unitItems = getRequiredUnitTestItems(label, testCommands).map(unitTestItem);
  switch (label) {
    case 'backend':
      return { items: [...unitItems, ...BACKEND_ITEMS], note: null };
    case 'frontend':
      return { items: [...unitItems, ...FRONTEND_ITEMS], note: null };
    case 'fullstack':
      return { items: [...unitItems, ...BACKEND_ITEMS, ...FRONTEND_ITEMS], note: null };
    default:
      return {
        items: [...unitItems, ...BACKEND_ITEMS, ...FRONTEND_ITEMS],
        note: `label "${label}" 沒有專屬驗收清單，回傳前端+後端完整清單，請挑適用項目執行（不適用的項目回報 passed=true + note="N/A"）。`,
      };
  }
}

export function registerVerificationTools(server: McpServer): void {

  // ── get_verification_plan ─────────────────────────────────
  server.tool(
    'get_verification_plan',
    '取得任務的驗收清單（依 task label 決定：backend=撈全表靜態檢查/DDL 比對/API 煙霧測試/seed SQL；frontend=tsc --noEmit/Playwright；fullstack=兩者）。專案設定的 frontendTestCommand/backendTestCommand 有設定時，會自動前置「單元測試全數通過」驗收項——此項是完成閘門依據：update_task_status(completed) 要求該項最新一筆驗收回報 passed=true。**標記 completed 之前必須逐項執行並用 report_verification_result 回報結果。**',
    {
      taskId: z.string().describe('任務 ID'),
    },
    { title: 'Get Verification Plan', readOnlyHint: true, openWorldHint: false },
    async ({ taskId }) => {
      const db = getMcpDb();
      const task = db.prepare('SELECT id, label, title, project_id FROM tasks WHERE id = ?').get(taskId) as { id: string; label: string; title: string; project_id: string } | undefined;
      if (!task) {
        return { content: [{ type: 'text' as const, text: `Error: Task "${taskId}" not found` }], isError: true };
      }

      // 專案設定的單元測試指令（frontendTestCommand / backendTestCommand）→ 前置單元測試驗收項
      const proj = db.prepare('SELECT config_json FROM projects WHERE id = ?').get(task.project_id) as { config_json: string | null } | undefined;
      const testCommands = parseTestCommands(proj?.config_json);

      const { items, note } = getVerificationItems(task.label, testCommands);

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

  // ── get_test_baseline_plan ────────────────────────────────
  server.tool(
    'get_test_baseline_plan',
    '取得「測試基線修復」派工計畫（給 orchestrator）。**使用時機：專案填了 frontendTestCommand/backendTestCommand 但既有測試不是全綠時，先跑此計畫把基線修到全綠，再對此專案開單元測試強制**（有 testCommand 的專案 update_task_status(completed) 受單元測試閘門管制）。回傳派工計畫：orchestrator 用 create_task 開基線修復任務並派 agent 到對應 workspace；fixer 跑全套取得紅綠清單 → 每條失敗強制三分類（測試化石=依規格原文更新測試／真 bug=不改測試也不改程式、建議另開 bug 任務／環境問題=只回報建議修正）→ 重跑到綠。此工具本身只讀，不執行任何 workspace 指令。',
    {
      projectId: z.string().describe('專案 ID'),
      side: z.enum(['frontend', 'backend', 'both']).optional().describe('修復哪一側的測試基線（預設 both：兩側有設 testCommand 的都排入）'),
    },
    { title: 'Get Test Baseline Plan', readOnlyHint: true, openWorldHint: false },
    async ({ projectId, side }) => {
      const db = getMcpDb();
      const project = db.prepare('SELECT id, name, frontend_path, backend_path, config_json FROM projects WHERE id = ?').get(projectId) as
        { id: string; name: string; frontend_path: string | null; backend_path: string | null; config_json: string | null } | undefined;
      if (!project) {
        return { content: [{ type: 'text' as const, text: `Error: Project "${projectId}" not found` }], isError: true };
      }

      const cmds = parseTestCommands(project.config_json);
      const effSide = side ?? 'both';
      const configHint = '用 update_project(projectId, configJson={...}) 或 Web 專案設定的「單元測試指令」欄位填入後再呼叫。';

      // 指定 side 沒設指令 → 明確錯誤；both → 兩側有設的都排入（一側都沒設 → 錯誤）
      interface BaselineTarget { side: 'frontend' | 'backend'; command: string; workspace: string | null }
      const targets: BaselineTarget[] = [];
      if (effSide === 'frontend' || effSide === 'both') {
        if (cmds.frontend) targets.push({ side: 'frontend', command: cmds.frontend, workspace: project.frontend_path });
        else if (effSide === 'frontend') {
          return { content: [{ type: 'text' as const, text: `Error: 專案「${project.name}」未設定 frontendTestCommand，沒有可修復的前端測試基線。${configHint}` }], isError: true };
        }
      }
      if (effSide === 'backend' || effSide === 'both') {
        if (cmds.backend) targets.push({ side: 'backend', command: cmds.backend, workspace: project.backend_path });
        else if (effSide === 'backend') {
          return { content: [{ type: 'text' as const, text: `Error: 專案「${project.name}」未設定 backendTestCommand，沒有可修復的後端測試基線。${configHint}` }], isError: true };
        }
      }
      if (targets.length === 0) {
        return { content: [{ type: 'text' as const, text: `Error: 專案「${project.name}」frontendTestCommand / backendTestCommand 都未設定，沒有可修復的測試基線。${configHint}` }], isError: true };
      }
      const noWorkspace = targets.filter(t => !t.workspace);
      if (noWorkspace.length > 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Error: 以下 side 設了 testCommand 但專案沒有對應的 workspace 路徑，無法派 fixer agent：${noWorkspace.map(t => `${t.side}（${t.side}Path 未設定）`).join('、')}。用 update_project 設定 workspace 路徑後再呼叫。`,
          }],
          isError: true,
        };
      }

      const sideLabel: Record<'frontend' | 'backend', string> = { frontend: '前端', backend: '後端' };
      const fixerPrompts = targets.map(t => `## Fixer Prompt — ${t.side}（原封不動傳給 subagent，{TASK_ID} 替換為 create_task 回傳的任務 ID）

你是測試基線修復工程師（fixer）。workspace：${t.workspace}；測試指令：\`${t.command}\`。
目標：**把既有測試修到全套綠**，不是開發新功能、也不是重寫測試架構。

### 流程（強制，依序執行）
1. **取得基線**：在 workspace 執行 \`${t.command}\` 取得完整紅綠清單，用 mcp__omni-commander__report_output(taskId="{TASK_ID}", content="...") 回報基線數字（總數/通過/失敗/skip）與失敗清單
2. **每條失敗強制三分類**（一條都不可跳過，分類結果 report_output 留稽核軌跡）：
   - **測試化石**（程式依規格演進、測試沒跟上）→ 用 fetch_svn_specs / read_document / search_documents 撈該功能的最新規格，對照**規格原文**後更新測試斷言；測試名稱/註解標注規格出處
   - **真 bug**（測試才是對的、程式錯了）→ **不改測試也不改程式**，report_output 列出（測試名、期望 vs 實際、規格出處），建議另開 bug 任務處理
   - **環境問題**（JDK/Node 版本不符、缺環境變數、缺外部服務）→ 不亂改，report_output 回報建議的環境修正，由使用者處理
3. **判斷依據一律規格原文**：規格沒定義該行為 → mcp__omni-commander__report_spec_gap(taskId="{TASK_ID}", category=..., description=...) 記錄；**嚴禁把程式現狀當正確答案改寫斷言**（現狀可能就是 bug——把 bug 固化成測試斷言比沒有測試更糟）
4. **禁裝擋板**：${NO_INSTALL_GUARD_RULE}
5. **全部處理完重跑全套到綠**：真 bug 對應的測試可暫時 skip，但必須在 skip 處標注原因與追蹤建議（對應第 2 步列出的 bug 建議）；report_output 總結：修了哪些化石（各自的規格出處）/發現哪些真 bug/剩哪些 skip
6. **完成回報**：全套綠後用 mcp__omni-commander__report_verification_result(taskId="{TASK_ID}", results=[{item:"${t.side === 'frontend' ? 'fe-unit-tests' : 'be-unit-tests'}", passed:true, note:"基線修復完成，全套通過（skip 清單見 report_output 總結）"}]) 回報，再 update_task_status(taskId="{TASK_ID}", status="completed", summary=...)；無法修到綠 → update_task_status(taskId="{TASK_ID}", status="failed", summary="原因")。完成後回報使用者：基線已綠，可對此專案開單元測試強制

### 絕對禁止
- 不得修改任何產品程式碼（只動測試檔與測試輔助檔；真 bug 一律回報不修）
- 不得安裝套件或修改建置檔（見禁裝擋板）
- 規格沒定義的行為嚴禁自創預期值（report_spec_gap 記錄）`);

      const plan = `**測試基線修復派工計畫（Test Baseline Plan）**
**Project:** ${project.name}（projectId=${projectId}）
**目標：** 既有測試修到全套綠，之後此專案的單元測試閘門（update_task_status 完成閘門）才不會被歷史債卡死
**範圍：**
${targets.map(t => `- ${sideLabel[t.side]}：\`${t.command}\` — workspace: ${t.workspace}`).join('\n')}

> **給 orchestrator 的指示：**
> 1. 對每個 side 用 create_task(projectId="${projectId}", title="測試基線修復（${targets.map(t => t.side).join(' / ')}）", label=對應 side, taskType="refactor", description=...) 建立任務（taskType 用 refactor——整理既有測試，不是新功能）
> 2. update_task_status(taskId, "in_progress") 後用 Agent tool 派 fixer agent，cwd 設為該 side 的 workspace 路徑
> 3. 將下方對應 side 的 Fixer Prompt **原封不動**傳入（{TASK_ID} 替換為 create_task 回傳的任務 ID）。**此任務不要呼叫 get_execution_plan**——Fixer Prompt 即完整流程（基線修復不走規格驅動的開發軌，避免觸發 flow gate / 檢查表 / AI 回對閘門）
> 4. fixer 回報有「真 bug」時，向使用者確認後另開 bug 任務，不要讓 fixer 順手修
> 5. 基線全綠後告知使用者：此專案的單元測試強制已可安心啟用（testCommand 已設定，閘門自動生效）

---

${fixerPrompts.join('\n\n---\n\n')}`;

      return { content: [{ type: 'text' as const, text: truncateResponse(plan) }] };
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
