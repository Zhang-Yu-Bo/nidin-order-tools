# Nidin 訂單工具（Chrome extension）

非官方的 Chrome Manifest V3 extension，僅在 `https://order.nidin.shop/*` 自動啟用。

## 功能

- 訂單頁 `/orderListInfo/<order_id>`：複製、匯出 CSV、匯出 JSON、重新訂購。
- 菜單頁 `/menu/<store_id>`：匯入 JSON、驗證品項、經使用者確認後逐筆加入購物車。
- 支援 Nidin 的 SPA 路由切換，不需要按 F5。

工具不會前往結帳或送出訂單。點擊加入後若無法明確確認成功，該列會停止且不自動重試。

## 本機安裝

1. 先停用 Tampermonkey 內的「Nidin 訂單工具」，避免同時注入兩份介面。
2. 開啟 `chrome://extensions`。
3. 啟用「開發人員模式」。
4. 選擇「載入未封裝項目」，指定本資料夾。
5. 重新整理已開啟的 Nidin 頁面。

修改 extension 後，需在 `chrome://extensions` 重新載入 extension，並重新整理 Nidin 頁面。

## 權限與資料

- `storage`：暫存未完成的重新訂購流程。
- 網站存取範圍：僅 `https://order.nidin.shop/*`。
- 不使用分析、廣告、遠端程式碼或額外網路服務。
- 訂單暫存位於 extension 的 `chrome.storage.session`，依分頁隔離；關閉分頁、關閉 Chrome、停用、更新或重新載入 extension 時會清除。
- JSON、CSV 與剪貼簿內容只會在使用者主動操作時產生。

完整說明見 [隱私權政策](docs/PRIVACY_POLICY.md) 與 [安全設計](docs/SECURITY.md)。

## 專案結構

```text
manifest.json                 Manifest V3、最小權限與注入範圍
background/service-worker.js  分頁隔離的 storage.session 存取
content/app.js                頁面擷取、驗證、DOM 操作與 SPA 路由
icons/                        Extension 圖示
docs/                         隱私、商店文案與送審清單
store-assets/                 Chrome Web Store 圖像素材
```

網站改版時，優先檢查 `content/app.js` 頂端的 `SELECTORS`。所有輸入格式、防重複加入與價格檢查都集中保留在同一個 content script，避免跨模組狀態不一致。

## 發布

上傳前依照 [Chrome Web Store 發布清單](docs/PUBLISHING.md) 操作。發布 ZIP 必須讓 `manifest.json` 位於壓縮檔根目錄。

