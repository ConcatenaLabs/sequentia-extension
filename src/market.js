// A site's market and limit orders, settled the way the wallet chooses (`placeOrder`,
// `getOrders`, `cancelOrder` in doc/PROVIDER.md).
//
// The site names a market (two assets), a side, an amount of the base asset and, for
// a limit order, a price. The wallet reads the book itself, plans which orders to take
// (src/market-plan.js), shows one approval with what is given, what is got and what is
// paid in fees, each also in the reference currency, and then settles:
//
//  - Between two Sequentia assets, from the orders on the on-chain book: each order
//    taken is one transaction that pays its maker on the chain and this wallet in the
//    same transaction. A covenant order needs no maker online; an interactive maker's
//    offer is co-signed by its maker over the relay (src/dex.js), and this wallet checks
//    that transaction against its own half before signing it. Either way the wallet
//    receives at its usual address, in the clear. What a limit order does not fill rests
//    on the book as an order of the same kind, funded from this wallet and listed by it;
//    it fills with this wallet offline, and what is left can be taken back once its
//    time runs out. Every fee is paid in the asset the wallet gives.
//  - In developer mode, with an operator joined, an order resting in that operator's
//    tree (src/leaf-resting.js) is one more order of the market: when the best one
//    prices at least as well as every covenant order and holds the whole trade, the
//    trade fills it in the tree from this wallet's leaves, one transfer the operator
//    co-signs (in user mode such an order is not taken).
//  - Against BTC, from the quotes of makers who settle instantly over Lightning, through
//    this wallet's own channels (src/dex.js). Such a trade does not rest: a limit order
//    against BTC trades what the book reaches at the price, and the rest is not placed.
//
// Nothing here trusts a number from the site: every amount is recomputed from the
// relay's offers and each covenant is checked against the chain before the approval.

import * as wasmMod from '../pkg/lwk_wasm.js';
import * as seqob from '../vendor/seqob.js';
import { settleFill, planFillFromMatched, planPlaceOrder, postExisting, planRefund, orderFromCovenantTerms } from '../vendor/covenant-order.js';
import { makeCovenantHooks, makerPayout, revHexStr } from '../vendor/covenant-fill-host.js';
import { orderExpiryTime, lockState } from '../vendor/covenant-flow.js';
import { secp256k1 } from '../vendor/btc.js';
import * as A from './assets.js';
import * as engine from './engine.js';
import * as dex from './dex.js';
import * as ln from './ln.js';
import * as P from './market-plan.js';
import * as R from './market-orders.js';
import { BASE, ESPLORA, DEFAULT_FEERATE, EXCHANGE_RATE_SCALE } from './config.js';
import { fmtAtoms } from './util.js';
import { sessionMnemonic } from './vault.js';
import * as leaves from './leaves.js';
import * as leafResting from './leaf-resting.js';
import { supervisedAssets } from './leaf-profiles.js';

export const RELAY = BASE + '/seqob';
// How long a resting order rests before what is left of it can be taken back.
export const ORDER_SECONDS = 86400;
const FILL_VSIZE = 1500n;   // a covenant fill, as the fill path estimates it
const FUND_VSIZE = 500n;    // the funding of a resting order, or a take-back

const big = (v) => BigInt(v ?? 0);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const isHex64 = (s) => /^[0-9a-f]{64}$/.test(String(s || ''));
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- words ----
function tick(h) { return A.assetMeta(h).ticker; }
function prec(h) { return A.assetMeta(h).precision || 0; }
export function amountLine(h, atoms) {
  const s = fmtAtoms(big(atoms), prec(h)) + ' ' + tick(h);
  const r = A.refValueStr(h, String(atoms));
  return r ? s + ' (' + r + ')' : s;
}
function whenLine(unix) {
  return new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
// The fee of a transaction of about `vsize` vbytes, in `asset` at its published rate.
// A trade pays in the asset it gives and in nothing else.
function feeIn(asset, vsize) {
  let rate;
  try { rate = A.feeRateFor(asset); }
  catch { throw new Error('the network takes no fees in ' + tick(asset) + ' right now, and a trade pays its fees in the asset it gives'); }
  const native = (BigInt(DEFAULT_FEERATE) * vsize) / 1000n;
  return ceilDiv(native * BigInt(EXCHANGE_RATE_SCALE), rate);
}

// ---- the book ----
async function bookOf(base, quote) {
  const url = `${RELAY}/v1/market/${encodeURIComponent(base)}/${encodeURIComponent(quote)}/orderbook`;
  const r = await fetch(url, { cache: 'no-store' });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('the order book is unreachable right now (HTTP ' + r.status + ')');
  const j = await r.json();
  // statuses[i] is offers[i]'s live state: what it can be filled for now.
  return (j.offers || []).map((o, i) => {
    const st = (j.statuses || [])[i];
    const n = seqob.normRelayOffer(o);
    if (st && st.active_amount != null) n._active = String(st.active_amount);
    return n;
  });
}
// Both ways round: an order selling the quote for the base is listed on the reversed
// market.
async function marketOffers(base, quote) {
  const [a, b] = await Promise.all([bookOf(base, quote), bookOf(quote, base)]);
  return [...a, ...b];
}
async function fillsOf(sell, want) {
  try {
    const r = await fetch(`${RELAY}/v1/market/${sell}/${want}/fills?limit=1000`, { cache: 'no-store' });
    if (!r.ok) return [];
    return (await r.json()).fills || [];
  } catch { return []; }
}
async function tipMedianTime() {
  const h = (await (await fetch(`${ESPLORA}/blocks/tip/hash`)).text()).trim();
  const b = await (await fetch(`${ESPLORA}/block/${h}`)).json();
  if (!(Number(b.mediantime) > 0)) throw new Error('the chain\'s time is unreadable right now');
  return Number(b.mediantime);
}
async function outputOf(txid, vout) {
  const r = await fetch(`${ESPLORA}/tx/${txid}`);
  if (!r.ok) return null;
  const tx = await r.json();
  const o = tx.vout && tx.vout[vout];
  return o ? { scriptPubKey: o.scriptpubkey, asset: o.asset ?? null, value: o.value ?? null } : null;
}
async function voutOf(txid, spkHex) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`${ESPLORA}/tx/${txid}`);
      if (r.ok) {
        const tx = await r.json();
        const v = (tx.vout || []).findIndex((o) => String(o.scriptpubkey || '').toLowerCase() === spkHex);
        if (v >= 0) return v;
      }
    } catch { /* the explorer has not seen it yet */ }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  return null;
}

