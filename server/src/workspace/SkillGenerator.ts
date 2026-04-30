import fs from 'node:fs';
import path from 'node:path';
import type { AgentManager } from '../agent/AgentManager.js';
import { WorkspaceScanner } from './WorkspaceScanner.js';
import { upsertWorkspaceSkills } from '../db/queries/workspaceSkills.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('SkillGenerator');

/**
 * Generates or updates CLAUDE.md + .claude/skills/ for a workspace
 * by spawning an Opus agent that deep-reads the codebase.
 *
 * Two modes:
 * - "create"  — workspace has no CLAUDE.md / skills yet
 * - "enhance" — workspace already has CLAUDE.md / skills, agent audits and fills gaps
 */
export class SkillGenerator {
  private scanner = new WorkspaceScanner();

  constructor(private agentManager: AgentManager) {}

  async generate(
    projectId: string,
    workspacePath: string,
    workspaceType: 'frontend' | 'backend',
  ): Promise<string> {
    const hasClaudeMd = fs.existsSync(path.join(workspacePath, 'CLAUDE.md'));
    const hasSkillsDir = fs.existsSync(path.join(workspacePath, '.claude', 'skills'));
    const hasSkills = hasSkillsDir && fs.readdirSync(path.join(workspacePath, '.claude', 'skills')).some(f => f.endsWith('.md'));
    const mode: 'create' | 'enhance' = (hasClaudeMd || hasSkills) ? 'enhance' : 'create';

    logger.info({ projectId, workspacePath, workspaceType, mode }, 'Generating workspace skills');

    const prompt = this.buildPrompt(workspaceType, mode);

    const agentId = await this.agentManager.startAgent({
      projectId,
      role: 'architect',
      prompt,
      model: 'opus',
      workingDir: workspacePath,
      useWorkspaceSkills: false,
    });

    this.schedulePostScan(projectId, workspacePath, workspaceType, agentId);
    return agentId;
  }

  private schedulePostScan(
    projectId: string,
    workspacePath: string,
    workspaceType: 'frontend' | 'backend',
    agentId: string,
  ): void {
    const check = setInterval(() => {
      try {
        const { getAgent } = require('../db/queries/agents.js') as typeof import('../db/queries/agents.js');
        const agent = getAgent(agentId);
        if (agent && (agent.status === 'stopped' || agent.status === 'error')) {
          clearInterval(check);
          try {
            const result = this.scanner.scan(workspacePath);
            upsertWorkspaceSkills(projectId, workspaceType, {
              path: workspacePath,
              hasClaudeMd: result.hasClaudeMd,
              hasClaudeDir: result.hasClaudeDir,
              skills: result.skills,
            });
            logger.info({ projectId, workspaceType, hasClaudeMd: result.hasClaudeMd }, 'Post-generation scan complete');
          } catch (err) {
            logger.error({ err, projectId, workspaceType }, 'Post-generation scan failed');
          }
        }
      } catch {
        clearInterval(check);
      }
    }, 5000);
    setTimeout(() => clearInterval(check), 600000);
  }

