---
name: crawl-axure-snapshots
description: Use when crawling Axure Share prototype pages to capture clean HTML snapshots for use as UI specs. Covers URL navigation, hiding chrome elements, handling pages with & in names, and saving stripped HTML.
---

# Crawl Axure Share Snapshots

## Overview

使用 Playwright MCP 爬取 Axure Share 原型頁面，透過 5 個 JS 步驟（座標分析）手寫語意 HTML，供 agent 解讀 UI 規格。**全程不需要截圖。**

**核心做法：JS 座標分析（不是 DOM 擷取，不是截圖）**
- Axure 用絕對定位，DOM 順序 ≠ 視覺順序 → 用 `getBoundingClientRect()` 取得真實 x/y 位置
- Step 1：`<p>` 標籤 → 欄位清單（依 y 排序）
- Step 2：同行欄位的 x 座標 → 判斷左欄/右欄
- Step 3：`input/select/textarea` → 輸入類型、選項、預設值
- Step 3.5：大型自訂元件（WYSIWYG editor、file widget）→ 用高度過濾偵測，不需截圖
- Step 4：按鈕清單驗證

**為什麼不用 accessibility tree：**
- Axure 很多元素只是 `generic [ref=xxx]`，版面位置和群組關係完全丟失
- JS 座標資料更精確，且 token 極低

---

## URL 規則

### 優先：直接 .html URL（推薦）

```
https://{share_id}.axshare.com/{encoded_page_name}.html
```

**優點：**
- 無 Axure shell（無 sidebar/toolbar/iframe），頁面直接渲染
- `fullPage: true` 截圖可完整拿到全部內容，不需要 resize
- 速度快，結構乾淨

**範例：**
```
https://r56y9h.axshare.com/%E7%B0%BD%E5%91%88_%E6%96%B0%E5%A2%9E.html
```

頁面名稱直接 URL-encode（中文、底線、連字符都直接 encode）。

---

### 備用：Shell URL（`?id=xxx&p=xxx`）

直接 `.html` URL 不可用時（如 404）才改用 shell URL：

```
https://{share_id}.axshare.com/?id=null&p={encoded_page_name}
```

- `id=null` 讓 Axure 自動 redirect 到正確頁面 ID
- Shell URL 的內容在 `iframe#mainFrame` 內，需要 `browser_resize 1440x6000` 才能看到完整內容

**頁面名稱含 `&` 時：**
- `id=null` 會失效，必須用真實 page ID
- 頁面名稱中的 `&` 換成 `_`（底線），不用 `%26`

---

## 取得頁面 ID（含 & 頁面必備）

用 `browser_evaluate` 執行：

```javascript
() => {
  const findPage = (arr, keyword) => {
    for (const n of arr) {
      if (n.pageName?.includes(keyword))
        return JSON.stringify({ id: n.id, url: n.url, name: n.pageName });
      if (n.children) {
        const r = findPage(n.children, keyword);
        if (r) return r;
      }
    }
    return null;
  };
  return findPage(window.$axure.document.sitemap.rootNodes, 'SB05');
}
```

---

## 隱藏 Chrome 元素

導航到頁面後，在 `browser_evaluate` 執行以下 JS 隱藏 header/nav：

```javascript
() => {
  // 1. 隱藏 Axure Share 外殼的 sidebar（在父頁面，非 iframe 內）
  ['#sitemapContainer', '#sitemapHeader', '#menuSlideContainer',
   '#toolbar', '#toolbarContainer', '.axure-toolbar', '.pageNav'
  ].forEach(sel => {
    document.querySelectorAll(sel).forEach(el => el.style.display = 'none');
  });

  // 2. 隱藏 iframe 內的 header/nav chrome
  const doc = document.querySelector('iframe#mainFrame')?.contentDocument;
  const base = doc?.querySelector('#base') || document.querySelector('#base');
  [...(base?.children || [])].forEach(el => {
    const text = el.innerText || '', cls = el.className || '';
    if (
      text.includes('登入者') ||
      text.includes('發票平台') ||
      (text.includes('Close') && text.includes('首頁')) ||
      text.includes('個人資料維護') ||
      ((cls.includes('_形状') || cls.includes('box_1')) && !text.trim()) ||
      // 系統選單 nav（含「首頁」「個人設定區」等系統層級項目）
      (text.includes('首頁') && text.includes('個人設定區'))
    ) el.style.display = 'none';
  });
}
```

