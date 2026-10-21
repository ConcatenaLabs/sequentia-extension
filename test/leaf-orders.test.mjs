import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alreadyListed, takeStage, takeWaitsOnWallet, takeDone, takesToWatch, takeAnswer, postParams, postDue, offerTtl } from '../src/leaf-orders.js';
import { orderFromCovenantTerms } from '../vendor/covenant-order.js';

const part = (state, extra = {}) => ({ participation: 't1', state, round: null, released: false, gives: [], new_leaves: [], ...extra });

test('a take\'s stage follows the library\'s participation', () => {
  assert.equal(takeStage(part('pending')).stage, 'submitted');
  assert.equal(takeStage(part('issued', { round: 'r' })).stage, 'handing-over');
  assert.equal(takeStage(part('forfeiting', { round: 'r' })).stage, 'forfeits-in');
  assert.equal(takeStage(part('released', { released: true })).stage, 'released');
  for (const s of ['void', 'expired', 'refused', 'withdrawn']) assert.equal(takeStage(part(s)).stage, 'void');
  assert.equal(takeStage(null).stage, 'unknown');
});

test('the host syncs for a take while its forfeits wait on the wallet, and watches it until it is done', () => {
  assert.equal(takeWaitsOnWallet(part('pending')), true);
  assert.equal(takeWaitsOnWallet(part('issued')), true);
  assert.equal(takeWaitsOnWallet(part('forfeiting')), false);
  assert.equal(takeDone(part('forfeiting')), false);
  assert.equal(takeDone(part('released', { released: true })), true);
  assert.equal(takeDone(part('void')), true);
  const recs = [{ take: 'a' }, { take: 'b' }, { take: 'c' }];
  const parts = [{ participation: 'a', state: 'issued' }, { participation: 'b', state: 'released', released: true }, { participation: 'c', state: 'forfeiting' }];
  assert.deepEqual(takesToWatch(recs, parts), ['a', 'c']);
  // A take the library does not list yet is watched.
  assert.deepEqual(takesToWatch([{ take: 'z' }], []), ['z']);
});

test('a take is answered from its record and the library\'s participation', () => {
  const rec = { take: 't1', order: 'ab:1', offer_id: 'o', pair: { base_asset: 'x', quote_asset: 'y' }, asset_a: 'A', asset_b: 'B', filled: '10', price: '20', fee: '1', remainder: '5', forfeit_window_seconds: 600, at: 1 };
  const a = takeAnswer(rec, part('released', { released: true, round: 'rr', new_leaves: [{ asset: 'A', value: '10', leaf_id: 'l', state: 'live' }] }));
  assert.deepEqual([a.stage, a.round, a.leaf.leaf_id, a.leaf.value, a.order, a.forfeit_window_seconds], ['released', 'rr', 'l', '10', 'ab:1', 600]);
  assert.equal(takeAnswer(rec, null).stage, 'unknown');
});

test('an order the library says rests is posted at its outpoint, with its own terms', () => {
  const terms = { asset_a: '00'.repeat(32), asset_b: '11'.repeat(32), rate_num: '2', rate_den: '1', min_lot: '1000', expiry_locktime: 1800000000,
    maker_prog: '22'.repeat(32), maker_prog_ver: 1, maker_x: '33'.repeat(32), internal_key: '50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0', merkle_path: ['44'.repeat(32)] };
  const o = { order: 'p', state: 'resting', rests_at: 'cd'.repeat(32) + ':0', holds: '600000', relay: { ...terms, covenant_txid: 'cd'.repeat(32), covenant_vout: 0 } };
  const p = postParams(o, { offer_id: 'f' }, (ct) => ct, orderFromCovenantTerms);
  assert.deepEqual([p.txid, p.vout, String(p.sellAtoms), String(p.rateNum), String(p.minLot), p.makerProg, p.offerId], ['cd'.repeat(32), 0, '600000', '2', '1000', '22'.repeat(32), 'f']);
  assert.equal(postParams({ ...o, state: 'in_round' }, {}, (ct) => ct, orderFromCovenantTerms), null);
  const now = 1700000000;
  assert.equal(postDue(o, {}, now), true, 'never posted');
  assert.equal(postDue(o, { posted_at: now, posted_outpoint: o.rests_at, relay_expires: now + 86400 }, now), false, 'listed');
  assert.equal(postDue(o, { posted_at: now, posted_outpoint: 'ee:1', relay_expires: now + 86400 }, now), false, 'moved by a fill: the relay moves the listing');
  assert.equal(postDue(o, { posted_at: now, posted_outpoint: o.rests_at, relay_expires: now + 600 }, now), true, 'listing about to run out');
  assert.equal(postDue({ ...o, state: 'filled' }, {}, now), false);
});

test('the relay lists an order until its refund opens, within the relay\'s bound', () => {
  assert.equal(offerTtl(1700000000, 1700000000 + 30 * 86400), 7 * 86400 - 60);
  assert.equal(offerTtl(1700000000, 1700000000 + 7200), 7140);
  assert.equal(offerTtl(1700000000, 1700000000), 60);
  assert.equal(offerTtl(1700000000, 50000), 7 * 86400 - 60, 'a height lock: the relay\'s bound');
});

test('the relay\'s answer to a second post of a listed offer counts as listed', () => {
  assert.equal(alreadyListed('submit: offer 03ab/e3bb: offer already resting'), true);
  assert.equal(alreadyListed('is not an unspent output at the tip'), false);
});
