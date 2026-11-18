// With one order review for each site (src/site-trade.js), a placement whose answer was lost must
// never take another review's order for its own: the review looks for it among the library's orders
// that no record of its own names, so each review reads only the orders no other review records
// (src/site-context.js reviewLeaves, recordedElsewhere). The review of #227: site B's interrupted
// placement of the same amount claimed site A's resting order, listed it and quoted taking it back
// with B's figures; the review of the records kept before could do the same to a new site's order.
// The real vendored review (vendor/site-orders.js) over one store, as the extension keeps it.
//   node --test test/site-review-records.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SO from '../vendor/site-orders.js';
const { makeSiteOrders } = SO;
import { siteSide, keptSide, siteTag, recordedElsewhere, reviewLeaves } from '../src/site-context.js';

const AA = 'aa'.repeat(32), CC = 'cc'.repeat(32), DD = 'dd'.repeat(32);
const A = 'https://a.example', B = 'https://b.example', C = 'https://c.example', N = 'https://n.example';
const W = 'w1';
const rev = (h) => h.match(/../g).reverse().join('');
const meta = () => ({ ticker: 'X', precision: 0 });
const fmtAtoms = (a) => String(a);
const rec = (origin, sell, price, id) => ({ origin, market: { base: sell, quote: DD }, side: 'sell', price: String(price * 1e8), amount: '5000', sell, sold: '5000',
  rate_num: String(price), rate_den: '1', offer_id: id, at: 1 });
const libOrder = (order, sell, price) => ({ order, state: 'resting', amount: '5000', holds: '5000', refund_from: 1, rests_at: 't:' + order,
  terms: { asset_a: rev(sell), asset_b: rev(DD), rate_num: String(price), rate_den: '1' } });

// One store, as the extension's (src/site-trade.js store): every review's records side by side.
function world(records, lib) {
  const mem = {};
  for (const [k, v] of Object.entries(records)) mem[k] = JSON.stringify(v);
  const st = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  const runUser = async (cmd) => { if (cmd === 'orders') return lib; throw new Error('no ' + cmd); };
  const engine = { records: () => [], quote: async () => ({ ok: false }), drop() {}, advance: async (r) => r };
  // A review as src/site-trade.js makes it: its side's leaves, less the orders other reviews record.
  const review = (tag, side, filtered = true) => makeSiteOrders({ engine, store: st, tag: () => tag, assetMeta: meta, fmtAtoms,
    leaves: filtered ? reviewLeaves(side, () => recordedElsewhere(Object.keys(mem), (k) => st.getItem(k), W, tag)) : side.leaves });
  return { mem, st, runUser, review, db: (tag) => JSON.parse(mem['swk.siteorders.' + tag]) };
}

test('site B\'s interrupted placement never claims site A\'s resting order of the same amount', async () => {
  const tA = siteTag(W, A), tB = siteTag(W, B);
  const w = world({
    ['swk.siteorders.' + tA]: { trades: {}, orders: { oA: rec(A, AA, 2, 'x') }, placing: {} },
    ['swk.siteorders.' + tB]: { trades: {}, orders: {}, placing: { y: rec(B, CC, 9, 'y') } },
  }, [libOrder('oA', AA, 2)]);
  const b = w.review(tB, siteSide(B, w.runUser));
  const a = w.review(tA, siteSide(A, w.runUser));
  const listedB = await b.orders(B);
  assert.deepEqual(listedB.orders.map((o) => o.state), ['placing'], 'B lists only its own placement');
  assert.ok(!listedB.orders.some((o) => o.order === 'oA'), 'B never lists A\'s order');
  assert.deepEqual(Object.keys(w.db(tB).orders), [], 'B records no order');
  assert.deepEqual(Object.keys(w.db(tB).placing), ['y'], 'its placement still waits');
  await assert.rejects(b.quoteCancel({ order: 'oA' }, B), /no such order of this site/, 'nor can B quote taking it back');
  assert.deepEqual((await a.orders(A)).orders.map((o) => o.order), ['oA'], 'A still lists it');
  // What the split did without the filter (the vendored review matches on the amount alone).
  const w2 = world({
    ['swk.siteorders.' + tA]: { trades: {}, orders: { oA: rec(A, AA, 2, 'x') }, placing: {} },
    ['swk.siteorders.' + tB]: { trades: {}, orders: {}, placing: { y: rec(B, CC, 9, 'y') } },
  }, [libOrder('oA', AA, 2)]);
  const unfiltered = w2.review(tB, siteSide(B, w2.runUser), false);
  await unfiltered.orders(B);
  const claimed = Object.keys(w2.db(tB).orders);
  // The vendored review matching on the amount alone claims A's order; once it matches on the asset
  // too (the web wallet's samePlacement), it claims nothing even then.
  process.stdout.write(`without the filter, B's review claimed ${JSON.stringify(claimed)} (vendored review matches the asset: ${typeof SO.samePlacement === 'function'})\n`);
  assert.deepEqual(claimed, typeof SO.samePlacement === 'function' ? [] : ['oA']);
});

