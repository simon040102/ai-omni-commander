---
name: generate-invoice-page
description: Use when generating React pages for the ofeinvoice_ui project from Axure snapshot specs. Covers snapshot interpretation, component mapping, API naming, layout rules, and special page patterns (query/manage/import/modal/multi-tab).
---

# 生成發票平台 React 頁面

## 使用情境

當需要開發 `ofeinvoice_ui` 專案中某個功能的前端頁面，且已有：
1. Axure prototype 的 snapshot（`.md` 格式，存放於 `docs/axure-snapshots/`）
2. 功能代號（如 `SB01`、`OV01`）

## 如何讀懂 Axure Snapshot

Snapshot 是 accessibility tree 格式的 YAML（存放於 `docs/axure-snapshots/`），**已去除 Axure header/nav chrome**，直接從主內容開始：

```yaml
- generic [active] [ref=f5e1]:   ← 主內容根節點
  - generic:
    - paragraph: 查詢作業         ← 頁面標題
    - paragraph: 所屬年度 *       ← 欄位 label（* = 必填）
    - combobox:                   ← 下拉選單
```

對應到 UI 元素如下：

| Snapshot 元素 | 意義 |
|---|---|
| `paragraph: "XXX"` | 欄位 label 或文字 |
| `textbox` | `<input>` 文字輸入框 |
| `combobox` with `option` | `<select>` 下拉選單，`[selected]` 為預設值 |
| `checkbox` | checkbox 勾選框 |
| `button "XXX"` | 按鈕 |
| 按鈕旁的 `generic: "A1"` | Axure action ID，用來識別按鈕功能 |
| `textbox: "精準搜尋"` | placeholder 提示為精準搜尋（完全符合） |
| `textbox: "關鍵字搜尋"` | placeholder 提示為模糊搜尋 |
| `*` 在 label 後 | 必填欄位 |

### Action ID 判讀方式

Action ID（`generic: "A1"`、`"B1"` 等）的意義**由周圍的 `paragraph` 文字決定**，不是固定規則：

```yaml
- generic:
  - paragraph: 查詢      ← 這個 paragraph 才是按鈕名稱
  - generic: A1          ← A1 只是 Axure 的編號，本身沒有語意
```

**判讀方式：** 找 ID 旁邊的 `paragraph` 文字，那就是按鈕的功能。
不要靠 ID 猜功能，要靠文字確認。

### 按鈕置底判斷

Snapshot 不含 CSS 定位，但可從**頁面類型**和**按鈕在 tree 中的位置**推斷：

| 情況 | 使用方式 |
|---|---|
| 詳細頁（新增/編輯/檢視） | `<FloatBtnBox>` 置底（固定專案慣例） |
| 匯入頁 | `<FloatBtnBox>` 置底 |
| 查詢頁的查詢/清除按鈕 | inline，放在 `<div className="btn-box">` 裡 |
| 查詢頁的新增/刪除按鈕 | 表格上方 `<div className="tb-btn-group">` |

輔助線索：按鈕群出現在 **tree 末尾（所有欄位之後）** → 置底；夾在欄位中間 → inline。

## 專案元件對照

> 路徑：`D:/fork/ofeinvoice_ui/src/`

| 功能需求 | 使用元件 |
|---|---|
| 文字輸入欄位 | `<InputController>` |
| 數字輸入欄位 | `<NumberController>` |
| 下拉選單（含全部選項） | `<SelectController isQuery>` |
| 下拉選單（必填，無全部） | `<SelectController required>` |
| 檔案上傳 | `<FileController>` |
| 浮動按鈕區（詳細頁底部） | `<FloatBtnBox>` |
| 頁面標題 + breadcrumb | `<PageTitle>` |
| 分頁範圍顯示 | `<PageRange>` |
| 分頁選擇器 | `<PageSelector>` |
| 權限控制包裝 | `<Authorize useQuery>` / `<Authorize useAdd>` 等 |
| 確認 Modal | `<ConfirmModal>` |
| 訊息 Modal | `<MessageModal>` |
| 匯入結果 Modal | `<ImportResultModal>` |

## 常用 Hooks & Utils

