import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTrade, restTerms, lotFit, covenantQuote, orderProgress, fillStanding, fillOfSpend, progressFromChain, MAX_ORDERS_PER_TRADE } from '../src/market-plan.js';
import { ceilPrice } from '../vendor/covenant.js';

const G = 'aa'.repeat(32);   // the base (say a metal, precision 8)
const U = 'bb'.repeat(32);   // the quote (say a dollar, precision 8)
let n = 0;
// A covenant order selling `locked` of `sell` for `want` at num/den.
function cov(sell, want, locked, num, den, minLot = 1, extra = {}) {
  n++;
  return {
    offer_id: 'o' + n, offer_asset: sell, want_asset: want, offer_amount: String(locked),
    pair: { base_asset: sell, quote_asset: want }, expires_at_unix: '0',
    covenant: { rate_num: String(num), rate_den: String(den), min_lot: String(minLot), covenant_txid: 'c'.repeat(64), covenant_vout: 0 },
    ...extra,
  };
}

test('only covenant orders selling what the trade receives for what it pays are read', () => {
  const ask = cov(G, U, 100, 4000, 1);
  assert.ok(covenantQuote(ask, G, U));
  assert.equal(covenantQuote(ask, U, G), null);
  assert.equal(covenantQuote({ ...ask, covenant: undefined, same_chain: {} }, G, U), null);
  assert.equal(covenantQuote(cov(G, U, 100, 4000, 1, 1, { expires_at_unix: '10' }), G, U, 20), null);
});

test('a buy walks the asks cheapest first, each fill priced by the covenant', () => {
  const a1 = cov(G, U, 300, 4100, 1), a2 = cov(G, U, 500, 4000, 1), bid = cov(U, G, 10 ** 9, 1, 3900);
  const p = planTrade({ offers: [a1, bid, a2], base: G, quote: U, side: 'buy', amount: 600, basePrecision: 8 });
  assert.deepEqual(p.slices.map((s) => s.offerId), [a2.offer_id, a1.offer_id]);
  assert.deepEqual(p.slices.map((s) => s.filled), [500n, 100n]);
  assert.equal(p.gave, 500n * 4000n + 100n * 4100n);
  assert.equal(p.got, 600n);
  assert.equal(p.baseLeft, 0n);
});

test('a sell walks the reversed market: orders selling the quote for the base', () => {
  // Each sells U for G: a taker pays ceil(f * num / den) G for f U.
  const b1 = cov(U, G, 4_000_000, 1, 4000), b2 = cov(U, G, 4_000_000, 1, 3900), ask = cov(G, U, 100, 4100, 1);
  const p = planTrade({ offers: [b2, ask, b1], base: G, quote: U, side: 'sell', amount: 1500, basePrecision: 8 });
  // The best bid pays the most U per G: 4000 per G.
  assert.equal(p.slices[0].offerId, b1.offer_id);
  assert.equal(p.slices[0].filled, 4_000_000n);
  assert.equal(p.slices[0].pays, 1000n);
  // 500 G left; b2 pays 3900 per G, within 5% of the best.
  assert.equal(p.slices[1].offerId, b2.offer_id);
  assert.equal(p.slices[1].filled, 500n * 3900n);
  assert.equal(p.slices[1].pays, 500n);
  assert.equal(p.gave, 1500n);
  assert.equal(p.baseLeft, 0n);
  for (const s of p.slices) assert.ok(ceilPrice(s.filled, s.offer.covenant.rate_num, s.offer.covenant.rate_den) === s.pays);
});

test('a market order stops 5% past the best price; a limit order at its price', () => {
  const a1 = cov(G, U, 100, 4000, 1), a2 = cov(G, U, 100, 4199, 1), a3 = cov(G, U, 100, 4201, 1);
  const m = planTrade({ offers: [a1, a2, a3], base: G, quote: U, side: 'buy', amount: 300, basePrecision: 8 });
  assert.deepEqual(m.slices.map((s) => s.offerId), [a1.offer_id, a2.offer_id]);
  assert.equal(m.baseLeft, 100n);
  // Price per whole unit (1e8 atoms): 4100e8 quote atoms per G admits only a1.
  const l = planTrade({ offers: [a1, a2, a3], base: G, quote: U, side: 'buy', amount: 300, price: 4100n * 10n ** 8n, basePrecision: 8 });
  assert.deepEqual(l.slices.map((s) => s.offerId), [a1.offer_id]);
  assert.equal(l.baseLeft, 200n);
  // Selling at a limit of 3950 per G admits a bid at 4000 and not one at 3900.
  const b1 = cov(U, G, 4_000_000, 1, 4000), b2 = cov(U, G, 4_000_000, 1, 3900);
  const s = planTrade({ offers: [b1, b2], base: G, quote: U, side: 'sell', amount: 2000, price: 3950n * 10n ** 8n, basePrecision: 8 });
  assert.deepEqual(s.slices.map((x) => x.offerId), [b1.offer_id]);
  assert.equal(s.baseLeft, 1000n);
});

