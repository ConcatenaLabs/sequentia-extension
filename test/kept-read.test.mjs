// The overview's figures ask the Lightning-to-ark move what of each asset is on its way
// (vendor/lightning-to-ark.js `moving` and `channelPart`), and the move reads the leaf wallet's coins
// at once for each (`liveMoving`). The web wallet answers that from the page's last reading; the
// extension's leaf wallet answers through the offscreen host, one library command a read. Handed a
// call that sent a command each time, every figure sent one and nobody waited for it: on a wallet
// open for hours the line in front of the library grew by about nine commands a second and the
// upkeep pass and the receive code waited in it for good (sequentia-extension#219). The extension
// hands the move a kept read instead (src/kept-read.js): the last answer while fresh, else the one
// read under way.
//   node --test test/kept-read.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keptRead } from '../src/kept-read.js';
import { mountLightningToArk } from '../vendor/lightning-to-ark.js';

const ASSET = 'ab'.repeat(32);

// The move as the extension's service worker mounts it, with `coins` as given, and a store.
function mounted(coins) {
  const m = new Map();
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const move = mountLightningToArk({
    dev: async () => false, personBusy: () => false, channels: () => [], kindOf: () => ASSET, refreshChannels: async () => {},
    connect: async () => null, pay: async () => ({ paid: false }), payStatus: async () => ({ state: 'none' }), ark: null,
    leaves: { isOpen: async () => true, info: async () => ({}), coins, run: async () => ({}) },
    allowance: async () => null, closeFee: async () => null, close: async () => {}, store, tag: () => 't', log: () => {},
  });
  // The move has read the wallet's receives once (its pass does): from then on each figure reads coins.
  move.state.lastReceives = {};
  return move;
}
// One overview: two figures for each of eight assets.
const overview = (move) => { for (let i = 0; i < 8; i++) { move.moving(ASSET); move.channelPart(ASSET, 0n); } };

test('a command per figure: what the extension handed the move before', async () => {
  let sent = 0;
  const move = mounted(() => { sent++; return new Promise(() => {}); });
  for (let i = 0; i < 25; i++) overview(move);
  assert.equal(sent, 400, 'every figure of every overview sent the library a command, and none was waited for');
});

test('a kept read: one command in flight at most, its answer used by the figures while fresh', async () => {
  let t = 0, sent = 0, answer = null;
  const read = () => { sent++; return new Promise((ok) => { answer = ok; }); };
  const move = mounted(keptRead(read, { freshMs: 5000, now: () => t }));
  for (let i = 0; i < 25; i++) overview(move);
  assert.equal(sent, 1, 'one read under way, whatever the figures ask');
  answer([{ leaf_id: 'l1', asset: ASSET, value: '5', state: 'live' }]);
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 25; i++) { t += 100; overview(move); }
  assert.equal(sent, 1, 'the answer is used while fresh');
  t += 5000;
  overview(move);
  assert.equal(sent, 2, 'read again once it is old, once');
  for (let i = 0; i < 25; i++) overview(move);
  assert.equal(sent, 2);
});

test('a kept read that fails keeps the last answer and lets the next ask read again', async () => {
  let t = 0, n = 0;
  const get = keptRead(async () => { n++; if (n === 2) throw new Error('busy'); return ['c' + n]; }, { freshMs: 1000, now: () => t });
  assert.deepEqual(await get(), ['c1']);
  t += 2000;
  assert.deepEqual(await get(), ['c1'], 'a failed read answers the last');
  assert.deepEqual(await get(), ['c3'], 'and the next ask reads again');
});

test('the service worker hands the move the kept read', () => {
  const src = readFileSync(new URL('../src/ln-to-ark.js', import.meta.url), 'utf8');
  assert.match(src, /const leafCoins = keptRead\(\(\) => leaves\.runAny\('coins'\)\);/);
  assert.match(src, /coins: leafCoins,/);
  assert.doesNotMatch(src, /coins: \(\) => leaves\.runAny\('coins'\)/);
});
