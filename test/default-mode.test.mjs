import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toWire, fromWire } from '../src/wire.js';
import { forbiddenIn } from '../vendor/user-trade.js';
import { DEFAULT_WORDS, heldAssetList } from '../vendor/default-arca.js';
import { BTC_WORDS } from '../vendor/btc-ark.js';
import { userSplit } from '../src/balance-view.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a BigInt crosses the message boundary and comes back', () => {
  const v = { route: 'ark', sats: 12345n, fee: 0n, list: [1n, 'x', null], nested: { a: 2n ** 70n } };
  const w = toWire(v);
  assert.doesNotThrow(() => JSON.stringify(w));
  assert.deepEqual(fromWire(JSON.parse(JSON.stringify(w))), v);
  assert.equal(fromWire(toWire(7n)), 7n);
  assert.equal(fromWire(toWire(null)), null);
});

test('default mode says none of the forbidden words', () => {
  const said = [];
  for (const v of Object.values(DEFAULT_WORDS)) said.push(typeof v === 'function' ? v('1', 'GOLD', '2.0') : v);
  for (const v of Object.values(BTC_WORDS)) said.push(typeof v === 'function' ? v('0.0001', '0.00000087') : v);
  // The popup's default-mode cards, as written.
  const html = read('popup/popup.html');
  for (const id of ['sendDefault', 'recvDefault', 'faucetCard', 'tTrade']) {
    const i = html.indexOf(`id="${id}"`);
    assert.ok(i > 0, id);
    const block = html.slice(i, html.indexOf('</div>\n      <div class="card', i) > 0 ? html.indexOf('</div>\n      <div class="card', i) : i + 1500);
    said.push(block.replace(/<[^>]*>/g, ' ').replace(/id="[^"]*"/g, ''));
  }
  // Every sentence src/default-mode.js can say itself.
  const js = read('src/default-mode.js');
  for (const m of js.matchAll(/new Error\('([^']+)'\)/g)) said.push(m[1]);
  for (const s of said) assert.deepEqual(forbiddenIn(s), [], s);
});

test('a fresh wallet lists BTC alone to send; an asset once held', () => {
  assert.deepEqual(heldAssetList({}), ['BTC']);
  assert.deepEqual(heldAssetList({ aa: '0' }), ['BTC']);
  assert.deepEqual(heldAssetList({ aa: '5', bb: '0' }), ['BTC', 'aa']);
});

test('the balance details in default mode name no place an asset is held', () => {
  const row = { onchain: '5', leaves: '6', ln: '7', staked: '0', ark: '9' };
  assert.equal(userSplit(row, String), null);
  const popup = read('popup/popup.js');
  // The arriving line is drawn in default mode only, in the contract's words.
  assert.match(popup, /DEFAULT_WORDS\.arriving\(/);
});

test('removing the wallet closes its leaf and ark wallets before the vault goes', () => {
  const bg = read('background.js');
  const body = bg.slice(bg.indexOf("'removeWallet'"), bg.indexOf("'removeWallet'") + 800);
  const close = body.indexOf('dm.closeWallets()'), destroy = body.indexOf('vaultDestroy(');
  assert.ok(close > 0 && destroy > close, 'closeWallets runs before vaultDestroy');
  const dm = read('src/default-mode.js');
  const cw = dm.slice(dm.indexOf('export async function closeWallets'), dm.indexOf('export async function forgetWallet'));
  assert.match(cw, /leaves\.stop\(\)/);
  assert.match(cw, /stopArk\(\)/);
});

test('a coin kept safe while the wallet was away is said under its figure, from the leaf wallet\'s balance', async () => {
  const { keptSafeAtoms } = await import('../vendor/default-arca.js');
  const A = 'a'.repeat(64);
  assert.equal(keptSafeAtoms({ arca: { [A]: { exiting: '7', kept_safe: '7' } } }, A), 7n);
  assert.equal(DEFAULT_WORDS.keptSafe('0.07', 'GOLD'), '0.07 GOLD moved out of the Ark to keep it safe while you were away');
  // The leaf sum keeps it, the row carries it, the popup says it in default mode.
  assert.match(read('src/leaves.js'), /keptSafe: kept/);
  assert.match(read('background.js'), /keptSafe: key === 'BTC' \? '0' : String\(keptSafePer\[key\]/);
  assert.match(read('popup/popup.js'), /DEFAULT_WORDS\.keptSafe\(/);
});