test('fills keep to the covenant lot: nothing below a lot, no rest below one', () => {
  const q = { locked: 1000n, minLot: 100n };
  assert.equal(lotFit(q, 50n), 0n);
  assert.equal(lotFit(q, 950n), 900n);   // 50 would rest: take 900, leave a lot
  assert.equal(lotFit(q, 1000n), 1000n);
  assert.equal(lotFit(q, 5000n), 1000n);
  assert.equal(lotFit({ locked: 150n, minLot: 100n }, 120n), 0n);
  const a = cov(G, U, 1000, 4000, 1, 100);
  const p = planTrade({ offers: [a], base: G, quote: U, side: 'buy', amount: 950, basePrecision: 8 });
  assert.equal(p.slices[0].filled, 900n);
  assert.equal(p.baseLeft, 50n);
});

test('a trade takes at most a handful of orders', () => {
  const offers = Array.from({ length: 20 }, () => cov(G, U, 10, 4000, 1));
  const p = planTrade({ offers, base: G, quote: U, side: 'buy', amount: 1000, basePrecision: 8 });
  assert.equal(p.slices.length, MAX_ORDERS_PER_TRADE);
});

test('what a limit order leaves rests at its price exactly', () => {
  const unit = 10n ** 8n;
  // Selling 0.5 G at 4146 U: a taker pays ceil(f * 4146) U for f G.
  const s = restTerms({ base: G, quote: U, side: 'sell', baseLeft: 50_000_000n, price: 4146n * unit, basePrecision: 8 });
  assert.equal(s.sell, G); assert.equal(s.want, U);
  assert.equal(s.sellAtoms, 50_000_000n);
  assert.equal(s.rateNum, 4146n); assert.equal(s.rateDen, 1n);
  assert.equal(s.wantAtoms, 50_000_000n * 4146n);
  assert.equal(s.minLot, 50_000n);
  // Buying 0.5 G at 4146 U: it sells 2073 U, and a taker pays ceil(f / 4146) G for f U.
  const b = restTerms({ base: G, quote: U, side: 'buy', baseLeft: 50_000_000n, price: 4146n * unit, basePrecision: 8 });
  assert.equal(b.sell, U); assert.equal(b.want, G);
  assert.equal(b.sellAtoms, 2073n * unit);
  assert.equal(b.rateNum, 1n); assert.equal(b.rateDen, 4146n);
  assert.equal(b.wantAtoms, 50_000_000n);
  assert.equal(restTerms({ base: G, quote: U, side: 'buy', baseLeft: 0n, price: unit, basePrecision: 8 }), null);
  assert.throws(() => restTerms({ base: G, quote: U, side: 'sell', baseLeft: 9n * 10n ** 17n, price: 4146n * unit + 1n, basePrecision: 8 }), /too large/);
});

test('an order\'s progress follows its fills from where it was placed; an undone fill counts for nothing', () => {
  const rec = { offer_id: 'x', maker_pubkey: 'k', txid: 'f'.repeat(64), vout: 0, sell_atoms: '1000' };
  assert.equal(orderProgress(rec, []).holds, 1000n);
  const f1 = { offer_id: 'x', maker_pubkey: 'k', txid: '1'.repeat(64), spent: 'f'.repeat(64) + ':0', filled: 400, remainder: 600, credit: { value: 4000 }, rest: { vout: 1 }, state: 'final' };
  const f2 = { offer_id: 'x', maker_pubkey: 'k', txid: '2'.repeat(64), spent: '1'.repeat(64) + ':1', filled: 600, remainder: 0, credit: { value: 6000 }, state: 'confirmed' };
  let p = orderProgress(rec, [f1]);
  assert.equal(p.holds, 600n); assert.equal(p.restsAt, '1'.repeat(64) + ':1'); assert.equal(p.credited, 4000n); assert.equal(p.final, true);
  p = orderProgress(rec, [f1, f2]);
  assert.equal(p.holds, 0n); assert.equal(p.filled, 1000n); assert.equal(p.credited, 10000n); assert.equal(p.final, false);
  p = orderProgress(rec, [f1, { ...f2, state: 'undone' }]);
  assert.equal(p.holds, 600n);
  // Another maker's record with the same offer id is not this order's.
  assert.equal(orderProgress(rec, [{ ...f1, maker_pubkey: 'other' }]).holds, 1000n);
});

test('a fill is settled only once the relay calls it final', () => {
  const t = 'a'.repeat(64);
  assert.equal(fillStanding(t, []).state, 'sent');
  assert.equal(fillStanding(t, [{ txid: t, state: 'confirmed' }]).state, 'sent');
  assert.equal(fillStanding(t, [{ txid: t, state: 'final' }]).state, 'settled');
  assert.equal(fillStanding(t, [{ txid: t, state: 'final' }, { txid: t, state: 'undone' }]).state, 'sent');
});

