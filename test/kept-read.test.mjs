// The overview's figures ask the Lightning-to-ark move what of each asset is on its way
// (vendor/lightning-to-ark.js `moving` and `channelPart`), and the move reads the leaf wallet's coins
// at once for each (`liveMoving`). The web wallet answers that from the page's last reading; the
// extension's leaf wallet answers through the offscreen host, one library command a read. Handed a
// call that sent a command each time, every figure sent one and nobody waited for it: on a wallet
// open for hours the line in front of the library grew by about nine commands a second and the
// upkeep pass and the receive code waited in it for good (sequentia-extension#219).
//
// The extension hands the move two reads under one name (src/kept-read.js): while a figure is drawn,
// the last reading at once (never thrown, at most one read under way); in the move's pass, a read
// now whose refusal reaches the move, which then leaves what is moving as it was. A refused read is
// never an empty or an old answer in the pass.
//   node --test test/kept-read.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keptRead, figureReads } from '../src/kept-read.js';
import { mountLightningToArk } from '../vendor/lightning-to-ark.js';

const ASSET = 'ab'.repeat(32);
const tickOver = () => new Promise((r) => setImmediate(r));

// The move as the extension's service worker mounts it, with `coins` as given, a store, and a
// receive of ASSET paid from a channel (moving until its leaf is held).
function mounted(coins, { logs = [] } = {}) {
  // The move paid receive h1 from the asset's channel (its record keeps the hash).
  const m = new Map([['swk.lnToArk.t', JSON.stringify({ paid: ['h1'] })]]);
  const store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const move = mountLightningToArk({
    dev: async () => false, personBusy: () => false, channels: () => [], kindOf: () => ASSET, refreshChannels: async () => {},
    connect: async () => null, pay: async () => ({ paid: false }), payStatus: async () => ({ state: 'none' }), ark: null,
    leaves: {
      isOpen: async () => true, info: async () => ({ server_info: { assets: [] } }), coins,
      run: async (command) => (command === 'lightning_receives' ? { h1: { asset: ASSET, amount: '500', value: '500', state: 'issuing' } } : {}),
    },
    allowance: async () => null, closeFee: async () => null, close: async () => {}, store, tag: () => 't', log: (...a) => logs.push(a.join(' ')),
  });
  return move;
}
// One overview: two figures for each of eight assets.
const overview = (move, f) => { for (let i = 0; i < 8; i++) { f(() => move.moving(ASSET)); f(() => move.channelPart(ASSET, 0n)); } };
const direct = (g) => g();

test('a command per figure: what the extension handed the move before', async () => {
  let sent = 0;
  const move = mounted(() => { sent++; return new Promise(() => {}); });
  move.state.lastReceives = {};
  for (let i = 0; i < 25; i++) overview(move, direct);
  assert.equal(sent, 400, 'every figure of every overview sent the library a command, and none was waited for');
});

test('the peek: one read under way at most, its answer used while fresh, never thrown', async () => {
  let t = 0, sent = 0, answer = null, fail = null;
  const k = keptRead(() => { sent++; return new Promise((ok, no) => { answer = ok; fail = no; }); }, { freshMs: 5000, now: () => t });
  const fr = figureReads(k);
  const move = mounted(fr.read);
  move.state.lastReceives = {};
  for (let i = 0; i < 25; i++) overview(move, fr.drawing);
  assert.equal(sent, 1, 'one read under way, whatever the figures ask');
  answer([{ leaf_id: 'l1', asset: ASSET, value: '5', state: 'live' }]);
  await tickOver();
  for (let i = 0; i < 25; i++) { t += 100; overview(move, fr.drawing); }
  assert.equal(sent, 1, 'the answer is used while fresh');
  t += 5000;
  overview(move, fr.drawing);
  assert.equal(sent, 2, 'read again once it is old, once');
  fail({ kind: 'busy', message: 'busy' });
  await tickOver();
  assert.equal(k.peek(), null, 'a refused read leaves the peek without a fresh answer, and is not thrown');
  assert.equal(sent, 3, 'and the next peek reads again');
});

test('the current read: its refusal is thrown, the first and a later one, never an old or empty answer', async () => {
  let t = 0, n = 0;
  const k = keptRead(async () => { n++; if (n === 1 || n === 3) throw { kind: 'busy', message: 'the wallet was busy' }; return ['c' + n]; }, { freshMs: 1000, now: () => t });
  await assert.rejects(k.current(), (e) => e.kind === 'busy', 'the first read refused: thrown, not null');
  assert.deepEqual(await k.current(), ['c2']);
  t += 10;
  await assert.rejects(k.current(), (e) => e.kind === 'busy', 'a later read refused: thrown, not the last answer');
  assert.deepEqual(k.peek(), ['c2'], 'the peek still has the last answer while it is fresh');
  t += 2000;
  assert.equal(k.peek(), null, 'and none once it is old');
});

test('the move\'s pass with a refused coins read changes nothing, the first time and later', async () => {
  let n = 0;
  const outcomes = ['refuse', [{ leaf_id: 'other', asset: ASSET, value: '1', state: 'live' }], 'refuse'];
  const k = keptRead(async () => { const o = outcomes[n++]; if (o === 'refuse') throw { kind: 'busy', message: 'the wallet was busy' }; return o; });
  const fr = figureReads(k);
  const logs = [];
  const move = mounted(fr.read, { logs });
  // First pass: the coins read is refused. Before, the refusal was read as no coins (`|| []`) and
  // the paid receive counted as moving from an empty reading; now the pass stops and says so.
  await move.tickAssets();
  assert.equal(move.state.movingAssets.size, 0, 'nothing is set from a refused read');
  assert.ok(logs.some((l) => /asset channels not read now/.test(l)), 'the refusal reaches the move');
  // Second pass: read, the receive's leaf not held yet: the asset is moving.
  await move.tickAssets();
  assert.equal(move.state.movingAssets.get(ASSET), 500n, 'moving, from a current reading');
  // Third pass: refused again: what is moving stays as the last current reading said.
  const before = logs.length;
  await move.tickAssets();
  assert.equal(move.state.movingAssets.get(ASSET), 500n, 'a later refusal keeps the state, never ends the move');
  assert.ok(logs.slice(before).some((l) => /asset channels not read now/.test(l)));
});

test('the service worker hands the move the figure and pass reads, kept in the host\'s line', () => {
  const src = readFileSync(new URL('../src/ln-to-ark.js', import.meta.url), 'utf8');
  assert.match(src, /const leafCoins = figureReads\(keptRead\(\(\) => leaves\.runAny\('coins', \{\}, keep\)\)\);/);
  assert.match(src, /coins: leafCoins\.read,/);
  assert.match(src, /export function channelPart\(kind, read\) \{ return leafCoins\.drawing\(\(\) => move\.channelPart\(kind, read\)\); \}/);
  assert.match(src, /export function moving\(kind\) \{ return leafCoins\.drawing\(\(\) => move\.moving\(kind\)\); \}/);
  assert.match(src, /run: \(command, args\) => leaves\.runAny\(command, args, keep\),/);
  assert.doesNotMatch(src, /coins: \(\) => leaves\.runAny\('coins'\)/);
});
