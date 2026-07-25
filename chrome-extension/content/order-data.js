/**
 * 訂單 JSON 與暫存資料的正規化及驗證。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const {
    CONFIG,
    WorkflowError,
    normalizeText,
    cleanBuyerName,
    makeRowId,
    parsePrice,
  } = root.core;

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

      let reason = "";
      if (!productName) reason = "空白品項";
      else if (productName === "無商品" || productName === "合計") {
        reason = `忽略「${productName}」列`;
      } else if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > CONFIG.maxQuantity
      ) {
        reason = "數量必須為 1–999 的整數";
      } else if (price === null) {
        reason = "價格格式不正確";
      } else if (!buyer) {
        reason = "訂購者為空白";
      }

      if (reason) {
        ignored.push({
          rowNumber,
          productName: productName || "（空白）",
          reason,
        });
        return;
      }

      const fields = [
        productName,
        rawOptions,
        String(price),
        buyer,
        String(quantity),
        normalizeText(record.paid),
      ];
      rows.push({
        rowId: makeRowId(rowNumber, fields),
        rowNumber,
        productName,
        rawOptions,
        optionTokens: rawOptions
          ? rawOptions.split("/").map(normalizeText).filter(Boolean)
          : [],
        price,
        buyer,
        quantity,
        paid: normalizeText(record.paid),
        storeId: metadata.storeId || null,
        sourceOrderId: metadata.sourceOrderId || null,
      });
    });

    return { rows, ignored };
  }

  function exactOrderText(value, field, maxLength) {
    if (
      typeof value !== "string" ||
      value.length > maxLength ||
      !value ||
      normalizeText(value) !== value
    ) {
      throw new WorkflowError("JSON_FIELD", `${field} 格式不正確。`);
    }
    return value;
  }

  function validateOrderFile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkflowError("JSON_FORMAT", "JSON 最外層必須是物件。");
    }
    if (value.format !== CONFIG.orderFileFormat) {
      throw new WorkflowError("JSON_FORMAT", "不是 Nidin 訂單工具的 JSON。");
    }
    if (value.schemaVersion !== CONFIG.orderFileSchemaVersion) {
      throw new WorkflowError("JSON_VERSION", "JSON 訂單版本不相容。");
    }

    const storeId = value.storeId;
    const sourceOrderId = value.sourceOrderId;
    if (typeof storeId !== "string" || !/^\d+$/u.test(storeId)) {
      throw new WorkflowError("JSON_STORE", "JSON 店家 ID 格式不正確。");
    }
    if (
      typeof sourceOrderId !== "string" ||
      !/^\d+$/u.test(sourceOrderId)
    ) {
      throw new WorkflowError("JSON_ORDER", "JSON 來源訂單 ID 格式不正確。");
    }
    if (
      typeof value.exportedAt !== "string" ||
      value.exportedAt.length > 40 ||
      !Number.isFinite(Date.parse(value.exportedAt)) ||
      new Date(value.exportedAt).toISOString() !== value.exportedAt
    ) {
      throw new WorkflowError("JSON_DATE", "JSON 匯出時間格式不正確。");
    }
    if (
      !Array.isArray(value.items) ||
      !value.items.length ||
      value.items.length > CONFIG.maxRows
    ) {
      throw new WorkflowError(
        "JSON_ITEMS",
        `JSON 品項必須為 1–${CONFIG.maxRows} 筆。`,
      );
    }

    const items = value.items.map((item, index) => {
      const prefix = `第 ${index + 1} 筆`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new WorkflowError("JSON_ITEM", `${prefix}品項格式不正確。`);
      }
      const productName = exactOrderText(
        item.productName,
        `${prefix}品項名稱`,
        500,
      );
      if (!Array.isArray(item.options) || item.options.length > 100) {
        throw new WorkflowError("JSON_OPTIONS", `${prefix}規格格式不正確。`);
      }
      const options = item.options.map((option, optionIndex) =>
        exactOrderText(
          option,
          `${prefix}第 ${optionIndex + 1} 個規格`,
          500,
        )
      );
      if (
        typeof item.unitPrice !== "number" ||
        !Number.isFinite(item.unitPrice) ||
        item.unitPrice < 0 ||
        !Number.isSafeInteger(Math.round(item.unitPrice * 100)) ||
        Math.abs(item.unitPrice * 100 - Math.round(item.unitPrice * 100)) >
          0.000001
      ) {
        throw new WorkflowError("JSON_PRICE", `${prefix}單價格式不正確。`);
      }
      const buyer = cleanBuyerName(
        exactOrderText(item.buyer, `${prefix}訂購者`, 500),
      );
      if (!buyer) {
        throw new WorkflowError("JSON_BUYER", `${prefix} buyer 沒有姓名。`);
      }
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > CONFIG.maxQuantity
      ) {
        throw new WorkflowError(
          "JSON_QUANTITY",
          `${prefix}數量必須為 1–${CONFIG.maxQuantity} 的整數。`,
        );
      }
      if (typeof item.paid !== "boolean") {
        throw new WorkflowError("JSON_PAID", `${prefix}收款狀態格式不正確。`);
      }

      return {
        productName,
        options,
        unitPrice: item.unitPrice,
        buyer,
        quantity: item.quantity,
        paid: item.paid,
      };
    });

    return {
      format: CONFIG.orderFileFormat,
      schemaVersion: CONFIG.orderFileSchemaVersion,
      exportedAt: value.exportedAt,
      storeId,
      sourceOrderId,
      items,
    };
  }

  function parseOrderJson(text) {
    if (typeof text !== "string") {
      throw new WorkflowError("JSON_PARSE", "JSON 內容無法解析。");
    }
    if (text.length > CONFIG.maxFileBytes) {
      throw new WorkflowError("JSON_SIZE", "JSON 超過 1 MB 上限。");
    }
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    try {
      return validateOrderFile(JSON.parse(source));
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError("JSON_PARSE", "JSON 內容無法解析。");
    }
  }

  function createOrderFile(rows, storeId, sourceOrderId) {
    return validateOrderFile({
      format: CONFIG.orderFileFormat,
      schemaVersion: CONFIG.orderFileSchemaVersion,
      exportedAt: new Date().toISOString(),
      storeId,
      sourceOrderId,
      items: rows.map((row) => ({
        productName: row.productName,
        options: [...row.optionTokens],
        unitPrice: row.price,
        buyer: cleanBuyerName(row.buyer),
        quantity: row.quantity,
        paid: row.paid === "Y",
      })),
    });
  }

  function rowsFromOrderFile(orderFile) {
    return orderFile.items.map((item, index) => {
      const rowNumber = index + 2;
      const rawOptions = item.options.join(" / ");
      const paid = item.paid ? "Y" : "N";
      const fields = [
        item.productName,
        JSON.stringify(item.options),
        String(item.unitPrice),
        item.buyer,
        String(item.quantity),
        paid,
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
        sourceOrderId: orderFile.sourceOrderId,
      };
    });
  }

  function validatePending(value) {
    if (!value || value.schemaVersion !== CONFIG.schemaVersion) {
      throw new WorkflowError("STORAGE", "暫存資料版本不相容。");
    }
    if (!/^\d+$/u.test(String(value.storeId || ""))) {
      throw new WorkflowError("STORAGE", "暫存資料的店家 ID 不正確。");
    }
    if (!Array.isArray(value.rows) || value.rows.length > CONFIG.maxRows) {
      throw new WorkflowError("STORAGE", "暫存資料列數不正確。");
    }

    const rows = value.rows.map((row) => {
      const rowStoreId = row?.storeId === null || row?.storeId === undefined
        ? null
        : String(row.storeId);
      const rowSourceOrderId =
        row?.sourceOrderId === null || row?.sourceOrderId === undefined
          ? null
          : String(row.sourceOrderId);
      const buyer = typeof row?.buyer === "string"
        ? cleanBuyerName(row.buyer)
        : "";
      const valid = row &&
        typeof row.rowId === "string" &&
        row.rowId.length <= 100 &&
        Number.isInteger(row.rowNumber) &&
        row.rowNumber > 0 &&
        typeof row.productName === "string" &&
        Boolean(row.productName) &&
        normalizeText(row.productName) === row.productName &&
        row.productName.length <= 500 &&
        typeof row.rawOptions === "string" &&
        normalizeText(row.rawOptions) === row.rawOptions &&
        row.rawOptions.length <= 2000 &&
        Array.isArray(row.optionTokens) &&
        row.optionTokens.length <= 100 &&
        row.optionTokens.every(
          (token) =>
            typeof token === "string" &&
            Boolean(token) &&
            token.length <= 500 &&
            normalizeText(token) === token,
        ) &&
        Number.isFinite(row.price) &&
        row.price >= 0 &&
        Boolean(buyer) &&
        buyer.length <= 500 &&
        Number.isInteger(row.quantity) &&
        row.quantity >= 1 &&
        row.quantity <= CONFIG.maxQuantity &&
        (row.paid === "Y" || row.paid === "N") &&
        (rowStoreId === null || /^\d+$/u.test(rowStoreId)) &&
        (rowSourceOrderId === null || /^\d+$/u.test(rowSourceOrderId));
      if (!valid) throw new WorkflowError("STORAGE", "暫存品項格式不正確。");
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
        sourceOrderId: rowSourceOrderId,
      };
    });

    const rowIds = new Set(rows.map((row) => row.rowId));
    if (rowIds.size !== rows.length) {
      throw new WorkflowError("STORAGE", "暫存品項 ID 重複。");
    }
    const completedRowIds = Array.isArray(value.completedRowIds)
      ? [...new Set(value.completedRowIds.filter((id) => rowIds.has(id)))]
      : [];
    const completed = new Set(completedRowIds);
    const manualReviewRowIds = Array.isArray(value.manualReviewRowIds)
      ? [
        ...new Set(
          value.manualReviewRowIds.filter((id) =>
            rowIds.has(id) && !completed.has(id)
          ),
        ),
      ]
      : [];
    const targetOrderId =
      value.targetOrderId === null || value.targetOrderId === undefined
        ? null
        : String(value.targetOrderId);
    if (targetOrderId !== null && !/^\d+$/u.test(targetOrderId)) {
      throw new WorkflowError("STORAGE", "暫存購物車 ID 不正確。");
    }

    const ignoredRows = Array.isArray(value.ignoredRows)
      ? value.ignoredRows.slice(0, CONFIG.maxRows).map((item) => ({
        rowNumber: Number(item.rowNumber) || 0,
        productName: normalizeText(item.productName).slice(0, 200),
        reason: normalizeText(item.reason).slice(0, 300),
      }))
      : [];

    return {
      schemaVersion: CONFIG.schemaVersion,
      source: value.source === "order-page" ? "order-page" : "json",
      sourceOrderId: /^\d+$/u.test(String(value.sourceOrderId || ""))
        ? String(value.sourceOrderId)
        : null,
      storeId: String(value.storeId),
      storeConfirmed: Boolean(value.storeConfirmed),
      createdAt: typeof value.createdAt === "string"
        ? value.createdAt
        : new Date().toISOString(),
      rows,
      ignoredRows,
      completedRowIds,
      manualReviewRowIds,
      targetOrderId,
      autoValidate: Boolean(value.autoValidate),
    };
  }

  function createPending({
    source,
    sourceOrderId,
    storeId,
    storeConfirmed,
    rows,
    ignoredRows,
    autoValidate = false,
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
      autoValidate,
    });
  }

  function createPendingFromOrderFile(
    orderFile,
    { source, ignoredRows = [], autoValidate = false },
  ) {
    const validated = validateOrderFile(orderFile);
    return createPending({
      source,
      sourceOrderId: validated.sourceOrderId,
      storeId: validated.storeId,
      storeConfirmed: true,
      rows: rowsFromOrderFile(validated),
      ignoredRows,
      autoValidate,
    });
  }

  root.orderData = Object.freeze({
    normalizeRecords,
    validatePending,
    parseOrderJson,
    createOrderFile,
    createPendingFromOrderFile,
  });
})();