- Axure Share sidebar（頁面列表）在父頁面，用 `#sitemapContainer` 等 selector 隱藏
- `iframe#mainFrame` 內的 header/nav 另外處理
- 直接 `.html` URL → 無 sidebar，只需處理 `#base` 內的 chrome

---

## 擷取並清洗 HTML

隱藏 chrome 後，執行以下 JS 取得清洗後的 HTML：

```javascript
() => {
  const doc = document.querySelector('iframe#mainFrame')?.contentDocument || document;
  const base = doc.querySelector('#base');
  if (!base) return null;

  const clone = base.cloneNode(true);

  // 移除 chrome 元素（header/nav/sidebar）—— 必須在 removeAttribute('style') 之前 remove()
  // 不能靠前一步的 style.display='none'，因為後面會把 style 全部清掉
  [...clone.children].forEach(el => {
    const text = el.textContent || '', cls = el.className || '';
    if (
      text.includes('登入者') ||
      text.includes('發票平台') ||
      (text.includes('Close') && text.includes('首頁')) ||
      text.includes('個人資料維護') ||
      ((cls.includes('_形状') || cls.includes('box_1')) && !text.trim()) ||
      // 系統選單 nav（含「首頁」「個人設定區」等系統層級項目）
      (text.includes('首頁') && text.includes('個人設定區'))
    ) el.remove();
  });

  // 移除噪音元素
  clone.querySelectorAll('script, style, svg, link, noscript').forEach(el => el.remove());

  // 移除裝飾性 img（Axure 用 img 做背景/icon，無語意）
  clone.querySelectorAll('img').forEach(el => el.remove());

  // 移除隱藏的 validation error 元素（ax_default_hidden = 預設不顯示，非真實 UI）
  clone.querySelectorAll('.ax_default_hidden').forEach(el => el.remove());

  // 清理每個元素的屬性
  clone.querySelectorAll('*').forEach(el => {
    // 移除 inline style（最大噪音來源）
    el.removeAttribute('style');
    // 移除 Axure 生成的 ID（u + 數字）
    if (/^u\d+(_.*)?$/.test(el.id)) el.removeAttribute('id');
    // 移除無用屬性
    ['tabindex', 'unselectable', 'hidefocus', 'layer-opacity'].forEach(a => el.removeAttribute(a));
    // 移除 data-* 屬性
    [...el.attributes].filter(a => a.name.startsWith('data-')).forEach(a => el.removeAttribute(a.name));
    // 移除 input 上的 auto-gen class（如 u6_input）
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const cleanedClasses = [...el.classList].filter(c => !/^u\d+_/.test(c));
      el.className = cleanedClasses.join(' ');
    }
  });

  // 移除純空殼 div/span（無文字、無表單元素）
  // 多跑幾次直到穩定
  for (let i = 0; i < 5; i++) {
    clone.querySelectorAll('div, span').forEach(el => {
      if (!el.textContent?.trim() && !el.querySelector('input,select,textarea,button,a,table,tr,td,th')) {
        el.remove();
      }
    });
  }

  return clone.innerHTML;
}
```

---

## 流程

### 方法 A：JS 座標分析 → 語意 HTML（推薦）

**核心原則：Axure 用絕對定位，DOM 順序 ≠ 視覺順序。截圖消耗大量 token 且容易猜錯。改用 JS 查 x/y 座標，精確且 token 極低。**

**不存截圖。所有資訊從 JS 取得。**

```
1. browser_close → 確保無殘留頁面
2. browser_navigate → 目標頁面（直接 .html URL）
3. browser_evaluate → 執行隱藏 chrome JS
4. browser_evaluate → 【JS Step 1】取得所有欄位標籤 + y 座標，建立欄位清單
5. browser_evaluate → 【JS Step 2】對 y 值相近的欄位查 x 座標，判斷左右欄
6. browser_evaluate → 【JS Step 3】取得 input/select/textarea 類型 + 選項值
7. browser_evaluate → 【JS Step 3.5】偵測大型自訂元件（WYSIWYG editor、file widget 等）
7b. browser_evaluate → 【JS Step 3.7】Table 結構提取（有 table 的頁面必做）— 取得 header 欄位 x 座標順序、checkbox/icon 位置
8. 根據座標數字手寫語意 HTML（每個欄位的 label+input 必須包在 `<div>` 內，確保各占一行）
9. Write tool → 存成 docs/axure-snapshots/{projectId}/{module}-{page_type}.html
10. browser_evaluate → 【JS Step 4】驗證按鈕清單，比對 HTML 中的 <button>
```

