import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPair } from '../src/pair.js';

const T = { aa: 'GOLD', bb: 'USDX', cc: 'tSEQ', dd: 'EURX', ee: 'OILX' };
const tk = (h) => T[h];

test('BTC and the stablecoins are quotes; the Sequence token is a base like any other', () => {
  assert.deepEqual(canonicalPair('aa', 'BTC', tk), { base: 'aa', quote: 'BTC' });
  assert.deepEqual(canonicalPair('bb', 'aa', tk), { base: 'aa', quote: 'bb' });
  assert.deepEqual(canonicalPair('cc', 'bb', tk), { base: 'cc', quote: 'bb' });
  assert.deepEqual(canonicalPair('dd', 'bb', tk), { base: 'dd', quote: 'bb' });
  // A tie of ranks falls back to the id, whichever side is paid.
  assert.deepEqual(canonicalPair('ee', 'cc', tk), canonicalPair('cc', 'ee', tk));
  assert.deepEqual(canonicalPair('cc', 'ee', tk), { base: 'cc', quote: 'ee' });
});