// What each covenant order holds, read from the chain. The relay serves an order's
// signed terms, and its `offer_amount` is what the order held when it was signed: after
// a partial fill the order rests at a new outpoint holding less, and only the chain
// says how much. An order whose coin is spent or unreadable is left out.
async function withChainAmounts(offers) {
  const out = await Promise.all(offers.map(async (o) => {
    const ct = o.covenant;
    try {
      const vout = Number(ct.covenant_vout || 0);
      const sp = await fetch(`${ESPLORA}/tx/${ct.covenant_txid}/outspend/${vout}`).then((r) => (r.ok ? r.json() : null));
      if (sp && sp.spent) return null;
      const out = await outputOf(ct.covenant_txid, vout);
      if (!out || out.value == null || String(out.asset || '').toLowerCase() !== String(o.offer_asset).toLowerCase()) return null;
      return { ...o, offer_amount: String(out.value), _spk: out.scriptPubKey };
    } catch { return null; }
  }));
  return out.filter(Boolean);
}

// The outpoint holding an order's script, from the explorer (scripts are indexed by
// the forward sha256 of the script, as the deployed explorer indexes them).
async function outpointBySpk(spkHex) {
  if (!spkHex) return null;
  const h = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(spkHex.match(/../g).map((x) => parseInt(x, 16))))));
  const r = await fetch(`${ESPLORA}/scripthash/${h}/utxo`);
  if (!r.ok) return null;
  const u = (await r.json())[0];
  return u ? { txid: u.txid, vout: u.vout } : null;
}

// The key an order's listing is signed with: one per order, from the wallet's phrase,
// so the relay cannot link two orders of one wallet by their key.
async function orderKey(id) {
  const phrase = await sessionMnemonic();
  if (!phrase) throw new Error('the wallet is locked');
  const tag = new TextEncoder().encode('sequentia/market-order-offer-key/');
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array([...tag, ...new TextEncoder().encode(phrase.trim() + '/' + id)]));
  return new Uint8Array(d);
}

// ---- the trade ----

// Checks the site's request and answers { display, exec } for the approval.
export async function prepareOrder(origin, params) {
  const type = params && params.type;
  if (type !== 'market' && type !== 'limit') throw new Error("type must be 'market' or 'limit'");
  const side = params.side;
  if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
  const base = String(params.base || '').toLowerCase();
  const quote = params.quote === 'BTC' ? 'BTC' : String(params.quote || '').toLowerCase();
  if (!isHex64(base)) throw new Error('base must be a 32-byte hex asset id');
  if (quote !== 'BTC' && !isHex64(quote)) throw new Error("quote must be a 32-byte hex asset id or 'BTC'");
  if (base === quote) throw new Error('a market needs two different assets');
  const amount = String(params.amount ?? '');
  if (!/^\d+$/.test(amount) || big(amount) <= 0n) throw new Error('amount (atoms of the base asset) is required');
  const price = type === 'limit' ? String(params.price ?? '') : null;
  if (type === 'limit' && (!/^\d+$/.test(price) || big(price) <= 0n)) throw new Error('price (quote atoms per whole base unit) is required for a limit order');
  if (!A.precisionKnown(base) || (quote !== 'BTC' && !A.precisionKnown(quote))) throw new Error('the wallet does not know the precision of one of these assets');
  const opts = P.readOrderOptions(params, type);
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
  if (quote === 'BTC') {
    if (opts.postOnly) throw new Error(NEVER_RESTS);
    return prepareInstant(origin, { type, base, side, amount, price });
  }
  return prepareChain(origin, { type, base, quote, side, amount, price, opts });
}

