import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textSwapId, offerRows, readRows, completeRows, forOrigin, takeOfferSlot, OFFER_WAITS } from '../src/leaf-swap.js';
import { readFileSync } from 'node:fs';

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

test('a site has at most one swap offer waiting for the person\'s approval (sequentia-extension#224)', () => {
  const a = takeOfferSlot('https://a.example');
  assert.throws(() => takeOfferSlot('https://a.example'), (e) => e.message === OFFER_WAITS, 'a second offer while one waits is refused, in words the site sees');
  const b = takeOfferSlot('https://b.example');
  a.release();
  a.release();
  const again = takeOfferSlot('https://a.example');
  assert.throws(() => takeOfferSlot('https://a.example'));
  again.release(); b.release();
  // The provider takes the slot before the library makes the offer, and gives it back however the
  // approval ends.
  const pr = readFileSync(new URL('../src/provider-router.js', import.meta.url), 'utf8');
  const offer = pr.slice(pr.indexOf("case 'leafSwapOffer': {"), pr.indexOf("case 'leafSwapAccept': {"));
  assert.ok(offer.indexOf('const slot = leafSwap.takeOfferSlot(origin);') >= 0 && offer.indexOf('const slot = leafSwap.takeOfferSlot(origin);') < offer.indexOf("leaves.run('swap_offer'"), 'no offer without the slot');
  assert.match(offer, /\} finally \{ slot\.release\(\); \}\n    \}\n/);
});
