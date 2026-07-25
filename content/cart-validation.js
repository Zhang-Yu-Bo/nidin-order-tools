/**
 * 購物車狀態、品項驗證與結果呈現。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const {
    CONFIG,
    SELECTORS,
    WorkflowError,
    currentRoute,
    normalizeText,
    cleanText,
    delay,
    nextFrame,
    isVisible,
    waitForCondition,
    hashText,
    sameMoney,
  } = root.core;
  const {
    visibleMenuRoot,
    findMenuSearchButton,
    menuProductEntries,
    locateProduct,
    openProduct,
    closeProductModal,
    clearRetainedOptionalSelections,
    chooseOptions,
    modalPrice,
    setQuantity,
    findBuyerInput,
    checkModalAuthorization,
  } = root.menuDom;

  // ── 購物車狀態、防重複與驗證結果 ───────────────────────────────

  function cartSnapshot() {
    const found = new Map();
    document.querySelectorAll(SELECTORS.cartLink).forEach((anchor) => {
      if (!isVisible(anchor)) return;
      try {
        const url = new URL(anchor.getAttribute("href"), location.origin);
        const match = url.pathname.match(/^\/orderList\/(\d+)\/?$/u);
        if (url.origin === CONFIG.origin && match) {
          found.set(match[1], anchor);
        }
      } catch {
        // 忽略無效連結。
      }
    });

    const route = currentRoute();
    if (
      route.kind === "menu" && route.targetOrderId &&
      !found.has(route.targetOrderId)
    ) {
      found.set(route.targetOrderId, null);
    }
    const ids = [...found.keys()];
    if (ids.length > 1) {
      return { ambiguous: true, orderId: null, signature: "" };
    }
    if (!ids.length) {
      return { ambiguous: false, orderId: null, signature: "empty" };
    }

    const orderId = ids[0];
    const anchor = found.get(orderId);
    const container = anchor?.closest(".q-page-sticky") || anchor;
    return {
      ambiguous: false,
      orderId,
      signature: `${orderId}|${
        normalizeText(container?.textContent || location.pathname)
      }`,
    };
  }

  function cartChanged(before, after) {
    return !after.ambiguous && before.signature !== after.signature;
  }

  function successNotifications() {
    return [...document.querySelectorAll(SELECTORS.notification)].filter(
      (element) =>
        isVisible(element) &&
        /成功|已加入|加入購物車/u.test(cleanText(element)),
    );
  }

  function successNotificationSnapshot() {
    return new Map(
      successNotifications().map((element) => [
        element,
        `${cleanText(element)}|${element.childElementCount}`,
      ]),
    );
  }

  function hasNewSuccessNotification(previous) {
    return successNotifications().some((element) => {
      const signature = `${cleanText(element)}|${element.childElementCount}`;
      return !previous.has(element) || previous.get(element) !== signature;
    });
  }

  async function preflight(pending) {
    const route = currentRoute();
    if (route.kind !== "menu") {
      throw new WorkflowError("ROUTE", "目前不是普通 Nidin 菜單頁。");
    }
    if (route.storeId !== pending.storeId) {
      throw new WorkflowError(
        "STORE_MISMATCH",
        `目前店家 ${route.storeId} 與資料中的店家 ${pending.storeId} 不一致。`,
      );
    }

    const bodyText = normalizeText(document.body.innerText);
    const blocker = [
      "門市目前無上架菜單",
      "門市籌備中",
      "門市已歇業",
      "門市暫停接單",
    ].find((text) => bodyText.includes(text));
    if (blocker) throw new WorkflowError("STORE_CLOSED", blocker);

    const loginLink = [...document.querySelectorAll("a[href]")].find(
      (anchor) => {
        try {
          const url = new URL(anchor.getAttribute("href"), location.origin);
          return (
            isVisible(anchor) &&
            url.origin === CONFIG.origin &&
            url.pathname === "/login" &&
            /^登入$/u.test(cleanText(anchor))
          );
        } catch {
          return false;
        }
      },
    );
    if (loginLink) throw new WorkflowError("AUTH", "請先登入 Nidin。", true);

    await waitForCondition(visibleMenuRoot, {
      message: "菜單尚未完成載入。",
    });
    await waitForCondition(
      () => menuProductEntries().length || findMenuSearchButton(),
      {
        message: "菜單目前找不到可操作的商品清單或商品搜尋。",
      },
    );

    const cart = cartSnapshot();
    if (cart.ambiguous) {
      throw new WorkflowError("CART", "頁面上出現多個購物車，無法安全判定。");
    }
    const hasProgress = pending.completedRowIds.length > 0 ||
      pending.manualReviewRowIds.length > 0;
    if (!hasProgress && cart.orderId) {
      throw new WorkflowError(
        "CART",
        "目前已有購物車；本工具不會清空或覆蓋它。",
      );
    }
    if (hasProgress) {
      if (!pending.targetOrderId) {
        throw new WorkflowError(
          "CART",
          "無法證明目前購物車屬於先前流程，已停止續傳。",
        );
      }
      if (cart.orderId !== pending.targetOrderId) {
        throw new WorkflowError(
          "CART",
          "目前購物車與先前流程不一致，已停止續傳。",
        );
      }
    }
    return cart;
  }

  function resultStatus(error) {
    switch (error.code) {
      case "NO_PRODUCT":
        return "找不到商品";
      case "AMBIGUOUS_PRODUCT":
        return "商品不唯一";
      case "OPTION":
      case "OPTION_RESET":
      case "BUYER":
      case "QUANTITY":
      case "ADD_BUTTON":
        return "規格不匹配";
      case "PRICE":
        return "價格變更";
      case "SOLD_OUT":
        return "停售";
      case "TIMEOUT":
        return "頁面逾時";
      case "AUTH":
        return "登入／驗證未完成";
      default:
        return "頁面逾時";
    }
  }

  function groupRows(rows) {
    const groups = new Map();
    rows.forEach((row) => {
      const key = JSON.stringify([
        normalizeText(row.productName),
        row.optionTokens.map(normalizeText),
        row.price,
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
        throw new WorkflowError("BUYER", "此門市未提供訂購人姓名欄位。");
      }
      await clearRetainedOptionalSelections(modal);
      await setQuantity(modal, 1);
      const options = await chooseOptions(modal, sample.optionTokens);
      await nextFrame();
      await delay(CONFIG.shortDelayMs);
      const price = modalPrice(modal);
      if (price === null) {
        throw new WorkflowError("PRICE", "無法讀取商品總金額。");
      }
      if (!sameMoney(price, sample.price)) {
        throw new WorkflowError(
          "PRICE",
          `備份資料為 ${sample.price} 元，目前為 ${price} 元。`,
        );
      }

      return {
        status: "可加入",
        detail: "商品、規格與價格均相符。",
        productId: product.productId,
        mappedOptions: options.mappedOptions,
      };
    } catch (error) {
      return {
        status: resultStatus(error),
        detail: error.message,
        fatal: Boolean(error.fatal),
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
        pending.rows.map((row) => [
          row.rowId,
          row.productName,
          row.rawOptions,
          row.price,
          row.buyer,
          row.quantity,
        ]),
      ),
    );
  }

  function reportRows(state) {
    const ignored = (state.pending?.ignoredRows || []).map((item) => ({
      rowId: `ignored-${item.rowNumber}`,
      rowNumber: item.rowNumber,
      productName: item.productName,
      rawOptions: "",
      quantity: "",
      status: "已忽略",
      detail: item.reason,
    }));
    const current = new Map(
      state.results.map((result) => [result.rowId, result]),
    );
    const pending = (state.pending?.rows || []).map((row) => {
      if (current.has(row.rowId)) return current.get(row.rowId);
      let status = "待驗證";
      let detail = "";
      if (state.pending.completedRowIds.includes(row.rowId)) {
        status = "已加入（先前完成）";
        detail = "不會重複加入。";
      } else if (state.pending.manualReviewRowIds.includes(row.rowId)) {
        status = "待人工確認";
        detail = "曾點擊加入但無法確認結果，不會自動重試。";
      }
      return { ...row, status, detail };
    });
    return [...ignored, ...pending];
  }

  function renderReport(ui, state) {
    const pending = state.pending;
    ui.meta.textContent = pending
      ? `店家 ${pending.storeId}｜有效 ${pending.rows.length} 筆｜忽略 ${pending.ignoredRows.length} 筆`
      : "尚未載入訂單資料";
    ui.progress.textContent = pending
      ? `已完成 ${pending.completedRowIds.length} / ${pending.rows.length} 筆` +
        (pending.manualReviewRowIds.length
          ? `｜待人工確認 ${pending.manualReviewRowIds.length} 筆`
          : "")
      : "";

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    ["列", "品項／規格", "數量", "狀態"].forEach((text) => {
      const th = document.createElement("th");
      th.textContent = text;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    const body = document.createElement("tbody");

    reportRows(state).forEach((result) => {
      const tr = document.createElement("tr");
      const rowCell = document.createElement("td");
      rowCell.textContent = String(result.rowNumber || "");
      const productCell = document.createElement("td");
      productCell.className = "product";
      const name = document.createElement("div");
      name.textContent = result.productName;
      const options = document.createElement("div");
      options.className = "detail";
      options.textContent = result.rawOptions || "";
      productCell.append(name, options);
      const quantityCell = document.createElement("td");
      quantityCell.textContent = String(result.quantity || "");
      const statusCell = document.createElement("td");
      const status = document.createElement("div");
      status.textContent = result.status;
      const detail = document.createElement("div");
      detail.className = "detail";
      detail.textContent = result.detail || "";
      statusCell.append(status, detail);
      tr.append(rowCell, productCell, quantityCell, statusCell);
      body.appendChild(tr);
    });
    ui.report.replaceChildren(head, body);
  }

  function setUiStatus(ui, message, type = "info") {
    ui.status.className = `status ${type}`;
    ui.status.textContent = message;
  }

  root.cartValidation = Object.freeze({
    cartSnapshot,
    cartChanged,
    successNotificationSnapshot,
    hasNewSuccessNotification,
    preflight,
    groupRows,
    validateGroup,
    pendingFingerprint,
    renderReport,
    setUiStatus,
  });
})();
