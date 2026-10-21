// Takes and orders made from leaves, for a site's on-chain order book (developer mode).
//
// A take fills an on-chain order from the wallet's leaves through the operator's round:
// the library's `take` gives up a coin worth the price and the operator's fee, and once
// the operator has built the round that fills the order, a `sync` hands over the
// forfeit of that coin. The operator broadcasts the round only when every take in it
// has handed its forfeits over, within its forfeit window; a take whose forfeits do not
// come in time is voided and its coins are the wallet's again. A later `sync`, once the
// round is final, takes the new leaf. The offscreen host syncs every few seconds while
// a take it watches waits on the wallet (`TAKE_TICK_MS`), so the forfeits go in as soon
// as the round is built, whether or not any window of the extension is open.
//
// An order placed from leaves is an ordinary on-chain order: the library's
// `order_place` offboards exactly its amount into the address its terms make, through
// the operator's round, and the order rests there once the round is final and the
// operator (or, after a grace, the wallet) unlocks it. The wallet then posts it to the
// relay as it rests (`postExisting`), signed with a key of its own for that order.
//
// The records kept here (chrome.storage.local, per wallet) are what the wallet needs to
// carry each one on after a restart, and what it tells the site that made it. Where a
// take or an order stands is never kept: it is read from the library each time.
// Nothing about a take or an order is decided in this file; the library checks every
// order on its own node and prices every fill by the covenant's arithmetic.

import { stGet, stSet } from './util.js';
import { walletTag } from './mode.js';

const TAKES_KEY = 'ext.leaves.takes';     // { [walletTag]: [take record] }
const ORDERS_KEY = 'ext.leaves.orders';   // { [walletTag]: [order record] }

// How often the host syncs while a take waits on the wallet (its forfeits not yet in).
export const TAKE_TICK_MS = 3000;

// The library's participation states a take passes through, and those it ends in.
const TAKE_DONE = new Set(['released', 'void', 'expired', 'refused', 'withdrawn']);
const TAKE_WAITS_ON_WALLET = new Set(['pending', 'issued']);

// Where a take stands, from the library's participation (`participations`), in the
// words a site shows. `stage` is one of:
//   submitted          the operator holds the take; no round fills it yet
//   handing-over       the operator built the round; the wallet hands over its forfeits
//   forfeits-in        the forfeits are in; the round goes out once every take's are
//   released           the round is final and the wallet holds the new leaf
//   void               the take did not happen (its forfeits did not come in time, or
//                      the round was lost): the coins given up are the wallet's again
// A site learns whether the round is in a block, final or undone from its relay's fill
// record of the round (the relay watches the chain and its Bitcoin anchor).
export function takeStage(p) {
  if (!p) return { stage: 'unknown', done: false };
  const s = String(p.state || '');
  if (p.released || s === 'released') return { stage: 'released', done: true };
  if (s === 'void' || s === 'expired' || s === 'refused' || s === 'withdrawn') return { stage: 'void', done: true };
  if (s === 'forfeiting') return { stage: 'forfeits-in', done: false };
  if (s === 'issued') return { stage: 'handing-over', done: false };
  return { stage: 'submitted', done: false };
}

// Whether a take still needs the wallet: its forfeits not yet handed over.
export function takeWaitsOnWallet(p) {
  return !!p && !p.released && TAKE_WAITS_ON_WALLET.has(String(p.state || ''));
}
export function takeDone(p) {
  return !!p && (!!p.released || TAKE_DONE.has(String(p.state || '')));
}

// The library's participation of take `id`, from its `participations` answer.
export function participationOf(parts, id) {
  return (parts || []).find((p) => p.participation === id) || null;
}

// A take as getLeafTakes answers it: the record and where the library says it stands.
export function takeAnswer(rec, p) {
  const st = takeStage(p);
  const leaf = p && (p.new_leaves || [])[0];
  return {
    take: rec.take,
    stage: st.stage,
    state: p ? p.state : null,
    round: (p && p.round) || null,
    order: rec.order,
    offer_id: rec.offer_id || null,
    pair: rec.pair || null,
    asset_a: rec.asset_a, asset_b: rec.asset_b,
    filled: rec.filled, price: rec.price, fee: rec.fee, remainder: rec.remainder ?? null,
    leaf: leaf ? { leaf_id: leaf.leaf_id || null, asset: leaf.asset, value: String(leaf.value ?? ''), state: leaf.state || null } : null,
    forfeit_window_seconds: rec.forfeit_window_seconds ?? null,
    at: rec.at,
  };
}

