// The Bitcoin ark's band and the Lightning limit, as default mode applies them (src/ark-band.js,
// the web wallet's ark-limits.js and asset-lightning.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardCap, moveDown, direct, lnFits, LN_FALLBACK_USD } from '../src/ark-band.js';

const P = 100_000;   // USD per BTC: 1,500 USD = 1,500,000 sats
const S = (usd) => BigInt(usd * 1000);

test('the ark is refilled only below a quarter of its resting level, back up to it', () => {
  assert.equal(boardCap({ held: 0n, price: P }), S(1500));
  assert.equal(boardCap({ held: S(374), price: P }), S(1500) - S(374));
  assert.equal(boardCap({ held: S(375), price: P }), 0n);
  assert.equal(boardCap({ held: S(2000), price: P }), 0n);
  // No price yet: nothing goes in.
  assert.equal(boardCap({ held: 0n, price: null }), 0n);
  // A trade asking for more gets what it asks.
  assert.equal(boardCap({ held: S(1000), price: P, wanted: S(700) }), S(700));
  assert.equal(boardCap({ held: 0n, price: null, wanted: 5000n }), 5000n);
  // Figures a test set, and none at all.
  assert.equal(boardCap({ held: 0n, price: P, override: { btc: { board: 15 } } }), S(15));
  assert.equal(boardCap({ held: 0n, price: P, override: { btc: { board: null } } }), null);
});

test('at the ceiling, everything above the resting level moves out in one move', () => {
  assert.equal(moveDown({ held: S(2999), price: P }), 0n);
  assert.equal(moveDown({ held: S(3000), price: P }), S(1500));
  assert.equal(moveDown({ held: S(4200), price: P }), S(2700));
  assert.equal(moveDown({ held: S(4200), price: null }), 0n);
  assert.equal(moveDown({ held: 46_371n, price: P, override: { btc: { board: 15, hold: 30 } } }), 46_371n - 15_000n);
});

test('a payment of 1,500 USD or more goes to the address', () => {
  assert.equal(direct({ sats: S(1499), price: P }), null);
  assert.equal(direct({ sats: S(1500), price: P }), 1500);
  assert.equal(direct({ sats: S(1500), price: null }), null);
  assert.equal(direct({ sats: 0n, price: P }), null);
  assert.equal(direct({ sats: S(20), price: P, override: { btc: { direct: 15 } } }), 15);
});

test('Lightning: the operator\'s published limit, else the 1,500 USD fallback', () => {
  const info = { server_info: { assets: [{ asset: 'aa'.repeat(32), lightning: { state: 'up', max_payment: { send: '10', receive: '20' } } }],
    lightning: { bitcoin: { node: { state: 'up', max_payment: { send: '8853032', receive: '100000' } } } } } };
  assert.ok(lnFits({ info, kind: 'BTC', dir: 'in', atoms: 100000n, price: P }));
  assert.ok(!lnFits({ info, kind: 'BTC', dir: 'in', atoms: 100001n, price: P }));
  assert.ok(lnFits({ info, kind: 'BTC', dir: 'out', atoms: 8853032n, price: P }));
  assert.ok(!lnFits({ info, kind: 'aa'.repeat(32), dir: 'in', atoms: 21n, price: null }));
  // Published nothing: the fallback; not read: the fallback; no price: not held.
  assert.equal(LN_FALLBACK_USD, 1500);
  const none = { server_info: { assets: [], lightning: { bitcoin: { node: { state: 'up' } } } } };
  assert.ok(lnFits({ info: none, kind: 'BTC', dir: 'in', atoms: S(1500), price: P }));
  assert.ok(!lnFits({ info: none, kind: 'BTC', dir: 'in', atoms: S(1500) + 1n, price: P }));
  assert.ok(!lnFits({ info: null, kind: 'BTC', dir: 'in', atoms: S(1501), price: P }));
  assert.ok(lnFits({ info: null, kind: 'BTC', dir: 'in', atoms: S(9999), price: null }));
});
