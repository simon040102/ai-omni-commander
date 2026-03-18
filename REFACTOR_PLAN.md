# AI-OmniCommander v2 重構規劃

## 核心理念轉變

**v1**：每次建立一個「執行」，選模式、上傳文件、跑一次
**v2**：以「專案」為中心，專案是長期存在的實體，裡面持續接收任務並自動執行

---

## 一、專案管理（Project）

### 1.1 建立專案
- 使用者命名專案
- 設定 Frontend 資料夾路徑（Folder Picker）
- 設定 Backend 資料夾路徑（Folder Picker）
- （可選）綁定 Asana 專案 ID（從 Asana 專案列表選取）
- 建立後專案持久存在，隨時可進入操作

### 1.2 Workspace 自動偵測
選完資料夾後，自動掃描：
- `CLAUDE.md` 是否存在
- `.claude/` 目錄是否存在
- `.claude/commands/*.md` 技能檔案列表
- `.claude/settings.json` 設定

顯示偵測結果，例如：
```
✅ Frontend: CLAUDE.md 找到，3 個 skills
❌ Backend: 無 CLAUDE.md，無 .claude/
```

### 1.3 首次初始化 — 自動生成 Skills

如果偵測不到 CLAUDE.md / .claude/，提供「初始化 Skills」按鈕，生成流程：

#### 前端 Skill 生成 Prompt
```
請深入分析這個前端專案，生成 CLAUDE.md，內容包含：

1. **專案概覽**：框架、版本、主要依賴
2. **資料夾結構**：每個目錄的用途說明
3. **程式碼風格規範**：
   - 命名慣例（component、hook、utility）
   - import 順序規則
   - TypeScript 使用慣例
4. **共用元件清單**：列出所有可複用的 UI 元件及其 props
5. **排版與 CSS 規則**：
   - 使用的 CSS 方案（Tailwind / CSS Modules / styled-components）
   - 常用的 spacing、color、breakpoint token
   - 佈局模式（grid / flex 慣例）
6. **狀態管理模式**：store 結構、資料流方向
7. **API 串接模式**：fetch/axios 封裝、error handling 慣例
8. **路由結構**：頁面對應表
9. **測試慣例**：測試框架、檔案命名、mock 模式
10. **Build / Lint / Format 指令**
```

#### 後端 Skill 生成 Prompt
```
請深入分析這個後端專案，生成 CLAUDE.md，內容包含：

1. **專案概覽**：框架、語言版本、主要依賴
2. **資料夾結構**：每個目錄的用途說明
3. **Database Schema**：（使用者可貼入完整 table schema）
   - 所有 Table 及其欄位、型別、關聯
   - Migration 工具與流程
4. **程式碼風格規範**：
   - 命名慣例（controller、service、repository、model）
   - Error handling 模式
   - Logging 慣例
5. **API 架構**：
   - Router 結構
   - 中間件（middleware）清單與順序
   - 認證/授權機制
6. **資料存取模式**：ORM / raw query / repository pattern
7. **共用 Utility 清單**：可複用的 helper functions
8. **環境設定**：env 變數說明
9. **測試慣例**：測試框架、fixture、mock 模式
10. **Build / Lint / 啟動指令**
```

#### 通用規範生成（如果前後端有共通規則）
```
分析前後端共用的規範，生成跨專案 CLAUDE.md 補充：

1. **API Contract 規範**：request/response 格式、版本策略
2. **Error Code 定義**：錯誤碼對照表
3. **共用型別**：前後端共享的 type/interface
4. **Git 規範**：commit message 格式、branch 命名
5. **PR 規範**：review checklist
```

### 1.4 Skill 定期更新
- 可手動觸發「重新分析」更新 CLAUDE.md
- （進階）偵測到大量檔案變更後提示是否要更新 skills

---

## 二、Asana 整合（深度綁定）

### 2.1 專案綁定
- 建立專案時選擇 Asana 專案
- 一個 OmniCommander 專案 ↔ 一個 Asana 專案

### 2.2 任務同步
- **手動同步**：點按鈕拉取最新任務
- **定時同步**（可開關）：
  - 設定排程（例如每天早上 9:00、每 N 小時一次）
  - 使用 node-cron 或類似機制
  - 僅拉取「未完成」且「指派給我」的任務
  - 新增的任務標記為「新」

### 2.3 任務分類引擎
同步到任務後，自動分析任務內容，判斷類型：

