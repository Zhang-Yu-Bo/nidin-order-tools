'use strict';

const CHANNEL = 'nidin.orderTools.pending.v1';
const KEY_PREFIX = `${CHANNEL}.tab.`;
const NIDIN_ORIGIN = 'https://order.nidin.shop';
const MAX_VALUE_BYTES = 2 * 1024 * 1024;

function storageKey(tabId) {
  return `${KEY_PREFIX}${tabId}`;
}

function trustedSender(sender) {
  const sourceUrl =
    typeof sender.origin === 'string' ? sender.origin : sender.url;
  if (!Number.isInteger(sender.tab?.id) || typeof sourceUrl !== 'string') {
    return false;
  }
  try {
    return new URL(sourceUrl).origin === NIDIN_ORIGIN;
  } catch {
    return false;
  }
}

function validPending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_VALUE_BYTES;
  } catch {
    return false;
  }
}

async function handleStorageMessage(message, sender) {
  if (message?.channel !== CHANNEL || !trustedSender(sender)) {
    throw new Error('不接受此來源的暫存操作。');
  }

  const key = storageKey(sender.tab.id);
  switch (message.action) {
    case 'load': {
      const stored = await chrome.storage.session.get(key);
      return stored[key] ?? null;
    }
    case 'save':
      if (!validPending(message.value)) {
        throw new Error('暫存資料格式或大小不正確。');
      }
      await chrome.storage.session.set({ [key]: message.value });
      return null;
    case 'remove':
      await chrome.storage.session.remove(key);
      return null;
    case 'has': {
      const stored = await chrome.storage.session.get(key);
      return Object.hasOwn(stored, key);
    }
    default:
      throw new Error('未知的暫存操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleStorageMessage(message, sender).then(
    value => sendResponse({ ok: true, value }),
    error => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : '暫存操作失敗。'
    })
  );
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(storageKey(tabId));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  const oldKey = storageKey(removedTabId);
  const newKey = storageKey(addedTabId);
  void chrome.storage.session.get(oldKey).then(async stored => {
    if (Object.hasOwn(stored, oldKey)) {
      await chrome.storage.session.set({ [newKey]: stored[oldKey] });
      await chrome.storage.session.remove(oldKey);
    }
  });
});
