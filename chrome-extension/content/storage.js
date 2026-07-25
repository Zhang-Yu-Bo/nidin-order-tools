/**
 * 透過 service worker 存取分頁隔離的 chrome.storage.session。
 */
(() => {
  "use strict";

  const root = globalThis.NidinOrderTools;
  const { CONFIG, WorkflowError } = root.core;
  const { validatePending } = root.orderData;

  // 暫存資料只透過 service worker 存入 extension-owned storage.session。
  async function storageRequest(action, value) {
    if (!globalThis.chrome?.runtime?.id) {
      throw new WorkflowError(
        "EXTENSION_CONTEXT",
        "Chrome extension 已重新載入，請重新整理頁面。",
      );
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        channel: CONFIG.storageKey,
        action,
        value,
      });
    } catch {
      throw new WorkflowError(
        "EXTENSION_CONTEXT",
        "無法連線至 Chrome extension，請重新整理頁面。",
      );
    }
    if (!response?.ok) {
      throw new WorkflowError(
        "STORAGE",
        response?.error || "暫存資料操作失敗。",
      );
    }
    return response.value;
  }

  const Storage = Object.freeze({
    async load() {
      const value = await storageRequest("load");
      return value ? validatePending(value) : null;
    },
    async save(pending) {
      const value = validatePending(pending);
      await storageRequest("save", value);
    },
    async remove() {
      await storageRequest("remove");
    },
    async has() {
      return Boolean(await storageRequest("has"));
    },
  });

  root.storage = Object.freeze({
    Storage,
  });
})();
