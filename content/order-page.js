/**
 * 訂單頁資料擷取、複製與匯出。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const {
    CONFIG,
    HEADERS,
    OPTIONAL_HEADERS,
    SELECTORS,
    WorkflowError,
    currentRoute,
    normalizeText,
    cleanText,
    cleanBuyerName,
    protectSpreadsheetCell,
    encodeCsv,
  } = root.core;
  const { normalizeRecords, createOrderFile } = root.orderData;

  // ── 訂單頁擷取、複製與匯出 ─────────────────────────────────────

  function extractBuyer(row) {
    const icon = [...row.querySelectorAll("i.material-icons")].find(
      (element) => normalizeText(element.textContent) === "account_circle",
    );
    if (icon?.parentElement) {
      const buyer = cleanBuyerName(icon.parentElement.textContent);
      if (buyer) return buyer;
    }

    const group = row.parentElement?.parentElement;
    return cleanBuyerName(
      group?.querySelector(".font-size-subtitle-1")?.textContent,
    );
  }

  function extractOrderPageData() {
    const rowElements = [...document.querySelectorAll(SELECTORS.orderRows)];
    const subtotal = document.querySelector(SELECTORS.orderSubtotal);
    if (!rowElements.length || !subtotal) {
      throw new WorkflowError("ORDER_DOM", "找不到訂單商品或合計區。");
    }

    const rawRows = rowElements.map((row, index) => {
      const nameElement = row.querySelector(SELECTORS.orderProductName) ||
        row.querySelector(SELECTORS.orderProductNameFallback);
      const detail = cleanText(row.querySelector(SELECTORS.orderDetail));
      const price = detail.match(/\$\s*([\d,.]+(?:\.\d+)?)/u)?.[1] || "";
      const quantity = detail.match(/\/\s*(\d+)\s*份/u)?.[1] || "";
      const rawOptions = detail
        .replace(/\s*\$\s*[\d,.]+(?:\.\d+)?.*$/u, "")
        .replace(/\/\s*$/u, "")
        .trim();
      const group = row.parentElement?.parentElement;
      const paid = group?.querySelector(SELECTORS.orderPaidBadge) ? "Y" : "N";

      return {
        rowNumber: index + 2,
        productName: cleanText(nameElement),
        rawOptions,
        price,
        buyer: extractBuyer(row),
        quantity,
        paid,
      };
    });

    const subtotalText = normalizeText(subtotal.textContent).replace(
      /\s+/gu,
      "",
    );
    const summary = {
      productName: "合計",
      rawOptions: "",
      price: subtotalText.match(/\$([\d,.]+(?:\.\d+)?)/u)?.[1] || "",
      buyer: "",
      quantity: subtotalText.match(/\/(\d+)份/u)?.[1] || "",
      paid: "",
    };
    return { rawRows, summary };
  }

  function createOrderFileFromPage(storeId, sourceOrderId) {
    const data = extractOrderPageData();
    const normalized = normalizeRecords(data.rawRows, { sourceOrderId });
    normalized.ignored.push({
      rowNumber: data.rawRows.length + 2,
      productName: "合計",
      reason: "忽略「合計」列",
    });
    if (!normalized.rows.length) {
      throw new WorkflowError(
        "ORDER_EMPTY",
        "此訂單沒有可重新訂購的有效品項。",
      );
    }
    return {
      orderFile: createOrderFile(normalized.rows, storeId, sourceOrderId),
      ignoredRows: normalized.ignored,
    };
  }

  function collectMenuStoreIds() {
    const ids = new Set();

    const addUrl = (value) => {
      if (!value) return;
      try {
        const url = new URL(value, location.origin);
        const match = url.pathname.match(/^\/(?:menu|store)\/(\d+)\/?$/u);
        if (url.origin === CONFIG.origin && match) ids.add(match[1]);
      } catch {
        // 非 URL 內容不是店家依據。
      }
    };

    document.querySelectorAll("a[href]").forEach((anchor) =>
      addUrl(anchor.getAttribute("href"))
    );
    document.querySelectorAll(SELECTORS.productJson).forEach((script) => {
      try {
        const data = JSON.parse(script.textContent);
        const visit = (value) => {
          if (!value || typeof value !== "object") return;
          if (typeof value.url === "string") addUrl(value.url);
          Object.values(value).forEach(visit);
        };
        visit(data);
      } catch {
        // 忽略非有效 JSON-LD。
      }
    });
    return [...ids];
  }

  function parseMenuInput(value) {
    const text = normalizeText(value);
    if (!text) return null;
    let url;
    try {
      url = new URL(text, CONFIG.origin);
    } catch {
      return null;
    }
    const match = url.pathname.match(/^\/(?:menu|store)\/(\d+)\/?$/u);
    return url.origin === CONFIG.origin && match ? match[1] : null;
  }

  function resolveStoreId() {
    const detected = collectMenuStoreIds();
    if (detected.length === 1) return detected[0];

    const reason = detected.length > 1
      ? `頁面上找到多個店家 ID（${detected.join("、")}），無法安全判定。`
      : "頁面上找不到明確的店家連結。";
    const input = prompt(
      `${reason}\n請輸入 /menu/<店家ID>、/store/<店家ID> 或完整的 Nidin 網址：`,
      "",
    );
    if (input === null) return null;
    const storeId = parseMenuInput(input);
    if (!storeId) {
      throw new WorkflowError(
        "STORE_INPUT",
        "店家網址格式不正確；只接受同站的 /menu/<數字> 或 /store/<數字>。",
      );
    }
    return storeId;
  }

  function orderTable(rawRows, summary, includeMetadata = false) {
    const route = currentRoute();
    const storeIds = collectMenuStoreIds();
    const storeId = storeIds.length === 1 ? storeIds[0] : "";
    const header = includeMetadata
      ? [...HEADERS, ...OPTIONAL_HEADERS]
      : [...HEADERS];
    const toCells = (row) => [
      row.productName,
      row.rawOptions,
      row.price,
      row.buyer,
      row.quantity,
      row.paid,
    ];
    const rows = rawRows.map((row) => {
      const cells = toCells(row);
      return includeMetadata ? [...cells, storeId, route.orderId] : cells;
    });
    const summaryCells = toCells(summary);
    return [
      header,
      ...rows,
      includeMetadata
        ? [...summaryCells, storeId, route.orderId]
        : summaryCells,
    ];
  }

  function buildClipboardHtml(table) {
    const element = document.createElement("table");
    table.forEach((row, rowIndex) => {
      const tr = document.createElement("tr");
      row.forEach((value) => {
        const cell = document.createElement(rowIndex === 0 ? "th" : "td");
        cell.textContent = protectSpreadsheetCell(value);
        tr.appendChild(cell);
      });
      element.appendChild(tr);
    });
    return element.outerHTML;
  }

  async function copyTable(table) {
    const safeTable = table.map((row) => row.map(protectSpreadsheetCell));
    const tsv = safeTable.map((row) => row.join("\t")).join("\r\n");
    const html = buildClipboardHtml(table);

    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([tsv], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return;
      } catch {
        // 改用純文字。
      }
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(tsv);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = tsv;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new WorkflowError("CLIPBOARD", "瀏覽器拒絕存取剪貼簿。");
  }

  function downloadFile(content, type, filename) {
    const url = URL.createObjectURL(
      new Blob([content], { type }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadCsv(table) {
    downloadFile(
      encodeCsv(table),
      "text/csv;charset=utf-8",
      "order.csv",
    );
  }

  function downloadJson(orderFile) {
    downloadFile(
      `${JSON.stringify(orderFile, null, 2)}\n`,
      "application/json;charset=utf-8",
      `order-${orderFile.sourceOrderId}.json`,
    );
  }

  root.orderPage = Object.freeze({
    extractOrderPageData,
    createOrderFileFromPage,
    resolveStoreId,
    orderTable,
    copyTable,
    downloadCsv,
    downloadJson,
  });
})();