---

### JS Step 1：取得所有欄位標籤（y 座標排序）

```javascript
() => {
  const base = document.querySelector('iframe#mainFrame')?.contentDocument?.querySelector('#base')
             || document.querySelector('#base');
  return [...base.querySelectorAll('p')].filter(el => {
    const rect = el.getBoundingClientRect();
    return el.textContent?.trim() && el.textContent.trim().length < 25
      && el.offsetParent !== null && rect.width > 0 && rect.height > 0;
  }).map(el => {
    const rect = el.getBoundingClientRect();
    return { text: el.textContent.trim(), y: Math.round(rect.y) };
  }).sort((a, b) => a.y - b.y);
}
```

→ 回傳依 y 排序的標籤清單，**即是欄位從上到下的視覺順序**
→ y 值相近（差 < 20px）= 同一行

---

### JS Step 2：確認同行欄位的左右位置（x 座標）

```javascript
// 把上一步找到的同行欄位名稱填入陣列
() => {
  const base = document.querySelector('iframe#mainFrame')?.contentDocument?.querySelector('#base')
             || document.querySelector('#base');
  const targets = ['欄位A', '欄位B', '欄位C'];  // 填入要確認的欄位名
  return [...base.querySelectorAll('p')].filter(el =>
    targets.includes(el.textContent?.trim()) && el.offsetParent !== null
  ).map(el => {
    const rect = el.getBoundingClientRect();
    return { text: el.textContent.trim(), x: Math.round(rect.x), y: Math.round(rect.y) };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}
```

→ x 小的是左欄，x 大的是右欄
→ **以這個結果為準寫 HTML，不猜**

---

### JS Step 3：取得 input 類型 + select 選項（取代截圖）

```javascript
() => {
  const base = document.querySelector('iframe#mainFrame')?.contentDocument?.querySelector('#base')
             || document.querySelector('#base');
  return [...base.querySelectorAll('input, select, textarea')]
    .filter(el => el.offsetParent !== null)
    .map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        value: el.value || null,
        checked: el.type === 'radio' || el.type === 'checkbox' ? el.checked : undefined,
        y: Math.round(rect.y),
        options: el.tagName === 'SELECT'
          ? [...el.options].map(o => ({ text: o.text.trim(), selected: o.selected }))
          : undefined
      };
    }).sort((a, b) => a.y - b.y);
}
```

→ 得到每個 input 的類型、預設值、select 所有選項
→ **不需要截圖，JS 資料已完整**

---

### JS Step 3.5：偵測大型自訂元件（WYSIWYG editor、file widget 等）

**原因：** `<p>` 查詢抓不到 listbox/custom widget，`input/select/textarea` 查詢同樣抓不到。
這些元件可能佔據頁面大段空白，不查就完全漏掉。

```javascript
() => {
  const base = document.querySelector('iframe#mainFrame')?.contentDocument?.querySelector('#base')
             || document.querySelector('#base');
  const standardTags = new Set(['INPUT', 'SELECT', 'TEXTAREA', 'P', 'SPAN', 'LABEL',
                                  'BUTTON', 'A', 'H1', 'H2', 'H3', 'NAV', 'FORM']);
  return [...base.querySelectorAll('*')]
    .filter(el => {
      if (el.offsetParent === null) return false;
      const rect = el.getBoundingClientRect();
      // 高度超過 80px 且不是標準表單元素，且內部沒有標準表單欄位
      return rect.height > 80
        && !standardTags.has(el.tagName)
        && !el.querySelector('input, select, textarea');
    })
    .map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute('role') || null,
        y: Math.round(rect.y),
        h: Math.round(rect.height),
        textPreview: el.textContent?.trim().slice(0, 40) || ''
      };
    })
    .filter((v, i, arr) =>
      // 去重：避免父子元素重複報告（只留最外層）
      !arr.some((u, j) => j !== i && Math.abs(u.y - v.y) < 10 && u.h > v.h)
    )
    .sort((a, b) => a.y - b.y);
}
```

