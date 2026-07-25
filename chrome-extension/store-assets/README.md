# 商店圖像素材

- `promo-source.svg`、`marquee-source.svg`：可維護的宣傳圖來源。
- `promo-440x280.png`：Chrome Web Store 小型宣傳圖。
- `marquee-1400x560.png`：選用 marquee 圖。
- `screenshot-1280x800.png`：公開菜單頁上的實際 extension 懸浮介面。

重新產生圖示與宣傳圖：

```powershell
.\tools\render-svg-assets.ps1
```

重新擷取公開菜單頁畫面：

```powershell
node .\tools\capture-store-screenshot.cjs
```

Chrome 150 的命令列 headless 測試若未載入未封裝 extension，截圖工具會把同一份 `content/app.js` 注入公開 Nidin 頁面，只用於產生一致的 UI 圖像。送審前仍應在人工安裝的 extension 中確認畫面與此截圖一致。