| 分類 | 判斷依據 | 執行策略 |
|------|---------|---------|
| **Bug Fix** | 標題含 bug/fix/error/issue、Asana 標籤 | 單 Agent 快速修復 |
| **小功能** | 描述簡短、無跨模組依賴 | 單 Agent（前端或後端） |
| **大功能** | 描述詳細、涉及多模組、有子任務 | 多 Agent 協作（前+後端） |
| **重構** | 標題含 refactor/optimize | 單 Agent + Review |
| **測試** | 標題含 test/coverage | Testing Agent |

### 2.4 自動執行（可開關）
- 每個分類可獨立勾選是否自動執行
- 自動執行佇列：避免同時跑太多 Agent（可設定並行上限）
- 執行結果回寫 Asana：
  - 完成 → 標記 Asana 任務為完成 + 留言摘要
  - 需要人工 → 留言通知 + 不標記完成
  - 失敗 → 留言錯誤摘要

### 2.5 Spec 文件自動抓取
大功能任務的 Spec 來源策略：
1. **Asana 任務描述**：直接用任務的 notes 作為需求描述
2. **Asana 附件**：自動下載任務附件中的 PDF/文件作為 SA/SD
3. **指定資料夾**：專案設定一個「specs 資料夾路徑」，Agent 自動掃描
4. **自動生成**：如果沒有 spec，Agent 先分析任務需求，自動產生簡易 spec 再執行

---

## 三、任務執行流程（重新設計）

### 3.1 統一執行管線

取消 Spec Mode / Creative Mode / Quick Mode 的區分，改為統一流程：

```
任務進入 → 分類判斷 → 組裝 Context → 生成 Agent → 執行 → 驗證 → 報告
```

#### Step 1: 任務進入
來源：手動建立 / Asana 同步 / 自動排程

#### Step 2: 分類判斷
- 自動分析任務大小和類型
- 決定需要幾個 Agent、什麼角色
- 單一前端或後端任務 → 單 Agent
- 跨前後端任務 → 多 Agent + API Contract 先行

#### Step 3: 組裝 Context
- 載入 workspace CLAUDE.md + skills
- 載入 Superpowers 方法論（標配）
- 載入相關 spec 文件（如有）
- 載入 API contract（如有前後端協作）
- 注入 DB schema（後端任務）

#### Step 4: 生成 Agent 並執行
- 根據分類決定 Agent 配置
- 串流輸出到 Dashboard 終端

#### Step 5: 驗證（下方詳述）

#### Step 6: 報告
- 摘要產生
- 回寫 Asana（如已綁定）

### 3.2 手動建立任務
Dashboard 上仍保留手動建立任務入口：
- 輸入任務描述
- 選擇類型（或讓系統自動判斷）
- 可附加 spec 文件 / 錯誤日誌 / 相關檔案
- 選擇執行策略

### 3.3 前後端 API Contract 協作
當任務涉及前後端時（不論是大功能的多 Agent 協作，或單一任務需要定義介面）：

1. **Contract 先行**：先讓一個 Agent 定義 API 介面（OpenAPI / TypeScript interface）
2. **Contract 同步**：前端用 contract 做 mock，後端用 contract 實作
3. **整合驗證**：雙方完成後，跑一次整合測試確認對接正確
4. **單一端任務也適用**：即使只跑前端 Agent，也可以先產出 contract 供後端團隊參考

---

## 四、驗證系統（新增重點功能）

### 4.1 前端驗證策略

#### E2E 測試（推薦）
- 使用 Playwright / Cypress
- Agent 完成功能後，自動撰寫對應的 E2E 測試
- 執行測試，回報通過/失敗
- **Prompt 策略**：
  ```
  功能完成後，撰寫 E2E 測試驗證：
  1. 正常流程（happy path）
  2. 邊界條件
  3. 錯誤狀態
  使用 Playwright，遵循 Page Object Pattern
  ```

#### 瀏覽器操作驗證（MCP Browser Tool）
- 使用 Playwright MCP 或 Browser Use MCP
- Agent 實際打開瀏覽器、操作頁面、截圖驗證
- 適合 UI 變更的視覺驗證
- **Prompt 策略**：
  ```
  使用 Browser MCP 工具：
  1. 啟動開發伺服器
  2. 打開對應頁面
  3. 執行操作步驟
  4. 截圖確認 UI 正確
  5. 檢查 console 無錯誤
  ```