  private buildPrompt(workspaceType: 'frontend' | 'backend', mode: 'create' | 'enhance'): string {
    const lang = workspaceType === 'frontend' ? '前端' : '後端';

    const modeInstruction = mode === 'create'
      ? `此工作目錄**尚無** CLAUDE.md 或 .claude/skills/，從零開始建立。`
      : `此工作目錄**已有**${hasClaudeMd ? ' CLAUDE.md' : ''}${hasSkills ? ' .claude/skills/' : ''}，先讀取現有內容，找出缺漏或過時的部分補強。現有正確的內容不要刪除，只新增或修正。${hasClaudeMd && !hasSkills ? '\n注意：有 CLAUDE.md 但尚無 .claude/skills/，需要建立 skills 目錄和檔案。' : ''}`;

    return `你是一位深度理解真實工程現場的資深${lang}架構師。
你的任務是：**深度閱讀這個專案的程式碼，把它的「開發方式、習慣、潛規則」全部文件化**，讓未來的 AI agent 讀了之後，能像一個熟悉這個專案三個月的工程師一樣開發——不踩雷、不重複造輪子、風格一致。

${modeInstruction}

---

## 分析流程

### Phase 1：摸清全局
用 Glob、Grep 工具掃描整個專案：
- 資料夾結構、檔案命名規律
- package.json（依賴、scripts）、tsconfig、build 工具設定
- 有沒有現成的 CLAUDE.md、.claude/、README、ADR、docs/
- 有沒有 lint/format 設定（eslint、prettier、stylelint）

### Phase 2：深讀程式碼
**不要只看一兩個檔案。要跨越不同功能模組，廣泛取樣，抓出「這個專案一貫的做法」。**

每個維度都要看實際程式碼，提取真實的 pattern，不要假設：
${workspaceType === 'frontend' ? `
- 元件：怎麼定義 props？用 interface 還是 type？有沒有統一的 FC 寫法？
- Hooks：custom hook 放哪？命名規則？怎麼處理 side effect？
- 狀態：用什麼管理（zustand/redux/context/jotai/...）？store 結構怎麼組？action 怎麼命名？
- API 呼叫：有沒有封裝的 http client / api layer？錯誤怎麼處理？loading/error state 慣例？
- Form：react-hook-form / formik / 純 state？validation 在哪一層？error message 怎麼顯示？
- 路由：router 怎麼組？有沒有 guard？lazy load 怎麼做？navigate 怎麼呼叫？
- 共用元件：shared/components 有哪些？怎麼 import？有沒有 barrel index？哪些最常被誤重複實作？
- 樣式：Tailwind / CSS modules / styled-components？className 組合習慣？有沒有 design token？
- 型別：types/interfaces 放哪？有沒有 API response 型別生成？enum 還是 union string？
- Import：路徑 alias 配置？相對 vs 絕對偏好？barrel import 習慣？
- 測試：框架？test 檔放哪？命名慣例？mock 怎麼做？有沒有 shared test utils？
- i18n：有沒有？key 命名？t() 用法？哪些地方不需要翻譯？
- 其他觀察到的強烈慣例
` : `
- 分層：controller / service / repository（或其他分層）如何切？各層職責邊界在哪？
- 框架：NestJS / Express / Fastify / 其他？有哪些特有的 pattern（decorator、guard、interceptor、pipe...）？
- DB：用哪個 ORM？query 怎麼寫？N+1 怎麼處理？transaction 怎麼開？migration 規則？
- API：路由命名規則？prefix？versioning？request body 怎麼 validate（zod/class-validator/joi/...）？response 格式統一嗎？
- 認證授權：JWT/session？token 怎麼驗？role/permission 怎麼設計？guard 在哪層？
- 錯誤處理：有沒有 global exception filter？自訂 error class 怎麼繼承？HTTP status 對應規則？
- DTO/Entity：命名規則？validation decorator 怎麼放？序列化設定（class-transformer / exclude 等）？
- Log / Audit：用哪個 logger？哪些操作需要 audit？log 格式？
- 設定：env 怎麼讀？有沒有 config service / module？secrets 管理方式？
- 測試：unit vs integration？mock DB 策略？repository mock 怎麼做？test data 怎麼建？
- 其他觀察到的強烈慣例
`}

### Phase 3：挖潛規則（最重要）
讀程式碼時特別留意以下，這些是新 agent 最容易出錯的地方：

1. **刻意的奇怪寫法** — 看起來不合理但有原因的 workaround，標明「不要動、不要優化」和原因
2. **禁止清單** — 明確不能用的套件、寫法、模式（要有具體理由）
3. **已有但容易被忽略的 utility/helper** — 新 agent 最常重複造的輪子
4. **版本或環境限制** — 某些新 API 因版本鎖定無法使用
5. **隱性的業務規則** — 某些看似技術的決定其實是業務要求（例如：特定欄位不能為空、某操作必須寫 audit log）
6. **開發順序 / 依賴關係** — 做某功能之前必須先做什麼（例如：改 DB 前要先跑 migration）

---

## 輸出原則

**目標只有一個：讓未來的 AI agent 讀完這些文件，立刻知道「在這個專案要怎麼開發」。**

不要套固定模板。根據你在這個專案實際發現的東西，自己判斷：
- CLAUDE.md 要寫哪些章節、寫多深
- 要建多少個 skill 檔案、每個聚焦什麼主題
- 什麼值得單獨拆成一個 skill（有反覆使用價值的、容易踩雷的、需要查表的）

### CLAUDE.md 撰寫方向
- 開頭快速說清楚這是什麼專案、用什麼技術棧
- 架構概覽要讓人知道「要找什麼去哪個資料夾」
- 規範類的內容要具體，配程式碼範例，不要只說「遵循 XXX 風格」
- 禁止事項和 workaround 要獨立、醒目，是最容易救命的部分
- 寧可寫少但準確，不要寫多但模糊
- **必須包含「可用 Skills」章節**：列出所有建立的 .claude/skills/ 檔案名稱、描述、什麼情況下應該使用。格式範例：
  \`\`\`
  ## 可用 Skills（.claude/skills/）
  | Skill 名稱 | 說明 | 使用時機 |
  |-----------|------|---------|
  | develop-feature | 新功能開發流程 | 開發新頁面或新 API 時 |
  | coding-conventions | 命名與程式碼風格 | 寫任何程式碼前查閱 |
  \`\`\`

### .claude/skills/ 撰寫方向
每個 skill 聚焦一個明確的主題，讓 agent 在需要的時候能精確叫出來。
自己決定要建哪些，以下是**可能的方向**（不是必填清單）：
- 程式碼慣例 / 命名規則
- 反模式 / 禁止清單
- 共用元件使用指南
- 某個複雜流程的 step-by-step（例如：新增一個 API endpoint、新增一個 DB migration）
- 特定技術的專案內用法（例如：這個專案怎麼用 zustand、怎麼寫 form）
- 測試策略
- 任何你覺得「新人最需要知道」的主題

每個 skill 檔案必須有 frontmatter：
\`\`\`markdown
---
name: skill-name
description: 一句話說明：什麼情況下應該叫這個 skill
type: reference
---
\`\`\`

### 基本原則
- 所有路徑、範例都從實際程式碼提取，不要虛構
- 每條禁止/警告都要有理由
- 找不到的東西不要寫，寧缺勿濫

### 絕對禁止
- **不得執行任何 DB 操作**（SELECT、INSERT、UPDATE、DELETE、DROP、ALTER 等一律禁止）
- **不得修改任何現有程式碼**，只能讀取
- 唯一允許寫入的目標：CLAUDE.md 和 .claude/skills/ 下的 markdown 檔案

完成所有檔案後，輸出 [TASK_COMPLETE]`;
  }
}
