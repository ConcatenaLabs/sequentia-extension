// Orders resting as leaves in the operator's tree (developer mode): the service
// worker's side of the provider's `restOrder`, `fillRestingOrder`,
// `cancelRestingOrder` and `getRestingOrders`.
//
// A resting order is an `order-2` leaf of the operator's tree. The maker rests it
// (the library's `order_rest`: a participation that gives up its coins for the order's
// leaf), and once the round that makes it is final and the wallet has handed over its
// forfeits, the library publishes it to the operator at the next `sync`. The maker can
// then close its browser: takers fill the order in the tree, the operator co-signing
// each fill, and every fill pays the maker a credit, which the wallet takes up at its
// next `sync`. While the participation waits on the wallet, the offscreen host syncs
// every few seconds (the takes' watch), so its forfeits go in as soon as its round is
// built.
//
// Once the operator says the order rests, the wallet lists it on the relay: an offer
// with the `resting_leaf` member (seqob.js), signed by a key of its own for that order,
// at the coin the order rests at and what that coin holds. The relay follows the order
// from coin to coin from the operator's state view, so the wallet posts it only once
// (and again before the listing lapses, while the order still rests).
//
// A taker fills an order the relay served: the library quotes the fill
// (`order_fill_resting_quote`, from the operator's own view of the order), the window
// shows the quote, and the fill goes ahead only on it. If the order moved since (another
// taker filled it first), the operator refuses the fill with `order_moved`; the wallet
// asks for a new quote at the coin the order rests at now and goes ahead with it only
// when it takes the same amount at the same price and a fee no higher than the one
// shown.
//
// Nothing about an order is decided here: the library checks every coin against its
// round, plans every fill by the leaf's arithmetic, and prices every fee.

import * as leaves from './leaves.js';
import * as seqob from '../vendor/seqob.js';
import { secp256k1 } from '../vendor/btc.js';
import { stGet, stSet } from './util.js';
import { walletTag } from './mode.js';
import { BASE } from './config.js';
import { sessionMnemonic } from './vault.js';

// The relay resting orders are listed on: the on-chain book's, so a resting order is
// one more order of its market.
export const RELAY = BASE + '/seqob';

const RESTING_KEY = 'ext.leaves.resting'; // { [walletTag]: [record] }
const DAY = 86400;
const MAX_LISTING = 7 * DAY;     // the relay's longest offer
const EXIT_DEADLINE = 3 * DAY;   // the operator co-signs no spend of a coin after it

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- the records ----
async function readAll() {
  const tag = await walletTag();
  if (!tag) return { tag: null, all: {}, list: [] };
  const all = (await stGet('local', RESTING_KEY)) || {};
  return { tag, all, list: Array.isArray(all[tag]) ? all[tag] : [] };
}
export async function records() { return (await readAll()).list; }
async function remember(rec) {
  const { tag, all, list } = await readAll();
  if (!tag) throw new Error('open the wallet first');
  all[tag] = [...list.filter((r) => r.rested_by !== rec.rested_by), rec];
  await stSet('local', RESTING_KEY, all);
}
async function update(restedBy, patch) {
  const { tag, all, list } = await readAll();
  if (!tag) return;
  all[tag] = list.map((r) => (r.rested_by === restedBy ? { ...r, ...patch } : r));
  await stSet('local', RESTING_KEY, all);
}

// ---- what a site asks, checked ----

// The whole price of `amount` at rate_num/rate_den, which a resting order's offer
// signs as its want_amount: it must come out whole, or the offer could not state the
// order's own price.
export function wholePrice(amount, rateNum, rateDen) {
  const p = BigInt(amount) * BigInt(rateNum);
  if (p % BigInt(rateDen) !== 0n) {
    throw new Error(`${amount} at ${rateNum}/${rateDen} is not a whole number of atoms: name the price as the whole amount it asks (rate_num = the price, rate_den = the amount)`);
  }
  return p / BigInt(rateDen);
}