```typescript
import useApi from '../../../hooks/useApi';
// onQueryAPI, onGetAPI, onCreateAPI, onUpdateAPI, onDeleteAPI, onUploadFileAPI

import usePage from '../../../hooks/usePage';
// locationState, changeToPage, returnPage

import { loadCodeData, getCodeDataValue } from '../../../utils/codeDataUtils';
// 載入代碼資料（期數、發票格式等）

import { getBreadcrumb } from '../../../utils/breadcrumbUtils';
// getBreadcrumb('SB01', 'query' | 'create' | 'update' | 'view' | 'import')

import { currentMGYear, currentPeriod } from '../../../utils/invoiceUtils';
// 預設年度和期數

import { momentFormat } from '../../../utils/dateUtils';
// momentFormat(value, 'datetime')
```

## API 命名規則

- 查詢列表：`POST /main/{模組小寫}/search`
- 單筆查詢：`GET /main/{模組小寫}/{uuid}`
- 新增：`POST /main/{模組小寫}`
- 修改：`PUT /main/{模組小寫}`
- 刪除：`DELETE /main/{模組小寫}` (body: `{ uuids: [...] }`)
- 匯入：`POST /main/{模組小寫}/import`
- 取得年度清單：`GET /main/{模組小寫}/getYearList`

範例（SB01）：`/main/sb01/search`、`/main/sb01`、`/main/sb01/import`

## 頁面類型與檔案結構

### 類型一：查詢列表頁 (`Index.tsx`)

```
功能：查詢條件 + 結果表格 + 操作按鈕
對應 snapshot：XXX-查詢.md
```

**標準結構：**
```tsx
const Index = () => {
  // 1. State: queryForm, result, selectList, showConfirmModal, showMessageModal
  // 2. useEffect: 初始化 CodeData + API (getYearList)
  // 3. onSubmit → onSearch
  // 4. onAdd → changeToPage
  // 5. onDelete → onDeleteAPI
  // 6. ResultTable 子元件（內含表格 + 分頁 + 操作按鈕）

  return (
    <Fragment>
      <PageTitle />
      <Authorize useQuery>
        <div className="form-box">
          <div className="form-title">查詢作業</div>
          <form>
            {/* 查詢欄位 */}
            {/* 查詢/清除按鈕 */}
            <ResultTable ... />
          </form>
        </div>
      </Authorize>
      {/* ConfirmModal + MessageModal */}
    </Fragment>
  );
};
```

**ResultTable 子元件包含：**
- `<Row>` 左側：新增、刪除、匯入按鈕（各包 `<Authorize>`）
- `<Row>` 右側：`<PageRange>`
- `<table>` with `<thead>` / `<tbody>`
- 每列有 checkbox + 檢視/編輯按鈕 + 各欄位資料
- `<PageSelector>`

### 類型二：新增/編輯/檢視頁 (`XXXManage.tsx` 或 `Manage.tsx`)

```
功能：詳細資料表單
對應 snapshot：XXX-新增.md、XXX-編輯.md、XXX-檢視.md（通常共用一個元件）
```

**標準結構：**
```tsx
const Manage = () => {
  const { data, type, queryForm, ... } = locationState;
  // type: '新增' | '編輯' | '檢視'

  return (
    <Fragment>
      <PageTitle />
      <div className="form-box">
        <div className="form-title">詳細資料</div>
        <form>
          {/* 欄位（依 type 判斷 readOnly / disabled / required） */}
          <FloatBtnBox>
            {type !== '檢視' && <Button type="submit">儲存</Button>}
            <Button onClick={goBackHandler}>返回</Button>
          </FloatBtnBox>
        </form>
      </div>
      <MessageModal ... />
    </Fragment>
  );
};
```

**欄位規則：**
- 檢視模式：所有欄位 `readOnly` 或 `disabled`，只顯示返回按鈕
- 新增/編輯：欄位可編輯，顯示儲存 + 返回
- 必填（`*`）→ `required={type !== '檢視'}`

### 類型三：匯入頁 (`ImportPage.tsx`)

```
對應 snapshot：XXX-匯入.md
```

**標準結構：**
```tsx
// 注意事項 alert
// 範例下載 + 範例說明 按鈕
// FileController（上傳）
// ResultTable（匯入結果，最新10筆）
// FloatBtnBox: 匯入結果查詢 + 匯入 + 返回
```

## 步驟：從 Snapshot 生成頁面

### Step 1：讀取 snapshot

