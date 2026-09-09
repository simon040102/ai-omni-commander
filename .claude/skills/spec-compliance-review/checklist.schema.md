# 檔案格式

## checklist.json — 第一步抽出來的檢查表

```json
{
  "feature": "PP001 FEDI交易明細",
  "specs": {
    "sa": "hn_doc/FEDI_ADM/SA(前端)/PP/PP001/PP001_FEDI交易明細.md",
    "sd": "hn_doc/FEDI_ADM/SD(後端)/PP/PP001.md"
  },
  "items": [
    {
      "id": "1",
      "itemType": "ui_text",
      "side": "frontend",
      "content": "查詢",
      "sourceRef": "SA §2.1 查詢區塊"
    },
    {
      "id": "2",
      "itemType": "api",
      "side": "backend",
      "content": "POST /fedi/pp001/search",
      "sourceRef": "SD §1"
    },
    {
      "id": "3",
      "itemType": "logic",
      "side": "backend",
      "content": "帶 sortField / sortOrder 時改依指定欄位排序",
      "sourceRef": "SD §1"
    }
  ]
}
```

欄位說明：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `feature` | ✓ | 功能代碼 + 名稱，報告標題會用 |
| `specs` | ✓ | 讀了哪幾份規格。key 自己取（`sa` / `sd` / `sdCommon` 都可以），**值用絕對路徑**——規格檔通常不在前後端任一個 workspace 底下，相對路徑沒有共同基準 |
| `id` | ✓ | 表內唯一，用數字字串即可 |
| `itemType` | ✓ | `ui_text` / `api` / `param` / `response_field` / `db_field` / `logic` |
| `side` | ✓ | `frontend` / `backend`，決定去哪個 workspace 掃。**標錯會造成整批假不符** |
| `content` | ✓ | 要驗的字面內容。`api` 寫成 `METHOD /path`（**只寫路徑骨幹，寫死的參數值另立一項存成 `param`**） |
| `sourceRef` | ✓ | 規格章節，報告要引用 |

`param` 與 `response_field` 的界線：**進去的存 `param`，出來的存 `response_field`**（request 參數 vs response 欄位）。腳本對兩者同處理，但報告會分開統計，混了數字就不對。

`feature` 和 `specs` 腳本不讀，**寫錯不會有人告訴你**——那兩個欄位是給讀報告的人看的。

## review.json — 第三步 AI 驗證員的輸出

```json
{
  "reviewedAt": "2026-09-05",
  "reviewer": "independent-agent",
  "results": [
    {
      "itemId": "1",
      "status": "matched",
      "evidence": [{ "file": "src/container/PP/PP001/Index.tsx", "line": 88 }],
      "note": "查詢按鈕文字，Button 的 children"
    },
    {
      "itemId": "2",
      "status": "matched",
      "evidence": [{ "file": "MainService/.../Pp001Controller.java", "line": 34 }],
      "note": "路徑骨幹由類別層 @RequestMapping + 方法層 @PostMapping 組成"
    },
    {
      "itemId": "3",
      "status": "missing",
      "evidence": [{ "file": "MainService/.../Pp001ObjectRepository.java", "line": 492 }],
      "note": "SD §1 要求依 sortField 排序，但這一行的 ORDER BY 是寫死字串；Service 只傳 vo.getPageable()，sortField 根本沒進 repository"
    }
  ],
  "addedByReverseScan": [
    {
      "id": "R1",
      "itemType": "logic",
      "side": "backend",
      "content": "...",
      "sourceRef": "SD §3（檢查表漏抽）",
      "status": "matched",
      "evidence": [{ "file": "...", "line": 120 }]
    }
  ],
  "specConflicts": [
    { "desc": "SA 寫 E002，SD 寫 E001：台幣，兩者矛盾", "sourceRef": "SA §4 / SD §2" }
  ]
}
```

- `status`：`matched`（符合）／`missing`（不符）／`waived`（有正當理由豁免，必附 `note` 說明理由）
- `matched` **必附** `evidence`，`file` 相對於該 side 的 workspace 根目錄
- **`missing` 也要附 `evidence`**，指向「本來應該有、但實際不是那樣」的位置（例：`ORDER BY` 寫死的那一行）。全部塞在 `note` 字串裡，之後就沒辦法程式化統計不符項在哪
- `missing` 的 `note` 要寫到報告能直接用：規格怎麼寫、程式實際怎樣、在第幾行
- **`results` 必須涵蓋檢查表的每一項**，一項都不可以跳過。上面的範例只列三筆是為了短，不是示範可以漏——漏項就是漏驗
- `addedByReverseScan`：反向掃描補抽的項目，欄位同 `items` 再加上判定結果。**沒有補到也要留成空陣列**，報告要交代「反向掃描無遺漏」
- `specConflicts`：規格矛盾。`desc` 寫矛盾在哪、`sourceRef` 寫兩邊出處。腳本不讀，純靠人自律
- `reviewedAt` 用 `YYYY-MM-DD`；`reviewer` 隨意，只是留個記錄

## precheck.json — 第二步腳本輸出

腳本自動產生，不用手寫。結構同 `review.json` 的 `results`，多一個 `reason` 欄位說明為何判不到。
