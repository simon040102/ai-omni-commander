# AI-OmniCommander 功能文件

## 概述

AI-OmniCommander 是一個多 Agent 協作開發系統，透過 WebSocket 連接 React 前端與 Node.js 後端，管理多個 Claude Code CLI 子程序（Agent）同時執行軟體開發任務。

---

## 一、專案模式

### 1. Spec Mode（規格模式）
- 使用者上傳 SA（系統分析）/ SD（系統設計）文件（PDF、文字、Markdown）
- 文件依角色自動路由：Frontend 拿 SA+SD，Backend 只拿 SD
- 文件注入到 workspace 的 `.ai_specs/` 目錄，並在 CLAUDE.md 建立索引
- 每個 workspace 生成一個 Agent，`cwd` 設為 workspace 路徑
- Agent 自動讀取 workspace 的 CLAUDE.md 和 `.claude/` 技能
- 支援 Debug Mode（針對既有 codebase 修改，而非全新建置）

### 2. Creative Mode（創意模式）
- Architect Agent 逐一向使用者提問（一次一題，約 5-10 題）
- 使用者回答後，Agent 生成 SA/SD 文件
- 使用者確認或要求修改
- 確認後進入規劃階段（Master Agent 建立任務計畫）

### 3. Quick Mode（快速模式）
- 單一 Agent 執行聚焦任務
- 任務類型：Bug Fix / Small Change / Refactor / Other
- 選擇 Agent 角色：Backend / Frontend / DevOps / Testing
- 可附帶錯誤日誌和相關檔案路徑
- 可選擇載入 workspace 的 CLAUDE.md 和 `.claude/commands/` 技能

---

## 二、Agent 系統

### Agent 角色

| 角色 | 預設模型 | 職責 | 工具權限 |
|------|---------|------|---------|
| master | opus | 解析 SA/SD、拆解任務 | Read, Glob, Grep |
| architect | opus | 需求訪談、生成規格 | Read |
| backend | sonnet | API、DB、後端邏輯、單元測試 | Read, Edit, Write, Bash, Glob, Grep, Agent |
| frontend | sonnet | React/Tailwind UI、API 串接 | Read, Edit, Write, Bash, Glob, Grep, Agent |
| devops | sonnet | Docker、CI/CD、基礎設施 | Read, Edit, Write, Bash, Glob, Grep, Agent |
| testing | sonnet | 整合測試、QA、自動化 | Read, Edit, Write, Bash, Glob, Grep, Agent |
| review | sonnet | 程式碼審查（唯讀） | Read, Glob, Grep |
| quick | sonnet | 快速任務 | Read, Edit, Write, Bash, Glob, Grep, Agent |

### Agent 生命週期
- 狀態：idle → starting → running → stopped / error
- 透過 `claude --print --output-format stream-json --input-format stream-json` 啟動子程序
- 初始 prompt 透過 stdin 傳送（避免 ARG_MAX 限制）
- 支援透過 stdin 傳送後續指令
- 完成標記：`[TASK_COMPLETE]`、`[NEEDS_HUMAN]`、`[ENTITY_CHANGED]`、`[PLAN_READY]`、`[SPEC_READY]`、`[REVIEW_COMPLETE]`

### Token / 成本追蹤
- 追蹤 input tokens、output tokens、cache read/creation tokens
- 計算 USD 成本
- 統計對話 turn 數
- Dashboard 顯示每個 Agent 的統計

---

## 三、前端 UI 頁面

### 1. Setup（專案設定）
- 四步驟建立精靈：模式選擇 → Workspace 設定 → 文件上傳/訪談/快速任務 → 執行
- Workspace 設定：多個 workspace（label + 絕對路徑）
- Folder Picker：伺服器端目錄瀏覽器 + 最近使用路徑
- 文件上傳：拖放 + 貼上、自動偵測 SA/SD、每檔可切換類型
- 模型選擇：Sonnet / Opus / Haiku
- Superpowers 開關
- Code Review 開關
- Plan Approval 開關
- Debug Mode 開關

