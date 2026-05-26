---
name: crawl-axure-snapshots
description: Two-phase Axure crawler — Phase 1 script extracts coordinate JSON, Phase 2 AI generates styled HTML with mock CSS classes. Use when crawling Axure Share prototype pages.
---

# Crawl Axure Share Snapshots

## 兩段式流程

### Phase 1：腳本批次提取座標資料

```bash
node docs/axure-snapshots/crawl-axure.mjs <axure_url> <output_dir>
```

- 取得 sitemap 階層，提取功能代碼（`SM01_系統代碼維護` → `sm01`）
- 逐頁用 `getBoundingClientRect()` 提取可見元素的 y/x 座標
- **不做任何專案特定過濾**，所有可見元素都抓取，過濾交給 Phase 2 AI
- 存為 `_data/{moduleCode}-{pageType}.json`
- **輸出格式是 rows（行群組）**，y 值差 < 15px 的元素歸為同一行：
  ```json
  { "page": {...}, "items": [
    { "y": 191, "items": [{"type":"section-title", "text":"查詢作業", "x":267, "w":1613, "h":22}] },
    { "y": 707, "items": [{"type":"table-cell","text":"0095"}, {"type":"table-cell","text":"吳志榮"}, {"type":"btn-primary","text":"計畫工程師"}] }
  ]}
  ```
- 每行內 items 按 x 排序（左到右）
- `type` 值：`text`, `label`, `input-label`, `select-label`, `input`, `select`, `checkbox`, `radio`, `checkbox-label`, `radio-label`, `btn-primary`, `btn-secondary`, `section-title`, `heading`, `table-cell`, `menu-item`, `image`
- 支援斷點續爬、page crash 自動恢復

### Phase 2：AI subagent 生成語意 HTML

用 Agent tool 派 subagent，每次處理一個模組。用 MCP `report_output` / `report_milestone` 回報進度。

---

## Phase 2 AI Prompt 規則（必須嚴格遵守）

### 過濾（不輸出到 HTML）
- 包含「登入者」的文字
- 「Close」（section-title 或完全匹配）
- 「個人資料維護」
- breadcrumb（以 `/ ` 開頭）
- 日期格式（如 `2026.03.17`）
- Action ID（單一大寫字母+數字，如 `A1`、`B2`）

### 頁面結構
- 第一個有效 label → `<div class="title-menu"><h1 class="legend">頁面標題</h1></div>`
- `type=section-title`（非 Close）→ `<div class="form-box"><div class="form-title">標題</div>`
- 獨立 label 且下方不接 inputs → `<h3 class="legend">子標題</h3>`

### 表單欄位配對
- y 差 < 15px = 同一行
- labels 行 + 下一行 inputs → 按 x 近似配對
- **欄數由同行的 label 數量決定**：
  - 1 個 → `col-md-12`
  - 2 個 → `col-md-6`
  - 3 個 → `col-md-4`
  - 4 個 → `col-md-3`
- label 有 `*` → `<span class="asterisk">欄位名</span>`（去掉 `*`）
- **`<label>` 不加 class** — mock CSS 用 `.form-item label` 做浮動效果，加 `class="form-label"` 會破壞
- 檢視頁的 input 加 `readonly`

```html
<div class="form-group row">
  <div class="col-md-6 form-item">
    <label><span class="asterisk">角色代碼</span></label>
    <input type="text" class="form-control" value="關鍵字查詢">
  </div>
  <div class="col-md-6 form-item">
    <label><span>角色名稱</span></label>
    <input type="text" class="form-control">
  </div>
</div>
```

### 查詢/清除按鈕
```html
<div class="btn-box">
  <button class="btn btn-primary">查詢</button>
  <button class="btn btn-outline-primary">清除</button>
</div>
```

### 新增/刪除按鈕 + 分頁設定（同一 row，左右並排）
查詢按鈕下方、表格上方，通常有「新增」「刪除」按鈕（x 小 = 左邊）和分頁設定（x 大 = 右邊）：
```html
<div class="row">
  <div class="col-sm-4 tb-btn-group">
    <button class="btn btn-primary">新增</button>
    <button class="btn btn-primary">刪除</button>
  </div>
  <div class="col-sm-8 pager-setting">
    共 5 筆，<span class="pen">每頁顯示
      <select class="chzn-select"><option>5</option><option selected>200</option></select>
      筆/</span>第
    <select class="chzn-select"><option selected>1</option><option>2</option></select>
    頁
  </div>
</div>
```
**判斷方式：** JSON 中 `共 N 筆，每頁顯示` label + 小型 numeric select（w < 80）+ `筆 / 第` + `頁` = 分頁設定。同 y 的 btn-primary（如新增/刪除）放左邊。