```bash
# 查詢頁
Read docs/axure-snapshots/{模組}-查詢.md

# 詳細頁（有的話）
Read docs/axure-snapshots/{模組}-新增.md
Read docs/axure-snapshots/{模組}-檢視.md
```

### Step 2：解析 UI 結構

從 snapshot 提取：
1. **查詢欄位**：找 `paragraph` (label) + 對應的 `textbox`/`combobox`
2. **表格欄位**：找 result list 中的 `paragraph` 欄位名
3. **按鈕**：找 action ID (A1, B1, D1...)
4. **下拉選項**：`combobox` 的 `option` 列表
5. **必填標記**：label 中含 `*`

### Step 3：對照現有程式碼

參考同模組或相近模組的現有實作：
- `D:/fork/ofeinvoice_ui/src/container/SB/SB01/Index.tsx`（標準查詢+匯入）
- `D:/fork/ofeinvoice_ui/src/container/SB/SB01/SB01Manage.tsx`（標準 CRUD）

### Step 4：確認 CodeData 代碼

常見代碼名稱（傳入 `loadCodeData`）：
- `INV_PERIOD` → 發票期數（1-2月...11-12月）
- `INV_FORMAT` → 發票格式（35/37）
- `INV_CLASS` → 發票類別/字軌種類（07/08）
- `UPLOADSTATUS` → 上傳狀態
- `UPLOADRESULT` → 上傳結果

### Step 5：生成程式碼

按照現有 pattern 生成，注意：
- `form-box` / `form-title` / `form-group` CSS class 必須保留
- `gv_tab_sc` 為表格外層 class
- `tb-btn-group` 為表格操作按鈕區 class
- `btn-box` 為查詢按鈕區 class
- `pager-setting` 為分頁設定區 class

## 版面排列規則（md prop）

欄位的 `md` prop 決定 Bootstrap grid 寬度。格式為 2 位數字串：

```
md="24"  → label 欄 col-md-2 + input 欄 col-md-4 = 共 6 columns（半行寬）
md="210" → label 欄 col-md-2 + input 欄 col-md-10 = 共 12 columns（整行寬）
```

**標準排列（查詢頁 / 詳細頁）：**
- 每個 `<Form.Group as={Row} className="form-group">` 為一橫列
- 每列放 **2 個** `md="24"` 欄位（6 + 6 = 12 columns，兩欄並排）
- 若某列只有 1 個欄位，仍使用 `md="24"`（靠左半行）

**對照 Axure snapshot 決定分組：**
- snapshot 中同一視覺「行」的欄位 → 放進同一個 `Form.Group`
- snapshot 每行通常 2 個欄位（左右並排）→ 2 個 `md="24"` per Form.Group
- 特寬欄位（如 textarea、備註）→ `md="210"` 獨立一行

**範例：Axure 顯示 4 個欄位（2 列 × 2 欄）→ 2 個 Form.Group：**
```tsx
<Form.Group as={Row} className="form-group">
  <SelectController md="24" label="所屬年度" ... />
  <SelectController md="24" label="期數" ... />
</Form.Group>
<Form.Group as={Row} className="form-group">
  <InputController md="24" label="字軌" ... />
  <SelectController md="24" label="發票格式" ... />
</Form.Group>
```

## 範例：SB01 查詢頁查詢條件 → 程式碼對照

**Snapshot：**
```yaml
paragraph: 所屬年度 *      → SelectController label="所屬年度" required
combobox: 113/114/115       → 動態 yearList（從 API 取得）
paragraph: 期數             → SelectController label="期數" isQuery
combobox: 全部/1-2月/...    → codeDataList={periodList}
paragraph: 字軌             → InputController label="字軌" (validate: /^[A-Z]{2}$/)
paragraph: 發票格式         → SelectController label="發票格式" isQuery
combobox: 全部/35.../37...  → formatList
paragraph: 字軌種類         → SelectController label="字軌種類" isQuery
combobox: 全部/07.../08...  → classList
```

