/**
 * 菜單搜尋、商品視窗與規格 DOM 操作。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const {
    CONFIG,
    ADD_BUTTON_TEXT,
    AUTH_BUTTON_TEXT,
    SELECTORS,
    WorkflowError,
    routeKey,
    normalizeText,
    cleanText,
    delay,
    nextFrame,
    isVisible,
    isDisabled,
    clickElement,
    waitForCondition,
    setNativeValue,
    ownText,
    parsePrice,
  } = root.core;

  // ── 菜單搜尋與商品規格 DOM 操作 ─────────────────────────────────

  function visibleMenuRoot() {
    return [...document.querySelectorAll(SELECTORS.menuRoot)].find(isVisible) ||
      null;
  }

  function findMenuSearchButton() {
    const root = visibleMenuRoot();
    if (!root) return null;
    return [...root.querySelectorAll(SELECTORS.menuSearchButton)].find(
      (button) => {
        const icon = button.querySelector('.fa-search, [class*="fa-search"]');
        return (
          isVisible(button) &&
          Boolean(
            button.classList.contains("straight-line") ||
              icon ||
              /搜尋|search/iu.test(
                `${cleanText(button)} ${
                  button.getAttribute("aria-label") || ""
                }`,
              ),
          )
        );
      },
    ) || null;
  }

  function visibleSearchDialog() {
    const card = [...document.querySelectorAll(SELECTORS.searchCard)].find(
      isVisible,
    );
    if (!card) return null;
    return card.closest('.q-dialog__inner, [role="dialog"]') ||
      card.parentElement;
  }

  function visibleProductModal() {
    return [...document.querySelectorAll(SELECTORS.productModal)].find(
      isVisible,
    ) || null;
  }

  async function ensureSearchDialog() {
    if (visibleProductModal()) {
      throw new WorkflowError(
        "MODAL_OPEN",
        "前一個商品視窗仍未關閉，為避免點錯已停止。",
        true,
      );
    }
    const existing = visibleSearchDialog();
    if (existing?.querySelector(SELECTORS.searchInput)) return existing;

    const button = await waitForCondition(findMenuSearchButton, {
      message: "找不到 Nidin 的商品搜尋按鈕。",
    });
    clickElement(button);
    return waitForCondition(() => {
      const dialog = visibleSearchDialog();
      return dialog?.querySelector(SELECTORS.searchInput) ? dialog : null;
    }, { message: "商品搜尋視窗沒有開啟。" });
  }

  async function closeSearchDialog() {
    const dialog = visibleSearchDialog();
    if (!dialog) return;
    const close = [...dialog.querySelectorAll(SELECTORS.closeIcon)].find(
      (element) =>
        isVisible(element) && element.classList.contains("sticky-header"),
    );
    if (!close) return;
    close.click();
    try {
      await waitForCondition(() => !visibleSearchDialog(), {
        timeout: 3000,
        message: "搜尋視窗沒有關閉。",
      });
    } catch {
      // 不影響已完成的驗證結果。
    }
  }

  function findProductObject(value) {
    if (!value || typeof value !== "object") return null;
    if (
      (value["@type"] === "Product" || value.productID) &&
      typeof value.name === "string" &&
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
    root.querySelectorAll(SELECTORS.productJson).forEach((script) => {
      try {
        const product = findProductObject(JSON.parse(script.textContent));
        if (!product) return;
        let target = script.parentElement;
        while (
          target &&
          target !== root &&
          !target.classList.contains("cursor-pointer") &&
          !target.classList.contains("disabled-product")
        ) {
          target = target.parentElement;
        }
        if (!target || target === root || !isVisible(target)) return;
        entries.push({
          name: normalizeText(product.name),
          productId: String(product.productID),
          target,
          soldOut: target.classList.contains("disabled-product") ||
            isDisabled(target) ||
            /停售|完售|暫停供應/u.test(cleanText(target)),
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
      (entry) => normalizeText(entry.name) === normalizeText(productName),
    );
    const unique = new Map();
    matches.forEach((entry) => {
      const previous = unique.get(entry.productId);
      if (!previous || (previous.soldOut && !entry.soldOut)) {
        unique.set(entry.productId, entry);
      }
    });
    let exact = [...unique.values()];
    if (expectedProductId) {
      exact = exact.filter((entry) =>
        entry.productId === String(expectedProductId)
      );
    }

    if (!exact.length) {
      throw new WorkflowError("NO_PRODUCT", "找不到完整名稱相同的商品。");
    }
    if (exact.length !== 1) {
      throw new WorkflowError("AMBIGUOUS_PRODUCT", "找到多個同名商品。");
    }
    if (exact[0].soldOut) {
      throw new WorkflowError("SOLD_OUT", "商品已停售或暫停供應。");
    }
    return exact[0];
  }

  function optionalExactProductEntry(
    entries,
    productName,
    expectedProductId = null,
  ) {
    const normalizedName = normalizeText(productName);
    const hasCandidate = entries.some(
      (entry) =>
        entry.name === normalizedName &&
        (!expectedProductId ||
          entry.productId === String(expectedProductId)),
    );
    return hasCandidate
      ? exactProductEntry(entries, productName, expectedProductId)
      : null;
  }

  function waitForDomQuiet(root, quietMs, timeoutMs) {
    return new Promise((resolve) => {
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
    const scrollRoot = document.scrollingElement || document.documentElement;
    const originalTop = scrollRoot.scrollTop;
    const originalLeft = scrollRoot.scrollLeft;
    const rect = list.getBoundingClientRect();
    const viewportHeight = Math.max(
      globalThis.innerHeight,
      document.documentElement.clientHeight,
      480,
    );
    const listTop = Math.max(0, originalTop + rect.top);
    const listHeight = Math.max(rect.height, list.scrollHeight);
    const first = Math.max(0, listTop - Math.floor(viewportHeight * 0.15));
    const last = Math.max(
      first,
      listTop + listHeight - Math.floor(viewportHeight * 0.8),
    );
    const distance = last - first;
    const idealStep = Math.max(320, Math.floor(viewportHeight * 0.7));
    const count = Math.min(
      CONFIG.maxMenuScanSteps,
      Math.max(1, Math.ceil(distance / idealStep) + 1),
    );
    const positions = count === 1 ? [first] : Array.from(
      { length: count },
      (_, index) => first + (distance * index) / (count - 1),
    );

    return {
      scrollRoot,
      originalTop,
      originalLeft,
      positions,
    };
  }

  async function locateProductByMenuScan(
    productName,
    expectedProductId = null,
  ) {
    const root = visibleMenuRoot();
    if (!root) {
      throw new WorkflowError("NO_PRODUCT", "找不到可掃描的菜單。");
    }

    const initial = optionalExactProductEntry(
      menuProductEntries(),
      productName,
      expectedProductId,
    );
    if (initial) return initial;

    await waitForDomQuiet(
      root,
      CONFIG.menuSettleMs,
      CONFIG.menuSettleTimeoutMs,
    );
    const settled = optionalExactProductEntry(
      menuProductEntries(),
      productName,
      expectedProductId,
    );
    if (settled) return settled;

    const expectedRouteKey = routeKey();
    const scan = menuScanPositions(root);
    let keepPosition = false;
    try {
      for (const position of scan.positions) {
        if (routeKey() !== expectedRouteKey) {
          throw new WorkflowError(
            "ROUTE",
            "頁面已切換，已停止尋找商品。",
            true,
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
          expectedProductId,
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

    throw new WorkflowError("NO_PRODUCT", "找不到完整名稱相同的商品。");
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
          expectedProductId,
        );
      } catch (error) {
        if (error.code !== "NO_PRODUCT" && error.code !== "TIMEOUT") {
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
    expectedProductId = null,
  ) {
    const input = dialog.querySelector(SELECTORS.searchInput);
    if (!input) throw new WorkflowError("SEARCH", "找不到商品搜尋輸入欄。");
    setNativeValue(input, productName);
    await nextFrame();
    await nextFrame();

    await waitForCondition(
      () =>
        optionalExactProductEntry(
          productEntries(dialog),
          productName,
          expectedProductId,
        ),
      {
        timeout: CONFIG.searchResultTimeoutMs,
        message: `搜尋「${productName}」的結果載入逾時。`,
      },
    );
    await delay(CONFIG.shortDelayMs);
    return exactProductEntry(
      productEntries(dialog),
      productName,
      expectedProductId,
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
      throw new WorkflowError("MODAL_PRODUCT", "商品規格視窗切換成其他品項。");
    }
    return modal;
  }

  async function closeProductModal(modal) {
    if (!isVisible(modal)) return;
    const close = [...modal.querySelectorAll(SELECTORS.closeIcon)].find(
      isVisible,
    );
    if (!close) {
      throw new WorkflowError("MODAL_CLOSE", "找不到商品視窗的關閉按鈕。");
    }
    close.click();
    await waitForCondition(() => !isVisible(modal), {
      timeout: 4000,
      message: "商品規格視窗沒有關閉。",
    });
  }

  function optionLabel(option) {
    const direct = [...option.children].find((child) =>
      child.tagName === "DIV"
    );
    return normalizeText(direct?.textContent || option.textContent);
  }

  function optionCandidates(modal, label) {
    const matches = [...modal.querySelectorAll(SELECTORS.option)].filter(
      (option) => optionLabel(option) === label,
    );
    if (matches.length <= 1) return matches;

    const currentCombination = matches.filter((option) =>
      option.classList.contains("b-border")
    );
    return currentCombination.length === 1 ? currentCombination : matches;
  }

  function optionToggle(option) {
    const block = option.closest(SELECTORS.optionBlock);
    const adjustment = block?.closest(SELECTORS.adjustment);
    if (!block || !adjustment) return null;

    const previous = block.previousElementSibling;
    if (
      previous?.classList.contains("cursor-pointer") &&
      isVisible(previous)
    ) {
      return previous;
    }

    return [...adjustment.querySelectorAll(".cursor-pointer")].find(
      (candidate) =>
        !candidate.closest(SELECTORS.optionBlock) &&
        candidate.closest(SELECTORS.adjustment) === adjustment &&
        candidate.querySelector(".fa-caret-down, .fa-caret-up") &&
        isVisible(candidate),
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
        message: `規格「${label}」所在區塊沒有展開。`,
      });
    } catch {
      return [];
    }
  }

  async function resolveOptionToken(modal, token) {
    const label = normalizeText(token);
    return {
      matches: await visibleOptionCandidates(modal, label),
      label,
    };
  }

  function optionSelected(option) {
    return (
      option.classList.contains("b-bg") ||
      option.classList.contains("text-white") ||
      option.getAttribute("aria-checked") === "true"
    );
  }

  function adjustmentRequired(adjustment) {
    return [...adjustment.querySelectorAll(".text-secondary")].some(
      (element) => normalizeText(element.textContent).includes("✽"),
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
      (option) => optionLabel(option) === label,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function optionAmount(option) {
    if (!optionSelected(option)) return 0;
    const badge = option.parentElement?.querySelector(".amount");
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
      throw new WorkflowError(
        "OPTION_RESET",
        `無法唯一找到已選規格「${label}」。`,
      );
    }
    if (isVisible(option)) return option;

    const toggle = optionToggle(option);
    if (!toggle) {
      throw new WorkflowError("OPTION_RESET", `無法展開已選規格「${label}」。`);
    }
    clickElement(toggle);
    return waitForCondition(() => {
      option = adjustmentOption(adjustment, label);
      return option && isVisible(option) ? option : null;
    }, {
      root: adjustment,
      timeout: 3000,
      message: `已選規格「${label}」所在區塊沒有展開。`,
    });
  }

  async function clearRetainedOption(adjustment, label) {
    let option = await revealAdjustmentOption(adjustment, label);
    let amount = optionAmount(option);
    if (amount === null) {
      throw new WorkflowError(
        "OPTION_RESET",
        `無法讀取先前規格「${label}」的選取次數。`,
      );
    }
    if (amount === 0) return;

    const declaredLimit = adjustmentSelectionLimit(adjustment);
    const clickBudget = declaredLimit
      ? Math.min(
        CONFIG.maxOptionResetClicks,
        Math.max(1, declaredLimit - amount + 1),
      )
      : Math.min(CONFIG.maxOptionResetClicks, 2);

    for (let clickCount = 1; clickCount <= clickBudget; clickCount += 1) {
      if (isDisabled(option)) {
        throw new WorkflowError(
          "OPTION_RESET",
          `先前選取的規格「${label}」目前無法取消。`,
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
          message: `先前選取的規格「${label}」數量沒有變化。`,
        });
      } catch (error) {
        if (error?.code === "TIMEOUT") {
          throw new WorkflowError(
            "OPTION_RESET",
            `先前選取的規格「${label}」沒有回應，原數量為 ${previousAmount}。`,
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
      "OPTION_RESET",
      `先前選取的規格「${label}」在 ${clickBudget} 次安全點擊後仍有 ${amount} 份。`,
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
        (adjustment) =>
          !adjustmentRequired(adjustment) &&
          !intrinsicProductAdjustment(adjustment, modal),
      )
      .flatMap((adjustment) => adjustmentOptions(adjustment))
      .filter(optionSelected)
      .map(optionLabel);
    if (retained.length) {
      throw new WorkflowError(
        "OPTION_RESET",
        `仍保留先前規格「${[...new Set(retained)].join("、")}」。`,
      );
    }
  }

  function unexpectedSelectedOptions(modal, expectedLabels) {
    const expected = new Set(expectedLabels.map(normalizeText));
    return [...modal.querySelectorAll(SELECTORS.adjustment)]
      .filter((adjustment) => !intrinsicProductAdjustment(adjustment, modal))
      .flatMap((adjustment) => adjustmentOptions(adjustment))
      .filter((option) =>
        optionSelected(option) && !expected.has(optionLabel(option))
      )
      .map(optionLabel);
  }

  async function chooseOptions(modal, tokens) {
    const mappedOptions = [];

    for (const token of tokens) {
      const resolved = await resolveOptionToken(modal, token);
      const matches = resolved.matches;
      if (matches.length !== 1) {
        const reason = matches.length ? "規格名稱不唯一" : "找不到規格";
        throw new WorkflowError("OPTION", `${reason}「${token}」。`);
      }
      const option = matches[0];
      if (isDisabled(option)) {
        throw new WorkflowError("SOLD_OUT", `規格「${token}」已停售。`);
      }
      if (!optionSelected(option)) {
        clickElement(option);
        await waitForCondition(() => {
          const current = optionCandidates(modal, resolved.label);
          return current.length === 1 && optionSelected(current[0]);
        }, {
          timeout: 3000,
          message: `規格「${token}」沒有成功選取。`,
        });
      }
      mappedOptions.push({ token, label: optionLabel(option) });
    }

    const unselected = mappedOptions.find((mapping) => {
      const matches = optionCandidates(modal, mapping.label);
      return matches.length !== 1 || !optionSelected(matches[0]);
    });
    if (unselected) {
      throw new WorkflowError(
        "OPTION",
        `規格「${unselected.token}」與其他選項互斥。`,
      );
    }

    for (const adjustment of modal.querySelectorAll(SELECTORS.adjustment)) {
      if (!isVisible(adjustment)) continue;
      if (!adjustmentRequired(adjustment)) continue;
      const visibleOptions = [...adjustment.querySelectorAll(".option")].filter(
        isVisible,
      );
      if (visibleOptions.length && !visibleOptions.some(optionSelected)) {
        const title = [...adjustment.querySelectorAll("div, span")]
          .map(ownText)
          .find((value) => value && !value.includes("✽")) || "必選規格";
        throw new WorkflowError("OPTION", `尚未完成「${title}」的必選規格。`);
      }
    }

    const unexpected = unexpectedSelectedOptions(
      modal,
      mappedOptions.map((mapping) => mapping.label),
    );
    if (unexpected.length) {
      throw new WorkflowError(
        "OPTION_RESET",
        `畫面仍選取非本筆規格「${[...new Set(unexpected)].join("、")}」。`,
      );
    }

    return { mappedOptions };
  }

  async function applyMappedOptions(modal, mappings) {
    for (const mapping of mappings) {
      const label = normalizeText(mapping.label);
      const matches = await visibleOptionCandidates(modal, label);
      if (matches.length !== 1) {
        throw new WorkflowError(
          "OPTION",
          `已驗證規格「${mapping.label}」目前無法唯一找到。`,
        );
      }
      const option = matches[0];
      if (isDisabled(option)) {
        throw new WorkflowError(
          "SOLD_OUT",
          `規格「${mapping.label}」目前不可用。`,
        );
      }
      if (!optionSelected(option)) {
        clickElement(option);
        await waitForCondition(() => {
          const current = optionCandidates(modal, label);
          return current.length === 1 && optionSelected(current[0]);
        }, {
          timeout: 3000,
          message: `規格「${mapping.label}」沒有成功選取。`,
        });
      }
    }
    const lost = mappings.find((mapping) => {
      const matches = optionCandidates(modal, normalizeText(mapping.label));
      return matches.length !== 1 || !optionSelected(matches[0]);
    });
    if (lost) {
      throw new WorkflowError(
        "OPTION",
        `規格「${lost.label}」與其他選項互斥。`,
      );
    }
    const unexpected = unexpectedSelectedOptions(
      modal,
      mappings.map((mapping) => mapping.label),
    );
    if (unexpected.length) {
      throw new WorkflowError(
        "OPTION_RESET",
        `畫面仍選取非本筆規格「${[...new Set(unexpected)].join("、")}」。`,
      );
    }
  }

  function modalPrice(modal) {
    const block = [...modal.querySelectorAll(SELECTORS.modalActions)].find(
      (element) => /總金額|Total/iu.test(cleanText(element)),
    );
    if (!block) return null;
    const match = cleanText(block).match(
      /(?:總金額|Total)\s*[：:]?\s*(?:NT\$|\$)?\s*([\d,]+(?:\.\d+)?)\s*(?:元)?/iu,
    );
    return match ? parsePrice(match[1]) : null;
  }

  async function setQuantity(modal, quantity) {
    const input = modal.querySelector(SELECTORS.quantityInput);
    if (!input) throw new WorkflowError("QUANTITY", "找不到數量輸入欄。");
    setNativeValue(input, quantity);
    await nextFrame();
    await delay(CONFIG.shortDelayMs);
    if (Number(input.value) !== quantity) {
      throw new WorkflowError("QUANTITY", "數量沒有正確寫入。");
    }
  }

  function findBuyerInput(modal) {
    const byPlaceholder = [...modal.querySelectorAll('input[type="text"]')]
      .find((input) =>
        /訂購人|姓名|特殊符號/u.test(input.getAttribute("placeholder") || "")
      );
    if (byPlaceholder) return byPlaceholder;

    return [...modal.querySelectorAll("div")]
      .filter((element) => /訂購人姓名/u.test(ownText(element)))
      .sort(
        (left, right) =>
          left.querySelectorAll("input").length -
          right.querySelectorAll("input").length,
      )
      .map((element) => element.querySelector('input[type="text"]'))
      .find(Boolean) || null;
  }

  async function setBuyer(modal, buyer) {
    const input = findBuyerInput(modal);
    if (!input) {
      throw new WorkflowError("BUYER", "此商品視窗沒有訂購人姓名欄位。");
    }
    if (input.maxLength > 0 && buyer.length > input.maxLength) {
      throw new WorkflowError(
        "BUYER",
        `訂購者名稱超過 ${input.maxLength} 字。`,
      );
    }
    setNativeValue(input, buyer);
    await nextFrame();
    if (input.value !== buyer) {
      throw new WorkflowError("BUYER", "訂購者名稱沒有正確寫入。");
    }
    const field = input.closest(".q-field");
    if (field?.classList.contains("q-field--error")) {
      throw new WorkflowError("BUYER", "訂購者名稱不符合網站欄位規則。");
    }
  }

  function exactButton(modal, allowedText) {
    const matches = [...modal.querySelectorAll("button")]
      .filter(isVisible)
      .filter((button) => allowedText.has(cleanText(button)));
    return matches.length === 1 ? matches[0] : null;
  }

  function checkModalAuthorization(modal) {
    const auth = exactButton(modal, AUTH_BUTTON_TEXT);
    if (auth) {
      throw new WorkflowError(
        "AUTH",
        cleanText(auth) === "登入後訂購"
          ? "請先登入 Nidin。"
          : "請先完成 Nidin 手機驗證。",
        true,
      );
    }
    const add = exactButton(modal, ADD_BUTTON_TEXT);
    if (!add) {
      throw new WorkflowError("ADD_BUTTON", "找不到可確認的加入購物車按鈕。");
    }
    return add;
  }

  root.menuDom = Object.freeze({
    visibleMenuRoot,
    findMenuSearchButton,
    closeSearchDialog,
    menuProductEntries,
    locateProduct,
    openProduct,
    closeProductModal,
    clearRetainedOptionalSelections,
    chooseOptions,
    applyMappedOptions,
    modalPrice,
    setQuantity,
    findBuyerInput,
    setBuyer,
    checkModalAuthorization,
  });
})();
