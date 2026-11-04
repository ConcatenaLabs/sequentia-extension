// Room to receive is asked for by asset, BTC included: a request naming no asset for a Bitcoin node
// was refused by the service, and the sell for BTC then found no route to the wallet's node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const calls = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')
  .split('\n').filter((l) => /seqlnChannelInbound\(\{/.test(l));

test('every request for room names its asset, BTC included', () => {
  const all = [...calls('offscreen.js'), ...calls('src/ln.js')];
  assert.ok(all.length >= 4, `found ${all.length} requests`);
  for (const l of all) {
    assert.match(l, /asset: /, l.trim());
    assert.doesNotMatch(l, /'BTC' \? undefined/, l.trim());
  }
});