#### Build 驗證
- `npm run build` / `pnpm build` 必須成功
- TypeScript 編譯無錯誤
- Lint 通過

### 4.2 後端驗證策略

#### 單元/整合測試
- Agent 完成功能後，撰寫對應測試
- 使用專案既有的測試框架（Jest / Vitest / pytest 等）
- **Prompt 策略**：
  ```
  功能完成後，撰寫測試驗證：
  1. 每個新/修改的 API endpoint 的正常和異常情境
  2. Service 層的邏輯測試
  3. 資料庫操作的 CRUD 驗證
  ```

#### 資料庫驗證
- 執行 API 操作後，查詢 DB 確認資料正確
- 使用唯讀 SQL 查詢驗證（SELECT only）
- **安全規則**：嚴禁執行任何 DELETE / DROP / TRUNCATE / ALTER 指令
- **Prompt 策略**：
  ```
  驗證 CRUD 操作（唯讀查詢模式）：
  1. 呼叫 API 建立資料
  2. 用 SELECT 查詢資料庫，確認資料欄位正確
  3. 呼叫 API 更新資料
  4. 用 SELECT 再次查詢確認更新成功
  5. 呼叫 API 刪除
  6. 用 SELECT 確認資料已移除或軟刪除
  ⚠️ 嚴禁直接執行 DELETE / DROP / TRUNCATE / ALTER 等破壞性 SQL
  ```

#### API 測試
- 使用 curl / httpie / 或 Python requests
- 驗證每個 endpoint 的 request/response 格式
- 檢查 HTTP status code、error handling

### 4.3 通用驗證

#### Git Diff Review
- 驗證前先做 `git diff` review
- 確認改動範圍合理（沒有不相關的檔案被修改）
- 確認沒有 debug 程式碼、console.log 殘留

#### Lint / Type Check
- 前後端都跑 lint + type check
- 確保程式碼品質

#### Security Scan（內建於驗證流程）
掃描方式：
1. **Hardcoded Secrets 偵測**：Agent 在驗證階段用 Grep 掃描自己的改動
   - 搜尋 pattern：API key、password、secret、token 等字串
   - 檢查 `.env` 檔案有沒有被意外 commit
   - 掃描新增檔案中是否有 base64 encoded credentials
2. **依賴漏洞掃描**：
   - Node.js：`npm audit` / `pnpm audit`
   - Python：`pip audit` / `safety check`
   - 只在有新增/更新依賴時執行
3. **OWASP 基本檢查**（寫入 Agent prompt）：
   - SQL injection（檢查 raw query 有無參數化）
   - XSS（檢查有無 dangerouslySetInnerHTML 等）
   - CSRF（檢查 API 有無 CSRF 防護）
   - Auth bypass（檢查 middleware 順序）
4. **實作方式**：作為驗證流程的一環，寫在 Agent 的驗證 prompt 中，不需額外工具

### 4.4 驗證失敗處理
- **不自動 rollback**，因為最終由人工驗證
- 驗證失敗時：
  1. Agent 嘗試分析失敗原因
  2. 自動修正並重新驗證（最多重試 2 次）
  3. 仍然失敗 → 標記為 `needs_human`，在 UI 通知使用者
  4. 保留完整的失敗日誌和 Agent 輸出供 debug

### 4.5 驗證結果報告
```
✅ Build 通過
✅ TypeScript 無錯誤
✅ 5/5 測試通過
✅ DB 驗證：CRUD 正確（唯讀查詢）
✅ Security：無 hardcoded secrets
⚠️ Lint warning: 2 個（非阻斷）
📸 UI 截圖已保存
```

---

## 五、Superpowers 標配化

### 5.1 預設啟用
- 所有任務自動載入 Superpowers
- 不再需要使用者手動勾選
- 根據任務類型自動決定方法論組合：

| 任務類型 | 自動啟用的方法論 |
|---------|----------------|
| Bug Fix | Debugging |
| 新功能（大） | Brainstorm + TDD |
| 新功能（小） | TDD |
| 重構 | Brainstorm |
| 測試 | TDD |

### 5.2 設定覆蓋
- 專案層級可以調整預設組合
- 單一任務執行時可以覆蓋

---

## 六、Git 工作流

### 6.1 自動建 Branch
- 每個任務自動建立 branch
- 命名規則：`feature/{task-id}-{slug}` 或 `fix/{task-id}-{slug}`
- 可在專案設定中自訂 branch 命名模板

