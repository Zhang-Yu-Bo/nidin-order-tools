# Chrome Web Store 上架資料

## 基本資料

- 名稱：`Nidin 訂單工具（非官方）`
- 語言：繁體中文（`zh_TW`）
- 建議分類：生產力工具
- 開發者顯示名稱：`Yu-Bo Zhang`
- 支援信箱：`weber89521@gmail.com`
- 隱私權政策網址：`https://github.com/Zhang-Yu-Bo/nidin-order-tools/blob/main/docs/PRIVACY_POLICY.md`
- 可見性：Public

## 簡短說明

在 Nidin 訂單頁匯出資料，並於菜單頁驗證後協助重新加入品項。

## 詳細說明

Nidin 訂單工具是一個非官方的本機輔助工具，協助使用者備份訂單並安全地重新建立普通購物車。

主要功能：

- 在訂單頁複製資料，或匯出 CSV、JSON。
- 從訂單頁直接前往對應店家的普通菜單。
- 在菜單頁匯入 JSON，逐項驗證商品、規格與價格。
- 經使用者確認後，以 DOM 操作逐筆加入購物車。
- 保留進度並避免結果不明時重複加入。

Extension 不會自動結帳、送出訂單或清空購物車。所有訂單資料只在本機處理，不會傳送給開發者或第三方。

本 extension 與 Nidin 並無官方關係。

## 單一用途

在 Nidin 訂單與菜單頁提供訂單資料備份、驗證及重新加入購物車的本機輔助功能。

## 權限理由

### `storage`

使用 `chrome.storage.session` 暫存目前分頁尚未完成的重新訂購流程，讓同一分頁從訂單頁跳轉菜單頁後可接續處理。資料不跨瀏覽器工作階段保存。

### `https://order.nidin.shop/*`

只在 Nidin 訂單與菜單頁讀取畫面中的品項資料、顯示懸浮操作介面，並在使用者明確確認後操作商品 DOM。沒有其他網站權限。

## 隱私權欄位建議

- 遠端程式碼：否。
- 分析與廣告：無。
- 對外傳輸資料：無。
- 本機處理的資料類型：
  - 個人識別資訊：訂購人顯示名稱。
  - 網站內容：訂單品項、規格、價格、數量、收款狀態及識別碼。
  - 使用者提供內容：主動匯入的訂單 JSON。
- 不處理登入憑證、Cookie、付款卡號或其他付款憑證。

送審時的勾選內容必須與實際 Dashboard 選項及 `PRIVACY_POLICY.md` 一致。

## 圖像素材

- 商店圖示：`icons/icon-128.png`
- 小型宣傳圖：`store-assets/promo-440x280.png`
- 功能截圖：`store-assets/screenshot-1280x800.png`
- 選用 marquee：`store-assets/marquee-1400x560.png`
