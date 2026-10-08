import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The service worker reuses the offscreen document only when its `hello`
// answers with the manifest's version, and otherwise tears it down and waits
// up to 15 s for a document that does. The document answers with a literal
// baked into offscreen.js (so a stale document cannot pass for current code
// by reading the live manifest), which therefore has to be raised with every
// version: a literal left behind makes every offscreen job (Lightning swaps,
// market and limit orders, the leaf wallet) fail with "the wallet engine did
// not come up".
const root = new URL('..', import.meta.url).pathname;

test('the offscreen document\'s build stamp is the manifest version', () => {
  const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8'));
  const m = readFileSync(root + 'offscreen.js', 'utf8').match(/^const OFFSCREEN_BUILD = '([^']+)';/m);
  assert.ok(m, 'offscreen.js declares OFFSCREEN_BUILD on its first line');
  assert.equal(m[1], manifest.version);
});
