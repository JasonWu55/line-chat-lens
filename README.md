# Telegram Chat Lens

`Telegram Chat Lens` 是一個可部署到 GitHub Pages 的靜態網站，讓使用者把 Telegram 匯出的單一對話 `result.json` 拖進瀏覽器後，直接做視覺化分析。

這個專案的重點不是把聊天紀錄上傳到伺服器，而是完全在瀏覽器內處理資料，並盡量控制記憶體使用量，讓長時間跨度或大量訊息的對話也能分析。

本專案是由 Denny Huang 提出需求，並由 OpenAI Codex 協助撰寫與實作。

## Features

- 純靜態前端，可直接部署到 GitHub Pages
- 瀏覽器端分析，不需要後端
- 使用 Web Worker 分攤解析工作，避免主執行緒卡住
- 以串流方式讀取檔案，不暴力載入整份 JSON
- 只保留聚合統計，不保留完整訊息內容於記憶體
- 支援拖放上傳與處理進度顯示
- 提供互動式 tooltip，可在 hover 時查看精確數值

## Metrics

目前頁面提供的分析指標包含：

- 總訊息數
- 含文字訊息數
- 活躍天數
- 對話時間跨度
- 平均每日訊息量
- 最常發話者
- 典型回覆時間
- 最長沉默區間
- 月度訊息趨勢
- 每週時段熱區
- 回覆速度分布
- 熱門活躍日期
- 參與者比較
- 近似熱門詞

## Privacy

- 所有分析都在本地瀏覽器進行
- 頁面不會把聊天資料上傳到伺服器
- 建議不要把私人匯出檔提交到 Git repository
- `.gitignore` 已預設排除 `result.json` 與常見匯出資料夾

## How To Export Telegram Data

建議使用 Telegram Desktop 匯出。

1. 打開你要分析的單一對話。
2. 開啟右上角選單，選擇 `Export chat history`。
3. 在匯出設定中把格式改成 `JSON`。
4. 匯出完成後，將資料夾中的 `result.json` 拖進本網站。

如果你只想分析文字，媒體選項可以不勾選，這樣匯出檔會更小。

## Tech Notes

這個專案沒有使用建置工具，也沒有外部前端框架。主要檔案如下：

- `index.html`: 首頁與儀表板結構
- `styles.css`: 版面與視覺樣式
- `app.js`: UI 邏輯、圖表渲染、tooltip 互動
- `worker.js`: 串流解析 Telegram 匯出 JSON，並建立聚合統計

## Local Development

因為使用了 module script 與 Web Worker，請用靜態伺服器預覽，不要直接雙擊開啟 HTML。

例如：

```bash
python -m http.server 4173
```

然後打開：

```text
http://localhost:4173
```

## Deploy To GitHub Pages

這個專案不需要 build step，只要把下列檔案推到 GitHub repository 即可：

- `index.html`
- `styles.css`
- `app.js`
- `worker.js`
- `img/`
- `.nojekyll`

如果你使用 GitHub Pages：

1. 建立 repository，例如 `telegram-chat-lens`
2. 將專案推上 GitHub
3. 在 repository settings 的 Pages 中選擇 branch 與 root folder
4. 發布後即可直接使用

## Limitations

- 目前預設以 Telegram 匯出的單一對話 JSON 結構為主
- 熱門詞採近似 heavy-hitter 統計，不是全文精確詞頻
- 回覆速度分布是依照雙方輪流發言的時間差估算，不是語意層級的精確「誰回誰」
- 長時間沉默目前不會排除，超過 3 天的間隔會落在 `>3d` 區間

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
