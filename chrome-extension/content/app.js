/**
 * Nidin 訂單工具的隔離 content script。
 *
 * 維護順序：
 * 1. 網站改版時先檢查 SELECTORS。
 * 2. JSON 與暫存資料一律先通過 validate* 函式。
 * 3. 任何購物車變更都必須保留明確確認與「不自動重試」原則。
 */
(() => {
  'use strict';

  const CONFIG = Object.freeze({
    schemaVersion: 1,
    storageKey: 'nidin.orderTools.pending.v1',
    orderFileFormat: 'nidin-order-tools/order',
    orderFileSchemaVersion: 1,
    hostId: 'nidin-order-tools',
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
    origin: 'https://order.nidin.shop'
  });

  const HEADERS = Object.freeze([
    '品項',
    '額外資訊(冰/糖/加料)',
    '價格',
    '訂購者',
    '數量',
    '收款'
  ]);
  const OPTIONAL_HEADERS = Object.freeze(['店家ID', '來源訂單ID']);
  const READY_STATUSES = new Set(['可加入']);
  const ADD_BUTTON_TEXT = new Set(['加入購物車', '加入餐點']);
  const AUTH_BUTTON_TEXT = new Set(['登入後訂購', '驗證後訂購']);

  // 網站改版時，優先只調整這個區域。
  const SELECTORS = Object.freeze({
    orderRows: '.prod-list',
    orderSubtotal: '.subtotal_price',
    orderProductName: '.text-bold.q-mr-sm',
    orderProductNameFallback: '.text-bold .text-bold, .text-bold',
    orderDetail: '.prod-detail-font span',
    orderPaidBadge: '.q-badge[aria-label="已收款"]',
    menuRoot: '.menu-block',
    menuList: '.menu-list',
    menuSearchButton:
      'button.straight-line, [role="button"].straight-line, [data-testid="menu-search"]',
    searchCard: '.search-modal',
    searchInput: '.search-input input',
    productJson: 'script[type="application/ld+json"]',
    productModal: '.nidin-prod-modal',
    modalTitle: '.q-card__actions .text-bold.font-size-subtitle-1',
    option: '.option-block .option',
    optionBlock: '.option-block',
    adjustment: '.adjust',
    modalActions: '.q-card__actions, .q-card-actions, [class*="card-actions"]',
    quantityInput: '.input-number input[type="number"]',
    closeIcon: 'img[alt="close_icon"]',
    cartLink: 'a[href]',
    notification: '.q-notification, .q-notification__message, [role="status"]'
  });

  class WorkflowError extends Error {
    constructor(code, message, fatal = false) {
      super(message);
      this.name = 'WorkflowError';
      this.code = code;
      this.fatal = fatal;
    }
  }

  // 暫存資料只透過 service worker 存入 extension-owned storage.session。
  async function storageRequest(action, value) {
    if (!globalThis.chrome?.runtime?.id) {
      throw new WorkflowError('EXTENSION_CONTEXT', 'Chrome extension 已重新載入，請重新整理頁面。');
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        channel: CONFIG.storageKey,
        action,
        value
      });
    } catch {
      throw new WorkflowError('EXTENSION_CONTEXT', '無法連線至 Chrome extension，請重新整理頁面。');
    }
    if (!response?.ok) {
      throw new WorkflowError('STORAGE', response?.error || '暫存資料操作失敗。');
    }
    return response.value;
  }

  const Storage = Object.freeze({
    async load() {
      const value = await storageRequest('load');
      return value ? validatePending(value) : null;
    },
    async save(pending) {
      const value = validatePending(pending);
      await storageRequest('save', value);
    },
    async remove() {
      await storageRequest('remove');
    },
    async has() {
      return Boolean(await storageRequest('has'));
    }
  });

  function currentRoute(pathname = location.pathname) {
    let match = pathname.match(/^\/orderListInfo\/(\d+)\/?$/u);
    if (match) return { kind: 'order', orderId: match[1] };

    match = pathname.match(/^\/menu\/(\d+)(?:\/(\d+))?\/?$/u);
    if (match) {
      return {
        kind: 'menu',
        storeId: match[1],
        targetOrderId: match[2] || null
      };
    }
    return { kind: 'other' };
  }

  function normalizeText(value) {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  }

  function cleanText(element) {
    return normalizeText(element?.textContent || '');
  }

  function cleanBuyerName(value) {
    return normalizeText(value)
      .replace(/^account_circle\s*/u, '')
      .replace(/^訂購人姓名\s*[：:]?\s*/u, '')
      .trim();
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      element.getClientRects().length > 0
    );
  }

  function isDisabled(element) {
    return (
      !element ||
      element.disabled ||
      element.getAttribute('disabled') !== null ||
      element.getAttribute('aria-disabled') === 'true' ||
      element.classList.contains('disabled')
    );
  }

  function clickElement(element) {
    if (!isVisible(element) || isDisabled(element)) {
      throw new WorkflowError('NOT_CLICKABLE', '目標目前不可點擊。');
    }
    element.click();
  }

  function waitForCondition(check, options = {}) {
    const {
      timeout = CONFIG.domTimeoutMs,
      root = document.documentElement,
      message = '等待頁面回應逾時。',
      signal
    } = options;

    return new Promise((resolve, reject) => {
      let observer = null;
      let timer = null;

      const finish = (callback, value) => {
        observer?.disconnect();
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };

      const test = () => {
        if (signal?.aborted) {
          finish(reject, new WorkflowError('ABORTED', '操作已停止。'));
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
        finish(reject, new WorkflowError('ABORTED', '操作已停止。'));

      if (test()) return;

      observer = new MutationObserver(test);
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        if (!test()) {
          finish(reject, new WorkflowError('TIMEOUT', message));
        }
      }, timeout);
    });
  }

  function setNativeValue(input, value) {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new WorkflowError('INPUT', '無法設定輸入欄位。');

    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  }

  function ownText(element) {
    return normalizeText(
      [...element.childNodes]
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent)
        .join(' ')
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
    return `r${rowNumber}-${hashText(`${rowNumber}\u001f${fields.join('\u001f')}`)}`;
  }

  function parsePrice(value) {
    const text = normalizeText(value).replace(/[$,\s]/gu, '');
    if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function sameMoney(left, right) {
    return Math.abs(Number(left) - Number(right)) < 0.001;
  }

  function protectSpreadsheetCell(value) {
    const text = String(value ?? '');
    return /^[\t\r\n ]*[=+\-@]/u.test(text) ? `'${text}` : text;
  }

  function csvEscape(value) {
    const safe = protectSpreadsheetCell(value);
    return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
  }

  function encodeCsv(table) {
    return `\uFEFF${table.map(row => row.map(csvEscape).join(',')).join('\r\n')}`;
  }

  // ── 訂單資料格式與輸入驗證 ─────────────────────────────────────

  function normalizeRecords(records, metadata = {}) {
    const rows = [];
    const ignored = [];

    records.forEach((record, index) => {
      const rowNumber = record.rowNumber ?? index + 2;
      const productName = normalizeText(record.productName);
      const rawOptions = normalizeText(record.rawOptions);
      const price = parsePrice(record.price);
      const buyer = cleanBuyerName(record.buyer);
      const quantityText = normalizeText(record.quantity);
      const quantity = /^\d+$/u.test(quantityText) ? Number(quantityText) : NaN;

      let reason = '';
      if (!productName) reason = '空白品項';
      else if (productName === '無商品' || productName === '合計') {
        reason = `忽略「${productName}」列`;
      } else if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > CONFIG.maxQuantity
      ) {
        reason = '數量必須為 1–999 的整數';
      } else if (price === null) {
        reason = '價格格式不正確';
      } else if (!buyer) {
        reason = '訂購者為空白';
      }

      if (reason) {
        ignored.push({ rowNumber, productName: productName || '（空白）', reason });
        return;
      }

      const fields = [
        productName,
        rawOptions,
        String(price),
        buyer,
        String(quantity),
        normalizeText(record.paid)
      ];
      rows.push({
        rowId: makeRowId(rowNumber, fields),
        rowNumber,
        productName,
        rawOptions,
        optionTokens: rawOptions
          ? rawOptions.split('/').map(normalizeText).filter(Boolean)
          : [],
        price,
        buyer,
        quantity,
        paid: normalizeText(record.paid),
        storeId: metadata.storeId || null,
        sourceOrderId: metadata.sourceOrderId || null
      });
    });

    return { rows, ignored };
  }

  function exactOrderText(value, field, maxLength) {
    if (
      typeof value !== 'string' ||
      value.length > maxLength ||
      !value ||
      normalizeText(value) !== value
    ) {
      throw new WorkflowError('JSON_FIELD', `${field} 格式不正確。`);
    }
    return value;
  }

  function validateOrderFile(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new WorkflowError('JSON_FORMAT', 'JSON 最外層必須是物件。');
    }
    if (value.format !== CONFIG.orderFileFormat) {
      throw new WorkflowError('JSON_FORMAT', '不是 Nidin 訂單工具的 JSON。');
    }
    if (value.schemaVersion !== CONFIG.orderFileSchemaVersion) {
      throw new WorkflowError('JSON_VERSION', 'JSON 訂單版本不相容。');
    }

    const storeId = value.storeId;
    const sourceOrderId = value.sourceOrderId;
    if (typeof storeId !== 'string' || !/^\d+$/u.test(storeId)) {
      throw new WorkflowError('JSON_STORE', 'JSON 店家 ID 格式不正確。');
    }
    if (
      typeof sourceOrderId !== 'string' ||
      !/^\d+$/u.test(sourceOrderId)
    ) {
      throw new WorkflowError('JSON_ORDER', 'JSON 來源訂單 ID 格式不正確。');
    }
    if (
      typeof value.exportedAt !== 'string' ||
      value.exportedAt.length > 40 ||
      !Number.isFinite(Date.parse(value.exportedAt)) ||
      new Date(value.exportedAt).toISOString() !== value.exportedAt
    ) {
      throw new WorkflowError('JSON_DATE', 'JSON 匯出時間格式不正確。');
    }
    if (
      !Array.isArray(value.items) ||
      !value.items.length ||
      value.items.length > CONFIG.maxRows
    ) {
      throw new WorkflowError(
        'JSON_ITEMS',
        `JSON 品項必須為 1–${CONFIG.maxRows} 筆。`
      );
    }

    const items = value.items.map((item, index) => {
      const prefix = `第 ${index + 1} 筆`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new WorkflowError('JSON_ITEM', `${prefix}品項格式不正確。`);
      }
      const productName = exactOrderText(
        item.productName,
        `${prefix}品項名稱`,
        500
      );
      if (!Array.isArray(item.options) || item.options.length > 100) {
        throw new WorkflowError('JSON_OPTIONS', `${prefix}規格格式不正確。`);
      }
      const options = item.options.map((option, optionIndex) =>
        exactOrderText(
          option,
          `${prefix}第 ${optionIndex + 1} 個規格`,
          500
        )
      );
      if (
        typeof item.unitPrice !== 'number' ||
        !Number.isFinite(item.unitPrice) ||
        item.unitPrice < 0 ||
        !Number.isSafeInteger(Math.round(item.unitPrice * 100)) ||
        Math.abs(item.unitPrice * 100 - Math.round(item.unitPrice * 100)) >
          0.000001
      ) {
        throw new WorkflowError('JSON_PRICE', `${prefix}單價格式不正確。`);
      }
      const buyer = cleanBuyerName(
        exactOrderText(item.buyer, `${prefix}訂購者`, 500)
      );
      if (!buyer) {
        throw new WorkflowError('JSON_BUYER', `${prefix} buyer 沒有姓名。`);
      }
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > CONFIG.maxQuantity
      ) {
        throw new WorkflowError(
          'JSON_QUANTITY',
          `${prefix}數量必須為 1–${CONFIG.maxQuantity} 的整數。`
        );
      }
      if (typeof item.paid !== 'boolean') {
        throw new WorkflowError('JSON_PAID', `${prefix}收款狀態格式不正確。`);
      }

      return {
        productName,
        options,
        unitPrice: item.unitPrice,
        buyer,
        quantity: item.quantity,
        paid: item.paid
      };
    });

    return {
      format: CONFIG.orderFileFormat,
      schemaVersion: CONFIG.orderFileSchemaVersion,
      exportedAt: value.exportedAt,
      storeId,
      sourceOrderId,
      items
    };
  }

  function parseOrderJson(text) {
    if (typeof text !== 'string') {
      throw new WorkflowError('JSON_PARSE', 'JSON 內容無法解析。');
    }
    if (text.length > CONFIG.maxFileBytes) {
      throw new WorkflowError('JSON_SIZE', 'JSON 超過 1 MB 上限。');
    }
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    try {
      return validateOrderFile(JSON.parse(source));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError('JSON_PARSE', 'JSON 內容無法解析。');
    }
  }

  function createOrderFile(rows, storeId, sourceOrderId) {
    return validateOrderFile({
      format: CONFIG.orderFileFormat,
      schemaVersion: CONFIG.orderFileSchemaVersion,
      exportedAt: new Date().toISOString(),
      storeId,
      sourceOrderId,
      items: rows.map(row => ({
        productName: row.productName,
        options: [...row.optionTokens],
        unitPrice: row.price,
        buyer: cleanBuyerName(row.buyer),
        quantity: row.quantity,
        paid: row.paid === 'Y'
      }))
    });
  }

  function rowsFromOrderFile(orderFile) {
    return orderFile.items.map((item, index) => {
      const rowNumber = index + 2;
      const rawOptions = item.options.join(' / ');
      const paid = item.paid ? 'Y' : 'N';
      const fields = [
        item.productName,
        JSON.stringify(item.options),
        String(item.unitPrice),
        item.buyer,
        String(item.quantity),
        paid
      ];
      return {
        rowId: makeRowId(rowNumber, fields),
        rowNumber,
        productName: item.productName,
        rawOptions,
        optionTokens: [...item.options],
        price: item.unitPrice,
        buyer: item.buyer,
        quantity: item.quantity,
        paid,
        storeId: orderFile.storeId,
        sourceOrderId: orderFile.sourceOrderId
      };
    });
  }

  function validatePending(value) {
    if (!value || value.schemaVersion !== CONFIG.schemaVersion) {
      throw new WorkflowError('STORAGE', '暫存資料版本不相容。');
    }
    if (!/^\d+$/u.test(String(value.storeId || ''))) {
      throw new WorkflowError('STORAGE', '暫存資料的店家 ID 不正確。');
    }
    if (!Array.isArray(value.rows) || value.rows.length > CONFIG.maxRows) {
      throw new WorkflowError('STORAGE', '暫存資料列數不正確。');
    }

    const rows = value.rows.map(row => {
      const rowStoreId =
        row?.storeId === null || row?.storeId === undefined
          ? null
          : String(row.storeId);
      const rowSourceOrderId =
        row?.sourceOrderId === null || row?.sourceOrderId === undefined
          ? null
          : String(row.sourceOrderId);
      const buyer =
        typeof row?.buyer === 'string' ? cleanBuyerName(row.buyer) : '';
      const valid =
        row &&
        typeof row.rowId === 'string' &&
        row.rowId.length <= 100 &&
        Number.isInteger(row.rowNumber) &&
        row.rowNumber > 0 &&
        typeof row.productName === 'string' &&
        Boolean(row.productName) &&
        normalizeText(row.productName) === row.productName &&
        row.productName.length <= 500 &&
        typeof row.rawOptions === 'string' &&
        normalizeText(row.rawOptions) === row.rawOptions &&
        row.rawOptions.length <= 2000 &&
        Array.isArray(row.optionTokens) &&
        row.optionTokens.length <= 100 &&
        row.optionTokens.every(
          token =>
            typeof token === 'string' &&
            Boolean(token) &&
            token.length <= 500 &&
            normalizeText(token) === token
        ) &&
        Number.isFinite(row.price) &&
        row.price >= 0 &&
        Boolean(buyer) &&
        buyer.length <= 500 &&
        Number.isInteger(row.quantity) &&
        row.quantity >= 1 &&
        row.quantity <= CONFIG.maxQuantity &&
        (row.paid === 'Y' || row.paid === 'N') &&
        (rowStoreId === null || /^\d+$/u.test(rowStoreId)) &&
        (rowSourceOrderId === null || /^\d+$/u.test(rowSourceOrderId));
      if (!valid) throw new WorkflowError('STORAGE', '暫存品項格式不正確。');
      return {
        rowId: row.rowId,
        rowNumber: row.rowNumber,
        productName: row.productName,
        rawOptions: row.rawOptions,
        optionTokens: [...row.optionTokens],
        price: row.price,
        buyer,
        quantity: row.quantity,
        paid: row.paid,
        storeId: rowStoreId,
        sourceOrderId: rowSourceOrderId
      };
    });

    const rowIds = new Set(rows.map(row => row.rowId));
    if (rowIds.size !== rows.length) {
      throw new WorkflowError('STORAGE', '暫存品項 ID 重複。');
    }
    const completedRowIds = Array.isArray(value.completedRowIds)
      ? [...new Set(value.completedRowIds.filter(id => rowIds.has(id)))]
      : [];
    const completed = new Set(completedRowIds);
    const manualReviewRowIds = Array.isArray(value.manualReviewRowIds)
      ? [
          ...new Set(
            value.manualReviewRowIds.filter(id => rowIds.has(id) && !completed.has(id))
          )
        ]
      : [];
    const targetOrderId =
      value.targetOrderId === null || value.targetOrderId === undefined
        ? null
        : String(value.targetOrderId);
    if (targetOrderId !== null && !/^\d+$/u.test(targetOrderId)) {
      throw new WorkflowError('STORAGE', '暫存購物車 ID 不正確。');
    }

    const ignoredRows = Array.isArray(value.ignoredRows)
      ? value.ignoredRows.slice(0, CONFIG.maxRows).map(item => ({
          rowNumber: Number(item.rowNumber) || 0,
          productName: normalizeText(item.productName).slice(0, 200),
          reason: normalizeText(item.reason).slice(0, 300)
        }))
      : [];

    return {
      schemaVersion: CONFIG.schemaVersion,
      source: value.source === 'order-page' ? 'order-page' : 'json',
      sourceOrderId: /^\d+$/u.test(String(value.sourceOrderId || ''))
        ? String(value.sourceOrderId)
        : null,
      storeId: String(value.storeId),
      storeConfirmed: Boolean(value.storeConfirmed),
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
      rows,
      ignoredRows,
      completedRowIds,
      manualReviewRowIds,
      targetOrderId,
      autoValidate: Boolean(value.autoValidate)
    };
  }

  function createPending({
    source,
    sourceOrderId,
    storeId,
    storeConfirmed,
    rows,
    ignoredRows,
    autoValidate = false
  }) {
    return validatePending({
      schemaVersion: CONFIG.schemaVersion,
      source,
      sourceOrderId,
      storeId,
      storeConfirmed,
      createdAt: new Date().toISOString(),
      rows,
      ignoredRows,
      completedRowIds: [],
      manualReviewRowIds: [],
      targetOrderId: null,
      autoValidate
    });
  }

  function createPendingFromOrderFile(
    orderFile,
    { source, ignoredRows = [], autoValidate = false }
  ) {
    const validated = validateOrderFile(orderFile);
    return createPending({
      source,
      sourceOrderId: validated.sourceOrderId,
      storeId: validated.storeId,
      storeConfirmed: true,
      rows: rowsFromOrderFile(validated),
      ignoredRows,
      autoValidate
    });
  }

  // ── 訂單頁擷取、複製與匯出 ─────────────────────────────────────

  function extractBuyer(row) {
    const icon = [...row.querySelectorAll('i.material-icons')].find(
      element => normalizeText(element.textContent) === 'account_circle'
    );
    if (icon?.parentElement) {
      const buyer = cleanBuyerName(icon.parentElement.textContent);
      if (buyer) return buyer;
    }

    const group = row.parentElement?.parentElement;
    return cleanBuyerName(
      group?.querySelector('.font-size-subtitle-1')?.textContent
    );
  }

  function extractOrderPageData() {
    const rowElements = [...document.querySelectorAll(SELECTORS.orderRows)];
    const subtotal = document.querySelector(SELECTORS.orderSubtotal);
    if (!rowElements.length || !subtotal) {
      throw new WorkflowError('ORDER_DOM', '找不到訂單商品或合計區。');
    }

    const rawRows = rowElements.map((row, index) => {
      const nameElement =
        row.querySelector(SELECTORS.orderProductName) ||
        row.querySelector(SELECTORS.orderProductNameFallback);
      const detail = cleanText(row.querySelector(SELECTORS.orderDetail));
      const price = detail.match(/\$\s*([\d,.]+(?:\.\d+)?)/u)?.[1] || '';
      const quantity = detail.match(/\/\s*(\d+)\s*份/u)?.[1] || '';
      const rawOptions = detail
        .replace(/\s*\$\s*[\d,.]+(?:\.\d+)?.*$/u, '')
        .replace(/\/\s*$/u, '')
        .trim();
      const group = row.parentElement?.parentElement;
      const paid = group?.querySelector(SELECTORS.orderPaidBadge) ? 'Y' : 'N';

      return {
        rowNumber: index + 2,
        productName: cleanText(nameElement),
        rawOptions,
        price,
        buyer: extractBuyer(row),
        quantity,
        paid
      };
    });

    const subtotalText = normalizeText(subtotal.textContent).replace(/\s+/gu, '');
    const summary = {
      productName: '合計',
      rawOptions: '',
      price: subtotalText.match(/\$([\d,.]+(?:\.\d+)?)/u)?.[1] || '',
      buyer: '',
      quantity: subtotalText.match(/\/(\d+)份/u)?.[1] || '',
      paid: ''
    };
    return { rawRows, summary };
  }

  function createOrderFileFromPage(storeId, sourceOrderId) {
    const data = extractOrderPageData();
    const normalized = normalizeRecords(data.rawRows, { sourceOrderId });
    normalized.ignored.push({
      rowNumber: data.rawRows.length + 2,
      productName: '合計',
      reason: '忽略「合計」列'
    });
    if (!normalized.rows.length) {
      throw new WorkflowError('ORDER_EMPTY', '此訂單沒有可重新訂購的有效品項。');
    }
    return {
      orderFile: createOrderFile(normalized.rows, storeId, sourceOrderId),
      ignoredRows: normalized.ignored
    };
  }

  function collectMenuStoreIds() {
    const ids = new Set();

    const addUrl = value => {
      if (!value) return;
      try {
        const url = new URL(value, location.origin);
        const match = url.pathname.match(/^\/(?:menu|store)\/(\d+)\/?$/u);
        if (url.origin === CONFIG.origin && match) ids.add(match[1]);
      } catch {
        // 非 URL 內容不是店家依據。
      }
    };

    document.querySelectorAll('a[href]').forEach(anchor => addUrl(anchor.getAttribute('href')));
    document.querySelectorAll(SELECTORS.productJson).forEach(script => {
      try {
        const data = JSON.parse(script.textContent);
        const visit = value => {
          if (!value || typeof value !== 'object') return;
          if (typeof value.url === 'string') addUrl(value.url);
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

    const reason =
      detected.length > 1
        ? `頁面上找到多個店家 ID（${detected.join('、')}），無法安全判定。`
        : '頁面上找不到明確的店家連結。';
    const input = prompt(
      `${reason}\n請輸入 /menu/<店家ID>、/store/<店家ID> 或完整的 Nidin 網址：`,
      ''
    );
    if (input === null) return null;
    const storeId = parseMenuInput(input);
    if (!storeId) {
      throw new WorkflowError(
        'STORE_INPUT',
        '店家網址格式不正確；只接受同站的 /menu/<數字> 或 /store/<數字>。'
      );
    }
    return storeId;
  }

  function orderTable(rawRows, summary, includeMetadata = false) {
    const route = currentRoute();
    const storeIds = collectMenuStoreIds();
    const storeId = storeIds.length === 1 ? storeIds[0] : '';
    const header = includeMetadata ? [...HEADERS, ...OPTIONAL_HEADERS] : [...HEADERS];
    const toCells = row => [
      row.productName,
      row.rawOptions,
      row.price,
      row.buyer,
      row.quantity,
      row.paid
    ];
    const rows = rawRows.map(row => {
      const cells = toCells(row);
      return includeMetadata ? [...cells, storeId, route.orderId] : cells;
    });
    const summaryCells = toCells(summary);
    return [
      header,
      ...rows,
      includeMetadata ? [...summaryCells, storeId, route.orderId] : summaryCells
    ];
  }

  function buildClipboardHtml(table) {
    const element = document.createElement('table');
    table.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.forEach(value => {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        cell.textContent = protectSpreadsheetCell(value);
        tr.appendChild(cell);
      });
      element.appendChild(tr);
    });
    return element.outerHTML;
  }

  async function copyTable(table) {
    const safeTable = table.map(row => row.map(protectSpreadsheetCell));
    const tsv = safeTable.map(row => row.join('\t')).join('\r\n');
    const html = buildClipboardHtml(table);

    if (navigator.clipboard?.write && globalThis.ClipboardItem) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([tsv], { type: 'text/plain' }),
            'text/html': new Blob([html], { type: 'text/html' })
          })
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

    const textarea = document.createElement('textarea');
    textarea.value = tsv;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new WorkflowError('CLIPBOARD', '瀏覽器拒絕存取剪貼簿。');
  }

  function downloadFile(content, type, filename) {
    const url = URL.createObjectURL(
      new Blob([content], { type })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadCsv(table) {
    downloadFile(
      encodeCsv(table),
      'text/csv;charset=utf-8',
      'order.csv'
    );
  }

  function downloadJson(orderFile) {
    downloadFile(
      `${JSON.stringify(orderFile, null, 2)}\n`,
      'application/json;charset=utf-8',
      `order-${orderFile.sourceOrderId}.json`
    );
  }

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

    const host = document.createElement('div');
    host.id = CONFIG.hostId;
    Object.assign(host.style, {
      position: 'fixed',
      bottom: 'max(12px, env(safe-area-inset-bottom))',
      left: '12px',
      pointerEvents: 'none',
      zIndex: '2147483646'
    });
    document.body.appendChild(host);
    return { host, shadow: host.attachShadow({ mode: 'open' }) };
  }

  function makeButton(text, className = 'primary') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    return button;
  }

  function createFloatingUi() {
    const created = createHost();
    if (!created) return null;

    const style = document.createElement('style');
    style.textContent = `${baseStyles()}${floatingStyles()}`;
    const widget = document.createElement('div');
    widget.className = 'widget';
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.id = 'nidin-order-tools-panel';
    panel.hidden = true;
    const title = document.createElement('h2');
    title.className = 'title';
    title.textContent = 'Nidin 訂單工具';
    const launcher = makeButton('訂', 'launcher');
    launcher.setAttribute('aria-controls', panel.id);
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-label', '展開 Nidin 訂單工具');
    launcher.title = 'Nidin 訂單工具';
    const setExpanded = expanded => {
      panel.hidden = !expanded;
      launcher.setAttribute('aria-expanded', String(expanded));
      launcher.setAttribute(
        'aria-label',
        `${expanded ? '收合' : '展開'} Nidin 訂單工具`
      );
    };
    launcher.addEventListener('click', () => {
      setExpanded(launcher.getAttribute('aria-expanded') !== 'true');
    });
    panel.append(title);
    widget.append(panel, launcher);
    created.shadow.append(style, widget);

    return { ...created, panel, setExpanded };
  }

  function showOrderNotice(message) {
    const ui = createFloatingUi();
    if (!ui) return;
    const notice = document.createElement('div');
    notice.className = 'status error';
    notice.textContent = message;
    ui.panel.append(notice);
    ui.setExpanded(true);
  }

  function createOrderUi() {
    const ui = createFloatingUi();
    if (!ui) return null;

    const actions = document.createElement('div');
    actions.className = 'row';
    const copyButton = makeButton('複製');
    const csvExportButton = makeButton('匯出 CSV');
    const jsonExportButton = makeButton('匯出 JSON');
    const reorderButton = makeButton('重新訂購');
    actions.append(
      copyButton,
      csvExportButton,
      jsonExportButton,
      reorderButton
    );
    ui.panel.append(actions);
    return {
      ...ui,
      copyButton,
      csvExportButton,
      jsonExportButton,
      reorderButton
    };
  }

  async function initOrderPage(expectedRouteKey, generation) {
    try {
      await waitForCondition(() => {
        const rows = document.querySelectorAll(SELECTORS.orderRows);
        const total = document.querySelector(SELECTORS.orderSubtotal);
        return rows.length && total;
      }, { message: '找不到訂單商品與合計區，可能是網站版面已更新。' });
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
      reorderButton
    } = ui;

    copyButton.addEventListener('click', async () => {
      try {
        const data = extractOrderPageData();
        await copyTable(orderTable(data.rawRows, data.summary));
        alert('已複製，可貼到 Excel 或 Google 試算表。');
      } catch (error) {
        alert(`複製失敗：${error.message}`);
      }
    });

    csvExportButton.addEventListener('click', () => {
      try {
        const data = extractOrderPageData();
        downloadCsv(orderTable(data.rawRows, data.summary, true));
      } catch (error) {
        alert(`匯出 CSV 失敗：${error.message}`);
      }
    });

    jsonExportButton.addEventListener('click', () => {
      try {
        const route = currentRoute();
        const storeId = resolveStoreId();
        if (!storeId) return;
        const { orderFile } = createOrderFileFromPage(
          storeId,
          route.orderId
        );
        downloadJson(orderFile);
      } catch (error) {
        alert(`匯出 JSON 失敗：${error.message}`);
      }
    });

    reorderButton.addEventListener('click', async () => {
      try {
        const route = currentRoute();
        const storeId = resolveStoreId();
        if (!storeId) return;
        const { orderFile, ignoredRows } = createOrderFileFromPage(
          storeId,
          route.orderId
        );
        const accepted = confirm(
          `即將前往店家 ${storeId} 的普通菜單。\n` +
          `有效品項：${orderFile.items.length} 筆\n` +
          `忽略品項：${ignoredRows.length} 筆\n\n` +
          '菜單頁只會先驗證；仍需按「開始加入」才會改變購物車。'
        );
        if (!accepted) return;

        const pending = createPendingFromOrderFile(orderFile, {
          source: 'order-page',
          ignoredRows,
          autoValidate: true
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

    const style = document.createElement('style');
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

    const meta = document.createElement('div');
    meta.className = 'meta';
    const actions = document.createElement('div');
    actions.className = 'row';
    const importButton = makeButton('匯入 JSON');
    const validateButton = makeButton('驗證品項', 'secondary');
    const startButton = makeButton('開始加入');
    const stopButton = makeButton('停止', 'danger');
    const clearButton = makeButton('清除', 'secondary');
    validateButton.disabled = true;
    startButton.disabled = true;
    stopButton.disabled = true;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    const status = document.createElement('div');
    status.className = 'status info';
    status.setAttribute('aria-live', 'polite');
    status.textContent = '請匯入 JSON，或從訂單頁使用「重新訂購」。';
    const progress = document.createElement('div');
    progress.className = 'progress';
    const report = document.createElement('table');
    report.className = 'report';
    actions.append(importButton, validateButton, startButton, stopButton, clearButton);
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
      setExpanded: ui.setExpanded
    };
  }

  // ── 菜單搜尋與商品規格 DOM 操作 ─────────────────────────────────

  function visibleMenuRoot() {
    return [...document.querySelectorAll(SELECTORS.menuRoot)].find(isVisible) || null;
  }

  function findMenuSearchButton() {
    const root = visibleMenuRoot();
    if (!root) return null;
    return [...root.querySelectorAll(SELECTORS.menuSearchButton)].find(button => {
      const icon = button.querySelector('.fa-search, [class*="fa-search"]');
      return (
        isVisible(button) &&
        Boolean(
          button.classList.contains('straight-line') ||
            icon ||
            /搜尋|search/iu.test(
              `${cleanText(button)} ${button.getAttribute('aria-label') || ''}`
            )
        )
      );
    }) || null;
  }

  function visibleSearchDialog() {
    const card = [...document.querySelectorAll(SELECTORS.searchCard)].find(isVisible);
    if (!card) return null;
    return card.closest('.q-dialog__inner, [role="dialog"]') || card.parentElement;
  }

  function visibleProductModal() {
    return [...document.querySelectorAll(SELECTORS.productModal)].find(isVisible) || null;
  }

  async function ensureSearchDialog() {
    if (visibleProductModal()) {
      throw new WorkflowError(
        'MODAL_OPEN',
        '前一個商品視窗仍未關閉，為避免點錯已停止。',
        true
      );
    }
    const existing = visibleSearchDialog();
    if (existing?.querySelector(SELECTORS.searchInput)) return existing;

    const button = await waitForCondition(findMenuSearchButton, {
      message: '找不到 Nidin 的商品搜尋按鈕。'
    });
    clickElement(button);
    return waitForCondition(() => {
      const dialog = visibleSearchDialog();
      return dialog?.querySelector(SELECTORS.searchInput) ? dialog : null;
    }, { message: '商品搜尋視窗沒有開啟。' });
  }

  async function closeSearchDialog() {
    const dialog = visibleSearchDialog();
    if (!dialog) return;
    const close = [...dialog.querySelectorAll(SELECTORS.closeIcon)].find(
      element => isVisible(element) && element.classList.contains('sticky-header')
    );
    if (!close) return;
    close.click();
    try {
      await waitForCondition(() => !visibleSearchDialog(), {
        timeout: 3000,
        message: '搜尋視窗沒有關閉。'
      });
    } catch {
      // 不影響已完成的驗證結果。
    }
  }

  function findProductObject(value) {
    if (!value || typeof value !== 'object') return null;
    if (
      (value['@type'] === 'Product' || value.productID) &&
      typeof value.name === 'string' &&
      value.productID !== undefined
    ) {
      return value;
    }
    for (const child of Object.values(value)) {
      const found = findProductObject(child);
      if (found) return found;
    }
    return null;
  }

  function productEntries(root) {
    if (!root) return [];
    const entries = [];
    root.querySelectorAll(SELECTORS.productJson).forEach(script => {
      try {
        const product = findProductObject(JSON.parse(script.textContent));
        if (!product) return;
        let target = script.parentElement;
        while (
          target &&
          target !== root &&
          !target.classList.contains('cursor-pointer') &&
          !target.classList.contains('disabled-product')
        ) {
          target = target.parentElement;
        }
        if (!target || target === root || !isVisible(target)) return;
        entries.push({
          name: normalizeText(product.name),
          productId: String(product.productID),
          target,
          soldOut:
            target.classList.contains('disabled-product') ||
            isDisabled(target) ||
            /停售|完售|暫停供應/u.test(cleanText(target))
        });
      } catch {
        // 單一無效 JSON-LD 不影響其他商品。
      }
    });
    return entries;
  }

  function menuProductEntries() {
    return productEntries(visibleMenuRoot());
  }

  function exactProductEntry(entries, productName, expectedProductId = null) {
    const matches = entries.filter(
      entry => normalizeText(entry.name) === normalizeText(productName)
    );
    const unique = new Map();
    matches.forEach(entry => {
      const previous = unique.get(entry.productId);
      if (!previous || (previous.soldOut && !entry.soldOut)) {
        unique.set(entry.productId, entry);
      }
    });
    let exact = [...unique.values()];
    if (expectedProductId) {
      exact = exact.filter(entry => entry.productId === String(expectedProductId));
    }

    if (!exact.length) {
      throw new WorkflowError('NO_PRODUCT', '找不到完整名稱相同的商品。');
    }
    if (exact.length !== 1) {
      throw new WorkflowError('AMBIGUOUS_PRODUCT', '找到多個同名商品。');
    }
    if (exact[0].soldOut) {
      throw new WorkflowError('SOLD_OUT', '商品已停售或暫停供應。');
    }
    return exact[0];
  }

  function optionalExactProductEntry(
    entries,
    productName,
    expectedProductId = null
  ) {
    const normalizedName = normalizeText(productName);
    const hasCandidate = entries.some(
      entry =>
        entry.name === normalizedName &&
        (!expectedProductId ||
          entry.productId === String(expectedProductId))
    );
    return hasCandidate
      ? exactProductEntry(entries, productName, expectedProductId)
      : null;
  }

  function waitForDomQuiet(root, quietMs, timeoutMs) {
    return new Promise(resolve => {
      let quietTimer = null;
      let timeoutTimer = null;
      let finished = false;
      const observer = new MutationObserver(() => armQuietTimer());

      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(timeoutTimer);
        resolve();
      };
      const armQuietTimer = () => {
        if (finished) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };

      observer.observe(root, { childList: true, subtree: true });
      timeoutTimer = setTimeout(finish, timeoutMs);
      armQuietTimer();
    });
  }

  function menuScanPositions(root) {
    const list = root.querySelector(SELECTORS.menuList) || root;
    const scrollRoot =
      document.scrollingElement || document.documentElement;
    const originalTop = scrollRoot.scrollTop;
    const originalLeft = scrollRoot.scrollLeft;
    const rect = list.getBoundingClientRect();
    const viewportHeight = Math.max(
      globalThis.innerHeight,
      document.documentElement.clientHeight,
      480
    );
    const listTop = Math.max(0, originalTop + rect.top);
    const listHeight = Math.max(rect.height, list.scrollHeight);
    const first = Math.max(0, listTop - Math.floor(viewportHeight * 0.15));
    const last = Math.max(
      first,
      listTop + listHeight - Math.floor(viewportHeight * 0.8)
    );
    const distance = last - first;
    const idealStep = Math.max(320, Math.floor(viewportHeight * 0.7));
    const count = Math.min(
      CONFIG.maxMenuScanSteps,
      Math.max(1, Math.ceil(distance / idealStep) + 1)
    );
    const positions =
      count === 1
        ? [first]
        : Array.from(
            { length: count },
            (_, index) => first + (distance * index) / (count - 1)
          );

    return {
      scrollRoot,
      originalTop,
      originalLeft,
      positions
    };
  }

  async function locateProductByMenuScan(
    productName,
    expectedProductId = null
  ) {
    const root = visibleMenuRoot();
    if (!root) {
      throw new WorkflowError('NO_PRODUCT', '找不到可掃描的菜單。');
    }

    const initial = optionalExactProductEntry(
      menuProductEntries(),
      productName,
      expectedProductId
    );
    if (initial) return initial;

    await waitForDomQuiet(
      root,
      CONFIG.menuSettleMs,
      CONFIG.menuSettleTimeoutMs
    );
    const settled = optionalExactProductEntry(
      menuProductEntries(),
      productName,
      expectedProductId
    );
    if (settled) return settled;

    const expectedRouteKey = routeKey();
    const scan = menuScanPositions(root);
    let keepPosition = false;
    try {
      for (const position of scan.positions) {
        if (routeKey() !== expectedRouteKey) {
          throw new WorkflowError(
            'ROUTE',
            '頁面已切換，已停止尋找商品。',
            true
          );
        }

        scan.scrollRoot.scrollTop = Math.round(position);
        scan.scrollRoot.scrollLeft = scan.originalLeft;
        await nextFrame();
        await nextFrame();
        await delay(CONFIG.menuScanDelayMs);

        const match = optionalExactProductEntry(
          menuProductEntries(),
          productName,
          expectedProductId
        );
        if (match) {
          keepPosition = true;
          return match;
        }
      }
    } finally {
      if (!keepPosition && routeKey() === expectedRouteKey) {
        scan.scrollRoot.scrollTop = scan.originalTop;
        scan.scrollRoot.scrollLeft = scan.originalLeft;
      }
    }

    throw new WorkflowError('NO_PRODUCT', '找不到完整名稱相同的商品。');
  }

  async function locateProduct(productName, expectedProductId = null) {
    const existingDialog = visibleSearchDialog();
    if (
      existingDialog?.querySelector(SELECTORS.searchInput) ||
      findMenuSearchButton()
    ) {
      try {
        const dialog = await ensureSearchDialog();
        return await locateProductWithSearch(
          dialog,
          productName,
          expectedProductId
        );
      } catch (error) {
        if (error.code !== 'NO_PRODUCT' && error.code !== 'TIMEOUT') {
          throw error;
        }
        await closeSearchDialog();
        if (visibleSearchDialog()) throw error;
      }
    }

    return locateProductByMenuScan(productName, expectedProductId);
  }

  async function locateProductWithSearch(
    dialog,
    productName,
    expectedProductId = null
  ) {
    const input = dialog.querySelector(SELECTORS.searchInput);
    if (!input) throw new WorkflowError('SEARCH', '找不到商品搜尋輸入欄。');
    setNativeValue(input, productName);
    await nextFrame();
    await nextFrame();

    await waitForCondition(
      () =>
        optionalExactProductEntry(
          productEntries(dialog),
          productName,
          expectedProductId
        ),
      {
        timeout: CONFIG.searchResultTimeoutMs,
        message: `搜尋「${productName}」的結果載入逾時。`
      }
    );
    await delay(CONFIG.shortDelayMs);
    return exactProductEntry(
      productEntries(dialog),
      productName,
      expectedProductId
    );
  }

  function modalProductName(modal) {
    return cleanText(modal?.querySelector(SELECTORS.modalTitle));
  }

  function modalProductReady(modal, expectedName) {
    return modalProductName(modal) === expectedName;
  }

  async function openProduct(entry) {
    clickElement(entry.target);
    const expectedName = normalizeText(entry.name);
    const modal = await waitForCondition(() => {
      const modal = visibleProductModal();
      return modal?.querySelector(SELECTORS.quantityInput) &&
        modalProductReady(modal, expectedName)
        ? modal
        : null;
    }, { message: `「${entry.name}」的商品規格視窗沒有完成載入。` });
    await nextFrame();
    await nextFrame();
    await delay(CONFIG.shortDelayMs);
    if (!modalProductReady(modal, expectedName)) {
      throw new WorkflowError('MODAL_PRODUCT', '商品規格視窗切換成其他品項。');
    }
    return modal;
  }

  async function closeProductModal(modal) {
    if (!isVisible(modal)) return;
    const close = [...modal.querySelectorAll(SELECTORS.closeIcon)].find(isVisible);
    if (!close) throw new WorkflowError('MODAL_CLOSE', '找不到商品視窗的關閉按鈕。');
    close.click();
    await waitForCondition(() => !isVisible(modal), {
      timeout: 4000,
      message: '商品規格視窗沒有關閉。'
    });
  }

  function optionLabel(option) {
    const direct = [...option.children].find(child => child.tagName === 'DIV');
    return normalizeText(direct?.textContent || option.textContent);
  }

  function optionCandidates(modal, label) {
    const matches = [...modal.querySelectorAll(SELECTORS.option)].filter(
      option => optionLabel(option) === label
    );
    if (matches.length <= 1) return matches;

    const currentCombination = matches.filter(option =>
      option.classList.contains('b-border')
    );
    return currentCombination.length === 1 ? currentCombination : matches;
  }

  function optionToggle(option) {
    const block = option.closest(SELECTORS.optionBlock);
    const adjustment = block?.closest(SELECTORS.adjustment);
    if (!block || !adjustment) return null;

    const previous = block.previousElementSibling;
    if (
      previous?.classList.contains('cursor-pointer') &&
      isVisible(previous)
    ) {
      return previous;
    }

    return [...adjustment.querySelectorAll('.cursor-pointer')].find(
      candidate =>
        !candidate.closest(SELECTORS.optionBlock) &&
        candidate.closest(SELECTORS.adjustment) === adjustment &&
        candidate.querySelector('.fa-caret-down, .fa-caret-up') &&
        isVisible(candidate)
    ) || null;
  }

  async function visibleOptionCandidates(modal, label) {
    let matches = optionCandidates(modal, label);
    if (matches.length !== 1 || isVisible(matches[0])) return matches;

    const toggle = optionToggle(matches[0]);
    if (!toggle) return [];
    clickElement(toggle);

    try {
      return await waitForCondition(() => {
        matches = optionCandidates(modal, label);
        return matches.length === 1 && isVisible(matches[0]) ? matches : null;
      }, {
        timeout: 3000,
        message: `規格「${label}」所在區塊沒有展開。`
      });
    } catch {
      return [];
    }
  }

  async function resolveOptionToken(modal, token) {
    const label = normalizeText(token);
    return {
      matches: await visibleOptionCandidates(modal, label),
      label
    };
  }

  function optionSelected(option) {
    return (
      option.classList.contains('b-bg') ||
      option.classList.contains('text-white') ||
      option.getAttribute('aria-checked') === 'true'
    );
  }

  function adjustmentRequired(adjustment) {
    return [...adjustment.querySelectorAll('.text-secondary')].some(
      element => normalizeText(element.textContent).includes('✽')
    );
  }

  function adjustmentOptions(adjustment) {
    return [...adjustment.querySelectorAll(SELECTORS.option)];
  }

  function intrinsicProductAdjustment(adjustment, modal) {
    const options = adjustmentOptions(adjustment);
    return (
      options.length === 1 &&
      optionLabel(options[0]) === modalProductName(modal)
    );
  }

  function adjustmentOption(adjustment, label) {
    const matches = adjustmentOptions(adjustment).filter(
      option => optionLabel(option) === label
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function optionAmount(option) {
    if (!optionSelected(option)) return 0;
    const badge = option.parentElement?.querySelector('.amount');
    if (!badge) return 1;
    const value = normalizeText(badge.textContent);
    if (!/^[1-9]\d*$/u.test(value)) return null;
    const amount = Number(value);
    return Number.isSafeInteger(amount) ? amount : null;
  }

  function adjustmentSelectionLimit(adjustment) {
    const match = cleanText(adjustment).match(/最多可選\s*(\d+)\s*項/u);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function revealAdjustmentOption(adjustment, label) {
    let option = adjustmentOption(adjustment, label);
    if (!option) {
      throw new WorkflowError('OPTION_RESET', `無法唯一找到已選規格「${label}」。`);
    }
    if (isVisible(option)) return option;

    const toggle = optionToggle(option);
    if (!toggle) {
      throw new WorkflowError('OPTION_RESET', `無法展開已選規格「${label}」。`);
    }
    clickElement(toggle);
    return waitForCondition(() => {
      option = adjustmentOption(adjustment, label);
      return option && isVisible(option) ? option : null;
    }, {
      root: adjustment,
      timeout: 3000,
      message: `已選規格「${label}」所在區塊沒有展開。`
    });
  }

  async function clearRetainedOption(adjustment, label) {
    let option = await revealAdjustmentOption(adjustment, label);
    let amount = optionAmount(option);
    if (amount === null) {
      throw new WorkflowError(
        'OPTION_RESET',
        `無法讀取先前規格「${label}」的選取次數。`
      );
    }
    if (amount === 0) return;

    const declaredLimit = adjustmentSelectionLimit(adjustment);
    const clickBudget = declaredLimit
      ? Math.min(
          CONFIG.maxOptionResetClicks,
          Math.max(1, declaredLimit - amount + 1)
        )
      : Math.min(CONFIG.maxOptionResetClicks, 2);

    for (let clickCount = 1; clickCount <= clickBudget; clickCount += 1) {
      if (isDisabled(option)) {
        throw new WorkflowError(
          'OPTION_RESET',
          `先前選取的規格「${label}」目前無法取消。`
        );
      }

      const previousAmount = amount;
      clickElement(option);
      let changed;
      try {
        changed = await waitForCondition(() => {
          const current = adjustmentOption(adjustment, label);
          if (!current) return null;
          const currentAmount = optionAmount(current);
          return currentAmount !== null && currentAmount !== previousAmount
            ? { option: current, amount: currentAmount }
            : null;
        }, {
          root: adjustment,
          timeout: 3000,
          message: `先前選取的規格「${label}」數量沒有變化。`
        });
      } catch (error) {
        if (error?.code === 'TIMEOUT') {
          throw new WorkflowError(
            'OPTION_RESET',
            `先前選取的規格「${label}」沒有回應，原數量為 ${previousAmount}。`
          );
        }
        throw error;
      }

      option = changed.option;
      amount = changed.amount;
      if (amount === 0) return;
      await nextFrame();
      await delay(CONFIG.shortDelayMs);
    }

    throw new WorkflowError(
      'OPTION_RESET',
      `先前選取的規格「${label}」在 ${clickBudget} 次安全點擊後仍有 ${amount} 份。`
    );
  }

  async function clearRetainedOptionalSelections(modal) {
    for (const adjustment of modal.querySelectorAll(SELECTORS.adjustment)) {
      if (
        adjustmentRequired(adjustment) ||
        intrinsicProductAdjustment(adjustment, modal)
      ) {
        continue;
      }

      const selectedLabels = adjustmentOptions(adjustment)
        .filter(optionSelected)
        .map(optionLabel);
      for (const label of selectedLabels) {
        await clearRetainedOption(adjustment, label);
      }
    }

    await nextFrame();
    await delay(CONFIG.shortDelayMs);
    const retained = [...modal.querySelectorAll(SELECTORS.adjustment)]
      .filter(
        adjustment =>
          !adjustmentRequired(adjustment) &&
          !intrinsicProductAdjustment(adjustment, modal)
      )
      .flatMap(adjustment => adjustmentOptions(adjustment))
      .filter(optionSelected)
      .map(optionLabel);
    if (retained.length) {
      throw new WorkflowError(
        'OPTION_RESET',
        `仍保留先前規格「${[...new Set(retained)].join('、')}」。`
      );
    }
  }

  function unexpectedSelectedOptions(modal, expectedLabels) {
    const expected = new Set(expectedLabels.map(normalizeText));
    return [...modal.querySelectorAll(SELECTORS.adjustment)]
      .filter(adjustment => !intrinsicProductAdjustment(adjustment, modal))
      .flatMap(adjustment => adjustmentOptions(adjustment))
      .filter(option => optionSelected(option) && !expected.has(optionLabel(option)))
      .map(optionLabel);
  }

  async function chooseOptions(modal, tokens) {
    const mappedOptions = [];

    for (const token of tokens) {
      const resolved = await resolveOptionToken(modal, token);
      const matches = resolved.matches;
      if (matches.length !== 1) {
        const reason = matches.length ? '規格名稱不唯一' : '找不到規格';
        throw new WorkflowError('OPTION', `${reason}「${token}」。`);
      }
      const option = matches[0];
      if (isDisabled(option)) {
        throw new WorkflowError('SOLD_OUT', `規格「${token}」已停售。`);
      }
      if (!optionSelected(option)) {
        clickElement(option);
        await waitForCondition(() => {
          const current = optionCandidates(modal, resolved.label);
          return current.length === 1 && optionSelected(current[0]);
        }, {
          timeout: 3000,
          message: `規格「${token}」沒有成功選取。`
        });
      }
      mappedOptions.push({ token, label: optionLabel(option) });
    }

    const unselected = mappedOptions.find(mapping => {
      const matches = optionCandidates(modal, mapping.label);
      return matches.length !== 1 || !optionSelected(matches[0]);
    });
    if (unselected) {
      throw new WorkflowError('OPTION', `規格「${unselected.token}」與其他選項互斥。`);
    }

    for (const adjustment of modal.querySelectorAll(SELECTORS.adjustment)) {
      if (!isVisible(adjustment)) continue;
      if (!adjustmentRequired(adjustment)) continue;
      const visibleOptions = [...adjustment.querySelectorAll('.option')].filter(isVisible);
      if (visibleOptions.length && !visibleOptions.some(optionSelected)) {
        const title =
          [...adjustment.querySelectorAll('div, span')]
            .map(ownText)
            .find(value => value && !value.includes('✽')) || '必選規格';
        throw new WorkflowError('OPTION', `尚未完成「${title}」的必選規格。`);
      }
    }

    const unexpected = unexpectedSelectedOptions(
      modal,
      mappedOptions.map(mapping => mapping.label)
    );
    if (unexpected.length) {
      throw new WorkflowError(
        'OPTION_RESET',
        `畫面仍選取非本筆規格「${[...new Set(unexpected)].join('、')}」。`
      );
    }

    return { mappedOptions };
  }

  async function applyMappedOptions(modal, mappings) {
    for (const mapping of mappings) {
      const label = normalizeText(mapping.label);
      const matches = await visibleOptionCandidates(modal, label);
      if (matches.length !== 1) {
        throw new WorkflowError('OPTION', `已驗證規格「${mapping.label}」目前無法唯一找到。`);
      }
      const option = matches[0];
      if (isDisabled(option)) {
        throw new WorkflowError('SOLD_OUT', `規格「${mapping.label}」目前不可用。`);
      }
      if (!optionSelected(option)) {
        clickElement(option);
        await waitForCondition(() => {
          const current = optionCandidates(modal, label);
          return current.length === 1 && optionSelected(current[0]);
        }, {
          timeout: 3000,
          message: `規格「${mapping.label}」沒有成功選取。`
        });
      }
    }
    const lost = mappings.find(mapping => {
      const matches = optionCandidates(modal, normalizeText(mapping.label));
      return matches.length !== 1 || !optionSelected(matches[0]);
    });
    if (lost) throw new WorkflowError('OPTION', `規格「${lost.label}」與其他選項互斥。`);
    const unexpected = unexpectedSelectedOptions(
      modal,
      mappings.map(mapping => mapping.label)
    );
    if (unexpected.length) {
      throw new WorkflowError(
        'OPTION_RESET',
        `畫面仍選取非本筆規格「${[...new Set(unexpected)].join('、')}」。`
      );
    }
  }

  function modalPrice(modal) {
    const block = [...modal.querySelectorAll(SELECTORS.modalActions)].find(
      element => /總金額|Total/iu.test(cleanText(element))
    );
    if (!block) return null;
    const match = cleanText(block).match(
      /(?:總金額|Total)\s*[：:]?\s*(?:NT\$|\$)?\s*([\d,]+(?:\.\d+)?)\s*(?:元)?/iu
    );
    return match ? parsePrice(match[1]) : null;
  }

  async function setQuantity(modal, quantity) {
    const input = modal.querySelector(SELECTORS.quantityInput);
    if (!input) throw new WorkflowError('QUANTITY', '找不到數量輸入欄。');
    setNativeValue(input, quantity);
    await nextFrame();
    await delay(CONFIG.shortDelayMs);
    if (Number(input.value) !== quantity) {
      throw new WorkflowError('QUANTITY', '數量沒有正確寫入。');
    }
  }

  function findBuyerInput(modal) {
    const byPlaceholder = [...modal.querySelectorAll('input[type="text"]')].find(input =>
      /訂購人|姓名|特殊符號/u.test(input.getAttribute('placeholder') || '')
    );
    if (byPlaceholder) return byPlaceholder;

    return [...modal.querySelectorAll('div')]
      .filter(element => /訂購人姓名/u.test(ownText(element)))
      .sort(
        (left, right) =>
          left.querySelectorAll('input').length - right.querySelectorAll('input').length
      )
      .map(element => element.querySelector('input[type="text"]'))
      .find(Boolean) || null;
  }

  async function setBuyer(modal, buyer) {
    const input = findBuyerInput(modal);
    if (!input) {
      throw new WorkflowError('BUYER', '此商品視窗沒有訂購人姓名欄位。');
    }
    if (input.maxLength > 0 && buyer.length > input.maxLength) {
      throw new WorkflowError('BUYER', `訂購者名稱超過 ${input.maxLength} 字。`);
    }
    setNativeValue(input, buyer);
    await nextFrame();
    if (input.value !== buyer) {
      throw new WorkflowError('BUYER', '訂購者名稱沒有正確寫入。');
    }
    const field = input.closest('.q-field');
    if (field?.classList.contains('q-field--error')) {
      throw new WorkflowError('BUYER', '訂購者名稱不符合網站欄位規則。');
    }
  }

  function exactButton(modal, allowedText) {
    const matches = [...modal.querySelectorAll('button')]
      .filter(isVisible)
      .filter(button => allowedText.has(cleanText(button)));
    return matches.length === 1 ? matches[0] : null;
  }

  function checkModalAuthorization(modal) {
    const auth = exactButton(modal, AUTH_BUTTON_TEXT);
    if (auth) {
      throw new WorkflowError(
        'AUTH',
        cleanText(auth) === '登入後訂購'
          ? '請先登入 Nidin。'
          : '請先完成 Nidin 手機驗證。',
        true
      );
    }
    const add = exactButton(modal, ADD_BUTTON_TEXT);
    if (!add) {
      throw new WorkflowError('ADD_BUTTON', '找不到可確認的加入購物車按鈕。');
    }
    return add;
  }

  // ── 購物車狀態、防重複與驗證結果 ───────────────────────────────

  function cartSnapshot() {
    const found = new Map();
    document.querySelectorAll(SELECTORS.cartLink).forEach(anchor => {
      if (!isVisible(anchor)) return;
      try {
        const url = new URL(anchor.getAttribute('href'), location.origin);
        const match = url.pathname.match(/^\/orderList\/(\d+)\/?$/u);
        if (url.origin === CONFIG.origin && match) {
          found.set(match[1], anchor);
        }
      } catch {
        // 忽略無效連結。
      }
    });

    const route = currentRoute();
    if (route.kind === 'menu' && route.targetOrderId && !found.has(route.targetOrderId)) {
      found.set(route.targetOrderId, null);
    }
    const ids = [...found.keys()];
    if (ids.length > 1) return { ambiguous: true, orderId: null, signature: '' };
    if (!ids.length) return { ambiguous: false, orderId: null, signature: 'empty' };

    const orderId = ids[0];
    const anchor = found.get(orderId);
    const container = anchor?.closest('.q-page-sticky') || anchor;
    return {
      ambiguous: false,
      orderId,
      signature: `${orderId}|${normalizeText(container?.textContent || location.pathname)}`
    };
  }

  function cartChanged(before, after) {
    return !after.ambiguous && before.signature !== after.signature;
  }

  function successNotifications() {
    return [...document.querySelectorAll(SELECTORS.notification)].filter(
      element => isVisible(element) && /成功|已加入|加入購物車/u.test(cleanText(element))
    );
  }

  function successNotificationSnapshot() {
    return new Map(
      successNotifications().map(element => [
        element,
        `${cleanText(element)}|${element.childElementCount}`
      ])
    );
  }

  function hasNewSuccessNotification(previous) {
    return successNotifications().some(element => {
      const signature = `${cleanText(element)}|${element.childElementCount}`;
      return !previous.has(element) || previous.get(element) !== signature;
    });
  }

  async function preflight(pending) {
    const route = currentRoute();
    if (route.kind !== 'menu') {
      throw new WorkflowError('ROUTE', '目前不是普通 Nidin 菜單頁。');
    }
    if (route.storeId !== pending.storeId) {
      throw new WorkflowError(
        'STORE_MISMATCH',
        `目前店家 ${route.storeId} 與資料中的店家 ${pending.storeId} 不一致。`
      );
    }

    const bodyText = normalizeText(document.body.innerText);
    const blocker = [
      '門市目前無上架菜單',
      '門市籌備中',
      '門市已歇業',
      '門市暫停接單'
    ].find(text => bodyText.includes(text));
    if (blocker) throw new WorkflowError('STORE_CLOSED', blocker);

    const loginLink = [...document.querySelectorAll('a[href]')].find(anchor => {
      try {
        const url = new URL(anchor.getAttribute('href'), location.origin);
        return (
          isVisible(anchor) &&
          url.origin === CONFIG.origin &&
          url.pathname === '/login' &&
          /^登入$/u.test(cleanText(anchor))
        );
      } catch {
        return false;
      }
    });
    if (loginLink) throw new WorkflowError('AUTH', '請先登入 Nidin。', true);

    await waitForCondition(visibleMenuRoot, {
      message: '菜單尚未完成載入。'
    });
    await waitForCondition(() => menuProductEntries().length || findMenuSearchButton(), {
      message: '菜單目前找不到可操作的商品清單或商品搜尋。'
    });

    const cart = cartSnapshot();
    if (cart.ambiguous) {
      throw new WorkflowError('CART', '頁面上出現多個購物車，無法安全判定。');
    }
    const hasProgress =
      pending.completedRowIds.length > 0 || pending.manualReviewRowIds.length > 0;
    if (!hasProgress && cart.orderId) {
      throw new WorkflowError('CART', '目前已有購物車；本工具不會清空或覆蓋它。');
    }
    if (hasProgress) {
      if (!pending.targetOrderId) {
        throw new WorkflowError('CART', '無法證明目前購物車屬於先前流程，已停止續傳。');
      }
      if (cart.orderId !== pending.targetOrderId) {
        throw new WorkflowError('CART', '目前購物車與先前流程不一致，已停止續傳。');
      }
    }
    return cart;
  }

  function resultStatus(error) {
    switch (error.code) {
      case 'NO_PRODUCT':
        return '找不到商品';
      case 'AMBIGUOUS_PRODUCT':
        return '商品不唯一';
      case 'OPTION':
      case 'OPTION_RESET':
      case 'BUYER':
      case 'QUANTITY':
      case 'ADD_BUTTON':
        return '規格不匹配';
      case 'PRICE':
        return '價格變更';
      case 'SOLD_OUT':
        return '停售';
      case 'TIMEOUT':
        return '頁面逾時';
      case 'AUTH':
        return '登入／驗證未完成';
      default:
        return '頁面逾時';
    }
  }

  function groupRows(rows) {
    const groups = new Map();
    rows.forEach(row => {
      const key = JSON.stringify([
        normalizeText(row.productName),
        row.optionTokens.map(normalizeText),
        row.price
      ]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    });
    return [...groups.values()];
  }

  async function validateGroup(rows) {
    const sample = rows[0];
    let modal = null;
    try {
      const product = await locateProduct(sample.productName);
      modal = await openProduct(product);
      checkModalAuthorization(modal);
      if (!findBuyerInput(modal)) {
        throw new WorkflowError('BUYER', '此門市未提供訂購人姓名欄位。');
      }
      await clearRetainedOptionalSelections(modal);
      await setQuantity(modal, 1);
      const options = await chooseOptions(modal, sample.optionTokens);
      await nextFrame();
      await delay(CONFIG.shortDelayMs);
      const price = modalPrice(modal);
      if (price === null) {
        throw new WorkflowError('PRICE', '無法讀取商品總金額。');
      }
      if (!sameMoney(price, sample.price)) {
        throw new WorkflowError(
          'PRICE',
          `備份資料為 ${sample.price} 元，目前為 ${price} 元。`
        );
      }

      return {
        status: '可加入',
        detail: '商品、規格與價格均相符。',
        productId: product.productId,
        mappedOptions: options.mappedOptions
      };
    } catch (error) {
      return {
        status: resultStatus(error),
        detail: error.message,
        fatal: Boolean(error.fatal)
      };
    } finally {
      if (modal && isVisible(modal)) {
        try {
          await closeProductModal(modal);
        } catch {
          // 下一步會重新確認是否仍有商品視窗。
        }
      }
    }
  }

  function pendingFingerprint(pending) {
    return hashText(
      JSON.stringify(
        pending.rows.map(row => [
          row.rowId,
          row.productName,
          row.rawOptions,
          row.price,
          row.buyer,
          row.quantity
        ])
      )
    );
  }

  function reportRows(state) {
    const ignored = (state.pending?.ignoredRows || []).map(item => ({
      rowId: `ignored-${item.rowNumber}`,
      rowNumber: item.rowNumber,
      productName: item.productName,
      rawOptions: '',
      quantity: '',
      status: '已忽略',
      detail: item.reason
    }));
    const current = new Map(state.results.map(result => [result.rowId, result]));
    const pending = (state.pending?.rows || []).map(row => {
      if (current.has(row.rowId)) return current.get(row.rowId);
      let status = '待驗證';
      let detail = '';
      if (state.pending.completedRowIds.includes(row.rowId)) {
        status = '已加入（先前完成）';
        detail = '不會重複加入。';
      } else if (state.pending.manualReviewRowIds.includes(row.rowId)) {
        status = '待人工確認';
        detail = '曾點擊加入但無法確認結果，不會自動重試。';
      }
      return { ...row, status, detail };
    });
    return [...ignored, ...pending];
  }

  function renderReport(ui, state) {
    const pending = state.pending;
    ui.meta.textContent = pending
      ? `店家 ${pending.storeId}｜有效 ${pending.rows.length} 筆｜忽略 ${pending.ignoredRows.length} 筆`
      : '尚未載入訂單資料';
    ui.progress.textContent = pending
      ? `已完成 ${pending.completedRowIds.length} / ${pending.rows.length} 筆` +
        (pending.manualReviewRowIds.length
          ? `｜待人工確認 ${pending.manualReviewRowIds.length} 筆`
          : '')
      : '';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['列', '品項／規格', '數量', '狀態'].forEach(text => {
      const th = document.createElement('th');
      th.textContent = text;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    const body = document.createElement('tbody');

    reportRows(state).forEach(result => {
      const tr = document.createElement('tr');
      const rowCell = document.createElement('td');
      rowCell.textContent = String(result.rowNumber || '');
      const productCell = document.createElement('td');
      productCell.className = 'product';
      const name = document.createElement('div');
      name.textContent = result.productName;
      const options = document.createElement('div');
      options.className = 'detail';
      options.textContent = result.rawOptions || '';
      productCell.append(name, options);
      const quantityCell = document.createElement('td');
      quantityCell.textContent = String(result.quantity || '');
      const statusCell = document.createElement('td');
      const status = document.createElement('div');
      status.textContent = result.status;
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = result.detail || '';
      statusCell.append(status, detail);
      tr.append(rowCell, productCell, quantityCell, statusCell);
      body.appendChild(tr);
    });
    ui.report.replaceChildren(head, body);
  }

  function setUiStatus(ui, message, type = 'info') {
    ui.status.className = `status ${type}`;
    ui.status.textContent = message;
  }

  // ── 菜單頁工作流程控制器 ───────────────────────────────────────

  async function initMenuPage(expectedRouteKey, generation) {
    if (!routeIsActive(expectedRouteKey, generation)) return;
    const ui = createMenuUi();
    if (!ui) return;

    const state = {
      pending: null,
      results: [],
      validationFingerprint: null,
      phase: 'idle',
      stopRequested: false
    };
    registerRouteCleanup(generation, () => {
      state.stopRequested = true;
    });

    const setPhase = phase => {
      state.phase = phase;
      const busy = phase !== 'idle';
      ui.importButton.disabled = busy;
      ui.validateButton.disabled = busy || !state.pending;
      ui.clearButton.disabled = busy;
      ui.stopButton.disabled = phase !== 'validating' && phase !== 'adding';
      ui.startButton.disabled =
        busy ||
        !state.pending ||
        state.validationFingerprint !== pendingFingerprint(state.pending) ||
        !state.results.some(result => READY_STATUSES.has(result.status));
    };

    const savePending = async () => {
      if (state.pending) await Storage.save(state.pending);
    };

    const confirmUndeclaredStore = async () => {
      if (state.pending.storeConfirmed) return true;
      const accepted = confirm(
        `暫存資料尚未確認店家 ID。\n確定要把資料套用到目前店家 ${state.pending.storeId} 嗎？`
      );
      if (accepted) {
        state.pending.storeConfirmed = true;
        try {
          await savePending();
        } catch (error) {
          state.pending.storeConfirmed = false;
          throw error;
        }
      }
      return accepted;
    };

    const runValidation = async () => {
      if (
        state.phase !== 'idle' ||
        !state.pending ||
        !routeIsActive(expectedRouteKey, generation)
      ) {
        return;
      }
      let storeConfirmed;
      try {
        storeConfirmed = await confirmUndeclaredStore();
      } catch (error) {
        setUiStatus(ui, `無法保存店家確認：${error.message}`, 'error');
        return;
      }
      if (!storeConfirmed) {
        setUiStatus(ui, '尚未確認目前店家，未開始驗證。', 'warning');
        return;
      }

      state.stopRequested = false;
      state.results = [];
      state.validationFingerprint = null;
      setPhase('validating');
      setUiStatus(ui, '正在驗證商品、規格與價格；此階段不會加入購物車。');
      renderReport(ui, state);

      try {
        await preflight(state.pending);
        const completed = new Set(state.pending.completedRowIds);
        const manualReview = new Set(state.pending.manualReviewRowIds);
        const remaining = state.pending.rows.filter(
          row => !completed.has(row.rowId) && !manualReview.has(row.rowId)
        );
        state.results.push(
          ...state.pending.rows
            .filter(row => completed.has(row.rowId))
            .map(row => ({
              ...row,
              status: '已加入（先前完成）',
              detail: '不會重複加入。'
            }))
        );
        state.results.push(
          ...state.pending.rows
            .filter(row => manualReview.has(row.rowId))
            .map(row => ({
              ...row,
              status: '待人工確認',
              detail: '曾點擊加入但無法確認結果，不會自動重試。'
            }))
        );

        for (const group of groupRows(remaining)) {
          if (state.stopRequested) break;
          const groupResult = await validateGroup(group);
          group.forEach(row => state.results.push({ ...row, ...groupResult }));
          renderReport(ui, state);
          if (groupResult.fatal) {
            state.stopRequested = true;
            break;
          }
        }
        await closeSearchDialog();

        const readyCount = state.results.filter(result =>
          READY_STATUSES.has(result.status)
        ).length;
        state.validationFingerprint = pendingFingerprint(state.pending);
        if (state.stopRequested) {
          setUiStatus(ui, '驗證已停止；未驗證的品項不會加入。', 'warning');
        } else if (readyCount) {
          setUiStatus(
            ui,
            `驗證完成：${readyCount} 筆可加入。請檢查報告後再按「開始加入」。`,
            'success'
          );
        } else {
          setUiStatus(ui, '驗證完成，但沒有可安全自動加入的品項。', 'warning');
        }
      } catch (error) {
        await closeSearchDialog();
        setUiStatus(ui, `驗證停止：${error.message}`, 'error');
      } finally {
        setPhase('idle');
        renderReport(ui, state);
      }
    };

    const addOneRow = async result => {
      let modal = null;
      let addClicked = false;
      const before = cartSnapshot();
      if (before.ambiguous) throw new WorkflowError('CART', '無法唯一判定購物車。');

      try {
        const product = await locateProduct(result.productName, result.productId);
        modal = await openProduct(product);
        checkModalAuthorization(modal);
        await clearRetainedOptionalSelections(modal);
        await applyMappedOptions(modal, result.mappedOptions);
        await setBuyer(modal, result.buyer);
        await setQuantity(modal, result.quantity);
        await nextFrame();
        await delay(CONFIG.shortDelayMs);

        const total = modalPrice(modal);
        const expectedTotal = result.price * result.quantity;
        if (total === null || !sameMoney(total, expectedTotal)) {
          throw new WorkflowError(
            'PRICE',
            `加入前總額不一致；預期 ${expectedTotal} 元，畫面為 ${total ?? '無法讀取'} 元。`
          );
        }

        const addButton = checkModalAuthorization(modal);
        if (isDisabled(addButton)) {
          throw new WorkflowError('ADD_BUTTON', '加入購物車按鈕目前不可用。');
        }
        const previousNotifications = successNotificationSnapshot();
        clickElement(addButton); // 每列唯一一次，逾時時禁止重點。
        addClicked = true;

        let confirmed = false;
        let confirmedBy = '';
        try {
          await waitForCondition(() => {
            const after = cartSnapshot();
            if (isVisible(modal)) return false;
            if (cartChanged(before, after)) {
              confirmedBy = '購物車狀態變更';
              return true;
            }
            if (hasNewSuccessNotification(previousNotifications)) {
              confirmedBy = '成功通知';
              return true;
            }
            return false;
          }, { message: '加入後沒有收到明確的購物車回應。' });
          confirmed = true;
        } catch (error) {
          const after = cartSnapshot();
          if (cartChanged(before, after)) {
            confirmed = true;
            confirmedBy = '購物車狀態變更';
          } else {
            throw error;
          }
        }

        if (!confirmed) {
          throw new WorkflowError('ADD_VERIFY', '無法確認此品項是否加入。');
        }
        const after = cartSnapshot();
        if (after.ambiguous) {
          throw new WorkflowError('CART', '加入後出現多個購物車。', true);
        }
        if (
          state.pending.targetOrderId &&
          after.orderId &&
          state.pending.targetOrderId !== after.orderId
        ) {
          throw new WorkflowError('CART', '購物車 ID 在流程中發生變更。', true);
        }
        if (!state.pending.targetOrderId && after.orderId) {
          state.pending.targetOrderId = after.orderId;
        }
        return confirmedBy || '頁面回應';
      } catch (error) {
        if (addClicked && error && typeof error === 'object') {
          error.afterClick = true;
        }
        throw error;
      } finally {
        if (modal && isVisible(modal)) {
          try {
            await closeProductModal(modal);
          } catch {
            // 不重點加入；交由使用者檢查目前畫面。
          }
        }
      }
    };

    const runAdding = async () => {
      if (
        state.phase !== 'idle' ||
        !state.pending ||
        !routeIsActive(expectedRouteKey, generation) ||
        state.validationFingerprint !== pendingFingerprint(state.pending)
      ) {
        return;
      }
      const completed = new Set(state.pending.completedRowIds);
      const manualReview = new Set(state.pending.manualReviewRowIds);
      const ready = state.results.filter(
        result =>
          READY_STATUSES.has(result.status) &&
          !completed.has(result.rowId) &&
          !manualReview.has(result.rowId)
      );
      if (!ready.length) return;

      const accepted = confirm(
        `將依序加入 ${ready.length} 筆品項至普通購物車。\n` +
        '工具不會前往結帳或送出訂單，是否開始？'
      );
      if (!accepted) return;

      state.stopRequested = false;
      setPhase('adding');
      setUiStatus(ui, '正在逐筆加入；每筆只會點擊一次加入按鈕。');
      try {
        await preflight(state.pending);
        for (const result of ready) {
          if (state.stopRequested) break;
          setUiStatus(
            ui,
            `正在加入第 ${result.rowNumber} 列：${result.productName}`
          );
          let addedAndConfirmed = false;
          try {
            const confirmedBy = await addOneRow(result);
            addedAndConfirmed = true;
            state.pending.completedRowIds.push(result.rowId);
            state.pending.completedRowIds = [...new Set(state.pending.completedRowIds)];
            result.status = '加入成功';
            result.detail = `已由${confirmedBy}確認。`;
            await savePending();
          } catch (error) {
            if (addedAndConfirmed) {
              result.status = '待人工確認';
              result.detail =
                `已確認加入，但無法保存進度：${error.message} ` +
                '請勿重新加入此列；請檢查購物車並重新整理頁面。';
              state.stopRequested = true;
            } else if (error.afterClick) {
              state.pending.manualReviewRowIds.push(result.rowId);
              state.pending.manualReviewRowIds = [
                ...new Set(state.pending.manualReviewRowIds)
              ];
              const after = cartSnapshot();
              if (!after.ambiguous && after.orderId && !state.pending.targetOrderId) {
                state.pending.targetOrderId = after.orderId;
              }
              result.status = '待人工確認';
              result.detail =
                `${error.message} 為避免重複加入，本列不會自動重試。`;
              state.stopRequested = true;
              try {
                await savePending();
              } catch (storageError) {
                result.detail += ` 暫存進度也失敗：${storageError.message}`;
              }
            } else {
              result.status = '加入失敗';
              result.detail = error.message;
              if (error.fatal) state.stopRequested = true;
            }
          }
          renderReport(ui, state);
        }
        await closeSearchDialog();

        const finished = state.pending.rows.every(row =>
          state.pending.completedRowIds.includes(row.rowId)
        );
        if (finished) {
          try {
            await Storage.remove();
            setUiStatus(
              ui,
              '所有可處理品項均已加入。請自行檢查購物車；工具不會送出訂單。',
              'success'
            );
          } catch (error) {
            setUiStatus(
              ui,
              `所有品項已加入，但無法清除暫存：${error.message}`,
              'warning'
            );
          }
        } else if (state.stopRequested) {
          setUiStatus(
            ui,
            '流程已停止。已完成進度已保存，未完成品項不會自動重試。',
            'warning'
          );
        } else {
          setUiStatus(
            ui,
            '加入流程結束；部分品項需人工處理。失敗品項不會自動重試。',
            'warning'
          );
        }
      } catch (error) {
        await closeSearchDialog();
        setUiStatus(ui, `加入流程停止：${error.message}`, 'error');
      } finally {
        state.validationFingerprint = null;
        setPhase('idle');
        renderReport(ui, state);
      }
    };

    ui.importButton.addEventListener('click', () => ui.fileInput.click());
    ui.fileInput.addEventListener('change', async () => {
      const file = ui.fileInput.files?.[0];
      ui.fileInput.value = '';
      if (!file) return;

      try {
        if (state.phase !== 'idle') return;
        if (file.size > CONFIG.maxFileBytes) {
          throw new WorkflowError('JSON_SIZE', 'JSON 超過 1 MB 上限。');
        }
        if (!/\.json$/iu.test(file.name)) {
          throw new WorkflowError('JSON_FILE', '只接受副檔名為 .json 的檔案。');
        }
        if (
          state.pending &&
          state.pending.rows.some(
            row => !state.pending.completedRowIds.includes(row.rowId)
          ) &&
          !confirm('目前有未完成流程；匯入新 JSON 會覆蓋暫存資料，是否繼續？')
        ) {
          return;
        }

        const orderFile = parseOrderJson(await file.text());
        const route = currentRoute();
        if (route.kind !== 'menu') {
          throw new WorkflowError('ROUTE', '目前不是普通菜單頁。');
        }
        if (orderFile.storeId !== route.storeId) {
          throw new WorkflowError(
            'STORE_MISMATCH',
            `JSON 店家 ${orderFile.storeId} 與目前店家 ${route.storeId} 不一致。`
          );
        }
        const importedPending = createPendingFromOrderFile(orderFile, {
          source: 'json',
          autoValidate: false
        });
        await Storage.save(importedPending);
        state.pending = importedPending;
        state.results = [];
        state.validationFingerprint = null;
        renderReport(ui, state);
        setPhase('idle');
        await runValidation();
      } catch (error) {
        setUiStatus(ui, `匯入失敗：${error.message}`, 'error');
      }
    });

    ui.validateButton.addEventListener('click', () => void runValidation());
    ui.startButton.addEventListener('click', () => void runAdding());
    ui.stopButton.addEventListener('click', () => {
      state.stopRequested = true;
      setUiStatus(ui, '已要求停止；目前這一筆處理完後會停止。', 'warning');
    });
    ui.clearButton.addEventListener('click', async () => {
      try {
        const hasStoredData = await Storage.has();
        if (!state.pending && !hasStoredData) return;
        if (
          confirm(
            '只會清除本工具在此分頁的暫存資料，不會清空購物車。是否繼續？'
          )
        ) {
          await Storage.remove();
          state.pending = null;
          state.results = [];
          state.validationFingerprint = null;
          renderReport(ui, state);
          setUiStatus(ui, '暫存資料已清除；購物車沒有變更。', 'success');
          setPhase('idle');
        }
      } catch (error) {
        setUiStatus(ui, `清除暫存失敗：${error.message}`, 'error');
      }
    });

    try {
      state.pending = await Storage.load();
      if (state.pending) {
        ui.setExpanded(true);
        const autoValidate = state.pending.autoValidate;
        state.pending.autoValidate = false;
        await savePending();
        renderReport(ui, state);
        setPhase('idle');
        if (autoValidate) {
          setUiStatus(ui, '已收到重新訂購資料，準備開始唯讀驗證。');
          await runValidation();
        } else {
          setUiStatus(
            ui,
            state.pending.completedRowIds.length
              ? '找到未完成進度；請按「驗證品項」後再繼續。'
              : '找到暫存資料；請按「驗證品項」，或清除後重新匯入。',
            'warning'
          );
        }
      } else {
        renderReport(ui, state);
        setPhase('idle');
      }
    } catch (error) {
      ui.setExpanded(true);
      setPhase('idle');
      setUiStatus(
        ui,
        `暫存資料無法使用：${error.message}。可按「清除」移除。`,
        'error'
      );
    }
  }

  // ── Nidin SPA 路由生命週期 ──────────────────────────────────────

  let activeRouteKey = null;
  let activeRouteGeneration = 0;
  let activeRouteCleanup = null;
  let routeSyncQueued = false;

  function routeKey(route = currentRoute()) {
    if (route.kind === 'order') return `order:${route.orderId}`;
    if (route.kind === 'menu') return `menu:${route.storeId}`;
    return 'other';
  }

  function routeIsActive(expectedRouteKey, generation) {
    return (
      generation === activeRouteGeneration &&
      expectedRouteKey === activeRouteKey &&
      routeKey() === expectedRouteKey
    );
  }

  function registerRouteCleanup(generation, cleanup) {
    if (generation !== activeRouteGeneration) {
      cleanup();
      return;
    }
    activeRouteCleanup = cleanup;
  }

  async function bootstrap(route, expectedRouteKey, generation) {
    if (route.kind === 'order') {
      await initOrderPage(expectedRouteKey, generation);
    } else if (route.kind === 'menu') {
      await initMenuPage(expectedRouteKey, generation);
    }
  }

  function syncRoute() {
    const route = currentRoute();
    const nextRouteKey = routeKey(route);
    if (nextRouteKey === activeRouteKey) return;

    activeRouteCleanup?.();
    activeRouteCleanup = null;
    activeRouteKey = nextRouteKey;
    const generation = ++activeRouteGeneration;
    document.getElementById(CONFIG.hostId)?.remove();

    void bootstrap(route, nextRouteKey, generation).catch(error => {
      if (
        route.kind === 'order' &&
        routeIsActive(nextRouteKey, generation)
      ) {
        showOrderNotice(`工具啟動失敗：${error.message}`);
      }
    });
  }

  function scheduleRouteSync() {
    if (routeKey() === activeRouteKey || routeSyncQueued) return;
    routeSyncQueued = true;
    queueMicrotask(() => {
      routeSyncQueued = false;
      syncRoute();
    });
  }

  const routeObserver = new MutationObserver(scheduleRouteSync);
  routeObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
  addEventListener('popstate', scheduleRouteSync);
  addEventListener('hashchange', scheduleRouteSync);
  syncRoute();
})();