### 6.2 Commit 策略
- **AI 產出 commit message**：遵循 conventional commits 格式
- **人工決定何時 commit**：Agent 不自動執行 `git commit`
- Agent 完成後，在 UI 上顯示建議的 commit message，使用者確認後才 commit
- 或者使用者直接在終端手動 commit

### 6.3 衝突處理
- 如果 branch 落後 main，通知使用者
- 不自動 rebase/merge，留給人工處理

---

## 七、環境管理

### 7.1 自動偵測
- 分析 `package.json` / `pyproject.toml` / `docker-compose.yml` 偵測：
  - Dev server 啟動指令（`npm run dev` / `python manage.py runserver`）
  - 測試指令（`npm test` / `pytest`）
  - Build 指令（`npm run build`）
  - DB 類型和連線方式

### 7.2 安全限制
- **嚴禁以下 DB 操作**（寫入 Agent 系統 prompt + 工具層攔截）：
  - `DROP TABLE` / `DROP DATABASE`
  - `DELETE FROM` (不帶 WHERE 的全表刪除)
  - `TRUNCATE TABLE`
  - `ALTER TABLE ... DROP COLUMN`
  - 任何影響 schema 的破壞性操作
- **允許的 DB 操作**：
  - SELECT（驗證用）
  - INSERT / UPDATE / DELETE（透過 API 呼叫，非直接 SQL）
  - Migration 工具執行（如 `prisma migrate` / `knex migrate`，需人工確認）

### 7.3 Dev Server 管理
- 前端驗證時自動啟動 dev server
- 驗證完成後自動關閉
- 偵測 port 衝突，自動選用空閒 port

---

## 八、通知系統（UI 內建）

### 8.1 UI 通知中心
Dashboard 右上角通知鈴鐺，顯示：
- 任務完成通知（含摘要）
- 任務失敗告警（含失敗原因）
- 需要人工介入的任務
- Asana 同步結果

### 8.2 通知列表頁
- 所有通知的時間軸
- 可篩選：全部 / 成功 / 失敗 / 需介入
- 點擊通知跳轉到對應任務的 Agent 終端

### 8.3 每日摘要（可選）
- 當日自動執行的所有任務摘要
- 成功/失敗/待處理統計
- 顯示在 Dashboard 首頁

---

## 九、UI 重構

### 9.1 設計系統
使用 [UI UX Pro Max Skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) 指導 UI 設計：
- 配置為 OmniCommander 自己的 `.claude/commands/` skill
- 生成統一的 Design System（色彩、字型、間距、元件風格）
- 所有 UI 元件遵循同一設計語言
- 暗色主題為主（開發工具風格）

### 9.2 新的首頁：專案列表
取代現在的 Setup Wizard，首頁是所有專案的卡片/列表：

```
┌─────────────────────────────────────────────────────────┐
│  AI-OmniCommander                          🔔 通知 (3)  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📁 MyApp                            🟢 2 tasks running │
│     FE: /projects/myapp/web          ✅ CLAUDE.md       │
│     BE: /projects/myapp/server       ✅ CLAUDE.md       │
│     Asana: MyApp Sprint Board        🔄 Last sync: 5m   │
│                                                         │
│  📁 LandingPage                      ⏸ idle             │
│     FE: /projects/landing/src        ❌ No skills       │
│     Asana: (not linked)                                 │
│                                                         │
│  [+ 新增專案]                                            │
└─────────────────────────────────────────────────────────┘
```

### 9.3 專案內頁：任務 Dashboard
點進專案後，左右分欄：

```
┌─ 任務列表 ──────────────────┬─ Agent 終端 ──────────────────┐
│                              │                               │
│  🔴 Bug: Login 500 error    │  [Frontend Agent]             │
│     ↳ Executing...           │  > Reading CLAUDE.md...       │
│                              │  > Analyzing component...     │
│  🟡 Feature: User Profile    │                               │
│     ↳ Queued (2nd)           │  ┌─ 驗證結果 ─────────┐      │
│                              │  │ ✅ Build 通過       │      │
│  ✅ Fix: CSS alignment       │  │ ✅ 3/3 測試通過     │      │
│     ↳ Completed 2h ago       │  │ ⚠️ 1 lint warning  │      │
│                              │  └────────────────────┘      │
│  [+ 手動新增任務]             │                               │
│  [🔄 同步 Asana]             │                               │
└──────────────────────────────┴───────────────────────────────┘
```

