# Jev MCP（給 Claude Code 用）

讓 Claude Code 多一個工具 `jev_classify`：把「資料量大、每筆都問同一個封閉問題」的判斷，批次丟給 TypeSafe 的 Jev 模型——零點幾秒一筆、非常便宜。

- **choice**：每筆從你給的選項挑一個（例：這張是 bug／feature／other？）
- **score**：每筆依由低到高的量尺打 0~1 分（例：嚴重程度 外觀小問題 → 系統掛掉）

適合：大量分類、名單篩選、風險打分、程式／文件快篩。
不適合：需要寫出內容或理由的工作；需要高準度定論的判定（Jev 只做快篩，結果僅供參考）。

## 安裝前準備

1. **Node.js 20 以上**：https://nodejs.org
2. **Claude Code**（`claude` 指令可在終端機執行）
3. **自己的 TypeSafe API key**：到 https://console.typesafe.ai 申請。費用算在你自己的帳號，**不要共用別人的 key**。

## 一鍵安裝

**Windows**：解壓縮後，雙擊 `install.cmd`，貼上 API key（輸入時不會顯示）。

**macOS／Linux**：
```bash
bash install.sh
```

安裝程式會：檢查 Node.js 與 Claude Code → 把 `jev-mcp.mjs` 放到 `~/.jev-mcp/` → 先驗證 API key（只查模型清單，不送任何資料）→ 註冊到 Claude Code（使用者層級，所有專案都能用）。

裝完**新開一個 Claude Code session** 就能用，例如跟 Claude 說「把這 200 則留言用 Jev 分成五類」。

## API key 存在哪

存成這個 MCP 的環境變數 `TYPESAFE_API_KEY`，寫在你電腦的 Claude Code 使用者設定 `~/.claude.json`（Windows：`C:\Users\<你>\.claude.json`）裡 jev 那一項。

- 是**明碼**存放（跟其他 MCP 的金鑰一樣）：這個檔案不要傳給別人、不要 commit 進 git
- 要換 key：重新執行安裝程式即可（會覆蓋舊的註冊）

## 其他

- 換 key／更新版本：重新執行安裝程式
- 移除：`claude mcp remove jev -s user`，再刪掉 `~/.jev-mcp/` 資料夾
- 資料會送到第三方 TypeSafe：只送判斷需要的文字，不要送帳密、金鑰、個資
- 進階參數（Windows）：`install.ps1 -ApiKey <key> -Name <註冊名稱> -InstallDir <安裝位置>`