→ 若看到 `h > 200` 的元件（如 WYSIWYG editor、document viewer），在 HTML 中加入對應的 comment placeholder：
```html
<!-- y=2450~3200: 富文字文件編輯器（WYSIWYG）
     包含格式工具列（B I U 對齊 字型 字號...）
     及大型文件預覽畫布（公司信頭、主旨、說明、核章欄）
-->
<div>
  <div>[文件編輯器工具列：B I U 字型 字號 對齊 ...]</div>
  <div>[文件預覽畫布：公文格式 — 公司信頭、主旨、說明、正文、附件說明、核章欄]</div>
</div>
```

---

### JS Step 3.7：Table 結構提取（查詢頁必做）

**問題：** Axure table 的 DOM 順序不等於視覺欄位順序。checkbox、icon 欄（檢視/編輯/刪除）的 x 位置決定它在哪一欄，不能靠猜。

```javascript
() => {
  const base = document.querySelector('iframe#mainFrame')?.contentDocument?.querySelector('#base')
             || document.querySelector('#base');
  // 找 table header row：一組 y 值相近的短文字（通常是欄位名稱）
  const allTexts = [...base.querySelectorAll('p, div')].filter(el => {
    const t = el.textContent?.trim();
    return t && t.length < 20 && el.offsetParent !== null
      && el.children.length === 0; // leaf nodes only
  }).map(el => {
    const rect = el.getBoundingClientRect();
    return { text: el.textContent.trim(), x: Math.round(rect.x), y: Math.round(rect.y) };
  });

  // Group by y (within 10px = same row)
  const rows = {};
  for (const t of allTexts) {
    const rowKey = Math.round(t.y / 10) * 10;
    if (!rows[rowKey]) rows[rowKey] = [];
    rows[rowKey].push(t);
  }

  // Find the row with most items (likely the header row)
  const headerRow = Object.values(rows).sort((a, b) => b.length - a.length)[0];
  if (!headerRow) return null;
  headerRow.sort((a, b) => a.x - b.x); // sort by x = visual column order

  // Find clickable icons in data rows (檢視/編輯/刪除 etc)
  const icons = [...base.querySelectorAll('img, svg, [style*="cursor:pointer"], [style*="cursor: pointer"]')]
    .filter(el => el.offsetParent !== null)
    .map(el => {
      const rect = el.getBoundingClientRect();
      const alt = el.getAttribute('alt') || el.getAttribute('title') || el.textContent?.trim() || '';
      return { type: 'icon', alt, x: Math.round(rect.x), y: Math.round(rect.y) };
    });

  // Find checkboxes in data rows
  const checks = [...base.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
    .filter(el => el.offsetParent !== null)
    .map(el => {
      const rect = el.getBoundingClientRect();
      return { type: 'checkbox', x: Math.round(rect.x), y: Math.round(rect.y) };
    });

  return {
    headerColumns: headerRow,
    iconPositions: icons.slice(0, 20),
    checkboxPositions: checks.slice(0, 10),
  };
}
```

→ `headerColumns` 依 x 排序 = 欄位的真實視覺順序
→ `checkboxPositions` 的 x 值 < 所有 header x → checkbox 在最左欄
→ `iconPositions` 的 x 值決定 icon 在哪一欄（例如 x 在「備註」和「編輯」header 之間 → 該 icon 屬於那一欄）
→ **`<th>` 和 `<td>` 的順序必須嚴格依照 x 座標，不能隨意排列**

---

### JS Step 4：驗證按鈕（寫完 HTML 後必做）

```javascript
() => {
  const base = document.querySelector('iframe#mainFrame')?.contentDocument?.querySelector('#base')
             || document.querySelector('#base');
  return [...base.querySelectorAll('p, div')].filter(el => {
    const style = window.getComputedStyle(el);
    const t = el.textContent?.trim();
    return (style.cursor === 'pointer' || el.closest('[style*="cursor"]'))
      && t && t.length < 30 && el.offsetParent !== null;
  }).map(el => {
    const rect = el.getBoundingClientRect();
    return { text: el.textContent.trim(), y: Math.round(rect.y) };
  }).filter((v, i, a) => a.findIndex(x => x.text === v.text) === i)
    .sort((a, b) => a.y - b.y);
}
```

