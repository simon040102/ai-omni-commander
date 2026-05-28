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

### State 5：收集 Axure 原型

自動查找對應的 Axure snapshot：

```bash
ls docs/axure-snapshots/{projectId}/ov01-*.html
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

### State 6：詢問額外文件

```
有沒有要提供額外的文件或資料夾？
（可以貼檔案路徑或資料夾路徑，沒有的話直接說「執行」）
```

使用者可能：
- 提供路徑 → 讀取並加入上下文
- 說「沒有」/「就這樣」→ 進入 State 7
- 說「執行」→ 進入 State 7

### State 7：確認並執行

彙整所有收集到的資訊，讓使用者確認：

```
準備執行：

📋 專案：電子發票
📌 任務：OV01.電子銷項產生_查詢頁 (frontend)
📄 規格文件：
  - SA_OV01.md ✓
  - SD_OV01.pdf ✓
🎨 Axure 原型：ov01-查詢.html, ov01-檢視.html ✓
📁 額外文件：D:\specs\OV01-notes.md ✓
🗂️ Workspace：D:\fork\ofeinvoice_ui

確認執行？
```

使用者說「好」/「執行」/「確認」→ 開始執行。

### State 8：執行

1. `create_task(projectId, title, label, taskType, description, prompt)`
2. `update_task_status(taskId, "in_progress")`
3. Agent tool → 派 subagent

Subagent prompt 組裝：
```
你是 {project.name} 專案的開發 agent。

## Workspace 規範（最優先！開始開發前必須先完成）
1. 用 Read tool 讀取 {workspacePath}/CLAUDE.md — 了解專案架構、命名規範、開發規則
2. 用 Bash 執行 ls {workspacePath}/.claude/skills/ — 列出所有可用 skill
3. 讀取與本次任務相關的 skill（如有 coding-standards、api-patterns、component-guidelines 等）
4. **嚴格遵循 CLAUDE.md 和 skills 裡的所有規則進行開發**

## 任務
{task.title}

## 目標
{任務描述 + 使用者口述內容}

## UI 規格（Axure 原型）
{列出 Axure HTML 檔案路徑，請 subagent 用 Read tool 讀取}

## 技術規格
{SA/SD 文件內容摘要，或檔案路徑}

## 額外參考文件
{使用者提供的文件內容}

## Workspace
cwd: {frontendPath 或 backendPath}

## 進度回報
- 每完成一步：mcp__omni-commander__report_output(taskId="{taskId}", content="...")
- 重要節點：mcp__omni-commander__report_milestone(taskId="{taskId}", content="...")
- 全部完成：mcp__omni-commander__update_task_status(taskId="{taskId}", status="completed", summary="...")
```

4. 回覆使用者：「任務已啟動，可以在 Web UI 的 Agents 頁面看到即時進度。」

---

## 重要原則

1. **不要急著執行** — 每一步都等使用者確認
2. **資訊不完整就問** — 不猜測專案、不猜測任務類型
3. **收集完才執行** — SVN 文件 + Axure + 使用者文件全部到手後才組裝 prompt
4. **prompt 要完整** — subagent 拿到的 prompt 必須包含所有上下文，不能依賴外部知識
5. **回報進度** — 透過 MCP 回報到 Web UI，使用者在終端機和 Web UI 都能追蹤

---

## 快捷指令

使用者也可以跳過對話，直接說完整指令：
```
幫我執行電子發票專案的 OV01 前端查詢頁，SA 在 D:\specs\OV01-SA.md，直接執行
```
→ 跳到 State 4 自動收集，然後直接執行（不需要逐步確認）
