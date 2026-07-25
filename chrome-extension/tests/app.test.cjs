'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
);
const source = manifest.content_scripts
  .flatMap(entry => entry.js)
  .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n');
const fixtureHtml = `
  <button class="option"><div>綠茶凍</div></button>
  <button class="option b-border"><div>綠茶凍</div></button>
`;
const order = {
  items: [
    { buyer: '測試使用者' }
  ]
};

function extract(name, nextName) {
  const found = source.indexOf(`function ${name}(`);
  const start = source.lastIndexOf('\n', found) + 1;
  const next = source.indexOf(`function ${nextName}(`, found + 1);
  const end = source.lastIndexOf('\n', next);
  assert.ok(found >= 0 && next > found && end > start, `cannot extract ${name}`);
  return source.slice(start, end).trim();
}

test('duplicate option names use only one current product combination', () => {
  const optionCandidates = new Function(
    'SELECTORS',
    'optionLabel',
    `${extract('optionCandidates', 'optionToggle')}; return optionCandidates;`
  )({ option: '.option' }, option => option.label);

  const greenTeaJelly = [...fixtureHtml.matchAll(
    /class="([^"]*\boption\b[^"]*)"[^>]*>\s*<div[^>]*>\s*綠茶凍\s*<\/div>/gu
  )];
  assert.equal(greenTeaJelly.length, 2);
  assert.equal(
    greenTeaJelly.filter(match => /(?:^|\s)b-border(?:\s|$)/u.test(match[1])).length,
    1
  );

  const candidate = current => ({
    label: '綠茶凍',
    classList: { contains: name => name === 'b-border' && current }
  });
  const modal = options => ({ querySelectorAll: () => options });

  const active = candidate(true);
  assert.deepEqual(optionCandidates(modal([candidate(false), active]), '綠茶凍'), [active]);
  assert.equal(optionCandidates(modal([candidate(true), candidate(true)]), '綠茶凍').length, 2);
  assert.equal(optionCandidates(modal([candidate(false), candidate(false)]), '綠茶凍').length, 2);
});

test('buyer labels are removed and the current JSON fixture remains valid', () => {
  const normalizeText = new Function(
    `${extract('normalizeText', 'cleanText')}; return normalizeText;`
  )();
  const cleanBuyerName = new Function(
    'normalizeText',
    `${extract('cleanBuyerName', 'delay')}; return cleanBuyerName;`
  )(normalizeText);

  assert.equal(cleanBuyerName('訂購人姓名:測試使用者'), '測試使用者');
  assert.equal(cleanBuyerName('訂購人姓名： 測試使用者'), '測試使用者');
  assert.ok(order.items.length > 0);
  assert.ok(order.items.every(item =>
    item.buyer && !/^訂購人姓名\s*[：:]/u.test(item.buyer)
  ));
});

test('counted optional toppings reset safely for zero, one and two selections', async () => {
  const normalizeText = new Function(
    `${extract('normalizeText', 'cleanText')}; return normalizeText;`
  )();
  const optionAmount = new Function(
    'optionSelected',
    'normalizeText',
    `${extract('optionAmount', 'adjustmentSelectionLimit')}; return optionAmount;`
  )(option => option.classList.contains('b-bg'), normalizeText);
  const selectionLimit = new Function(
    'cleanText',
    `${extract('adjustmentSelectionLimit', 'revealAdjustmentOption')}; ` +
      'return adjustmentSelectionLimit;'
  )(element => normalizeText(element.textContent));

  class WorkflowError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  let amount = 0;
  let clicks = 0;
  const option = {
    classList: { contains: name => name === 'b-bg' && amount > 0 },
    getAttribute: () => null,
    parentElement: {
      querySelector: selector =>
        selector === '.amount' && amount > 0
          ? { textContent: String(amount) }
          : null
    }
  };
  const adjustment = { textContent: '加料*2（最多可選2項）' };
  const clearRetainedOption = new Function(
    'revealAdjustmentOption',
    'optionAmount',
    'adjustmentSelectionLimit',
    'CONFIG',
    'isDisabled',
    'clickElement',
    'waitForCondition',
    'adjustmentOption',
    'nextFrame',
    'delay',
    'WorkflowError',
    `${extract('clearRetainedOption', 'clearRetainedOptionalSelections')}; ` +
      'return clearRetainedOption;'
  )(
    () => Promise.resolve(option),
    optionAmount,
    selectionLimit,
    { maxOptionResetClicks: 12, shortDelayMs: 0 },
    () => false,
    () => {
      clicks += 1;
      amount = amount === 1 ? 2 : 0;
    },
    check => {
      const value = check();
      assert.ok(value);
      return Promise.resolve(value);
    },
    () => option,
    () => Promise.resolve(),
    () => Promise.resolve(),
    WorkflowError
  );

  for (const [initial, expectedClicks] of [[0, 0], [1, 2], [2, 1]]) {
    amount = initial;
    clicks = 0;
    await clearRetainedOption(adjustment, '綠茶凍');
    assert.equal(amount, 0);
    assert.equal(clicks, expectedClicks);
  }
});

test('content script uses only the extension storage bridge', () => {
  assert.doesNotMatch(source, /\bsessionStorage\b/u);
  assert.match(source, /state\.pending = await Storage\.load\(\)/u);
  assert.match(source, /await Storage\.save\(pending\)/u);
  assert.match(source, /await Storage\.remove\(\)/u);
  assert.match(source, /if \(addedAndConfirmed\) \{[\s\S]*?state\.stopRequested = true;/u);
  assert.match(
    source,
    /await Storage\.save\(importedPending\);\s*state\.pending = importedPending;/u
  );
  assert.doesNotMatch(source, /==UserScript==/u);
});
