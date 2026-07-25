'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('manifest uses MV3 with minimum permissions and exact site scope', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.ok(Number(manifest.minimum_chrome_version) >= 112);
  assert.ok(manifest.description.length <= 132);

  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(
    manifest.content_scripts[0].matches,
    ['https://order.nidin.shop/*']
  );
  assert.ok(manifest.content_scripts[0].js.length > 0);
  assert.equal(
    new Set(manifest.content_scripts[0].js).size,
    manifest.content_scripts[0].js.length
  );
  assert.equal(manifest.content_scripts[0].js.at(-1), 'content/app.js');
  assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
  assert.equal(manifest.content_scripts[0].all_frames, false);
  assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
  assert.equal(
    manifest.content_security_policy.extension_pages,
    "script-src 'self'; object-src 'none'"
  );
});

test('all runtime files referenced by manifest exist', () => {
  const files = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(entry => entry.js),
    ...Object.values(manifest.icons)
  ];
  for (const file of files) {
    assert.ok(fs.statSync(path.join(root, file)).isFile(), `missing ${file}`);
  }
});

test('runtime has no remote execution or extra network client', () => {
  const runtime = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(entry => entry.js)
  ].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

  assert.doesNotMatch(runtime, /\beval\s*\(/u);
  assert.doesNotMatch(runtime, /\bnew\s+Function\s*\(/u);
  assert.doesNotMatch(runtime, /\b(?:fetch|XMLHttpRequest|WebSocket)\b/u);
  const externalOrigins = [...runtime.matchAll(/https:\/\/[^\s'")`]+/gu)]
    .map(match => match[0])
    .filter(url => !url.startsWith('https://order.nidin.shop'));
  assert.deepEqual(externalOrigins, []);
});

test('content script and service worker use the same storage channel', () => {
  const content = manifest.content_scripts
    .flatMap(entry => entry.js)
    .map(file => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  const worker = fs.readFileSync(
    path.join(root, 'background/service-worker.js'),
    'utf8'
  );
  const appChannel = content.match(/storageKey:\s*'([^']+)'/u)?.[1];
  const workerChannel = worker.match(/const CHANNEL = '([^']+)'/u)?.[1];
  assert.ok(appChannel);
  assert.equal(workerChannel, appChannel);
});