test('an order followed on the chain: each spend that pays its maker is a fill; anything else ends it', () => {
  const ids = { orderSpk: '5120' + 'a'.repeat(64), makerSpk: '5120' + 'b'.repeat(64) };
  // Input 1 spends the order: credit at 2, rest at 3.
  const part = { txid: 't1', vout: [{}, {}, { scriptpubkey: ids.makerSpk, value: 4000 }, { scriptpubkey: ids.orderSpk, value: 600 }] };
  const f1 = fillOfSpend(part, 1, 1000n, ids);
  assert.deepEqual([f1.filled, f1.credit, f1.remainder, f1.next], [400n, 4000n, 600n, { txid: 't1', vout: 3 }]);
  const whole = { txid: 't2', vout: [{ scriptpubkey: ids.makerSpk, value: 6000 }, { scriptpubkey: '0014' + 'c'.repeat(40), value: 1 }] };
  const f2 = fillOfSpend(whole, 0, 600n, ids);
  assert.deepEqual([f2.filled, f2.remainder, f2.next], [600n, 0n, null]);
  // A refund pays the maker's own address, not the credit script: not a fill.
  assert.equal(fillOfSpend({ txid: 't3', vout: [{ scriptpubkey: '0014' + 'd'.repeat(40), value: 999 }] }, 0, 1000n, ids), null);
  const rec = { offer_id: 'x', maker_pubkey: 'k', txid: 'f'.repeat(64), vout: 0, sell_atoms: '1000' };
  const p = progressFromChain(rec, [{ ...f1, confirmed: true }, { ...f2, confirmed: false }], [{ offer_id: 'x', maker_pubkey: 'k', txid: 't1', state: 'final' }]);
  assert.equal(p.holds, 0n); assert.equal(p.filled, 1000n); assert.equal(p.credited, 10000n); assert.equal(p.final, false);
  assert.deepEqual(p.fills.map((f) => [f.txid, f.state, f.standing]), [['t1', 'final', 'settled'], ['t2', 'mempool', 'sent']]);
  // With no relay records at all (a relay restarted, or one without them), the chain
  // still says what filled, and nothing reads settled.
  const q = progressFromChain(rec, [{ ...f1, confirmed: true }], []);
  assert.equal(q.holds, 600n); assert.equal(q.restsAt, 't1:3'); assert.equal(q.fills[0].standing, 'sent');
});

// ---- an order resting in the operator's tree, taken by placeOrder in developer mode ----
import { restingQuote, planResting } from '../src/market-plan.js';

test('a resting order of the joined operator is one more order of the market, at what its coin holds', () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32), OP = 'cc'.repeat(32);
  const offer = (over = {}) => ({ offer_id: 'r', offer_asset: A, want_asset: B, offer_amount: '600000', _active: '400000',
    resting_leaf: { operator_key: OP, rate_num: '2', rate_den: '1', min_lot: '10000', value: '400000' }, ...over });
  const q = restingQuote(offer(), A, B, OP);
  assert.equal(q.locked, 400000n);
  assert.equal(restingQuote(offer(), A, B, 'dd'.repeat(32)), null, 'another operator\'s order is not taken');
  assert.equal(restingQuote(offer({ _active: '0' }), A, B, OP), null, 'an order listed at nothing is not taken');
  // Buying 200,000 base: filled from it at 2 each.
  assert.deepEqual(planResting({ resting: [q], side: 'buy', amount: '200000', basePrecision: 0 }), { q, filled: 200000n, pays: 400000n });
  // More than it holds: not this way.
  assert.equal(planResting({ resting: [q], side: 'buy', amount: '400001', basePrecision: 0 }), null);
  // A fill leaving less than a lot: not this way.
  assert.equal(planResting({ resting: [q], side: 'buy', amount: '395000', basePrecision: 0 }), null);
  // A covenant order priced better takes the trade instead.
  const cov = { num: 3n, den: 2n, locked: 1000000n, minLot: 1n };
  assert.equal(planResting({ resting: [q], covenants: [cov], side: 'buy', amount: '200000', basePrecision: 0 }), null);
  // A limit below its price: not filled.
  assert.equal(planResting({ resting: [q], side: 'buy', amount: '200000', price: '1', basePrecision: 0 }), null);
  assert.ok(planResting({ resting: [q], side: 'buy', amount: '200000', price: '2', basePrecision: 0 }));
  // Selling the base to an order that sells the quote (a bid): the base given buys as
  // much of the quote as it pays for.
  const bid = restingQuote({ ...offer(), offer_asset: B, want_asset: A, resting_leaf: { operator_key: OP, rate_num: '1', rate_den: '4', min_lot: '1', value: '800000' }, _active: '800000' }, B, A, OP);
  assert.deepEqual(planResting({ resting: [bid], side: 'sell', amount: '100000', basePrecision: 0 }), { q: bid, filled: 400000n, pays: 100000n });
});