// The order a relay served, as fillRestingOrder takes it: its id, operator and
// locator, its terms (display asset ids, decimal amounts).
export function servedOrder(o) {
  const t = o && (o.resting_leaf || o.restingLeaf);
  if (!t) throw new Error('order must be the relay’s offer of an order resting in the operator’s tree (its resting_leaf terms)');
  const id = String(t.order_id ?? t.orderId ?? '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('the order’s order_id must be a 64-hex leaf id');
  return {
    order: id, operator_key: String(t.operator_key ?? t.operatorKey ?? '').toLowerCase(),
    operator_url: t.operator_url ?? t.operatorUrl ?? null,
    coin: String(t.coin ?? '').toLowerCase(), value: String(t.value ?? '0'),
    asset_a: String(t.asset_a ?? t.assetA ?? ''), asset_b: String(t.asset_b ?? t.assetB ?? ''),
    offer_id: o.offer_id ?? o.offerId ?? null, maker_pubkey: o.maker_pubkey ?? o.makerPubkey ?? null,
  };
}

// ---- resting ----

export async function rest(origin, args, quote) {
  const r = await leaves.run('order_rest', { ...args, shown: quote });
  const offerId = hex(crypto.getRandomValues(new Uint8Array(16)));
  await remember({ rested_by: r.order, order: null, origin, offer_id: offerId, amount: String(r.amount),
    rate_num: String(args.rate_num), rate_den: String(args.rate_den), at: Date.now() });
  await watch().catch((e) => console.warn('[leaves] resting order not watched:', e.message));
  return { ...r, offer_id: offerId };
}

// The participations of resting orders whose forfeits the wallet has yet to hand over:
// the host syncs for them as it does for takes.
export async function participationsToWatch() {
  return (await records()).filter((r) => !r.order && !r.cancelled && !r.not_rested).map((r) => r.rested_by);
}

let watchHook = null;
// The take watcher (leaf-trade.js) asks for these through its hook, so the host gets
// one list of participations to sync for.
export function setWatchHook(fn) { watchHook = fn; }
async function watch() { if (watchHook) await watchHook(); }

// The key a resting order's offer is signed with: one per order, from the wallet's
// phrase, so the relay cannot link two orders of one wallet by their key.
async function offerKey(restedBy) {
  const phrase = await sessionMnemonic();
  if (!phrase) throw new Error('the wallet is locked');
  const tag = new TextEncoder().encode('sequentia/leaf-resting-offer-key/');
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array([...tag, ...new TextEncoder().encode(phrase.trim() + '/' + restedBy)]));
  return new Uint8Array(d);
}

// The relay's offer of a resting order, from the operator's view of it (`served`, an
// `order_resting` other) and the record of what the wallet rested.
export function offerFor(rec, served, op, nowUnix, marginSecs) {
  const t = served.terms || {};
  const amount = BigInt(rec.amount);
  const want = wholePrice(amount, t.rate_num, t.rate_den);
  const refundBy = Number(t.expiry) - (marginSecs || 6 * 3600);
  const exitBy = served.expiry != null ? Number(served.expiry) - EXIT_DEADLINE : Infinity;
  const delist = Math.min(refundBy, exitBy);
  const expires = Math.min(nowUnix + MAX_LISTING - 60, delist);
  if (expires <= nowUnix + 60) throw new Error('the order is at its delist time: the operator fills it no more');
  return {
    offer_id: rec.offer_id, schema_version: 1,
    pair: { base_asset: served.asset, quote_asset: t.asset_b },
    trade_dir: 'TRADE_DIR_SELL',
    base_amount: amount.toString(), offer_amount: amount.toString(), offer_asset: served.asset,
    want_amount: want.toString(), want_asset: t.asset_b,
    allow_partial: true, min_fill: String(t.min_lot),
    created_at_unix: String(nowUnix), expires_at_unix: String(expires),
    resting_leaf: {
      operator_url: op.server, operator_key: op.operator, order_id: served.order,
      asset_a: served.asset, asset_b: t.asset_b, rate_num: String(t.rate_num), rate_den: String(t.rate_den),
      min_lot: String(t.min_lot), landed_maker: t.maker, landed_expiry: Number(t.expiry), refund_key: t.refund_key,
      coin: served.coin, value: String(served.value),
    },
  };
}

// Whether a resting order must be posted (again) now: it rests at the operator, and the
// relay has no live listing of it from this wallet.
export function postDue(rec, served, nowUnix) {
  if (!served || served.state !== 'resting') return false;
  if (!rec.posted_at) return true;
  return !!rec.relay_expires && Number(rec.relay_expires) - nowUnix < 3600 && !rec.cancelled;
}

// After every sync: each resting order that rests at the operator and is not listed is
// posted. Runs in either mode: an order rested in developer mode stays listed.
let progressing = null;
export function progressResting() {
  if (!progressing) progressing = run().finally(() => { progressing = null; });
  return progressing;
  async function run() {
    const recs = (await records()).filter((r) => !r.cancelled);
    if (!recs.length) return;
    let view = await leaves.runAny('order_resting', {});
    // The order ids (once published) the operator's view is asked for. A
    // participation that published its order, or ended without one, is no longer
    // watched.
    let watched = false;
    for (const r of recs) {
      const mine = (view.orders || []).find((o) => o.rested_by === r.rested_by);
      if (mine && mine.order && r.order !== mine.order) { await update(r.rested_by, { order: mine.order }); watched = true; }
      if (mine && mine.state === 'not_rested' && !r.not_rested) { await update(r.rested_by, { not_rested: true }); watched = true; }
    }
    if (watched) await watch().catch(() => {});
    const fresh = await records();
    const ids = fresh.filter((r) => r.order && !r.cancelled).map((r) => r.order);
    if (!ids.length) return;
    view = await leaves.runAny('order_resting', { orders: ids });
    const info = await leaves.runAny('info');
    const op = { server: info.server, operator: info.operator };
    const margin = Number(((info.server_info || {}).fills || {}).order_margin_seconds || 0);
    const now = Math.floor(Date.now() / 1000);
    for (const rec of fresh) {
      if (!rec.order || rec.cancelled) continue;
      const served = (view.others || []).find((o) => o.order === rec.order);
      if (!postDue(rec, served, now)) continue;
      try {
        const priv = await offerKey(rec.rested_by);
        const offer = offerFor(rec, served, op, now, margin);
        seqob.setSeqobBase(RELAY);
        await seqob.postRestingOffer(offer, priv);
        await update(rec.rested_by, { posted_at: now, posted_coin: served.coin, relay_expires: Number(offer.expires_at_unix),
          maker_pubkey: hex(secp256k1.getPublicKey(priv, true)), post_error: null });
        console.info(`[leaves] resting order ${rec.order.slice(0, 12)}… listed at the relay, resting at ${served.coin.slice(0, 12)}…`);
      } catch (e) {
        const m = String((e && e.message) || e);
        if (/already resting|already listed/i.test(m)) {
          await update(rec.rested_by, { posted_at: rec.posted_at || now, posted_coin: served.coin, post_error: null });
          continue;
        }
        await update(rec.rested_by, { post_error: m });
        console.warn(`[leaves] resting order ${rec.order.slice(0, 12)}… not listed yet: ${m}`);
      }
    }
  }
}

