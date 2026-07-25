/**
 * 菜單頁匯入、驗證與加入購物車流程。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const {
    CONFIG,
    READY_STATUSES,
    WorkflowError,
    currentRoute,
    delay,
    nextFrame,
    isVisible,
    isDisabled,
    clickElement,
    waitForCondition,
    sameMoney,
  } = root.core;
  const { Storage } = root.storage;
  const { parseOrderJson, createPendingFromOrderFile } = root.orderData;
  const { createMenuUi } = root.pageUi;
  const {
    closeSearchDialog,
    locateProduct,
    openProduct,
    closeProductModal,
    clearRetainedOptionalSelections,
    applyMappedOptions,
    modalPrice,
    setQuantity,
    setBuyer,
    checkModalAuthorization,
  } = root.menuDom;
  const {
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
  } = root.cartValidation;

  // ── 菜單頁工作流程控制器 ───────────────────────────────────────

  async function initMenuPage(expectedRouteKey, generation, lifecycle) {
    const { routeIsActive, registerRouteCleanup } = lifecycle;
    if (!routeIsActive(expectedRouteKey, generation)) return;
    const ui = createMenuUi();
    if (!ui) return;

    const state = {
      pending: null,
      results: [],
      validationFingerprint: null,
      phase: "idle",
      stopRequested: false,
    };
    registerRouteCleanup(generation, () => {
      state.stopRequested = true;
    });

    const setPhase = (phase) => {
      state.phase = phase;
      const busy = phase !== "idle";
      ui.importButton.disabled = busy;
      ui.validateButton.disabled = busy || !state.pending;
      ui.clearButton.disabled = busy;
      ui.stopButton.disabled = phase !== "validating" && phase !== "adding";
      ui.startButton.disabled = busy ||
        !state.pending ||
        state.validationFingerprint !== pendingFingerprint(state.pending) ||
        !state.results.some((result) => READY_STATUSES.has(result.status));
    };

    const savePending = async () => {
      if (state.pending) await Storage.save(state.pending);
    };

    const confirmUndeclaredStore = async () => {
      if (state.pending.storeConfirmed) return true;
      const accepted = confirm(
        `暫存資料尚未確認店家 ID。\n確定要把資料套用到目前店家 ${state.pending.storeId} 嗎？`,
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
        state.phase !== "idle" ||
        !state.pending ||
        !routeIsActive(expectedRouteKey, generation)
      ) {
        return;
      }
      let storeConfirmed;
      try {
        storeConfirmed = await confirmUndeclaredStore();
      } catch (error) {
        setUiStatus(ui, `無法保存店家確認：${error.message}`, "error");
        return;
      }
      if (!storeConfirmed) {
        setUiStatus(ui, "尚未確認目前店家，未開始驗證。", "warning");
        return;
      }

      state.stopRequested = false;
      state.results = [];
      state.validationFingerprint = null;
      setPhase("validating");
      setUiStatus(ui, "正在驗證商品、規格與價格；此階段不會加入購物車。");
      renderReport(ui, state);

      try {
        await preflight(state.pending);
        const completed = new Set(state.pending.completedRowIds);
        const manualReview = new Set(state.pending.manualReviewRowIds);
        const remaining = state.pending.rows.filter(
          (row) => !completed.has(row.rowId) && !manualReview.has(row.rowId),
        );
        state.results.push(
          ...state.pending.rows
            .filter((row) => completed.has(row.rowId))
            .map((row) => ({
              ...row,
              status: "已加入（先前完成）",
              detail: "不會重複加入。",
            })),
        );
        state.results.push(
          ...state.pending.rows
            .filter((row) => manualReview.has(row.rowId))
            .map((row) => ({
              ...row,
              status: "待人工確認",
              detail: "曾點擊加入但無法確認結果，不會自動重試。",
            })),
        );

        for (const group of groupRows(remaining)) {
          if (state.stopRequested) break;
          const groupResult = await validateGroup(group);
          group.forEach((row) =>
            state.results.push({ ...row, ...groupResult })
          );
          renderReport(ui, state);
          if (groupResult.fatal) {
            state.stopRequested = true;
            break;
          }
        }
        await closeSearchDialog();

        const readyCount = state.results.filter((result) =>
          READY_STATUSES.has(result.status)
        ).length;
        state.validationFingerprint = pendingFingerprint(state.pending);
        if (state.stopRequested) {
          setUiStatus(ui, "驗證已停止；未驗證的品項不會加入。", "warning");
        } else if (readyCount) {
          setUiStatus(
            ui,
            `驗證完成：${readyCount} 筆可加入。請檢查報告後再按「開始加入」。`,
            "success",
          );
        } else {
          setUiStatus(ui, "驗證完成，但沒有可安全自動加入的品項。", "warning");
        }
      } catch (error) {
        await closeSearchDialog();
        setUiStatus(ui, `驗證停止：${error.message}`, "error");
      } finally {
        setPhase("idle");
        renderReport(ui, state);
      }
    };

    const addOneRow = async (result) => {
      let modal = null;
      let addClicked = false;
      const before = cartSnapshot();
      if (before.ambiguous) {
        throw new WorkflowError("CART", "無法唯一判定購物車。");
      }

      try {
        const product = await locateProduct(
          result.productName,
          result.productId,
        );
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
            "PRICE",
            `加入前總額不一致；預期 ${expectedTotal} 元，畫面為 ${
              total ?? "無法讀取"
            } 元。`,
          );
        }

        const addButton = checkModalAuthorization(modal);
        if (isDisabled(addButton)) {
          throw new WorkflowError("ADD_BUTTON", "加入購物車按鈕目前不可用。");
        }
        const previousNotifications = successNotificationSnapshot();
        clickElement(addButton); // 每列唯一一次，逾時時禁止重點。
        addClicked = true;

        let confirmed = false;
        let confirmedBy = "";
        try {
          await waitForCondition(() => {
            const after = cartSnapshot();
            if (isVisible(modal)) return false;
            if (cartChanged(before, after)) {
              confirmedBy = "購物車狀態變更";
              return true;
            }
            if (hasNewSuccessNotification(previousNotifications)) {
              confirmedBy = "成功通知";
              return true;
            }
            return false;
          }, { message: "加入後沒有收到明確的購物車回應。" });
          confirmed = true;
        } catch (error) {
          const after = cartSnapshot();
          if (cartChanged(before, after)) {
            confirmed = true;
            confirmedBy = "購物車狀態變更";
          } else {
            throw error;
          }
        }

        if (!confirmed) {
          throw new WorkflowError("ADD_VERIFY", "無法確認此品項是否加入。");
        }
        const after = cartSnapshot();
        if (after.ambiguous) {
          throw new WorkflowError("CART", "加入後出現多個購物車。", true);
        }
        if (
          state.pending.targetOrderId &&
          after.orderId &&
          state.pending.targetOrderId !== after.orderId
        ) {
          throw new WorkflowError("CART", "購物車 ID 在流程中發生變更。", true);
        }
        if (!state.pending.targetOrderId && after.orderId) {
          state.pending.targetOrderId = after.orderId;
        }
        return confirmedBy || "頁面回應";
      } catch (error) {
        if (addClicked && error && typeof error === "object") {
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
        state.phase !== "idle" ||
        !state.pending ||
        !routeIsActive(expectedRouteKey, generation) ||
        state.validationFingerprint !== pendingFingerprint(state.pending)
      ) {
        return;
      }
      const completed = new Set(state.pending.completedRowIds);
      const manualReview = new Set(state.pending.manualReviewRowIds);
      const ready = state.results.filter(
        (result) =>
          READY_STATUSES.has(result.status) &&
          !completed.has(result.rowId) &&
          !manualReview.has(result.rowId),
      );
      if (!ready.length) return;

      const accepted = confirm(
        `將依序加入 ${ready.length} 筆品項至普通購物車。\n` +
          "工具不會前往結帳或送出訂單，是否開始？",
      );
      if (!accepted) return;

      state.stopRequested = false;
      setPhase("adding");
      setUiStatus(ui, "正在逐筆加入；每筆只會點擊一次加入按鈕。");
      try {
        await preflight(state.pending);
        for (const result of ready) {
          if (state.stopRequested) break;
          setUiStatus(
            ui,
            `正在加入第 ${result.rowNumber} 列：${result.productName}`,
          );
          let addedAndConfirmed = false;
          try {
            const confirmedBy = await addOneRow(result);
            addedAndConfirmed = true;
            state.pending.completedRowIds.push(result.rowId);
            state.pending.completedRowIds = [
              ...new Set(state.pending.completedRowIds),
            ];
            result.status = "加入成功";
            result.detail = `已由${confirmedBy}確認。`;
            await savePending();
          } catch (error) {
            if (addedAndConfirmed) {
              result.status = "待人工確認";
              result.detail = `已確認加入，但無法保存進度：${error.message} ` +
                "請勿重新加入此列；請檢查購物車並重新整理頁面。";
              state.stopRequested = true;
            } else if (error.afterClick) {
              state.pending.manualReviewRowIds.push(result.rowId);
              state.pending.manualReviewRowIds = [
                ...new Set(state.pending.manualReviewRowIds),
              ];
              const after = cartSnapshot();
              if (
                !after.ambiguous && after.orderId &&
                !state.pending.targetOrderId
              ) {
                state.pending.targetOrderId = after.orderId;
              }
              result.status = "待人工確認";
              result.detail =
                `${error.message} 為避免重複加入，本列不會自動重試。`;
              state.stopRequested = true;
              try {
                await savePending();
              } catch (storageError) {
                result.detail += ` 暫存進度也失敗：${storageError.message}`;
              }
            } else {
              result.status = "加入失敗";
              result.detail = error.message;
              if (error.fatal) state.stopRequested = true;
            }
          }
          renderReport(ui, state);
        }
        await closeSearchDialog();

        const finished = state.pending.rows.every((row) =>
          state.pending.completedRowIds.includes(row.rowId)
        );
        if (finished) {
          try {
            await Storage.remove();
            setUiStatus(
              ui,
              "所有可處理品項均已加入。請自行檢查購物車；工具不會送出訂單。",
              "success",
            );
          } catch (error) {
            setUiStatus(
              ui,
              `所有品項已加入，但無法清除暫存：${error.message}`,
              "warning",
            );
          }
        } else if (state.stopRequested) {
          setUiStatus(
            ui,
            "流程已停止。已完成進度已保存，未完成品項不會自動重試。",
            "warning",
          );
        } else {
          setUiStatus(
            ui,
            "加入流程結束；部分品項需人工處理。失敗品項不會自動重試。",
            "warning",
          );
        }
      } catch (error) {
        await closeSearchDialog();
        setUiStatus(ui, `加入流程停止：${error.message}`, "error");
      } finally {
        state.validationFingerprint = null;
        setPhase("idle");
        renderReport(ui, state);
      }
    };

    ui.importButton.addEventListener("click", () => ui.fileInput.click());
    ui.fileInput.addEventListener("change", async () => {
      const file = ui.fileInput.files?.[0];
      ui.fileInput.value = "";
      if (!file) return;

      try {
        if (state.phase !== "idle") return;
        if (file.size > CONFIG.maxFileBytes) {
          throw new WorkflowError("JSON_SIZE", "JSON 超過 1 MB 上限。");
        }
        if (!/\.json$/iu.test(file.name)) {
          throw new WorkflowError("JSON_FILE", "只接受副檔名為 .json 的檔案。");
        }
        if (
          state.pending &&
          state.pending.rows.some(
            (row) => !state.pending.completedRowIds.includes(row.rowId),
          ) &&
          !confirm("目前有未完成流程；匯入新 JSON 會覆蓋暫存資料，是否繼續？")
        ) {
          return;
        }

        const orderFile = parseOrderJson(await file.text());
        const route = currentRoute();
        if (route.kind !== "menu") {
          throw new WorkflowError("ROUTE", "目前不是普通菜單頁。");
        }
        if (orderFile.storeId !== route.storeId) {
          throw new WorkflowError(
            "STORE_MISMATCH",
            `JSON 店家 ${orderFile.storeId} 與目前店家 ${route.storeId} 不一致。`,
          );
        }
        const importedPending = createPendingFromOrderFile(orderFile, {
          source: "json",
          autoValidate: false,
        });
        await Storage.save(importedPending);
        state.pending = importedPending;
        state.results = [];
        state.validationFingerprint = null;
        renderReport(ui, state);
        setPhase("idle");
        await runValidation();
      } catch (error) {
        setUiStatus(ui, `匯入失敗：${error.message}`, "error");
      }
    });

    ui.validateButton.addEventListener("click", () => void runValidation());
    ui.startButton.addEventListener("click", () => void runAdding());
    ui.stopButton.addEventListener("click", () => {
      state.stopRequested = true;
      setUiStatus(ui, "已要求停止；目前這一筆處理完後會停止。", "warning");
    });
    ui.clearButton.addEventListener("click", async () => {
      try {
        const hasStoredData = await Storage.has();
        if (!state.pending && !hasStoredData) return;
        if (
          confirm(
            "只會清除本工具在此分頁的暫存資料，不會清空購物車。是否繼續？",
          )
        ) {
          await Storage.remove();
          state.pending = null;
          state.results = [];
          state.validationFingerprint = null;
          renderReport(ui, state);
          setUiStatus(ui, "暫存資料已清除；購物車沒有變更。", "success");
          setPhase("idle");
        }
      } catch (error) {
        setUiStatus(ui, `清除暫存失敗：${error.message}`, "error");
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
        setPhase("idle");
        if (autoValidate) {
          setUiStatus(ui, "已收到重新訂購資料，準備開始唯讀驗證。");
          await runValidation();
        } else {
          setUiStatus(
            ui,
            state.pending.completedRowIds.length
              ? "找到未完成進度；請按「驗證品項」後再繼續。"
              : "找到暫存資料；請按「驗證品項」，或清除後重新匯入。",
            "warning",
          );
        }
      } else {
        renderReport(ui, state);
        setPhase("idle");
      }
    } catch (error) {
      ui.setExpanded(true);
      setPhase("idle");
      setUiStatus(
        ui,
        `暫存資料無法使用：${error.message}。可按「清除」移除。`,
        "error",
      );
    }
  }

  root.menuWorkflow = Object.freeze({
    initMenuPage,
  });
})();