const WOULD_TRADE = 'this order would trade at once; nothing was placed';
const NEVER_RESTS = 'an order against BTC trades at once and never rests on the book; nothing was placed';
// "about 6 hours", "about 7 days": how long an order rests before it can be taken back.
const restsFor = (secs) => {
  const [n, u] = secs < 2 * 86400 ? [Math.round(secs / 3600), 'hour'] : [Math.round(secs / 86400), 'day'];
  return 'about ' + n + ' ' + u + (n === 1 ? '' : 's');
};

async function prepareChain(origin, { type, base, quote, side, amount, price, opts = P.readOrderOptions({}, type) }) {
  const receive = side === 'buy' ? base : quote, payAsset = side === 'buy' ? quote : base;
  const all = await marketOffers(base, quote);
  const covs = all.filter((o) => P.covenantQuote(o, receive, payAsset));
  const inters = all.filter((o) => P.interactiveQuote(o, receive, payAsset));
  // An order resting in the joined operator's tree, when it is where the best price
  // is, is filled from leaves: no on-chain coin moves.
  const leaf = await prepareResting(origin, { type, base, quote, side, amount, price, all, covs, receive, payAsset });
  if (leaf && opts.postOnly) throw new Error(WOULD_TRADE);
  if (leaf) return leaf;
  // Coins are chosen from a scan begun now: one begun before the wallet's last trade
  // landed can still show a coin that trade spent.
  await engine.syncFresh();
  const offers = [...await withChainAmounts(covs), ...inters];
  const plan = P.planTrade({ offers, base, quote, side, amount, price, basePrecision: prec(base), interactive: true });
  if (opts.postOnly && plan.slices.length) throw new Error(WOULD_TRADE);
  const rest = type === 'limit' && opts.rest
    ? P.withMinFill(P.restTerms({ base, quote, side, baseLeft: plan.baseLeft, price, basePrecision: prec(base) }), opts.minFill, { side, price, basePrecision: prec(base) })
    : null;
  if (!plan.slices.length && !rest) {
    throw new Error(type === 'market' ? 'nothing on the book can be traded at this market right now'
      : !opts.rest ? 'nothing on the book reaches this price right now; nothing was placed' : 'nothing to place');
  }
  const restSecs = opts.takeBackAfter || ORDER_SECONDS;

  // Each order taken is checked against the chain now: a relay that lies about an
  // order's script is caught before anything is shown.
  for (const s of plan.slices) if (!s.interactive) planFillFromMatched(synthOf(s), s.offer._spk, { makerCancellableOK: true });

  const pay = plan.pay;
  const fillFee = plan.slices.length ? feeIn(pay, FILL_VSIZE) : 0n;
  const fees = fillFee * BigInt(plan.slices.length) + (rest ? feeIn(rest.sell, FUND_VSIZE) : 0n);
  const gives = plan.gave + (rest ? rest.sellAtoms : 0n);
  const have = engine.availableFor(pay);
  if (have < gives + fees) {
    throw new Error('not enough ' + tick(pay) + ': this trade gives ' + fmtAtoms(gives + fees, prec(pay)) + ' ' + tick(pay)
      + ' with its fees, and the wallet holds ' + fmtAtoms(have, prec(pay)));
  }
  // A covenant fill spends coins in the clear; a balance partly held confidential is
  // first moved in the clear to this wallet, in one transfer, as part of the trade.
  const needClear = plan.slices.length ? plan.gave + fillFee * BigInt(plan.slices.length) : 0n;
  const unblind = needClear > 0n && explicitHeld(pay) < needClear ? needClear : 0n;

  const nOrders = plan.slices.length;
  const rows = [];
  rows.push(['You give', amountLine(pay, plan.gave + (rest ? rest.sellAtoms : 0n))]);
  if (nOrders) rows.push([rest ? 'You get now' : 'You get', amountLine(plan.receive, plan.got)]);
  if (rest) rows.push([nOrders ? 'You get later' : 'You get', 'up to ' + amountLine(rest.want, rest.wantAtoms) + ', as others fill your order']);
  rows.push(['Fees', amountLine(pay, fees)]);
  if (rest) {
    rows.push(['Your order', (side === 'buy' ? 'Buy ' : 'Sell ') + fmtAtoms(plan.baseLeft, prec(base)) + ' ' + tick(base)
      + ' at ' + fmtAtoms(big(price), prec(quote)) + ' ' + tick(quote) + ' each' + (A.refValueStr(quote, price) ? ' (' + A.refValueStr(quote, price) + ')' : '')]);
    if (opts.minFill != null) rows.push(['Smallest fill', amountLine(rest.sell, rest.minLot)]);
    rows.push(['Taking it back', 'what is left of it can be taken back from ' + restsFor(restSecs) + ' after it is placed; until then it stays on the book for anyone to fill at your price']);
  }
  const text = (type === 'market'
    ? (side === 'buy' ? 'Buy ' : 'Sell ') + fmtAtoms(plan.baseDone, prec(base)) + ' ' + tick(base) + ' at the best prices on the book'
      + (plan.baseLeft > 0n ? ' (the book does not reach the whole amount near the best price; the rest is not traded)' : '') + '.'
    : (nOrders
      ? (side === 'buy' ? 'Buy ' : 'Sell ') + fmtAtoms(plan.baseDone, prec(base)) + ' ' + tick(base) + ' now at your price or better'
        + (rest ? ', and place an order for the rest at your price.' : '.')
      : 'Place an order on the book to ' + side + ' ' + fmtAtoms(plan.baseLeft, prec(base)) + ' ' + tick(base) + ' at your price.'));
  const display = {
    text,
    rows,
    detail: (nOrders ? 'Each order is taken in one transaction that pays its maker and this wallet together, or does nothing. ' : '')
      + 'Every fee is paid in ' + tick(pay) + '.',
  };

  const exec = async () => {
    const id = seqob.randHex(16);
    const trade = { id, origin, at: Date.now(), kind: 'chain', type, side, market: { base, quote }, pay, receive: plan.receive, fills: [], order: null };
    if (unblind > 0n) {
      await engine.sendToAddress({ chain: 'seq', asset: pay, amount: unblind.toString(), address: engine.rawAddress(false).toString() });
    }
    let first = true;
    for (const s of plan.slices) {
      try {
        if (!first) await engine.syncFresh();
        first = false;
        const r = await fillOne(s, pay, fillFee);
        trade.fills.push({ ok: true, txid: r.txid, offer_id: s.offerId, pair: s.offer.pair, filled: s.filled.toString(), pays: s.pays.toString() });
      } catch (e) {
        trade.fills.push({ ok: false, offer_id: s.offerId, error: String((e && e.message) || e) });
      }
    }
    const done = trade.fills.filter((f) => f.ok);
    if (rest) {
      if (trade.fills.length) await engine.syncFresh().catch(() => {});
      try { trade.order = (await placeRest(origin, { base, quote, side, price, baseLeft: plan.baseLeft + leftFromFailed(trade.fills, plan, side), opts }, rest, done.length !== trade.fills.length)).id; }
      catch (e) { trade.order_error = String((e && e.message) || e); }
    }
    if (done.length || trade.order) await R.rememberTrade(trade);
    engine.sync().catch(() => {});
    if (!done.length && !trade.order) {
      throw new Error((trade.order_error || (trade.fills[0] && trade.fills[0].error) || 'nothing was traded') + '; nothing of yours moved');
    }
    return answerTrade(trade, plan);
  };
  return { display, exec };
}

