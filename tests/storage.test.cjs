'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createHarness() {
  const values = new Map();
  const listeners = {};
  const session = {
    get(key) {
      return Promise.resolve(
        values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
      );
    },
    set(items) {
      for (const [key, value] of Object.entries(items)) {
        values.set(key, structuredClone(value));
      }
      return Promise.resolve();
    },
    remove(key) {
      values.delete(key);
      return Promise.resolve();
    }
  };
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.message = listener;
        }
      }
    },
    storage: { session },
    tabs: {
      onRemoved: {
        addListener(listener) {
          listeners.removed = listener;
        }
      },
      onReplaced: {
        addListener(listener) {
          listeners.replaced = listener;
        }
      }
    }
  };

  const source = fs.readFileSync(
    path.resolve(__dirname, '../background/service-worker.js'),
    'utf8'
  );
  vm.runInNewContext(source, {
    chrome,
    URL,
    TextEncoder,
    structuredClone
  });

  function message(action, sender, value) {
    return new Promise(resolve => {
      const keepChannelOpen = listeners.message(
        {
          channel: 'nidin.orderTools.pending.v1',
          action,
          value
        },
        sender,
        resolve
      );
      assert.equal(keepChannelOpen, true);
    });
  }

  return { listeners, message, values };
}

const trusted = tabId => ({
  tab: { id: tabId },
  url: 'https://order.nidin.shop/menu/12345'
});

test('session data is isolated by tab and supports its full lifecycle', async () => {
  const harness = createHarness();
  const pending = { schemaVersion: 1, rows: [{ rowId: 'row-1' }] };

  const initial = await harness.message('has', trusted(10));
  assert.equal(initial.ok, true);
  assert.equal(initial.value, false);
  assert.equal((await harness.message('save', trusted(10), pending)).ok, true);
  assert.equal((await harness.message('has', trusted(10))).value, true);
  assert.equal((await harness.message('has', trusted(11))).value, false);

  const loaded = await harness.message('load', trusted(10));
  assert.equal(loaded.ok, true);
  assert.equal(JSON.stringify(loaded.value), JSON.stringify(pending));

  assert.equal((await harness.message('remove', trusted(10))).ok, true);
  assert.equal((await harness.message('has', trusted(10))).value, false);
});

test('untrusted origins, unknown actions and oversized values are rejected', async () => {
  const harness = createHarness();
  const badSender = { tab: { id: 1 }, url: 'https://example.com/' };

  assert.equal((await harness.message('load', badSender)).ok, false);
  assert.equal((await harness.message('unknown', trusted(1))).ok, false);
  assert.equal(
    (await harness.message('save', trusted(1), {
      payload: 'x'.repeat(2 * 1024 * 1024)
    })).ok,
    false
  );
});

test('closing or replacing a tab removes or transfers only that tab state', async () => {
  const harness = createHarness();
  await harness.message('save', trusted(20), { value: 'move-me' });
  harness.listeners.replaced(21, 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await harness.message('has', trusted(20))).value, false);
  assert.equal((await harness.message('load', trusted(21))).value.value, 'move-me');

  harness.listeners.removed(21);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await harness.message('has', trusted(21))).value, false);
});