// The resting orders a site rested from this wallet, as the library and its operator
// show them: where each rests, what it holds, its fills, and the credits the wallet
// holds of it.
export async function forOrigin(origin) {
  const recs = (await records()).filter((r) => r.origin === origin);
  if (!recs.length) return [];
  const ids = recs.filter((r) => r.order).map((r) => r.order);
  const view = await leaves.run('order_resting', ids.length ? { orders: ids } : {});
  return recs.map((rec) => {
    const mine = (view.orders || []).find((o) => o.rested_by === rec.rested_by) || null;
    const op = (mine && mine.operator) || null;
    return {
      order: (mine && mine.order) || rec.order || null, rested_by: rec.rested_by, offer_id: rec.offer_id, at: rec.at,
      amount: rec.amount, state: op ? op.state : (mine ? mine.state : null),
      coin: op ? op.coin : null, holds: op ? op.value : null, fills_left: op ? op.fills_left : null,
      fills: (op && op.fills) || [], credits: (mine && mine.credits) || [],
      listed: rec.posted_at ? { at: rec.posted_at, coin: rec.posted_coin, relay_expires: rec.relay_expires, maker_pubkey: rec.maker_pubkey } : null,
      post_error: rec.post_error || null,
    };
  });
}

// ---- filling ----

export async function fillQuote(served, amount) {
  const args = { order: served.order };
  if (amount != null) args.amount = String(amount);
  return await leaves.run('order_fill_resting_quote', args);
}

// The fill, as the window showed `quote`. If the operator answers that the order has
// moved, one new quote at the coin it rests at now is taken when it fills the same
// amount at the same price for no more fee; otherwise the refusal stands.
export async function fill(served, amount, quote) {
  const args = { order: served.order };
  if (amount != null) args.amount = String(amount);
  try {
    const r = await leaves.run('order_fill_resting', { ...args, shown: quote });
    return { ...r, coin: quote.coin };
  } catch (e) {
    if (!e || e.code !== 'order_moved') throw e;
    const again = await leaves.run('order_fill_resting_quote', args);
    const same = again.filled === quote.filled && again.paid === quote.paid
      && (again.fee || {}).asset === (quote.fee || {}).asset && BigInt((again.fee || {}).amount || 0) <= BigInt((quote.fee || {}).amount || 0);
    if (!same) {
      throw new Error(`the order moved to coin ${again.coin} before this fill went in, and filling it there now takes ${again.filled} for ${again.paid} and a fee of ${(again.fee || {}).amount}: ask again`);
    }
    console.info(`[leaves] resting order ${served.order.slice(0, 12)}… moved from ${quote.coin.slice(0, 12)}… to ${again.coin.slice(0, 12)}… (order_moved): filled there`);
    const r = await leaves.run('order_fill_resting', { ...args, shown: again });
    return { ...r, coin: again.coin, moved_from: quote.coin, refused_first: e.message };
  }
}

// ---- cancelling ----

export async function recordFor(origin, order) {
  const r = (await records()).find((x) => x.order === order || x.rested_by === order);
  if (!r || r.origin !== origin) throw new Error('this site rested no order ' + order + ' from this wallet');
  return r;
}

export async function cancel(rec, quote) {
  const order = rec.order || rec.rested_by;
  const r = await leaves.run('order_cancel_resting', { order, shown: quote });
  await update(rec.rested_by, { cancelled: Date.now() });
  // The relay delists the order once its operator says it is cancelled; the signed
  // cancel takes it out at once.
  if (rec.posted_at) {
    try {
      seqob.setSeqobBase(RELAY);
      await seqob.signAndCancel(rec.offer_id, await offerKey(rec.rested_by), Math.floor(Date.now() / 1000));
    } catch (e) { console.warn('[leaves] the relay did not take the cancel (it delists the order from the operator’s view):', e.message); }
  }
  return r;
}