### 表格
- **判斷方式**：一個 row 裡有 3+ 個 `table-cell` type → 這是表頭行
- 後續 rows 如果也有多個 `table-cell` → 這是 data rows，全部收入 `<tbody>`
- **同一 row 裡的 btn-primary 也屬於表格**（如「計畫工程師」按鈕在 data row 裡）→ 放進 `<td>`
- 檢視/編輯欄位在 thead 保留文字，tbody 用 **CSS icon class**（不用 emoji）：
  - 檢視 → `<a class="tabeIcon iconView" title="檢視"></a>`（sprite position: 0 -45px）
  - 編輯 → `<a class="tabeIcon iconEdit" title="編輯"></a>`（sprite position: 0 0px）
  - 刪除 → `<a class="tabeIcon iconDelete" title="刪除"></a>`（sprite position: 0 -135px）
  - **注意：iconView 和 iconEdit 是不同的 class，不要搞混！title 要跟 class 對應**
- icon 文字（👁️‍🗨️、✏️）不當 data，用 CSS class 替代
- **checkbox 在 row 裡且表格有 checkbox 欄** → 放進 `<td><input type="checkbox">`

### 分頁導航（頁碼）
表格下方的 `type=tab` 元素（文字是 1,2,3,>,>> 等）：
```html
<nav class="pager">
  <ul class="pagination">
    <li class="page-item"><a class="page-link">1</a></li>
    <li class="page-item"><a class="page-link">2</a></li>
    <li class="page-item"><a class="page-link">&gt;</a></li>
    <li class="page-item"><a class="page-link">&gt;&gt;</a></li>
  </ul>
</nav>
```

### Checkbox/Radio
- label 下面接 checkbox-label → `<div class="form-group">`
- label 用 `<label class="form-label fw-bold">`（**不要放在 `form-item` 裡**，會被 CSS absolute positioning 蓋掉）
- checkbox 用 `<div class="form-check form-check-inline">`

```html
<div class="form-group">
  <label class="form-label fw-bold">申請身份 *</label>
  <div class="form-check form-check-inline">
    <input class="form-check-input" type="checkbox" checked>
    <label class="form-check-label">文書組</label>
  </div>
  <div class="form-check form-check-inline">
    <input class="form-check-input" type="checkbox" checked>
    <label class="form-check-label">資訊部</label>
  </div>
</div>
```

### 下拉選單
- `type=select` → `<select class="form-select">` + `<option>`
- 分頁用的小 select（全數字選項、w < 80）→ 放進 pager-setting，不當一般表單欄位

---

## HTML 模板

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{page.name}</title>
  <link rel="stylesheet" href="../style.min.css">
  <style>
    .tabeIcon::before{background-image:url(../images/icon.svg)!important;}
    .main-content-box{margin-left:0!important;max-width:100%!important;width:100%!important;}
    .form-item label{position:relative!important;transform:none!important;font-size:13px!important;color:#888!important;margin-bottom:2px!important;}
  </style>
</head>
<body>
  <div id="root">
    <main role="main" class="container-fluid">
      <div class="row">
        <div id="content-box" class="main-content-box">
          <div class="by-component">
            {content}
          </div>
        </div>
      </div>
    </main>
  </div>
</body>
</html>
```

- CSS 路徑用 `../style.min.css`（相對路徑），本機瀏覽器可直接開
- Server API 會自動 rewrite 為 `/api/mockup-assets/style.min.css`
- **必須加 inline `<style>` 覆寫 icon sprite 路徑**（解決 iframe 載入問題）：
```html
<style>
  .tabeIcon::before { background-image: url(../images/icon.svg) !important; }
</style>
```

---

## 靜態資源

```
docs/axure-snapshots/
├── style.min.css          ← 從 portal_ui/mock/css/ 複製（images 路徑已修正為 images/）
├── images/                ← 從 portal_ui/mock/images/ 複製（含 icon.svg sprite）
├── crawl-axure.mjs        ← Phase 1 腳本
└── {projectId}/
    ├── _data/             ← Phase 1 JSON 輸出
    │   ├── sm01-查詢.json
    │   └── ...
    ├── _sitemap.json
    ├── sm01-查詢.html     ← Phase 2 HTML 輸出
    └── ...
```

---

## 命名慣例

```
{moduleCode}-{pageType}.html
```

- `moduleCode` = sitemap 父節點功能代碼小寫（`sm01`, `dm04`, `df01`）
- `pageType` = 頁面名稱去掉模組前綴（`查詢`, `新增`, `修改(新增跳窗)`）
- Web UI 用 `moduleCode` 前綴做群組分類顯示
- 無代碼頁面用 `misc`

---

## MCP 進度回報

Phase 2 處理時，使用 OmniCommander MCP 回報：
- `report_output(taskId, "[ok] sm01-查詢.html")` — 每完成一頁
- `report_milestone(taskId, "SM01 完成 (5/5)")` — 每完成一個模組
- `update_task_status(taskId, "completed")` — 全部完成

---

## 瀏覽器卡住處理

- Phase 1 腳本內建：page crash → 自動重建 page，累計 3 次停止
- Phase 2 不需瀏覽器
