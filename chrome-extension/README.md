# Chrome Extension

此資料夾是可以直接載入 Chrome 的 Nidin 訂單工具。專案介紹、功能與使用方式請參閱[根目錄 README](../README.md)。

## 載入方式

1. 先停用 Tampermonkey 內的「Nidin 訂單工具」，避免同時注入兩份介面。
2. 開啟 `chrome://extensions`。
3. 啟用「開發人員模式」。
4. 選擇「載入未封裝項目」，指定本資料夾。
5. 重新整理已開啟的 Nidin 頁面。

修改 extension 後，需在 `chrome://extensions` 重新載入 extension，並重新整理 Nidin 頁面。

## 專案結構

```text
manifest.json                    權限、網址範圍與 content script 載入順序
background/service-worker.js     分頁隔離的 storage.session 存取
content/core.js                  設定、選擇器、路由與共用工具
content/order-data.js            JSON 與暫存資料驗證
content/storage.js               Content script 的暫存介面
content/order-page.js            訂單擷取、複製與匯出
content/page-ui.js               Shadow DOM 懸浮介面
content/menu-dom.js              菜單搜尋與商品規格操作
content/cart-validation.js       購物車狀態與品項驗證
content/menu-workflow.js         匯入、驗證與加入流程
content/app.js                   SPA 路由生命週期與啟動入口
```

各模組依 `manifest.json` 所列順序初始化，透過只存在於 extension isolated world 的暫時命名空間交換唯讀介面；`app.js` 啟動後會移除該命名空間。

網站改版時，優先檢查 `content/core.js` 的 `SELECTORS`。菜單 DOM 調整集中在 `content/menu-dom.js`，流程狀態則由 `content/menu-workflow.js` 管理。

## 發布

上傳前依照 [Chrome Web Store 發布清單](docs/PUBLISHING.md) 操作。發布 ZIP 必須讓 `manifest.json` 位於壓縮檔根目錄。