→ 和 HTML 中所有 `<button>` 逐一比對：**數量一致、順序一致才完成**

---

**為什麼不用截圖：**
- 截圖是圖片，消耗大量 token（比文字貴數十倍）
- Axure 用絕對定位，視覺位置和 DOM 順序無關，截圖容易猜錯
- JS 拿到的是精確像素座標 + 完整欄位資料，**比截圖更準、更省**
- Step 3.5 負責偵測截圖才看得到的大型自訂元件（WYSIWYG、file widget），截圖的最後用途也已被 JS 取代

**截圖只用於使用者主動要求人工抽查時**，不是標準流程的一部分。

**Token 消耗參考（以收文單_新增這類複雜表單頁為例）：**

| 動作 | 約 token 數 |
|------|-------------|
| `browser_navigate`（含 accessibility tree 快照） | ~2,000–3,000 |
| 隱藏 chrome JS | ~200 |
| Steps 1 + 3 + 3.5 合一呼叫（JSON 結果） | ~1,500–2,000 |
| Write HTML（~3KB） | ~1,500 |
| Step 4 按鈕驗證 | ~300 |
| **合計** | **~5,500–7,000** |

對比截圖方案：fullPage 截圖（頁面高 ~4000px）約 20,000–60,000 token，貴 **5–10 倍**，且順序容易猜錯。

---

**手寫語意 HTML 規則：**
- **排除系統選單 nav**：含「首頁」「個人設定區」等系統層級項目的 `<nav>` 是應用外殼，不屬於頁面規格，**不寫入 HTML**
- 用真實 HTML 語意元素：`<form>`, `<select>`, `<input>`, `<table>`, `<button>`
- **每個獨立欄位（label+input）必須包在 `<div>` 內**，確保各占一行（`<label>` 預設 inline，不包就全擠一行）
- 兩欄並排的欄位用 `<table><tr><td>` 表示左右關係
- `<select>` 的 `<option>` 只保留看到的選項，預選值加 `selected`
- `<table>` 的 `<tbody>` 只保留一筆樣本 row
- 按鈕標記 Action ID 為 HTML comment：`<!-- A1 -->`, `<!-- B1 -->` 等（從 Axure 頁面標記讀取）
- 不寫 CSS class、inline style、id——保持最小結構
- 一個頁面的 HTML 目標大小：約 2~5 KB

**輸出範例（sb01-查詢.html）：**
```html
<!-- SB01.年度電子發票字軌檔 — 查詢頁 -->
<h1>SB01.年度電子發票字軌檔</h1>
<section id="search-form">
  <h2>查詢作業</h2>
  <form>
    <div><label>所屬年度 * <select name="year"><option selected>114</option></select></label></div>
    <div><label>期數 <select name="period"><option selected>9-10月</option></select></label></div>
    <div>
      <button class="primary">查詢</button><!-- A1 -->
      <button>清除</button><!-- A2 -->
    </div>
  </form>
</section>
<section id="result">
  <div><button class="primary">新增</button><!-- D1 --></div>
  <table>
    <thead><tr><th>所屬年度</th><th>字軌</th>...</tr></thead>
    <tbody><tr><td>114</td><td>AA</td>...</tr></tbody>
  </table>
</section>
```

---

### 方法 B：擷取並清洗 Axure HTML（備用）

當截圖無法清楚辨識細節時（例如 tooltip 文字、複雜 Dynamic Panel 狀態），改用 HTML 擷取：

```
1. browser_navigate → 目標頁面 URL
2. browser_evaluate → 執行隱藏 chrome JS
3. browser_evaluate → 執行 HTML 清洗 JS，取得 innerHTML
4. node -e → 存成 docs/axure-snapshots/{projectId}/{module}-{page_type}.html
```

---

---

## 方法 C：Rendered HTML（用實際程式碼 + CSS 還原）

當需要確認「實際實作」與 Axure 規格的差異，或需要可交互的 HTML 預覽時使用。

