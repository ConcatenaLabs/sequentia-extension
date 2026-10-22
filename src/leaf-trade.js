// The service worker's side of takes and orders made from leaves (developer mode):
// the library's commands behind the provider's `takeOrder` and `placeOrderFromLeaves`,
// the records that carry each one across a restart (src/leaf-orders.js), and the
// work the wallet does for them with no window open:
//
//  - a take: the offscreen host is told which takes to watch, and syncs every few
//    seconds while one waits on the wallet, so its forfeits go in as soon as the
//    operator builds the round; the host reports each change of a take (`leafTake`);
//  - an order: after every sync, an order the library says rests on the chain is
//    posted to the relay as it rests (`postExisting`), and posted again before the
//    relay's listing runs out while it still rests.
//
// Both carry on after the popup closes, and after the browser restarts once the
// wallet is unlocked again: the records are in chrome.storage.local, the coins and
// the take in the library's own store.

import * as leaves from './leaves.js';
import * as R from './leaf-orders.js';
import * as leafResting from './leaf-resting.js';
import { postExisting, orderFromCovenantTerms } from '../vendor/covenant-order.js';
import * as seqob from '../vendor/seqob.js';
import { secp256k1 } from '../vendor/btc.js';
import { BASE, ESPLORA } from './config.js';
import { sessionMnemonic } from './vault.js';

// The on-chain order book an order from leaves is posted to: the relay of the site's
// on-chain room (the same mount dexFillOnchain reads).
export const RELAY = BASE + '/seqob';

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// The operator joined, as a site's room names it: its key, its server, the assets it
// serves with their fees, and how long it waits for a take's forfeits.
export async function operator() {
  // The library's `info` carries the server's own view under `server_info`.
  const info = await leaves.run('info');
  const srv = (info && info.server_info) || {};
  return {
    operator: info.operator || null,
    server: info.server || null,
    genesis_hash: info.genesis_hash || null,
    assets: srv.assets || null,
    fills: srv.fills || null,
    forfeit_window_seconds: (srv.fills && srv.fills.forfeit_window_seconds) ?? null,
  };
}

// ---- takes ----

// Tells the offscreen host which takes still need the wallet. Runs in either mode: a
// take made in developer mode must finish whatever the mode is now.
// The participations of resting orders (src/leaf-resting.js) wait on the wallet's
// forfeits in the same way, and are watched with the takes.
leafResting.setWatchHook(() => watchTakes());
export async function watchTakes() {
  const recs = await R.takeRecords();
  const resting = await leafResting.participationsToWatch().catch(() => []);
  if (!recs.length && !resting.length) return [];
  const parts = recs.length ? await leaves.runAny('participations') : [];
  const ids = [...R.takesToWatch(recs, parts), ...resting];
  await leaves.hostOp('watch', { takes: ids, tickMs: R.TAKE_TICK_MS });
  return ids;
}

export async function take(origin, served, args, quote, window) {
  const r = await leaves.run('take', { ...args, shown: quote });
  const pair = served.pair || null;
  await R.rememberTake({
    take: r.take, origin, order: r.order, offer_id: served.offer_id || null, pair,
    asset_a: r.asset_a, asset_b: r.asset_b, filled: r.filled, price: r.price, fee: r.fee, remainder: r.remainder,
    forfeit_window_seconds: window, at: Date.now(),
  });
  await watchTakes().catch((e) => console.warn('[leaves] could not watch the take:', e.message));
  return r;
}

export async function takesFor(origin) {
  const recs = (await R.takeRecords()).filter((r) => r.origin === origin);
  if (!recs.length) return [];
  const parts = await leaves.run('participations');
  return recs.map((r) => R.takeAnswer(r, R.participationOf(parts, r.take)));
}

// A change of a take, from the host: the answer for the site that made it.
export async function takeChanged(data) {
  const recs = await R.takeRecords();
  const rec = recs.find((r) => r.take === data.take);
  if (!rec) return null;
  return { origin: rec.origin, answer: R.takeAnswer(rec, data.participation) };
}

// ---- orders placed from leaves ----

export async function place(origin, args, quote) {
  const r = await leaves.run('order_place', { ...args, shown: quote });
  const offerId = hex(crypto.getRandomValues(new Uint8Array(16)));
  await R.rememberOrder({ order: r.order, origin, offer_id: offerId, amount: r.amount, at: Date.now() });
  return { ...r, offer_id: offerId };
}

