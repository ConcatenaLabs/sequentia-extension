import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textSwapId, offerRows, readRows, completeRows, forOrigin } from '../src/leaf-swap.js';

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32);
const amt = (atoms, hex) => `${atoms} ${hex === X ? 'X' : 'Y'} (${atoms} atoms)`;
const hexOf = (s) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

test('the swap a text names, read only to find this wallet\'s record of it', () => {
  const id = 'cd'.repeat(32);
  assert.equal(textSwapId('swap-accept:' + hexOf(JSON.stringify({ kind: 'swap-accept', swap: id }))), id);
  assert.equal(textSwapId('arca-accept:' + hexOf(JSON.stringify({ swap: id }))), id);
  assert.equal(textSwapId('not an acceptance'), null);
  assert.equal(textSwapId('swap-accept:zz'), null);
  assert.equal(textSwapId('swap-accept:' + hexOf('{"no":"swap"}')), null);
});

test('the windows show the library\'s numbers as it gave them', () => {
  const o = Object.fromEntries(offerRows({ gives: { asset: X, value: '300000' }, gets: { asset: Y, value: '400000' }, pays: { asset: X, margin: '536', margins: '192' } }, amt));
  assert.match(o['You give'], /^300000 X/);
  assert.match(o['You get'], /^400000 Y \(400000 atoms\) as a leaf/);
  assert.match(o['You pay'], /^536 X .* 192 X/);
  const r = Object.fromEntries(readRows({ gets: { asset: X, value: '300000' }, gives: { asset: Y, value: '400000' }, pays: { asset: Y, margins: '2' },
    maker_pays: { asset: X, margin: '536' }, change: { asset: Y, value: '2599998' }, dates: { exit_deadline: 1794753413, rests_on_board: true } }, amt));
  assert.match(r['You pay'], /^2 Y/);
  assert.match(r['The other wallet pays'], /^536 X/);
  assert.match(r['Change'], /^2599998 Y/);
  assert.match(r['Dates'], /2026-11-15 14:36:53 UTC .*one rests on a board/);
  const c = Object.fromEntries(completeRows({ swap: 'id', gives: { asset: Y, value: '500000' }, gets: { asset: X, value: '200000' }, pays: { asset: Y, margin: '30', margins: '4' } }, amt));
  assert.match(c['You pay'], /^30 Y \(30 atoms\) margin and 4 Y/);
});

test('a site sees only the swaps it started', () => {
  const list = [{ swap: 'a', role: 'maker', state: 'open', gives: {}, gets: {}, offer: 'swap-offer:..' }, { swap: 'b', role: 'taker', state: 'done', gives: {}, gets: {} }];
  const recs = { a: { origin: 'https://one' }, b: { origin: 'https://two' } };
  assert.deepEqual(forOrigin(list, recs, 'https://one').map((s) => s.swap), ['a']);
  assert.equal(forOrigin(list, recs, 'https://one')[0].offer, 'swap-offer:..');
  assert.deepEqual(forOrigin(list, recs, 'https://three'), []);
});