test('the review of the records kept before never claims a new site\'s order with an old placement', async () => {
  const tN = siteTag(W, N);
  const w = world({
    ['swk.siteorders.' + W]: { trades: {}, orders: {}, placing: { old: rec(C, CC, 9, 'old') } },
    ['swk.siteorders.' + tN]: { trades: {}, orders: { oN: rec(N, AA, 2, 'n') }, placing: {} },
  }, [libOrder('oN', AA, 2)]);
  const k = w.review(W, keptSide(w.runUser));
  const listed = await k.orders(C);
  assert.ok(!listed.orders.some((o) => o.order === 'oN'));
  assert.deepEqual(Object.keys(w.db(W).orders), [], 'the kept review records no order');
  // And the other way: a new site's placement never claims an order the kept review records.
  const tC = siteTag(W, C);
  const w2 = world({
    ['swk.siteorders.' + W]: { trades: {}, orders: { oOld: rec(A, AA, 2, 'o') }, placing: {} },
    ['swk.siteorders.' + tC]: { trades: {}, orders: {}, placing: { p: rec(C, CC, 9, 'p') } },
  }, [libOrder('oOld', AA, 2)]);
  const c = w2.review(tC, siteSide(C, w2.runUser));
  await c.orders(C);
  assert.deepEqual(Object.keys(w2.db(tC).orders), []);
});

test('a placement still finds its own order, which no other review records', async () => {
  const tA = siteTag(W, A), tB = siteTag(W, B);
  const w = world({
    ['swk.siteorders.' + tA]: { trades: {}, orders: { oA: rec(A, AA, 2, 'x') }, placing: {} },
    ['swk.siteorders.' + tB]: { trades: {}, orders: {}, placing: { y: rec(B, CC, 9, 'y') } },
  }, [libOrder('oA', AA, 2), libOrder('oB', CC, 9)]);
  const b = w.review(tB, siteSide(B, w.runUser));
  await b.orders(B);
  assert.deepEqual(Object.keys(w.db(tB).orders), ['oB'], 'its own order claimed');
  assert.deepEqual(w.db(tB).placing, {});
});

test('the orders recorded elsewhere: every other site\'s review and the kept one, never this one\'s own', () => {
  const mem = {
    ['swk.siteorders.' + W]: JSON.stringify({ orders: { k1: {} } }),
    ['swk.siteorders.' + siteTag(W, A)]: JSON.stringify({ orders: { a1: {}, a2: {} } }),
    ['swk.siteorders.' + siteTag(W, B)]: JSON.stringify({ orders: { b1: {} } }),
    ['swk.siteorders.w2|site|' + A]: JSON.stringify({ orders: { other: {} } }),
    ['swk.usertrade.' + W]: JSON.stringify([{ id: 't' }]),
    'swk.siteorders.broken': '{',
  };
  const read = (k) => mem[k];
  assert.deepEqual([...recordedElsewhere(Object.keys(mem), read, W, siteTag(W, A))].sort(), ['b1', 'k1']);
  assert.deepEqual([...recordedElsewhere(Object.keys(mem), read, W, W)].sort(), ['a1', 'a2', 'b1']);
});
