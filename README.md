# Teams Transcript Capture

一個極簡的 Chrome 擴充（MV3），一鍵擷取**網頁版 Microsoft Teams** 的即時字幕（live captions），停止後自動把逐字稿存成 Markdown，寫進你指定的 **OneDrive 同步資料夾**，由 OneDrive 自動上傳到雲端。

- 只抓**文字**（字幕），不錄音、不錄影。
- 不使用 Graph API / OAuth / CDK 租戶 —— 靠「寫進本機已同步的 OneDrive 資料夾」達成上傳。
- 目標資料夾範例：`~/Library/CloudStorage/OneDrive-TaoDigitalSolutionsInc/...`

## 安裝（load unpacked）

1. Chrome 開 `chrome://extensions`
2. 右上角開啟 **Developer mode（開發人員模式）**
3. 按 **Load unpacked（載入未封裝項目）**
4. 選擇這個資料夾（含 `manifest.json` 的那層）

安裝後，開啟 `https://teams.microsoft.com`，右下角會出現浮動按鈕。

## 使用

1. 在 Teams 會議中，手動開啟 **live captions（即時字幕）**：`More → Language and speech → Turn on live captions`。
2. 按右下角 **📁** 選擇要存放的 OneDrive 資料夾（第一次會跳出選擇對話框；之後記住）。
3. 按 **● 開始擷取**。
4. 結束時按 **■ 停止並存檔** —— 逐字稿會寫進剛選的資料夾。

檔名：`會議標題_YYYY-MM-DD_HHMM.md`；偵測不到標題時退回 `TeamsTranscript_YYYY-MM-DD_HHMM.md`。

輸出格式：
```
# Teams Transcript

- 會議：<標題>
- 日期：…
- 擷取開始 / 結束：…
- 對話行數：…

---

[HH:MM:SS] 講者：內容
[HH:MM:SS] 講者：內容
```

工具列圖示點開的 popup 顯示即時狀態（擷取中 / 行數 / 目標資料夾 / 最後存檔）。

### 移動浮動面板

- 拖曳面板左側的 **⠿** 小把手，即可在網頁可視範圍內移動；原本的擷取與資料夾按鈕維持不變。
- 最後位置儲存在擴充功能的本機儲存空間，重新整理網頁後會還原。
- 視窗縮小或面板大小改變時，面板會自動移回最近的可視邊界。
- 也可以用 Tab 聚焦把手，再按方向鍵微調位置。

### 在 Arc 更新已載入的擴充功能

1. 若正在擷取，先按 **停止並存檔**，確認逐字稿已儲存。
2. 在 Arc 開啟 `chrome://extensions`，開啟 **Developer mode（開發人員模式）**。
3. 找到 **Teams Transcript Capture**，按該擴充功能的 **重新載入（Reload）**。
4. 回到 Teams 分頁，重新整理網頁，讓新版面板載入。
5. 拖曳把手後重新整理，確認位置保留；縮小視窗，確認面板仍在可視範圍內。

## Calibration（重要）

Teams 的字幕 DOM 沒有公開文件，且會隨版本改變。若擷取結果為空或亂碼，需要校正 `content.js` 最上方的 `SEL` 選擇器：

1. 開一場真的有 live captions 的 Teams 會議。
2. 對著一行字幕按右鍵 → **檢查（Inspect）**。
3. 找出：字幕**容器**、單行**字幕**、**講者**名稱、**文字**內容各自的 selector（`data-tid` 或 class）。
4. 把它們填進 `SEL.container / line / speaker / text` 的陣列最前面（保留其他當 fallback）。
5. 在 `chrome://extensions` 按這個擴充的**重新整理**，回 Teams 分頁重試。

## 已知限制（v1 non-goals）

- 不錄音 / 不錄影；不抓 Teams 官方 transcript（那需要 Graph API）。
- 不會自動幫你開字幕，要自己開。
- 沒有逐字稿編輯器 / 即時翻譯 / AI 摘要。
- 一次一場會議（不支援多分頁同時擷取）。
- 需要桌面版 Chrome（File System Access API）。
- FSA 目標資料夾權限在每個瀏覽器工作階段可能會再確認一次（按一下即可）。

## 檔案

| 檔案 | 作用 |
|---|---|
| `manifest.json` | MV3 設定 |
| `content.js` | 注入浮動按鈕、擷取字幕、寫檔 |
| `popup.html` / `popup.js` | 工具列狀態視窗 |