// A trade filled from one order resting in the joined operator's tree, when that is
// where the best price is (src/market-plan.js planResting); null otherwise, and always
// in user mode. The library quotes the fill from the operator's own view of the order.
// The operator serves no resting order in a supervised asset (one its issuer can freeze),
// so a market with one is never filled from the tree.
async function prepareResting(origin, { type, base, quote, side, amount, price, all, covs, receive, payAsset }) {
  if ((await leaves.mode().catch(() => null)) !== 'developer' || !(await leaves.config().catch(() => null))) return null;
  const restingAll = all.filter((o) => o.resting_leaf);
  if (!restingAll.length) return null;
  let op;
  try {
    await leaves.requireLeaves();
    const info = await leaves.run('info');
    op = info.operator;
    const sup = supervisedAssets(info);
    if (sup.includes(base) || sup.includes(quote)) return null;
  } catch { return null; }
  const resting = restingAll.map((o) => P.restingQuote(o, receive, payAsset, op)).filter(Boolean);
  // Each covenant order at its signed size: what decides is its price, which a fill
  // does not change.
  const covenants = covs.map((o) => P.covenantQuote(o, receive, payAsset)).filter(Boolean);
  const plan = P.planResting({ resting, covenants, side, amount, price: type === 'limit' ? price : null, basePrecision: prec(base) });
  if (!plan) return null;
  const served = leafResting.servedOrder(plan.q.offer);
  const quote2 = await leafResting.fillQuote(served, plan.filled.toString());
  if (big(quote2.filled) !== plan.filled || big(quote2.paid) !== plan.pays) {
    throw new Error('the order the book showed has changed at its operator; try again');
  }
  const fee = big(quote2.fee.amount);
  const rows = [
    ['You give', amountLine(payAsset, plan.pays + fee)],
    ['You get', amountLine(receive, plan.filled)],
    ['Fees', amountLine(payAsset, fee)],
  ];
  const baseDone = side === 'buy' ? plan.filled : plan.pays;
  const display = {
    text: (side === 'buy' ? 'Buy ' : 'Sell ') + fmtAtoms(baseDone, prec(base)) + ' ' + tick(base) + ' from an order resting in the operator’s tree, at its price.',
    rows,
    detail: 'The order is filled in one transfer in the tree that pays its maker and this wallet together, co-signed by the operator. Every fee is paid in ' + tick(payAsset) + '.',
  };
  const exec = async () => {
    const r = await leafResting.fill(served, plan.filled.toString(), quote2);
    const tid = r.answer && r.answer.transfer_id;
    const trade = { id: seqob.randHex(16), origin, at: Date.now(), kind: 'leaf', type, side, market: { base, quote }, pay: payAsset, receive,
      fills: [{ ok: true, txid: tid || null, offer_id: plan.q.offerId, pair: plan.q.offer.pair, filled: plan.filled.toString(), pays: plan.pays.toString(),
        order: served.order, coin: r.coin, ...(r.moved_from ? { moved_from: r.moved_from } : {}) }], order: null };
    await R.rememberTrade(trade);
    return { ...answerTrade(trade, null), gave: (plan.pays + fee).toString(), got: plan.filled.toString(), transfer_id: tid || null,
      ...(r.moved_from ? { moved_from: r.moved_from } : {}) };
  };
  return { display, exec };
}