**生成結果：**
```tsx
<SelectController md="24" label="所屬年度" name="invoiceYear" required methods={methods}>
  {yearList.map((item: any) => (
    <option key={item} value={item}>{item}</option>
  ))}
</SelectController>
<SelectController md="24" label="期數" name="invoicePeriodNo" isQuery methods={methods} codeDataList={periodList} />
<InputController md="24" label="字軌" name="invoiceTrack" methods={methods}
  rules={{ validate: { check: (v) => v && !/^[A-Z]{2}$/.test(v) ? '字軌格式錯誤' : undefined } }}
/>
<SelectController md="24" label="發票格式" name="invoiceFormat" isQuery methods={methods}>
  {formatList.map(item => <option key={item.no} value={item.no}>{item.value1}</option>)}
</SelectController>
<SelectController md="24" label="字軌種類" name="invoiceType" isQuery methods={methods}>
  {classList.map(item => <option key={item.no} value={item.no}>{item.value1}</option>)}
</SelectController>
```

## 特殊情況

### 查詢頁沒有新增/刪除按鈕
SB02、SB03、SB07、SB09、SB10 查詢頁只有查詢功能，無 checkbox 和操作按鈕。

### 「新增&修改」合一頁
SB05、SB09、SB10 的 Axure 把新增和修改標示為同一頁（`-新增&修改`），對應程式碼為同一個 `Manage.tsx`，用 `type` 區分。

### 多步驟 Tab 頁（SB07）
SB07 詳細頁為多 Tab：步驟1~6（一般設定/銷項設定/進項設定/申報設定/通知設定/發票簿冊），各 Tab 為獨立元件放在 `Tab/` 子目錄。

### 彈窗（Modal）
部分操作（SB04 配號、SB08 簿冊、SB09 新增年度）使用 Modal 而非跳頁。Modal 元件放在同目錄。

### 營業人統編 Picker（SB06、SB07、SB08、SB09、SB10）
多個模組有 `textbox: 70789607（茂林光電科技股份有限公司）` + search icon + Authorize 按鈕。這是一個複合元件（統編輸入框 + 搜尋）：
```tsx
<div className="input-group">
  <InputController label="營業人統編" name="taxId" required methods={methods} />
  <Button variant="outline-secondary" onClick={onSearchCompany}>
    <SearchIcon />
  </Button>
</div>
```
通常搭配 company picker modal 或 autocomplete。

### SB08 複雜查詢（多維篩選）
SB08 有 BU、所屬年度、期數、發票簿類別、是否外部轉入、簿冊別、使用群組共 7 個查詢條件，表格欄位 13 個。善用 snapshot 中的 `combobox option` 列表確認所有選項。

### SB09 開關帳（12月份 × 3欄矩陣）
SB09 詳細頁是 12 個月 × 3 欄（銷項/進項/是否已申報）的矩陣表單，搭配提醒文字說明開關帳條件。用 table 或 grid 佈局，而非標準 Form.Group。

### SB10 不合邏輯統編（多個文字輸入）
SB10 詳細頁有約 20 個統編輸入框（分 5 列 × 4 欄），建議用陣列 state 管理：`unlogicTaxIds: string[]`。

## SB 模組快速對照

| 模組 | 頁面 | 特殊說明 |
|------|------|---------|
| SB01 | 查詢、新增、檢視、匯入 | 標準 CRUD + 匯入 |
| SB02 | 查詢、編輯、檢視 | 無新增刪除，僅編輯 |
| SB03 | 查詢（+ 匯入客服用、檢視） | 查詢無操作按鈕 |
| SB04 | 查詢、配號設定 | 配號用 Modal，分有下層/單一公司 |
| SB05 | 查詢、新增修改、檢視 | 有 `新增&修改` 合一頁 |
| SB06 | 查詢、新增、修改、檢視 | 含 AR Type/ARCM Type/名單設定 |
| SB07 | 查詢、詳細（多 Tab） | 6個Tab，統編Picker，無新增刪除 |
| SB08 | 查詢 | 7個查詢條件，13欄表格，統編Picker |
| SB09 | 查詢、新增修改 | 12月×3欄矩陣，新增年度用Modal |
| SB10 | 查詢、新增修改 | ~20個統編輸入框，陣列管理 |

## 輸出目標路徑

```
D:/fork/ofeinvoice_ui/src/container/{模組}/{功能代號}/
├── Index.tsx          ← 查詢列表
├── Manage.tsx         ← 新增/編輯/檢視（或 {功能代號}Manage.tsx）
└── ImportPage.tsx     ← 匯入（如有）
```
