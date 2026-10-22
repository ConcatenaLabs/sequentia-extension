// The resting-order helpers of src/leaf-resting.js that decide nothing about an
// order but what the wallet posts to the relay: the price stated whole, the
// relay's offer built from the operator's view, signed and verified by the
// vendored seqob.js, and listed no later than the order's delist time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wholePrice, servedOrder, offerFor, postDue } from '../src/leaf-resting.js';
import { __test__ as seqob, hexToBytes, restingOfferForPost, normRelayOffer } from '../vendor/seqob.js';

const A = '1f'.repeat(32), B = '2e'.repeat(32);
const served = (over = {}) => ({
  order: 'd1'.repeat(32), state: 'resting', coin: 'e2'.repeat(32), asset: A, value: '400000',
  terms: { asset_b: B, rate_num: '2', rate_den: '1', min_lot: '10000', maker: '31'.repeat(32), expiry: 1_900_000_000,
    refund_key: '41'.repeat(32), credits: [] },
  expiry: 1_890_000_000, fills: [], ...over,
});
const rec = { rested_by: 'aa'.repeat(32), order: 'd1'.repeat(32), offer_id: 'o1', amount: '600000' };
const op = { server: 'https://sequentiatestnet.com/arca', operator: '5c'.repeat(32) };

test('the price is stated whole, or refused', () => {
  assert.equal(wholePrice('600000', '2', '1'), 1200000n);
  assert.equal(wholePrice('3', '10', '3'), 10n);
  assert.throws(() => wholePrice('4', '10', '3'), /not a whole number of atoms/);
});

test('the relay\'s offer: the terms the operator serves, the locator where it rests now', () => {
  const o = offerFor(rec, served(), op, 1_800_000_000, 21600);
  assert.equal(o.trade_dir, 'TRADE_DIR_SELL');
  assert.deepEqual([o.base_amount, o.offer_amount, o.want_amount], ['600000', '600000', '1200000']);
  assert.equal(o.resting_leaf.coin, 'e2'.repeat(32));
  assert.equal(o.resting_leaf.value, '400000');
  assert.equal(o.resting_leaf.order_id, 'd1'.repeat(32));
  assert.equal(o.resting_leaf.operator_key, op.operator);
  assert.equal(Number(o.expires_at_unix), 1_800_000_000 + 7 * 86400 - 60);
  const signed = seqob.signOffer(o, hexToBytes('07'.padStart(64, '0')));
  assert.equal(seqob.verifyOffer(signed), true);
  // The wire form, read back as the relay serves it, verifies too.
  const back = normRelayOffer(JSON.parse(JSON.stringify(restingOfferForPost(signed))));
  assert.equal(seqob.verifyOffer(back), true);
});

test('the listing ends no later than the delist time', () => {
  // The batch's exit deadline (first expiry less three days) comes first.
  const o = offerFor(rec, served(), op, 1_889_700_000, 21600);
  assert.equal(Number(o.expires_at_unix), 1_890_000_000 - 3 * 86400);
  // Without a batch expiry: the REFUND time less the order margin.
  const p = offerFor(rec, served({ expiry: null }), op, 1_899_900_000, 21600);
  assert.equal(Number(p.expires_at_unix), 1_900_000_000 - 21600);
  assert.throws(() => offerFor(rec, served(), op, 1_890_000_000 - 3 * 86400, 21600), /delist time/);
});

test('a resting order is posted once while it rests, and again before its listing lapses', () => {
  assert.equal(postDue(rec, served(), 100), true);
  assert.equal(postDue({ ...rec, posted_at: 90, relay_expires: 100 + 7200 }, served(), 100), false);
  assert.equal(postDue({ ...rec, posted_at: 90, relay_expires: 100 + 600 }, served(), 100), true);
  assert.equal(postDue(rec, served({ state: 'cancelled' }), 100), false);
  assert.equal(postDue(rec, null, 100), false);
});

test('a served order names its id, operator and locator', () => {
  const s = servedOrder({ offer_id: 'x', maker_pubkey: '02', resting_leaf: { order_id: 'D1'.repeat(32), operator_key: '5C'.repeat(32), coin: 'e2'.repeat(32), value: '5', asset_a: A, asset_b: B } });
  assert.equal(s.order, 'd1'.repeat(32));
  assert.equal(s.operator_key, '5c'.repeat(32));
  assert.throws(() => servedOrder({ covenant: {} }), /resting_leaf/);
});