### 9.4 專案設定頁
- **基本設定**：名稱、前端/後端資料夾、Asana 綁定
- **Skills 管理**：查看偵測結果 / 重新生成 / 手動編輯 CLAUDE.md
- **自動化規則**：
  - Asana 排程同步（開關 + 頻率）
  - 各類型任務自動執行（開關 per 類型）
  - 並行 Agent 上限
- **驗證設定**：
  - 前端：E2E 框架選擇 / Browser MCP / Build check
  - 後端：測試框架 / DB 驗證 / API 測試
  - 通用：Lint / Type check / Security scan
- **Git 設定**：branch 命名模板、目標 branch
- **環境設定**：Dev server 指令、DB 連線（唯讀驗證用）

---

## 十、Context 品質保障

### 10.1 問題
公司出錢所以費用不是重點，但上下文和 skill 壓縮後能否保持品質才是關鍵。

### 10.2 策略
1. **Skill 精煉**：自動生成的 CLAUDE.md 要精煉、結構化，避免冗長
   - 用條列而非長段落
   - 程式碼範例要精簡有代表性
   - 定期重新分析，移除過時內容
2. **Context 分層載入**：
   - 第一層：CLAUDE.md（必載，專案核心規範）
   - 第二層：相關 skill commands（依任務類型選擇性載入）
   - 第三層：Spec 文件（只在大功能時載入）
   - 第四層：API contract / DB schema（只在需要時載入）
3. **Prompt 模板測試**：
   - 定期用實際任務測試 Agent 是否遵循 skill 規範
   - 如果偏差過大，調整 prompt 結構或 skill 內容
4. **壓縮後驗證**：
   - Agent 執行前，可選擇先做一次「dry run」確認 context 載入正確
   - 驗證 Agent 是否知道專案的命名慣例、目錄結構等基本資訊

---

## 十一、技術實作優先級

### Phase 1: 核心重構
1. 專案 CRUD + 前後端資料夾設定
2. Workspace 自動偵測（CLAUDE.md / .claude/）
3. 首次 Skill 自動生成
4. 統一任務執行管線（取代三種 Mode）
5. Superpowers 標配化
6. UI 重構 — 專案列表 + 任務 Dashboard（使用 UI UX Pro Max Skill）

### Phase 2: Asana 深度整合
7. Asana 專案綁定（一對一）
8. 任務同步（手動 + 定時排程）
9. 任務自動分類引擎
10. 自動執行佇列
11. 結果回寫 Asana

### Phase 3: 驗證系統
12. Build / Lint / Type check 驗證
13. 後端測試驗證 + DB 唯讀查詢驗證
14. 前端 E2E 驗證（Playwright）
15. Browser MCP 視覺驗證
16. Security Scan（hardcoded secrets + 依賴漏洞 + OWASP）
17. 驗證失敗 → 自動重試 → 通知人工

### Phase 4: Git 工作流
18. 自動建 branch
19. AI 產出 commit message（人工確認後 commit）
20. 衝突偵測與通知

### Phase 5: 輔助功能
21. 前後端 API Contract 協作
22. UI 通知中心
23. 環境自動偵測與管理
24. 每日摘要
25. Context 品質監控

---

## 十二、移除 / 簡化的功能

v1 的以下功能在 v2 中不再需要：
- **Spec Mode / Creative Mode / Quick Mode 切換** → 統一管線
- **手動上傳 SA/SD 文件的 wizard** → Asana 自動抓取 + Spec 資料夾
- **Creative Mode 的 Architect 訪談** → 任務描述直接來自 Asana 或手動輸入
- **手動勾選 Superpowers** → 自動標配
- **Code Review Agent 手動開關** → 整合進驗證流程
- **複雜的 mode/step wizard** → 簡潔的專案設定頁

---

## 十三、待確認問題

1. **資料夾數量**：目前設計是固定 Frontend + Backend 兩個，還是要支援更多（例如 mobile、shared library）？
2. **Asana 以外**：未來是否需要支援其他專案管理工具（Jira、Linear、GitHub Issues）？
3. **Git 託管**：是用 GitHub 還是其他平台？影響 PR 相關功能。
4. **驗證環境**：後端 DB 驗證是用開發環境的 DB 嗎？
5. **多人協作**：是否只有一個使用者？