// ---- the records ----
async function readAll(key) {
  const tag = await walletTag();
  if (!tag) return { tag: null, all: {}, list: [] };
  const all = (await stGet('local', key)) || {};
  return { tag, all, list: Array.isArray(all[tag]) ? all[tag] : [] };
}
async function writeList(key, tag, all, list) {
  all[tag] = list;
  await stSet('local', key, all);
}

export async function takeRecords() { return (await readAll(TAKES_KEY)).list; }
export async function rememberTake(rec) {
  const { tag, all, list } = await readAll(TAKES_KEY);
  if (!tag) throw new Error('open the wallet first');
  await writeList(TAKES_KEY, tag, all, [...list.filter((r) => r.take !== rec.take), rec]);
}
export async function updateTake(id, patch) {
  const { tag, all, list } = await readAll(TAKES_KEY);
  if (!tag) return;
  await writeList(TAKES_KEY, tag, all, list.map((r) => (r.take === id ? { ...r, ...patch } : r)));
}

export async function orderRecords() { return (await readAll(ORDERS_KEY)).list; }
export async function rememberOrder(rec) {
  const { tag, all, list } = await readAll(ORDERS_KEY);
  if (!tag) throw new Error('open the wallet first');
  await writeList(ORDERS_KEY, tag, all, [...list.filter((r) => r.order !== rec.order), rec]);
}
export async function updateOrder(id, patch) {
  const { tag, all, list } = await readAll(ORDERS_KEY);
  if (!tag) return;
  await writeList(ORDERS_KEY, tag, all, list.map((r) => (r.order === id ? { ...r, ...patch } : r)));
}

// The takes the host must watch: those whose forfeits the wallet has yet to hand over,
// or whose leaf it has yet to take.
export function takesToWatch(records, parts) {
  const out = [];
  for (const r of records || []) {
    const p = participationOf(parts, r.take);
    if (!takeDone(p)) out.push(r.take);
  }
  return out;
}

// ---- an order placed from leaves, posted once it rests ----

// The relay's offer for an order the library says rests (`orders`, state `resting`,
// with its terms as the relay serves them in `relay`), as postExisting wants it.
// `normTerms` turns the relay's byte fields (base64 in its JSON) into hex.
export function postParams(o, rec, normTerms, orderFromTerms) {
  if (!o || o.state !== 'resting' || !o.relay || !o.rests_at) return null;
  const ct = normTerms(JSON.parse(JSON.stringify(o.relay)));
  const order = orderFromTerms(ct);
  const [txid, vout] = String(o.rests_at).split(':');
  return {
    assetA: order.assetA, assetB: order.assetB,
    sellAtoms: BigInt(o.holds), rateNum: order.rateNum, rateDen: order.rateDen, minLot: order.minLot,
    expiryLocktime: order.expiryLocktime, makerProg: order.makerProg, makerX: order.makerX,
    ...(order.internalKey ? { internalKey: order.internalKey } : {}),
    txid, vout: Number(vout), offerId: rec.offer_id,
  };
}

// How long the relay lists the offer: until the order's REFUND opens (a median time,
// which the order's own clock reads) but no longer than the relay takes (`maxSecs`),
// less a minute either way. The wallet posts it again before that runs out while the
// order still rests.
export function offerTtl(nowUnix, expiryLocktime, maxSecs = 7 * 86400) {
  const untilRefund = Number(expiryLocktime) >= 500000000 ? Number(expiryLocktime) - nowUnix - 60 : maxSecs;
  return Math.max(60, Math.min(maxSecs - 60, untilRefund));
}

// Whether an order record must be posted (again) now: it rests, and the relay has no
// live listing of it from this wallet (never posted, or within an hour of the
// listing's expiry). After a partial fill the order rests at a new outpoint, and the
// relay moves its listing there itself (the outpoint is outside the signed offer), so
// a move is no reason to post again.
export function postDue(o, rec, nowUnix) {
  if (!o || o.state !== 'resting' || !o.rests_at) return false;
  if (!rec.posted_at) return true;
  return !!rec.relay_expires && Number(rec.relay_expires) - nowUnix < 3600;
}

// The relay's answer to a post of an offer it already lists (the same maker key and
// offer id, resting): the order is listed, and that is all the post wanted.
export function alreadyListed(message) {
  return /already resting/i.test(String(message || ''));
}
