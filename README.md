# Telegram Chat Lens

`Telegram Chat Lens` 是一個可直接部署為靜態網站的 Telegram 對話分析工具。使用者只要把 Telegram 匯出的單一對話 `result.json` 拖進頁面，瀏覽器就會在本機完成解析、統計與視覺化，不需要後端，也不會把聊天資料上傳到伺服器。

目前專案由單頁前端組成，適合部署到 GitHub Pages 或任何靜態檔案主機。

## 專案現況

- 純前端靜態網站，沒有 build step
- 使用 `Web Worker` 在背景解析大型 JSON
- 以串流方式掃描 `messages` 陣列，不一次把整份匯出檔載入記憶體
- 頁面內建 Telegram Desktop 匯出教學
- 支援拖曳或手動選取 `result.json`
- 適合分析長時間跨度、訊息量大的單一對話

## 目前提供的分析內容

- 摘要卡片
  - 總訊息數
  - 含文字訊息數
  - 活躍天數
  - 對話時間跨度
  - 平均每日訊息量
  - 發言最多者
  - 典型回覆時間
  - 最長沉默區間
- 圖表與列表
  - 月度訊息趨勢
  - 日度訊息趨勢
  - 每週時段熱區
  - 回覆速度分布
  - 熱門活躍日期
  - 參與者比較
  - 近似熱門詞
  - 每位參與者的愛用詞彙與口頭禪候選
  - 每位參與者的訊息樣態比例
  - 通話互動分析

## 支援的資料來源

目前以 Telegram Desktop 匯出的單一對話 JSON 為主要目標，頁面會從匯出檔內的 `messages` 陣列進行分析。

建議匯出方式：

1. 在 Telegram Desktop 開啟要分析的單一對話。
2. 點選右上角選單，選擇 `Export chat history`。
3. 格式選 `JSON`。
4. 匯出完成後，把資料夾內的 `result.json` 拖進頁面。

如果只想分析文字內容，可以不勾選媒體，匯出檔通常會更小。

## 隱私

- 所有處理都在本機瀏覽器內完成
- 專案本身沒有後端，也不會主動上傳聊天資料
- 不建議把私人匯出檔提交到 Git repository
- 專案內的 `json/` 目錄目前放的是範例資料，不是應用程式執行所必需

## 專案結構

- `index.html`: 頁面結構、上傳區與各分析面板
- `styles.css`: 版面與視覺樣式
- `app.js`: UI 邏輯、圖表渲染、互動控制
- `worker.js`: Telegram JSON 串流解析與聚合統計
- `img/`: 匯出教學截圖
- `json/`: 範例或測試用匯出資料

## 本機預覽

因為頁面使用 `type="module"` 與 `Web Worker`，不要直接雙擊 `index.html` 開啟，請用靜態伺服器預覽。

例如：

```bash
python3 -m http.server 4173
```

然後開啟：

```text
http://localhost:4173
```

## 部署

此專案沒有打包流程，直接把以下檔案與資料夾部署成靜態網站即可：

- `index.html`
- `styles.css`
- `app.js`
- `worker.js`
- `img/`

如果要部署到 GitHub Pages，將上述檔案推到 repository 後，在 Pages 設定中選擇要發布的 branch 與資料夾即可。

## 實作說明

- 解析器會先定位 JSON 內的 `messages` 陣列，再逐筆組出訊息物件
- 統計以聚合結果為主，不保留完整訊息清單在記憶體中
- 熱門詞與口頭禪採 bounded heavy-hitter 類型的近似統計
- 回覆速度以雙方交替發話的時間差估算，不是語意層級的精確回覆鏈
- 通話分析依 Telegram 匯出中的 `phone_call` 事件與相關欄位整理

## 已知限制

- 目前主要針對 Telegram 單一對話的匯出 JSON
- 若匯出格式缺少 `messages` 陣列，頁面會直接判定為不支援
- 中文詞彙分析不是斷詞器結果，長字串會拆成連續雙字詞做近似統計
- 熱門詞、愛用詞與口頭禪是近似值，不是全文精確詞頻
- 回覆速度不會排除長時間沉默，超過 1 天會落在 `>1d`
- 通話結果與時長依匯出檔提供的欄位品質而定

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