// What a fill that failed did not take, in base atoms, so a limit order's rest covers it.
function leftFromFailed(fills, plan, side) {
  let left = 0n;
  for (const f of fills) {
    if (f.ok) continue;
    const s = plan.slices.find((x) => x.offerId === f.offer_id);
    if (s) left += side === 'buy' ? s.filled : s.pays;
  }
  return left;
}

function explicitHeld(asset) {
  let sum = 0n;
  try {
    for (const u of engine.getWollet().utxos()) {
      const sec = u.unblinded();
      if (sec.asset().toString() !== asset) continue;
      if (sec.isExplicit && !sec.isExplicit()) continue;
      sum += BigInt(sec.value());
    }
  } catch { /* unreadable: the fill path refuses on its own */ }
  return sum;
}

function synthOf(s) {
  return {
    resting_is_covenant: true,
    covenant: s.offer.covenant,
    covenant_locked: String(big(s.offer.offer_amount)),
    fill_base_amount: s.filled.toString(),
    offer_id: s.offerId,
    pair: s.offer.pair,
  };
}

// Takes one order: one transaction, its credit to the maker and this wallet's asset to
// this wallet's transparent address, the fee in the asset given.
async function fillOne(s, payAsset, feeAtoms) {
  if (s.interactive) {
    // The maker co-signs; the fee is paid in the asset given, as for a covenant fill.
    const receive = String(s.offer.offer_asset).toLowerCase();
    const txid = await dex.liftSameChain(s.offer,
      { take: s.take, payAsset, payAtoms: s.pays, recvAsset: receive, recvAtoms: s.filled },
      { feeAsset: payAsset, feeAmount: feeAtoms, feeRate: BigInt(A.feeRateFor(payAsset)) });
    if (!txid) throw new Error('the maker\'s swap was not broadcast');
    return { txid };
  }
  const transparent = engine.rawAddress(false).toString();
  const hooks = makeCovenantHooks({
    wasm: wasmMod,
    wollet: engine.getWollet(),
    network: engine.getNetwork(),
    mnemonic: engine.getMnemonic(),
    esploraFetch: (path, init) => fetch(ESPLORA + path, init),
    receiveAddress: () => transparent,
    fee: { asset: payAsset, atoms: feeAtoms.toString() },
    noteOwnTx: engine.noteOwn,
    // An order whose maker kept a key of its own can be withdrawn before this fill
    // lands; the fill then does nothing, and nothing of this wallet moves.
    opts: { makerCancellableOK: true },
  });
  const res = await engine.withWollet(() => settleFill(synthOf(s), hooks));
  return { txid: res.txid };
}

// Places the order that rests with what a limit order did not fill: the record first,
// then the funding, then the listing (once the funding is in a block).
async function placeRest(origin, { base, quote, side, price, baseLeft, opts = {} }, restPlanned, recompute) {
  const rest = recompute
    ? P.withMinFill(P.restTerms({ base, quote, side, baseLeft, price, basePrecision: prec(base) }), opts.minFill ?? null, { side, price, basePrecision: prec(base) })
    : restPlanned;
  const recs = await R.orderRecords();
  const idx = R.nextMakerIndex(recs);
  const payout = makerPayout(engine.getSigner(), engine.getNetwork(), idx);
  const expiry = orderExpiryTime(await tipMedianTime(), opts.takeBackAfter || ORDER_SECONDS);
  const plan = planPlaceOrder({
    assetA: revHexStr(rest.sell), assetB: revHexStr(rest.want), sellAtoms: rest.sellAtoms,
    rateNum: rest.rateNum, rateDen: rest.rateDen, minLot: rest.minLot,
    expiryLocktime: expiry, makerProg: payout.program, makerX: payout.internalKey,
  });
  const address = wasmMod.scriptToAddress(plan.spkHex, engine.getNetwork());
  const id = seqob.randHex(16);
  const priv = await orderKey(id);
  const rec = {
    id, origin, at: Date.now(), market: { base, quote }, side, price: String(price),
    base_amount: big(baseLeft).toString(),
    sell: rest.sell, want: rest.want, sell_atoms: rest.sellAtoms.toString(), want_atoms: rest.wantAtoms.toString(),
    rate_num: rest.rateNum.toString(), rate_den: rest.rateDen.toString(), min_lot: rest.minLot.toString(),
    expiry, maker_index: idx, maker_path: payout.path, spk: plan.spkHex,
    offer_id: id, maker_pubkey: hex(secp256k1.getPublicKey(priv, true)),
    txid: null, vout: null,
  };
  await R.rememberOrder(rec);
  engine.watchCredits(true);
  const { txid } = await engine.sendToAddress({ chain: 'seq', asset: rest.sell, amount: rest.sellAtoms.toString(), address });
  const vout = await voutOf(txid, plan.spkHex);
  await R.updateOrder(id, { txid, vout });
  progressOrders().catch(() => {});
  return { id, txid, vout };
}