```
1. 讀取 src/container/{MODULE}/{Page}.tsx — 取得真實 HTML 結構與 class 名稱
2. 讀取 public/css/style/style.css — 取得 Bootstrap + 自訂樣式
3. 寫一個 standalone HTML，<link> 指向本機 CSS 絕對路徑
4. Write tool → 存成 docs/axure-snapshots/{projectId}/{module}-rendered.html
```

**關鍵：**
- `<link rel="stylesheet" href="file:///D:/fork/ofeinvoice_ui/public/css/style/style.css">`
- 直接用瀏覽器開啟即可看到與正式環境相同的視覺效果
- `<tbody>` 只保留一筆樣本 row
- 命名規則：`{module}-rendered.html`（與 Axure 版的 `{module}-查詢.html` 並存）

---

## 儲存

使用 `node -e` 寫入（避免 heredoc 中文/特殊字元問題）：

```bash
node -e "
const fs = require('fs');
const content = \`...cleaned html...\`;
fs.mkdirSync('docs/axure-snapshots/{projectId}', { recursive: true });
fs.writeFileSync('docs/axure-snapshots/{projectId}/sb01-查詢.html', content, 'utf8');
"
```

---

## 瀏覽器卡住處理規則

**若瀏覽器操作（navigate / evaluate / screenshot）無回應或連續失敗：**

- 每次失敗計入一次「卡住」
- 同一頁面卡住 → 跳過該頁，繼續下一頁
- **累計卡住達 3 次（跨頁面合計）→ 立即停止，輸出 [TASK_COMPLETE] 並說明停止原因**

目的：避免瀏覽器掛起時無限等待，讓使用者知道爬到哪裡、從哪裡繼續。

---

## 常見問題

| 問題 | 原因 | 解法 |
|------|------|------|
| 頁面顯示 "Generating Project" | Axure 專案正在重新發佈 | 等待 30~60 秒後重試 |
| `id=null` 顯示空白頁 | 頁面名稱含 `&` | 改用真實 page ID + `_` 取代 `&` |
| heredoc 寫入失敗 | 中文/引號衝突 | 改用 `node -e` 寫入 |
| iframe 找不到 `#base` | 直接 .html URL，無 iframe | 直接在 `document` 找 `#base` |
| 清洗後仍有大量空 div | Axure 結構層次深 | 增加清洗迴圈次數（i < 10）|
| Browser crash / 亂碼輸出 | Chrome 進程卡死 | 用 `browser_close` 正常關閉；若無效，在 PowerShell 執行：`Get-Process chrome \| Where-Object { $_.MainWindowTitle -eq "" } \| Stop-Process -Force`（只殺無視窗的 headless Chrome，不影響使用者開著的 Chrome） |

---

## HTML Class 對應說明

Axure 不同版本/模板產生的 class 名稱可能不同，但語意相同：

| UI 功能 | 常見 class 變體 |
|---|---|
| 欄位 label | `div.text`、`div.label1`、`div._文字段落` |
| 文字輸入框 | `div.text_field`、`div.text_field1` |
| 下拉選單 | `div.droplist` |
| 主要按鈕（藍色） | `div.primary_button`、`div.primary_button1` |
| 次要按鈕（灰色） | `div.button` |
| 表格欄位 | `div.table_cell` |
| 分頁按鈕 | `div.menu_item` |
| Action ID 標記 | `div.annnote > div.annnotelabel` |
| Dynamic Panel 三層 | `div.ax_default > div.panel_state > div.panel_state_content` |

**Dynamic Panel 判讀：**
- 有多個 `panel_state` = 多狀態面板（如 Sign In / Sign Up 切換）
- 通常只有第一個 state（state0）是真正規格，其他是 Axure 模板殘留
- Axure 的 HTML comment（`<!-- Sign In Button (Group) -->`）保留且有用，不要清除

---

## 命名慣例

```
docs/axure-snapshots/{projectId}/{module_code}-{page_type}.html
```

範例：`docs/axure-snapshots/2463e4b4-4ff2-4c50-9178-835b62b82e08/sb01-查詢.html`

- `{projectId}` = OmniCommander 裡的專案 UUID（可從 DB 或 URL 取得）
- `{module_code}` = 功能代碼小寫（`sb01`、`sb05`...）
- `{page_type}` = 頁面類型（`查詢`、`新增修改`，`&` 省略只寫「新增修改」）