### 2. Dashboard（儀表板）
- **Agent 卡片**：按角色分組、顏色標記、運行狀態指示燈
- **多終端檢視**（DualTerminal）：分割視窗顯示多個 Agent 輸出
- **終端功能**：
  - 串流文字輸出
  - Tool use/result 格式化顯示
  - 錯誤訊息紅色標示
  - Markdown 自動渲染（標題、列表、程式碼區塊、粗體、斜體、連結）
  - Thinking blocks 可折疊區塊（黃色標示）
- **操作功能**：
  - 向執行中 Agent 傳送指令
  - Stop / Restart / Pause Agent
  - Focus mode（點擊 Agent 卡片 → 全寬終端）
- **迭代執行面板**：上傳新文件 + 重新執行
- **Plan Panel**：顯示待審核計劃、批准/拒絕
- **Intervention Bell**：人工介入通知

### 3. Active Agents（活躍 Agent）
- 顯示所有專案中正在執行的 Agent
- 按專案分組
- 點擊跳轉到該專案的 Dashboard

### 4. Tasks（任務看板）
- 任務卡片：狀態、優先度、分配 Agent
- 依賴關係視覺化
- 狀態篩選：pending / in_progress / completed / failed

### 5. Events（事件日誌）
- 所有專案事件的時間軸
- Agent 活動、任務轉換等

### 6. Asana 整合頁面
- 瀏覽 Asana 中指派給使用者的任務
- 搜尋篩選（名稱、專案、標籤）
- 檢視任務詳情、留言/故事
- 匯入任務到專案（預填名稱、描述、模式）

### 7. Sidebar
- 專案列表 + 狀態徽章
- 切換專案時載入完整狀態
- 活動指示器（有新輸出時）

### 8. Header
- 專案名稱 + 模式徽章
- 狀態指示器
- WebSocket 連線狀態
- Intervention Bell
- 頁面切換

---

## 四、文件處理系統

### 上傳與儲存
- 儲存於 `data/uploads/{projectId}/`
- SQLite `documents` 表：id, projectId, filename, filePath, fileType, docType, parsedText
- 支援 PDF、TXT、MD、DOCX

### 文件類型
- **SA**（系統分析）：需求、使用案例、使用者故事
- **SD**（系統設計）：架構、API 設計、DB Schema、UI Wireframe

### 路由規則
- Frontend Agent：SA + SD
- Backend Agent：SD only
- 其他角色：SA + SD

### Workspace 注入
- 執行時文件複製到 workspace `.ai_specs/` 目錄
- CLAUDE.md 中建立索引標記：`<!-- AI_SPECS_INDEX -->` ... `<!-- END_AI_SPECS_INDEX -->`
- 迭代執行時合併新舊文件

### PDF 處理
- 檔案路徑寫入 prompt，Agent 用 Claude 的 Read tool 原生讀取

---

## 五、技能系統

### Workspace 技能
- Agent 的 `cwd` 設為 workspace 路徑
- Claude Code 自動載入 `CLAUDE.md` 和 `.claude/` 目錄
- Quick Mode 的 UI 可瀏覽 `.claude/commands/*.md` 技能清單

### Superpowers 方法論

#### Brainstorm（腦力激盪）
- Discovery → Design → Validation 三階段
- 在設計完成前不寫程式

#### TDD（測試驅動開發）
- RED → GREEN → REFACTOR 循環
- 必須先寫失敗測試，再寫最小實作

#### Systematic Debugging（系統化除錯）
- Reproduce → Isolate → Root Cause Analysis → Fix & Verify
- 基於證據，一次只改一個地方

---

## 六、人工介入系統

- Agent 輸出 `[NEEDS_HUMAN]` 時觸發
- UI 顯示 Intervention Bell 通知
- 使用者可：批准繼續 / 傳送指令 / 跳過任務
- 所有介入記錄持久化到 SQLite

---

## 七、計劃審核系統

- Agent 輸出 `[PLAN_READY]` 時暫停
- PlanPanel 顯示待審核計劃（Markdown 格式）
- 使用者批准或拒絕（附回饋）
- 審核歷史記錄