// Lists each order whose funding is in a block and that the relay does not list yet,
// and moves maker credits into the wallet's own coins. Runs after each sync, on the
// wallet's minute alarm, and whenever a site asks for its orders.
let progressing = null;
export function progressOrders() {
  if (!progressing) progressing = run().finally(() => { progressing = null; });
  return progressing;
  async function run() {
    if (!engine.isOpen()) return;
    const recs = await R.orderRecords();
    if (!recs.length) return;
    engine.watchCredits(true);
    for (const rec of recs) {
      if (rec.withdrawn_txid) continue;
      // A worker that died between the funding and its record: the coin is found again
      // by the order's script.
      if (!rec.txid || rec.vout == null) {
        const at = await outpointBySpk(rec.spk).catch(() => null);
        if (!at) continue;
        await R.updateOrder(rec.id, at);
        Object.assign(rec, at);
      }
      if (!R.postDue(rec)) continue;
      try {
        const priv = await orderKey(rec.id);
        seqob.setSeqobBase(RELAY);
        const now = Math.floor(Date.now() / 1000);
        const res = await postExisting({
          assetA: revHexStr(rec.sell), assetB: revHexStr(rec.want), sellAtoms: big(rec.sell_atoms),
          rateNum: big(rec.rate_num), rateDen: big(rec.rate_den), minLot: big(rec.min_lot),
          expiryLocktime: rec.expiry, makerProg: makerPayout(engine.getSigner(), engine.getNetwork(), rec.maker_index).program,
          makerX: makerPayout(engine.getSigner(), engine.getNetwork(), rec.maker_index).internalKey,
          txid: rec.txid, vout: rec.vout, offerId: rec.offer_id, makerPubkey: rec.maker_pubkey,
          nowUnix: now, ttlSecs: Math.max(60, Math.min(7 * 86400 - 60, rec.expiry - now - 60)),
        }, { fetchOutput: outputOf, postCovenantOffer: (offer) => seqob.postCovenantOffer(offer, priv) });
        await R.updateOrder(rec.id, { posted_at: now, relay_expires: Number(res.offer.expires_at_unix), post_error: null });
      } catch (e) {
        const m = String((e && e.message) || e);
        if (R.alreadyListed(m)) { await R.updateOrder(rec.id, { posted_at: Math.floor(Date.now() / 1000), post_error: null }); continue; }
        await R.updateOrder(rec.id, { post_error: R.fundingNotYetSeen(m) ? null : m });
      }
    }
    await sweepCredits().catch((e) => console.warn('[market] credits not moved yet:', (e && e.message) || e));
  }
}

// Maker credits arrive at the order's taproot payout, which the wallet's main coins do
// not include. They are moved to the wallet's own address, each asset paying its own
// fee, once they are worth more than ten times it; until then they count in the
// asset's figure all the same.
async function sweepCredits() {
  const cw = engine.creditWollet();
  if (!cw) return;
  const bal = (() => { try { return cw.balance().toJSON(); } catch { return {}; } })();
  for (const [asset, v] of Object.entries(bal)) {
    const have = big(v);
    if (have <= 0n) continue;
    let fee;
    try { fee = feeIn(asset, FUND_VSIZE); } catch { continue; }
    if (have <= fee * 10n) continue;
    await engine.sweepCredit(asset, have - fee * 2n);
  }
}

// The fills of one of the wallet's orders, read from the chain: from where it was
// placed, each spend that pays its maker credit, to where it rests now. Stops at a spend
// that is not a fill (the order taken back) or that cannot be read yet.
async function chainSpends(rec) {
  if (!rec.txid || rec.vout == null) return [];
  const payout = makerPayout(engine.getSigner(), engine.getNetwork(), rec.maker_index);
  const ids = { orderSpk: rec.spk, makerSpk: payout.spkHex };
  const out = [];
  let at = { txid: rec.txid, vout: rec.vout }, held = big(rec.sell_atoms);
  for (let i = 0; i < 200 && at; i++) {
    const sp = await fetch(`${ESPLORA}/tx/${at.txid}/outspend/${at.vout}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!sp || !sp.spent || !sp.txid) break;
    const tx = await fetch(`${ESPLORA}/tx/${sp.txid}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!tx) break;
    const f = P.fillOfSpend({ ...tx, txid: sp.txid }, Number(sp.vin), held, ids);
    if (!f) break;
    out.push({ ...f, confirmed: !!(sp.status && sp.status.confirmed) });
    held = f.remainder; at = f.next;
  }
  return out;
}
async function progressOf(rec, relayFills) {
  try { return P.progressFromChain(rec, await chainSpends(rec), relayFills); }
  catch { return P.orderProgress(rec, relayFills); }
}

// ---- what a site sees ----

function answerTrade(t, plan) {
  return {
    trade: t.id,
    filled: t.fills.filter((f) => f.ok).length,
    failed: t.fills.filter((f) => !f.ok).map((f) => f.error),
    order: t.order || null,
    order_error: t.order_error || null,
    ...(plan ? { gave: plan.gave.toString(), got: plan.got.toString() } : {}),
  };
}

