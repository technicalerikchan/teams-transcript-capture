# Teams Transcript Capture — v0.4.0

擷取網頁版 Microsoft Teams 的 **即時字幕文字**，會議結束後將 Markdown 逐字稿存入對應 OneDrive 資料夾。**不錄製音訊／影片，也不會啟動 Teams 官方錄影。**

## OneDrive 自動分流

v0.4.0 改用本機 Native Messaging 寫檔程式，避開 macOS OneDrive File Provider 與瀏覽器 File System Access API 的寫入問題，不再自動降級存到 Downloads。

固定目的地（相對使用者家目錄）：

| 分流 | 目的地 |
|---|---|
| CDK | `~/Library/CloudStorage/OneDrive-CDKGlobalLLC/transcript` |
| Tao | `~/Library/CloudStorage/OneDrive-TaoDigitalSolutionsInc/transcript` |

### 在 Arc 設定一次

1. 停止現有擷取並確認存檔。到 `chrome://extensions` 重新載入此目錄的擴充功能，確認版本 **0.4.0**，並允許新增的 `nativeMessaging` 權限。
2. CDK workspace：點擴充功能圖示，將 **OneDrive 分流** 選為 **固定存入 CDK OneDrive**。
3. TaoDigital workspace：同樣選為 **固定存入 Tao OneDrive**。
4. 在兩邊各按 **測試 OneDrive 連線**，確認顯示正確路徑及已掛載。
5. 重新整理 Teams 分頁，面板也有相同的分流選單與 📁 連線檢查。

Arc 沒有供此擴充功能使用的 workspace 名稱 API，設定是儲存在 **Arc profile**，不是依目前作用中的 workspace 猜測。此機的 CDK 和 TaoDigital 使用不同 profile，因此可各自設定一次。同一 profile 的其他 workspace 會共用設定。

「依 Teams 帳號自動辨識」模式接受 `cdk.com`／`taodigitalsolutions.com`，不使用聊天或參與者的 email。若找不到明確帳號或有多個帳號，需手動選擇分流；不會猜測目的地。建議此機採用固定 profile 分流。

每場開始擷取時固定目的地；中途更改分流設定適用下一場。補存舊稿優先使用該稿原本的目的地／帳號網域，避免補存至另一家公司。

### 安裝本機寫檔程式

擴充功能 ID 可在 `chrome://extensions` 的開發人員模式下取得。（ID 會依安裝而異，以 `chrome://extensions` 顯示的為準）

```bash
cd /Users/Erik.Chan/Desktop/teams-transcript-capture-main
python3 native/install.py --extension-id <你的擴充功能ID>
```

安裝位置：`~/.local/share/teams-transcript-capture/`。安裝程式在使用者層級的 Arc／Chrome NativeMessagingHosts 目錄註冊 host，不會修改瀏覽器 profile 設定。若搬動擴充功能資料夾導致 ID 改變，請重新安裝 host，指定新 ID。

- 本機程式由瀏覽器按需啟動，無網路服務、沒有常駐監看 Downloads。
- 只允許指定的 extension origin；只提供兩個固定目的地，拒絕任意路徑、檔名路徑穿越及覆寫既有不同內容。
- 檔案本機寫入成功不代表雲端同步已完成；OneDrive 用戶端仍須正常運作。
- 同名但不同內容會另存為 `名稱 (1).md`；同內容重試不重複建立。
- 若 OneDrive 根目錄不存在，會保留暫存並報錯，不會建立假的 OneDrive 根目錄。

## 擷取與補存

- **AUTO** 預設開啟，偵測會議後自動開始；即時字幕若未能自動開啟，請在 Teams 的 More → Language and speech → Turn on live captions 開啟。
- **● 開始擷取 / ■ 停止並存檔** 可手動操作。字幕行數增加才表示有收到內容。
- **💾 補存**：逐一補存未完成的稿件。每份稿件有獨立暫存，不會因開始下一場而覆寫上一份待存稿。
- **⬇ 備份**：只有手動按此按鈕才要求瀏覽器下載備份。下載請求不代表檔案已成功寫入；不會因此刪除暫存。
- **📁**：檢查本機寫檔程式及目的地；不再要求重複授權 OneDrive FSA handle。
- 拖曳 **⠿** 可移動面板；位置保存在 profile 本機 storage，方向鍵也可微調。

擷取名稱依會議標題或 1:1 對象命名為 `會議_YYYY-MM-DD_HHMM.md`，並建立 `minutes/` 資料夾。存檔後既有的 M365 Copilot 橋接會另開分頁、傳遞 prompt 以產生英文 minutes；這與本機寫檔是分開的行為。

請在 `chrome://extensions` 檢查是否另有從 `~/teams-transcript-capture` 載入的舊版本，若有請停用舊版，避免兩份擴充功能同時擷取／開 Copilot。

## 診斷

在 **實際會議視窗內、尚未離開會議時** 按 🔍。報告包含：

- 版本、載入／診斷時間、會議控制按鈕與 DOM 選擇器命中情況。
- `routing.selection`、`captureRoute` 及 `captureTenant`。
- `saveDiagnostics.lastSave` 的結果／錯誤，以及待補存的檔名／路由清單；不含暫存逐字稿或 prompt 正文。

`events: []` 只代表此分頁自載入後沒有偵測到會議，不能證明另一個視窗是否正在開會。Teams DOM 會隨版本變動；目前不保證所有租戶的字幕按鈕都能自動開啟。若行數不增加，請開啟字幕後在會議視窗提供診斷。

已知限制：一次一場會議，尚未支援同一 profile 中多分頁同時擷取。跨 frame 字幕由 background 彙整。

## 測試

```bash
node --test tests/*.test.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
node --check content.js
node --check background.js
```

Node 測試以瀏覽器 mock 驗證路由、待存稿保留與錯誤流程；Python 測試驗證寫檔與路徑限制。瀏覽器 Native Messaging 連線仍須在重新載入後按「測試 OneDrive 連線」確認。