---

## 八、程式碼審查系統

- 任務完成後自動觸發（若啟用）
- 唯讀 Review Agent（只有 Read, Glob, Grep）
- 檢查：正確性、安全漏洞、API 合約一致性、錯誤處理、程式碼風格
- 報告分類：CRITICAL / WARNING / SUGGESTION

---

## 九、迭代執行

- 專案完成後，Dashboard 顯示「New Execution」面板
- 上傳新增/更新的文件
- 合併新舊文件後重新生成 Agent
- 舊 Agent 輸出保留在終端歷史中

---

## 十、動態新增 Agent

- 專案執行中可新增 Agent
- 設定：角色、自定義 Prompt、模型、工作目錄、Workspace 技能、Superpowers
- 用途：新增專家、平行處理、動態擴展

---

## 十一、Asana 整合

- 需要設定 `ASANA_PAT` 環境變數
- 瀏覽指派給使用者的任務
- 搜尋篩選、檢視詳情和留言
- 匯入任務：預填專案名稱、描述、模式
- 任務備註中的 URL 可點擊

---

## 十二、WebSocket 通訊協定

### Client → Server
| 訊息類型 | 用途 |
|---------|------|
| `project.create` | 建立專案 |
| `project.uploadDocument` | 上傳文件 |
| `project.deleteDocument` | 刪除文件 |
| `project.clearDocuments` | 清除舊文件 |
| `project.startExecution` | 開始執行 |
| `project.pause` / `project.resume` | 暫停/恢復 |
| `project.delete` | 刪除專案 |
| `project.update` | 更新專案 |
| `project.getState` | 取得完整狀態 |
| `interview.userResponse` | 訪談回應 |
| `interview.confirmSpec` | 確認規格 |
| `agent.command` | 傳送指令給 Agent |
| `agent.action` | 控制 Agent（stop/restart/pause） |
| `agent.add` | 新增 Agent |
| `agent.delete` | 刪除 Agent |
| `agent.planAction` | 審核計劃 |
| `intervention.resolve` | 回應介入 |
| `asana.*` | Asana 相關操作 |

### Server → Client
| 訊息類型 | 用途 |
|---------|------|
| `projects.list` | 專案列表 |
| `project.state` | 完整專案狀態 |
| `project.documents` | 文件列表 |
| `agent.output` | 串流 Agent 輸出 |
| `agent.statusChange` | Agent 狀態變更 |
| `agent.started` / `agent.completed` | Agent 開始/完成 |
| `agent.initialPrompt` | Agent 初始 prompt |
| `agent.planReady` / `agent.plans` | 計劃相關 |
| `task.statusChange` | 任務狀態變更 |
| `intervention.request` | 介入請求 |
| `interview.*` | 訪談相關 |
| `error` | 錯誤訊息 |

---

## 十三、持久化與資料庫

- SQLite：`data/omni.db`
- 表：projects, agents, tasks, task_dependencies, documents, events, agent_outputs, interventions, agent_plans, recent_paths
- 重啟後完整保留歷史資料

---

## 十四、REST API 端點

| 端點 | 用途 |
|------|------|
| `GET /api/skills?path=...` | 取得 workspace 技能列表 |
| `GET /api/recent-paths?limit=...` | 最近使用的路徑 |
| `POST /api/recent-paths` | 儲存路徑 |
| `GET /api/browse-dir?path=...` | 瀏覽目錄（Folder Picker） |

---

## 十五、技術細節

- Server port：3456（可透過 `PORT` 環境變數設定）
- Vite dev server：5173，proxy `/omni-ws` 和 `/api` 到 server
- Claude CLI 路徑：`CLAUDE_PATH` 環境變數（預設 `claude`）
- stdin prompt：初始 prompt 透過 stdin 傳送，格式 `{"type":"user","content":"..."}`
- EventBus wildcard：`agent.*` 事件直接作為 WS 訊息廣播
- SQLite datetime：`datetime('now')` 回傳 UTC 無 'Z'，前端補上 'Z'