// The site's trades and orders, and where each stands.
export async function ordersFor(origin) {
  await progressOrders().catch(() => {});
  const orders = (await R.orderRecords()).filter((r) => r.origin === origin);
  const trades = (await R.tradeRecords()).filter((r) => r.origin === origin);
  const fillCache = new Map();
  const fillsFor = async (sell, want) => {
    const k = sell + '/' + want;
    if (!fillCache.has(k)) fillCache.set(k, await fillsOf(sell, want));
    return fillCache.get(k);
  };
  let medianTime = 0;
  try { medianTime = await tipMedianTime(); } catch { /* unknown: nothing can be taken back yet */ }

  const outOrders = [];
  for (const rec of orders) {
    const prog = await progressOf(rec, rec.txid ? await fillsFor(rec.sell, rec.want) : []);
    const lock = lockState(rec.expiry, { medianTime });
    const total = big(rec.base_amount);
    // In base terms: a sell order sold the base; a buy order was paid the base.
    const filledBase = rec.side === 'sell' ? prog.filled : prog.credited;
    let state;
    if (rec.withdrawn_txid) state = 'withdrawn';
    else if (!rec.txid || !rec.posted_at) state = 'placing';
    else if (prog.holds === 0n) state = prog.final ? 'filled' : 'filling';
    else state = 'open';
    outOrders.push({
      order: rec.id, market: rec.market, side: rec.side, price: rec.price, at: rec.at,
      amount: total.toString(),
      filled: (filledBase > total ? total : filledBase).toString(),
      holds: prog.holds.toString(), sell: rec.sell,
      state,
      settled: prog.final,
      take_back_from: rec.expiry,
      take_back_from_text: whenLine(rec.expiry),
      can_take_back: !rec.withdrawn_txid && prog.holds > 0n && !!rec.txid && lock.known && lock.open,
      withdrawn_txid: rec.withdrawn_txid || null,
      fills: prog.fills.map((f) => ({ ...f, standing: f.state === 'final' ? 'settled' : 'sent' })),
      note: rec.post_error || null,
    });
  }

  const outTrades = [];
  for (const t of trades) {
    if (t.kind === 'instant') {
      let state = 'sent', error = null, result = null;
      try {
        const j = await dex.jobResult(t.job);
        if (j && j.done) { if (j.ok) { state = 'settled'; result = j.result || null; } else { state = 'failed'; error = j.error || 'the trade did not settle'; } }
      } catch { /* the job is unreadable: still sent */ }
      outTrades.push({ trade: t.id, at: t.at, market: t.market, side: t.side, type: t.type, kind: 'instant', state, error,
        base: result ? String(result.baseAtoms ?? '') : t.base_atoms, quote: result ? String(result.quoteAtoms ?? '') : t.quote_atoms });
      continue;
    }
    const fills = [];
    for (const f of t.fills.filter((x) => x.ok)) {
      const [sell, want] = [f.pair && f.pair.base_asset, f.pair && f.pair.quote_asset];
      const st = P.fillStanding(f.txid, sell && want ? await fillsFor(sell, want) : []);
      // In base terms: buying, the order sold the base (filled); selling, it was paid
      // the base (pays).
      fills.push({ txid: f.txid, base: t.side === 'buy' ? f.filled : f.pays, quote: t.side === 'buy' ? f.pays : f.filled, state: st.state });
    }
    outTrades.push({ trade: t.id, at: t.at, market: t.market, side: t.side, type: t.type, kind: 'chain', order: t.order || null,
      fills, state: fills.length && fills.every((f) => f.state === 'settled') ? 'settled' : 'sent' });
  }
  return { orders: outOrders, trades: outTrades };
}