export async function ordersFor(origin) {
  const recs = (await R.orderRecords()).filter((r) => r.origin === origin);
  if (!recs.length) return [];
  const all = await leaves.run('orders');
  return recs.map((rec) => {
    const o = (all || []).find((x) => x.order === rec.order) || null;
    return {
      order: rec.order, offer_id: rec.offer_id, at: rec.at,
      state: o ? o.state : null, rests_at: (o && o.rests_at) || null, holds: (o && o.holds) || null,
      terms: (o && o.terms) || null, fills: (o && o.fills) || [], credits: (o && o.credits) || [],
      refund_from: (o && o.refund_from) ?? null, note: (o && o.note) || null,
      posted: rec.posted_at ? { at: rec.posted_at, outpoint: rec.posted_outpoint, relay_expires: rec.relay_expires, maker_pubkey: rec.maker_pubkey } : null,
      post_error: rec.post_error || null,
    };
  });
}

// The relay's byte fields arrive base64 in its JSON; the wallet's covenant code wants
// hex. A value already in hex (64 characters) is left as it is.
function bytesField(v) {
  if (typeof v !== 'string' || /^[0-9a-f]{64}$/i.test(v)) return v;
  const bin = atob(v);
  let s = '';
  for (let i = 0; i < bin.length; i++) s += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return s;
}
function normTerms(ct) {
  for (const k of ['maker_prog', 'maker_x', 'internal_key']) if (ct[k] != null) ct[k] = bytesField(ct[k]);
  if (Array.isArray(ct.merkle_path)) ct.merkle_path = ct.merkle_path.map(bytesField);
  return ct;
}

// The key an order's offer is signed with: one per order, from the wallet's phrase, so
// the relay cannot link two orders of one wallet by their key.
async function orderKey(orderId) {
  const phrase = await sessionMnemonic();
  if (!phrase) throw new Error('the wallet is locked');
  const tag = new TextEncoder().encode('sequentia/leaf-order-offer-key/');
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array([...tag, ...new TextEncoder().encode(phrase.trim() + '/' + orderId)]));
  return new Uint8Array(d);
}

async function fetchOutput(txid, vout) {
  const r = await fetch(`${ESPLORA}/tx/${txid}`);
  if (!r.ok) return null;
  const tx = await r.json();
  const o = tx.vout && tx.vout[vout];
  if (!o) return null;
  return { scriptPubKey: o.scriptpubkey, asset: o.asset ?? null, value: o.value ?? null };
}

// After every sync: each order of this wallet that rests and is not listed is posted.
let progressing = null;
export function progressOrders() {
  if (!progressing) progressing = run().finally(() => { progressing = null; });
  return progressing;
  async function run() {
    const recs = await R.orderRecords();
    if (!recs.length) return;
    const all = await leaves.runAny('orders');
    const now = Math.floor(Date.now() / 1000);
    // The operator takes an order only while its refund lies more than its margin
    // ahead: the listing ends there.
    let margin = 0;
    try { margin = Number(((await leaves.runAny('info')).server_info || {}).fills?.order_margin_seconds || 0); } catch { /* none known */ }
    for (const rec of recs) {
      const o = (all || []).find((x) => x.order === rec.order);
      if (!R.postDue(o, rec, now)) continue;
      try {
        const p = R.postParams(o, rec, normTerms, orderFromCovenantTerms);
        const priv = await orderKey(rec.order);
        const pub = hex(secp256k1.getPublicKey(priv, true));
        seqob.setSeqobBase(RELAY);
        const res = await postExisting({ ...p, nowUnix: now, ttlSecs: R.offerTtl(now, p.expiryLocktime - margin), makerPubkey: pub },
          { fetchOutput, postCovenantOffer: (offer) => seqob.postCovenantOffer(offer, priv) });
        await R.updateOrder(rec.order, { posted_at: now, posted_outpoint: o.rests_at, relay_expires: Number(res.offer.expires_at_unix), maker_pubkey: pub, post_error: null });
        console.info(`[leaves] order ${rec.order.slice(0, 12)}… posted to the relay at ${o.rests_at}`);
      } catch (e) {
        if (R.alreadyListed(e && e.message)) {
          await R.updateOrder(rec.order, { posted_at: rec.posted_at || now, posted_outpoint: o.rests_at, post_error: null });
          continue;
        }
        await R.updateOrder(rec.order, { post_error: String((e && e.message) || e) });
        console.warn(`[leaves] order ${rec.order.slice(0, 12)}… not posted yet: ${(e && e.message) || e}`);
      }
    }
  }
}
