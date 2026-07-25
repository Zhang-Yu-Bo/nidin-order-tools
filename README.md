# Nidin 訂單工具

非官方的 Chrome Extension，用來備份 Nidin 訂單，並協助將品項重新加入一般訂單的購物車。

擴充功能只會在 `https://order.nidin.shop/*` 自動啟用，不會自動結帳或送出訂單。

## 功能

- 訂單頁：複製訂單、匯出 CSV、匯出 JSON、前往原店家重新訂購。
- 菜單頁：匯入 JSON、驗證商品與規格、經使用者確認後逐筆加入購物車。
- 支援 Nidin 的 SPA 路由切換，不需要重新整理頁面。
- 加入結果不明時立即停止，不會自動重試而造成重複品項。

## 安裝

1. 下載或 clone 此 repository。
2. 開啟 Chrome 的 `chrome://extensions`。
3. 啟用右上角的「開發人員模式」。
4. 選擇「載入未封裝項目」。
5. 指定 [`chrome-extension`](chrome-extension) 資料夾。
6. 若已安裝相同用途的 Tampermonkey 腳本，請先停用，避免介面重複執行。

## 使用方式

在 `/orderListInfo/<order_id>` 訂單頁開啟左下角的懸浮按鈕，即可複製或匯出訂單。按下「重新訂購」後，工具會暫存資料並前往對應的 `/menu/<store_id>` 菜單頁。

在菜單頁可以匯入先前匯出的 JSON。請先按「驗證品項」檢查商品、規格與價格；確認結果後，再由使用者按「開始加入」。

## 安全與隱私

- 僅要求 `storage` 權限與 Nidin 訂單網站的存取範圍。
- 訂單資料只在本機處理，不會傳送給開發者、分析或廣告服務。
- 未完成流程使用 `chrome.storage.session` 依分頁暫存。
- 不讀取密碼、Cookie、登入權杖或付款資料。
- 不使用遠端程式碼或第三方套件。

詳細內容請參閱[隱私權政策](chrome-extension/docs/PRIVACY_POLICY.md)與[安全設計](chrome-extension/docs/SECURITY.md)。

## 專案結構

```text
chrome-extension/
├─ manifest.json       # Manifest V3、權限與載入順序
├─ background/         # 分頁隔離的暫存資料
├─ content/            # 訂單、菜單、驗證、介面與路由模組
├─ tests/              # Node.js 自動測試
├─ docs/               # 隱私、安全與上架文件
├─ icons/              # 擴充功能圖示
└─ store-assets/       # Chrome Web Store 圖像素材
```

網站版面改動時，請先檢查 [`content/core.js`](chrome-extension/content/core.js) 的 `SELECTORS`；商品規格操作集中在 [`content/menu-dom.js`](chrome-extension/content/menu-dom.js)。

## 開發檢查

執行測試：

```powershell
node --test chrome-extension/tests/app.test.cjs chrome-extension/tests/manifest.test.cjs chrome-extension/tests/storage.test.cjs
```

若已安裝 Deno，也可以執行靜態檢查：

```powershell
deno lint chrome-extension/background/service-worker.js chrome-extension/content/*.js chrome-extension/tests/*.cjs
```

網站互動仍需以「載入未封裝項目」進行人工測試。

## 參考專案

功能與使用情境曾參考 Greasy Fork 上的 [Nidin 你訂－訂單一鍵複製／下載](https://greasyfork.org/zh-TW/scripts/534694-nidin-你訂-訂單一鍵複製-下載)。

本專案與 Nidin 及上述參考專案皆無官方關係。

## 授權

[MIT License](LICENSE)
