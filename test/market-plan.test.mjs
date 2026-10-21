import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTrade, restTerms, lotFit, covenantQuote, orderProgress, fillStanding, MAX_ORDERS_PER_TRADE } from '../src/market-plan.js';
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
