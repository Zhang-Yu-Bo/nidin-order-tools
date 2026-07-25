/**
 * Shadow DOM 懸浮介面與訂單頁控制器。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const { CONFIG, SELECTORS, currentRoute, waitForCondition } = root.core;
  const { Storage } = root.storage;
  const { createPendingFromOrderFile } = root.orderData;
  const {
    extractOrderPageData,
    createOrderFileFromPage,
    resolveStoreId,
    orderTable,
    copyTable,
    downloadCsv,
    downloadJson,
  } = root.orderPage;

  // ── Shadow DOM 懸浮介面 ─────────────────────────────────────────

  function baseStyles() {
    return `
      :host { color: #202124; font: 14px/1.45 system-ui, sans-serif; }
      * { box-sizing: border-box; }
      button {
        appearance: none; border: 0; border-radius: 6px; cursor: pointer;
        font: inherit; font-weight: 600; padding: 7px 12px;
      }
      button:disabled { cursor: not-allowed; opacity: .5; }
      .primary { background: #1976d2; color: #fff; }
      .secondary { background: #eef3f8; color: #174a75; }
      .danger { background: #fff0f0; color: #a32626; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; }
      .status { border-radius: 6px; margin: 10px 0; padding: 8px 10px; }
      .info { background: #edf6ff; }
      .success { background: #eaf7ee; color: #176b35; }
      .warning { background: #fff6df; color: #735300; }
      .error { background: #fff0f0; color: #982b2b; }
    `;
  }

  function floatingStyles() {
    return `
      .widget {
        align-items: flex-start; display: flex; flex-direction: column; gap: 10px;
      }
      .panel {
        background: #fff; border: 1px solid #cfd8e3; border-radius: 10px;
        box-shadow: 0 8px 28px rgb(0 0 0 / 18%); max-height: calc(100vh - 84px);
        overflow: auto; padding: 12px; pointer-events: auto;
        width: min(440px, calc(100vw - 24px));
      }
      .panel[hidden] { display: none; }
      .title { font-size: 16px; font-weight: 700; margin: 0 0 8px; }
      .launcher {
        align-items: center; background: #1976d2; border: 2px solid #fff;
        border-radius: 50%; box-shadow: 0 4px 16px rgb(0 0 0 / 25%);
        color: #fff; display: inline-flex; font-size: 17px; height: 50px;
        justify-content: center; padding: 0; pointer-events: auto; width: 50px;
      }
      .launcher:hover { background: #1565c0; }
      .launcher:focus-visible { outline: 3px solid #90caf9; outline-offset: 2px; }
    `;
  }

  function createHost() {
    const existing = document.getElementById(CONFIG.hostId);
    if (existing) return null;

    const host = document.createElement("div");
    host.id = CONFIG.hostId;
    Object.assign(host.style, {
      position: "fixed",
      bottom: "max(12px, env(safe-area-inset-bottom))",
      left: "12px",
      pointerEvents: "none",
      zIndex: "2147483646",
    });
    document.body.appendChild(host);
    return { host, shadow: host.attachShadow({ mode: "open" }) };
  }

  function makeButton(text, className = "primary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    return button;
  }

  function createFloatingUi() {
    const created = createHost();
    if (!created) return null;

    const style = document.createElement("style");
    style.textContent = `${baseStyles()}${floatingStyles()}`;
    const widget = document.createElement("div");
    widget.className = "widget";
    const panel = document.createElement("section");
    panel.className = "panel";
    panel.id = "nidin-order-tools-panel";
    panel.hidden = true;
    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = "Nidin 訂單工具";
    const launcher = makeButton("訂", "launcher");
    launcher.setAttribute("aria-controls", panel.id);
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-label", "展開 Nidin 訂單工具");
    launcher.title = "Nidin 訂單工具";
    const setExpanded = (expanded) => {
      panel.hidden = !expanded;
      launcher.setAttribute("aria-expanded", String(expanded));
      launcher.setAttribute(
        "aria-label",
        `${expanded ? "收合" : "展開"} Nidin 訂單工具`,
      );
    };
    launcher.addEventListener("click", () => {
      setExpanded(launcher.getAttribute("aria-expanded") !== "true");
    });
    panel.append(title);
    widget.append(panel, launcher);
    created.shadow.append(style, widget);

    return { ...created, panel, setExpanded };
  }

  function showOrderNotice(message) {
    const ui = createFloatingUi();
    if (!ui) return;
    const notice = document.createElement("div");
    notice.className = "status error";
    notice.textContent = message;
    ui.panel.append(notice);
    ui.setExpanded(true);
  }

  function createOrderUi() {
    const ui = createFloatingUi();
    if (!ui) return null;

    const actions = document.createElement("div");
    actions.className = "row";
    const copyButton = makeButton("複製");
    const csvExportButton = makeButton("匯出 CSV");
    const jsonExportButton = makeButton("匯出 JSON");
    const reorderButton = makeButton("重新訂購");
    actions.append(
      copyButton,
      csvExportButton,
      jsonExportButton,
      reorderButton,
    );
    ui.panel.append(actions);
    return {
      ...ui,
      copyButton,
      csvExportButton,
      jsonExportButton,
      reorderButton,
    };
  }

  async function initOrderPage(expectedRouteKey, generation, lifecycle) {
    const { routeIsActive } = lifecycle;
    try {
      await waitForCondition(() => {
        const rows = document.querySelectorAll(SELECTORS.orderRows);
        const total = document.querySelector(SELECTORS.orderSubtotal);
        return rows.length && total;
      }, { message: "找不到訂單商品與合計區，可能是網站版面已更新。" });
    } catch (error) {
      if (!routeIsActive(expectedRouteKey, generation)) return;
      showOrderNotice(error.message);
      return;
    }
    if (!routeIsActive(expectedRouteKey, generation)) return;

    const ui = createOrderUi();
    if (!ui) return;
    const {
      copyButton,
      csvExportButton,
      jsonExportButton,
      reorderButton,
    } = ui;

    copyButton.addEventListener("click", async () => {
      try {
        const data = extractOrderPageData();
        await copyTable(orderTable(data.rawRows, data.summary));
        alert("已複製，可貼到 Excel 或 Google 試算表。");
      } catch (error) {
        alert(`複製失敗：${error.message}`);
      }
    });

    csvExportButton.addEventListener("click", () => {
      try {
        const data = extractOrderPageData();
        downloadCsv(orderTable(data.rawRows, data.summary, true));
      } catch (error) {
        alert(`匯出 CSV 失敗：${error.message}`);
      }
    });

    jsonExportButton.addEventListener("click", () => {
      try {
        const route = currentRoute();
        const storeId = resolveStoreId();
        if (!storeId) return;
        const { orderFile } = createOrderFileFromPage(
          storeId,
          route.orderId,
        );
        downloadJson(orderFile);
      } catch (error) {
        alert(`匯出 JSON 失敗：${error.message}`);
      }
    });

    reorderButton.addEventListener("click", async () => {
      try {
        const route = currentRoute();
        const storeId = resolveStoreId();
        if (!storeId) return;
        const { orderFile, ignoredRows } = createOrderFileFromPage(
          storeId,
          route.orderId,
        );
        const accepted = confirm(
          `即將前往店家 ${storeId} 的普通菜單。\n` +
            `有效品項：${orderFile.items.length} 筆\n` +
            `忽略品項：${ignoredRows.length} 筆\n\n` +
            "菜單頁只會先驗證；仍需按「開始加入」才會改變購物車。",
        );
        if (!accepted) return;

        const pending = createPendingFromOrderFile(orderFile, {
          source: "order-page",
          ignoredRows,
          autoValidate: true,
        });
        await Storage.save(pending);
        location.assign(`${CONFIG.origin}/menu/${storeId}`);
      } catch (error) {
        alert(`無法重新訂購：${error.message}`);
      }
    });
  }

  function createMenuUi() {
    const ui = createFloatingUi();
    if (!ui) return null;

    const style = document.createElement("style");
    style.textContent = `
      .meta { color: #5f6368; margin: 6px 0 10px; }
      .progress { color: #5f6368; font-size: 12px; margin-top: 7px; }
      .report { border-collapse: collapse; font-size: 12px; margin-top: 10px; width: 100%; }
      .report th, .report td {
        border-top: 1px solid #e3e7eb; padding: 6px 4px; text-align: left;
        vertical-align: top; word-break: break-word;
      }
      .report th { background: #f7f9fb; position: sticky; top: 0; }
      .product { max-width: 150px; }
      .detail { color: #5f6368; font-size: 11px; margin-top: 2px; }
      input[type=file] { display: none; }
    `;

    const meta = document.createElement("div");
    meta.className = "meta";
    const actions = document.createElement("div");
    actions.className = "row";
    const importButton = makeButton("匯入 JSON");
    const validateButton = makeButton("驗證品項", "secondary");
    const startButton = makeButton("開始加入");
    const stopButton = makeButton("停止", "danger");
    const clearButton = makeButton("清除", "secondary");
    validateButton.disabled = true;
    startButton.disabled = true;
    stopButton.disabled = true;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    const status = document.createElement("div");
    status.className = "status info";
    status.setAttribute("aria-live", "polite");
    status.textContent = "請匯入 JSON，或從訂單頁使用「重新訂購」。";
    const progress = document.createElement("div");
    progress.className = "progress";
    const report = document.createElement("table");
    report.className = "report";
    actions.append(
      importButton,
      validateButton,
      startButton,
      stopButton,
      clearButton,
    );
    ui.panel.append(meta, actions, fileInput, status, progress, report);
    ui.shadow.append(style);

    return {
      host: ui.host,
      meta,
      importButton,
      validateButton,
      startButton,
      stopButton,
      clearButton,
      fileInput,
      status,
      progress,
      report,
      setExpanded: ui.setExpanded,
    };
  }

  root.pageUi = Object.freeze({
    showOrderNotice,
    createMenuUi,
    initOrderPage,
  });
})();
