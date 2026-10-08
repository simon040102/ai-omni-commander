---
name: execute-project-task
description: Interactive task execution — user asks about projects, picks a task (from Asana or verbal), AI gathers SVN docs + user files, then executes via subagent when user says go. Trigger when user asks about projects, tasks, or wants to execute development work.
---

# Execute Project Task（互動式任務執行）

多步驟對話式流程。**不要急著執行**，先收集完所有資訊，等使用者說「執行」才跑。

## 對話流程（狀態機）

### State 1：列出專案

使用者問「有哪些專案」「列出專案」等：

```
mcp__omni-commander__list_projects()
```

回覆格式：
```
目前有 N 個專案：
1. **電子發票** — D:\fork\ofeinvoice_ui（FE）/ D:\fork\ofeinvoice（BE）
2. **林同棪** — D:\fork\tylinNew\portal_ui（FE）/ D:\fork\tylinNew\backend（BE）

要看哪個專案的任務？
```

### State 2：列出 Asana 任務

使用者選了專案後，列出該專案的 Asana 任務：

```
mcp__omni-commander__list_pending_tasks({ projectId })
```

如果有 Asana 同步的任務，列出：
```
**電子發票** 的待處理任務：
1. [OV01] 電子銷項產生_AR — 前端查詢頁
2. [SB01] 年度電子發票字軌檔 — 前端 CRUD
3. [IC02] 進項折讓維護 — 前端+後端
...

選一個任務編號，或直接描述你要做什麼。
```

### State 3：確定任務內容

使用者選了任務或口述內容後：

#### 3a. 如果選了 Asana 任務
- 從任務資料取得 `parent_name`（如 `OV01`）→ 功能代碼
- 取得任務標題、描述

#### 3b. 如果口述
- 提取功能代碼（如「OV01 查詢頁」→ `ov01`）
- 確認是前端/後端/全端

### State 4：自動抓取 SVN 文件

用功能代碼自動查找 SVN 規格文件：

```
mcp__omni-commander__get_documents({ projectId, taskId })
```

或根據功能代碼在 SVN 路徑查找：
- 提取 root code（`OV0101` → `OV`）
- 搜尋對應的 SA/SD .docx/.pdf

如果找到文件，告知使用者：
```
已找到以下規格文件：
- SA_OV01_電子銷項產生.docx（已轉 markdown）
- SD_OV01_電子銷項產生.pdf
```

如果缺少必要規格（前端需 SA+SD，後端需 SD），告知使用者並詢問是否提供。
使用者說「跳過」時，必須用 `report_output` 記錄：`[SKIP] 使用者跳過規格檢查：缺少 {缺少的文件類型} 文件`

### State 5：收集 Axure 原型

自動查找對應的 Axure snapshot（使用 OmniCommander 專案的絕對路徑）：

```bash
ls D:/暫存檔/claude\ code/ai-omni-commander-v5/docs/axure-snapshots/{projectId}/{code}-*.html
```

如果有，告知：
```
找到 Axure 原型頁面：
- ov01-電子銷項產生_AR-查詢.html
- ov01-電子銷項產生_AR-檢視.html
- ov01-電子銷項產生_AR-編輯.html
```

如果沒有：
```
此功能尚未爬取 Axure 原型。要先爬取嗎？
```

### State 6：確認資訊並詢問額外文件

彙整所有收集到的資訊，同時詢問是否有額外文件：

```
準備執行：

專案：電子發票
任務：OV01.電子銷項產生_查詢頁 (frontend)
規格文件：
  - SA_OV01.md
  - SD_OV01.pdf
Axure 原型：ov01-查詢.html, ov01-檢視.html
Workspace：D:\fork\ofeinvoice_ui

有額外文件要提供嗎？沒有的話說「執行」。
```

使用者可能：
- 提供路徑 → 讀取並加入上下文，再次顯示更新後的摘要
- 說「執行」/「好」/「確認」→ 進入 State 7

### State 7：執行

根據任務來源決定流程：
- **Asana 已存在的任務**（已有 taskId）→ 直接用現有 taskId
- **使用者口述的新任務**（沒有 taskId）→ 先 `create_task(projectId, title, label, taskType, description)`，用回傳的 taskId

1. **`get_execution_plan(taskId)`**（fullstack 任務用 `role="frontend"`／`role="backend"` 各取一份）——**不可跳過**：
   plan 裡已自動注入規格文件路徑、規格裁決、專案經驗筆記、專案額外指令、單元測試／驗收／規格回對規範與狀態回報指示，
   bug／feature／refactor 也帶了對應的 Superpowers 方法論；而且沒有取過 plan 的開發任務，結案時會被「執行計畫閘」擋下。
2. `update_task_status(taskId, "in_progress")`
3. Agent tool 派 subagent，cwd＝plan 回傳的 workingDir，模型照 plan 回傳的 model（規則見 CLAUDE.md「派工模型政策」）。prompt＝**plan 回傳的 prompt 原文**，前面再加：
   - CLAUDE.md「#3 讀取 Workspace 規範」那四步（plan 只寫了一句「檢查有無 CLAUDE.md」，這四步比較完整）
   - taskType 是 other 時，plan 不帶方法論段——照 CLAUDE.md「#1 注入 Superpowers 方法論」補上 /verification-before-completion
   - State 6 使用者額外提供的文件——**只放完整路徑**，讓 subagent 自己用 Read tool 讀；**嚴禁把規格內容摘要進 prompt**（摘要會打錯字、漏細節，subagent 會照錯的做）
   - **不要**再手動加專案額外指令（plan 已注入，重複會出現兩次）
4. 回覆使用者：「任務已啟動。」任務狀態、新開的規格缺口、檢查表會即時反映在 Web UI；subagent 用 report_output 回報的文字內容用 get_task_outputs(taskId)／resume_task(taskId) 查看。

---

## 重要原則

1. **不要急著執行** — 每一步都等使用者確認
2. **資訊不完整就問** — 不猜測專案、不猜測任務類型
3. **收集完才執行** — SVN 文件 + Axure + 使用者文件全部到手後才派工
4. **prompt 以 get_execution_plan 為準** — 不要自己重組；只在前面補 Workspace 規範與使用者額外文件的路徑
5. **回報進度** — subagent 透過 MCP 回報；狀態與規格缺口在 Web UI 看得到，回報全文用 get_task_outputs 查

---

## 快捷指令

使用者也可以跳過對話，直接說完整指令：
```
幫我執行電子發票專案的 OV01 前端查詢頁，SA 在 D:\specs\OV01-SA.md，直接執行
```
→ 跳到 State 4 自動收集，然後直接執行（不需要逐步確認）
