import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRequest, planSend, leafBalancesAnswer } from '../src/leaf-request.js';
import { inFlight, nextAskMs, freshRequestWaits } from '../src/leaf-schedule.js';

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const X = 'aa'.repeat(32);
const Y = 'bb'.repeat(32);
const base = {
  arca_request: 1, genesis_hash: 'g'.repeat(64), operator: 'o'.repeat(64), owner: '11'.repeat(32),
  owner_nonce: '22'.repeat(32), mailbox: '33'.repeat(32), exit_delay_units: 253, until: 1800000000,
};
const text = (v, prefix = 'request') => prefix + ':' + hex(JSON.stringify(v));
const info = { genesis_hash: base.genesis_hash, operator: base.operator };

test('a receive request reads whatever its prefix, as the library reads it', () => {
  assert.equal(readRequest(text(base)).owner, base.owner);
  assert.equal(readRequest(text(base, 'arca')).mailbox, base.mailbox);
  assert.throws(() => readRequest('nothing'), /no prefix/);
  assert.throws(() => readRequest('a b:00'), /not a word/);
  assert.throws(() => readRequest('request:zz'), /not hex/);
  assert.throws(() => readRequest(text({ arca_swap_offer: 1 })), /the text is not one/);
});

test('a send pays the request\'s asset and amount, or what the site names when the request leaves them out', () => {
  const p = planSend(readRequest(text({ ...base, asset: X, value: '1500' })), {}, info);
  assert.deepEqual([p.asset, p.amount, p.owner, p.mailbox, p.until], [X, '1500', base.owner, base.mailbox, base.until]);
  assert.equal(planSend(readRequest(text(base)), { asset: Y, amount: '700' }, info).asset, Y);
  // The site may override the amount of a request that names one; the asset never.
  assert.equal(planSend(readRequest(text({ ...base, asset: X, value: '1500' })), { amount: '900' }, info).amount, '900');
  assert.throws(() => planSend(readRequest(text({ ...base, asset: X })), { asset: Y, amount: '1' }, info), /asks for asset aa+, not bb+/);
});

test('no asset is a default, and a request for another operator or chain is refused before any window', () => {
  assert.throws(() => planSend(readRequest(text(base)), { amount: '5' }, info), /no asset is a default/);
  assert.throws(() => planSend(readRequest(text({ ...base, asset: X })), {}, info), /name the amount/);
  assert.throws(() => planSend(readRequest(text({ ...base, asset: X })), { amount: '0' }, info), /positive/);
  assert.throws(() => planSend(readRequest(text({ ...base, asset: X, value: '5', operator: 'p'.repeat(64) })), {}, info), /for operator p+, not this wallet's/);
  assert.throws(() => planSend(readRequest(text({ ...base, asset: X, value: '5', genesis_hash: 'h'.repeat(64) })), {}, info), /genesis h+, not this wallet's/);
});

test('leaf balances: per asset, the library\'s states summed, its on-chain coins and its headline', () => {
  const b = { arca: { [X]: { live: '2000000', 'operator-confirmed': '300000' }, [Y]: { pending: '5' } },
    sequentia_onchain: { [X]: '42' }, total: { value: '9', unit: 'reference', values: {} } };
  const a = leafBalancesAnswer(b, { now: 10, next_sync_at: 20, due: false, coins: [] });
  assert.deepEqual(a.leaves[X], { total: '2300000', states: { live: '2000000', 'operator-confirmed': '300000' } });
  assert.deepEqual(a.leaves[Y], { total: '5', states: { pending: '5' } });
  assert.deepEqual(a.onchain, { [X]: '42' });
  assert.equal(a.value.value, '9');
  assert.deepEqual(a.schedule, { now: 10, next_sync_at: 20, due: false });
  assert.equal(Object.keys(a.leaves).includes('BTC'), false);
});

test('the host syncs on the library\'s schedule, more often while something moves', () => {
  assert.equal(nextAskMs({ due: true, now: 1, next_sync_at: 1 }, 60000), 0);
  assert.equal(nextAskMs({ due: false, now: 100, next_sync_at: 110 }, 60000), 10000);
  assert.equal(nextAskMs({ due: false, now: 100, next_sync_at: 100000 }, 60000), 60000);
  assert.equal(nextAskMs({ due: false, now: 100, next_sync_at: null }, 60000), 60000);
  assert.equal(inFlight([{ state: 'live' }], []), false);
  assert.equal(inFlight([{ state: 'pending' }], []), true);
  assert.equal(inFlight([], [{ state: 'pending', released: false }]), true);
  assert.equal(inFlight([], [{ state: 'released' }]), false);
});

test('a request just handed out has the mailbox read every tick, for an hour', () => {
  const s = (asked, state = 'waiting', owner = 'k') => ({ now: 10000, receive_requests: [{ owner, state, asked_at: asked }] });
  assert.equal(freshRequestWaits(s(9000)), true);
  assert.equal(freshRequestWaits(s(5000)), false);
  assert.equal(freshRequestWaits(s(9000, 'lapsed')), false);
  assert.equal(freshRequestWaits(s(9000, 'waiting', 'restored')), false);
  assert.equal(freshRequestWaits({ now: 1 }), false);
});
