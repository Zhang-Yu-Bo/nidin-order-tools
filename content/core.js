/**
 * 共用設定、選擇器、路由判斷與無狀態工具。
 */
(() => {
  "use strict";

  const root = Object.create(null);
  Object.defineProperty(globalThis, "NidinOrderTools", {
    value: root,
    configurable: true,
  });

  const CONFIG = Object.freeze({
    schemaVersion: 1,
    storageKey: "nidin.orderTools.pending.v1",
    orderFileFormat: "nidin-order-tools/order",
    orderFileSchemaVersion: 1,
    hostId: "nidin-order-tools",
    maxFileBytes: 1024 * 1024,
    maxRows: 500,
    maxQuantity: 999,
    maxOptionResetClicks: 12,
    domTimeoutMs: 12_000,
    searchResultTimeoutMs: 6_000,
    menuSettleMs: 400,
    menuSettleTimeoutMs: 2_000,
    menuScanDelayMs: 240,
    maxMenuScanSteps: 120,
    shortDelayMs: 160,
    origin: "https://order.nidin.shop",
  });

  const HEADERS = Object.freeze([
    "品項",
    "額外資訊(冰/糖/加料)",
    "價格",
    "訂購者",
    "數量",
    "收款",
  ]);
  const OPTIONAL_HEADERS = Object.freeze(["店家ID", "來源訂單ID"]);
  const READY_STATUSES = new Set(["可加入"]);
  const ADD_BUTTON_TEXT = new Set(["加入購物車", "加入餐點"]);
  const AUTH_BUTTON_TEXT = new Set(["登入後訂購", "驗證後訂購"]);

  // 網站改版時，優先只調整這個區域。
  const SELECTORS = Object.freeze({
    orderRows: ".prod-list",
    orderSubtotal: ".subtotal_price",
    orderProductName: ".text-bold.q-mr-sm",
    orderProductNameFallback: ".text-bold .text-bold, .text-bold",
    orderDetail: ".prod-detail-font span",
    orderPaidBadge: '.q-badge[aria-label="已收款"]',
    menuRoot: ".menu-block",
    menuList: ".menu-list",
    menuSearchButton:
      'button.straight-line, [role="button"].straight-line, [data-testid="menu-search"]',
    searchCard: ".search-modal",
    searchInput: ".search-input input",
    productJson: 'script[type="application/ld+json"]',
    productModal: ".nidin-prod-modal",
    modalTitle: ".q-card__actions .text-bold.font-size-subtitle-1",
    option: ".option-block .option",
    optionBlock: ".option-block",
    adjustment: ".adjust",
    modalActions: '.q-card__actions, .q-card-actions, [class*="card-actions"]',
    quantityInput: '.input-number input[type="number"]',
    closeIcon: 'img[alt="close_icon"]',
    cartLink: "a[href]",
    notification: '.q-notification, .q-notification__message, [role="status"]',
  });

  class WorkflowError extends Error {
    constructor(code, message, fatal = false) {
      super(message);
      this.name = "WorkflowError";
      this.code = code;
      this.fatal = fatal;
    }
  }

  function currentRoute(pathname = location.pathname) {
    let match = pathname.match(/^\/orderListInfo\/(\d+)\/?$/u);
    if (match) return { kind: "order", orderId: match[1] };

    match = pathname.match(/^\/menu\/(\d+)(?:\/(\d+))?\/?$/u);
    if (match) {
      return {
        kind: "menu",
        storeId: match[1],
        targetOrderId: match[2] || null,
      };
    }
    return { kind: "other" };
  }

  function normalizeText(value) {
    return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
  }

  function cleanText(element) {
    return normalizeText(element?.textContent || "");
  }

  function cleanBuyerName(value) {
    return normalizeText(value)
      .replace(/^account_circle\s*/u, "")
      .replace(/^訂購人姓名\s*[：:]?\s*/u, "")
      .trim();
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      element.getClientRects().length > 0
    );
  }

  function isDisabled(element) {
    return (
      !element ||
      element.disabled ||
      element.getAttribute("disabled") !== null ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("disabled")
    );
  }

  function clickElement(element) {
    if (!isVisible(element) || isDisabled(element)) {
      throw new WorkflowError("NOT_CLICKABLE", "目標目前不可點擊。");
    }
    element.click();
  }

  function waitForCondition(check, options = {}) {
    const {
      timeout = CONFIG.domTimeoutMs,
      root = document.documentElement,
      message = "等待頁面回應逾時。",
      signal,
    } = options;

    return new Promise((resolve, reject) => {
      let observer = null;
      let timer = null;

      const finish = (callback, value) => {
        observer?.disconnect();
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback(value);
      };

      const test = () => {
        if (signal?.aborted) {
          finish(reject, new WorkflowError("ABORTED", "操作已停止。"));
          return true;
        }
        try {
          const result = check();
          if (result) {
            finish(resolve, result);
            return true;
          }
        } catch (error) {
          finish(reject, error);
          return true;
        }
        return false;
      };

      const onAbort = () =>
        finish(reject, new WorkflowError("ABORTED", "操作已停止。"));

      if (test()) return;

      observer = new MutationObserver(test);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (!test()) {
          finish(reject, new WorkflowError("TIMEOUT", message));
        }
      }, timeout);
    });
  }

  function setNativeValue(input, value) {
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) throw new WorkflowError("INPUT", "無法設定輸入欄位。");

    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  function ownText(element) {
    return normalizeText(
      [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" "),
    );
  }

  function hashText(value) {
    let hash = 0x811c9dc5;
    for (const character of String(value)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
  }

  function makeRowId(rowNumber, fields) {
    return `r${rowNumber}-${
      hashText(`${rowNumber}\u001f${fields.join("\u001f")}`)
    }`;
  }

  function parsePrice(value) {
    const text = normalizeText(value).replace(/[$,\s]/gu, "");
    if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function sameMoney(left, right) {
    return Math.abs(Number(left) - Number(right)) < 0.001;
  }

  function protectSpreadsheetCell(value) {
    const text = String(value ?? "");
    return /^[\t\r\n ]*[=+\-@]/u.test(text) ? `'${text}` : text;
  }

  function csvEscape(value) {
    const safe = protectSpreadsheetCell(value);
    return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
  }

  function encodeCsv(table) {
    return `\uFEFF${
      table.map((row) => row.map(csvEscape).join(",")).join("\r\n")
    }`;
  }

  function routeKey(route = currentRoute()) {
    if (route.kind === "order") return `order:${route.orderId}`;
    if (route.kind === "menu") return `menu:${route.storeId}`;
    return "other";
  }

  root.core = Object.freeze({
    CONFIG,
    HEADERS,
    OPTIONAL_HEADERS,
    READY_STATUSES,
    ADD_BUTTON_TEXT,
    AUTH_BUTTON_TEXT,
    SELECTORS,
    WorkflowError,
    currentRoute,
    routeKey,
    normalizeText,
    cleanText,
    cleanBuyerName,
    delay,
    nextFrame,
    isVisible,
    isDisabled,
    clickElement,
    waitForCondition,
    setNativeValue,
    ownText,
    hashText,
    makeRowId,
    parsePrice,
    sameMoney,
    protectSpreadsheetCell,
    encodeCsv,
  });
})();