// ---- taking an order back ----
export async function prepareCancel(origin, params) {
  const id = String((params && params.order) || '');
  const rec = (await R.orderRecords()).find((r) => r.id === id && r.origin === origin);
  if (!rec) throw new Error('no such order of this site in this wallet');
  if (rec.withdrawn_txid) throw new Error('this order was taken back already');
  if (!rec.txid) throw new Error('this order is still being placed');
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
  await engine.syncFresh();
  const prog = await progressOf(rec, await fillsOf(rec.sell, rec.want));
  if (prog.holds <= 0n || !prog.restsAt) throw new Error('nothing is left of this order to take back');
  const lock = lockState(rec.expiry, { medianTime: await tipMedianTime() });
  if (!lock.open) {
    throw new Error('this order can be taken back from ' + whenLine(rec.expiry) + '; until then it stays on the book for anyone to fill at your price');
  }
  const fee = feeIn(rec.sell, FUND_VSIZE);
  if (prog.holds <= fee) throw new Error('what is left of this order is worth less than the fee to take it back');
  const display = {
    text: 'Take back what is left of your order: ' + fmtAtoms(prog.holds, prec(rec.sell)) + ' ' + tick(rec.sell) + '.',
    rows: [['You get back', amountLine(rec.sell, prog.holds - fee)], ['Fees', amountLine(rec.sell, fee)]],
    detail: 'The order leaves the book, and what is left of it returns to this wallet.',
  };
  const exec = async () => {
    const [txid, vout] = prog.restsAt.split(':');
    const order = {
      assetA: revHexStr(rec.sell), assetB: revHexStr(rec.want), rateNum: big(rec.rate_num), rateDen: big(rec.rate_den),
      minLot: big(rec.min_lot), expiryLocktime: rec.expiry,
      makerProg: makerPayout(engine.getSigner(), engine.getNetwork(), rec.maker_index).program, makerVer: 1,
      makerX: makerPayout(engine.getSigner(), engine.getNetwork(), rec.maker_index).internalKey,
    };
    const recipe = { ...planRefund(order, { txid, vout: Number(vout), locked: prog.holds }), covenantAsset: rec.sell, makerKeyPath: rec.maker_path };
    const transparent = engine.rawAddress(false).toString();
    const hooks = makeCovenantHooks({
      wasm: wasmMod, wollet: engine.getWollet(), network: engine.getNetwork(), mnemonic: engine.getMnemonic(),
      esploraFetch: (path, init) => fetch(ESPLORA + path, init), receiveAddress: () => transparent,
      fee: { asset: rec.sell, atoms: fee.toString() }, noteOwnTx: engine.noteOwn,
    });
    const refundTxid = await engine.withWollet(async () => hooks.broadcast((await hooks.buildCovenantRefundTx(recipe)).rawHex));
    await R.updateOrder(rec.id, { withdrawn_txid: refundTxid, withdrawn_at: Date.now() });
    try { seqob.setSeqobBase(RELAY); await seqob.signAndCancel(rec.offer_id, await orderKey(rec.id)); } catch { /* the relay drops it once the coin is spent */ }
    engine.sync().catch(() => {});
    return { order: rec.id, txid: refundTxid };
  };
  return { display, exec };
}

// ---- against BTC ----
async function prepareInstant(origin, { type, base, side, amount, price }) {
  const unit = 10n ** BigInt(prec(base));
  const limitQuoteAtoms = type === 'limit' ? (big(amount) * big(price)) / unit : null;
  let prep;
  try {
    prep = await dex.prepareLnMarketOrder({ base, quote: 'BTC', side, baseAtoms: amount, limitQuoteAtoms: limitQuoteAtoms != null ? limitQuoteAtoms.toString() : undefined });
  } catch (e) {
    const m = String((e && e.message) || e);
    // The planner's words name its book; a site in user mode shows these.
    if (/no opposing resting orders|nothing fillable|nothing on the book/.test(m)) {
      throw new Error(type === 'limit' ? 'nothing on the book reaches this price right now; an order against BTC does not rest on the book' : 'nothing on the book can be traded at this market right now');
    }
    throw e;
  }
  const p = prep.plan;
  const payKind = side === 'buy' ? 'BTC' : base, getKind = side === 'buy' ? base : 'BTC';
  const payAtoms = side === 'buy' ? p.quoteAtoms : p.baseAtoms, getAtoms = side === 'buy' ? p.baseAtoms : p.quoteAtoms;
  // Settled through this wallet's own channels: what it can pay and receive that way
  // bounds the trade, and a trade it cannot settle is not offered.
  const held = Object.keys((await engine.balances()).seq || {});
  const chs = await ln.channelsSerialized([...held, base]).catch(() => ({ deployed: false, channels: [] }));
  const spend = (k) => (chs.channels || []).filter((c) => c.kind === k).reduce((s, c) => s + big(c.spendable), 0n);
  const recv = (k) => (chs.channels || []).filter((c) => c.kind === k).reduce((s, c) => s + big(c.receivable ?? 0), 0n);
  if (!chs.deployed || spend(payKind) < payAtoms || recv(getKind) < getAtoms) {
    throw new Error('this wallet cannot settle this trade against BTC: trades against BTC settle instantly, from the part of the wallet kept ready for instant payments, and that part holds '
      + fmtAtoms(spend(payKind), prec(payKind)) + ' ' + tick(payKind) + ' to give and room for ' + fmtAtoms(recv(getKind), prec(getKind)) + ' ' + tick(getKind) + ' to get');
  }
  const display = {
    text: (side === 'buy' ? 'Buy ' : 'Sell ') + fmtAtoms(p.baseAtoms, prec(base)) + ' ' + tick(base) + (type === 'limit' ? ' at your price or better' : ' at the best prices on the book')
      + (p.baseLeft > 0n ? '; the rest of the amount is not traded' + (type === 'limit' ? ' (an order against BTC does not rest on the book)' : '') : '') + '.',
    rows: [['You give', amountLine(payKind, payAtoms)], ['You get', amountLine(getKind, getAtoms)], ['Fees', 'none beyond the price']],
    detail: 'Settles instantly with ' + p.slices + ' order' + (p.slices === 1 ? '' : 's') + '; an order that does not settle is skipped and nothing of it moves.',
  };
  const exec = async () => {
    const r = await prep.exec();
    const id = seqob.randHex(16);
    await R.rememberTrade({ id, origin, at: Date.now(), kind: 'instant', type, side, market: { base, quote: 'BTC' }, job: r.jobId,
      base_atoms: p.baseAtoms.toString(), quote_atoms: p.quoteAtoms.toString() });
    return { trade: id, filled: p.slices, failed: [], order: null };
  };
  return { display, exec };
}
