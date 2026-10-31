import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPair, displayPair } from '../src/pair.js';

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

test('BTC is read in a fiat stablecoin, and is the quote against everything else', () => {
  const tk = (h) => ({ aa: 'GOLD', us: 'USDX', eu: 'EURX', ts: 'tSEQ' })[h] || ''
  assert.deepEqual(displayPair('us', 'BTC', tk), { base: 'BTC', quote: 'us' })
  assert.deepEqual(displayPair('BTC', 'eu', tk), { base: 'BTC', quote: 'eu' })
  assert.deepEqual(displayPair('aa', 'BTC', tk), { base: 'aa', quote: 'BTC' })
  assert.deepEqual(displayPair('ts', 'us', tk), canonicalPair('ts', 'us', tk))
  assert.deepEqual(canonicalPair('us', 'BTC', tk), { base: 'us', quote: 'BTC' }, 'the book key does not move')
})
