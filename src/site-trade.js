// A site's market and limit orders in user mode, settled the way the popup's Trade tab
// settles a trade: the web wallet's user composer engine (vendor/user-trade.js) behind its
// site adapter (vendor/site-orders.js), run here in the service worker. In user mode the
// wallet's coins are boarded into the operator's tree within a minute, so this is how a site
// sees and trades them: getBalances counts the leaves, and placeOrder takes from them.
//
// The engine asks the leaf library through `leaves.runUser` (the popup's `default.leaf`), BTC
// over the Bitcoin ark's Lightning (`default.ark`), and reads the relay, the makers and the
// chain as the popup does. Its records are kept in chrome.storage under `ext.siteTrade`. An
// order that rests is placed from leaves and listed on the relay by leaf-trade.js's listing,
// which runs after every sync of the leaf wallet in either mode.

import { createEngine } from '../vendor/user-trade.js';
import { makeSiteOrders } from '../vendor/site-orders.js';
import * as seqob from '../vendor/seqob.js';
import * as leaves from './leaves.js';
import * as R from './leaf-orders.js';
import * as A from './assets.js';
import * as dm from './default-mode.js';
import { BASE, ESPLORA, USER_PAIRS_URL, LEAF_MAKERS } from './config.js';
import { stGet, stSet, fmtAtoms } from './util.js';
import { walletTag } from './mode.js';

const STORE_KEY = 'ext.siteTrade';
const READ_TIMEOUT_MS = 20_000;
const RELAY = BASE + '/seqob';

// A synchronous store over chrome.storage, as the engine reads and writes it: loaded once,
// each write kept in memory and saved in order.
let mem = null, saving = Promise.resolve();
async function store() {
  if (!mem) mem = (await stGet('local', STORE_KEY)) || {};
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); const snap = { ...mem }; saving = saving.then(() => stSet('local', STORE_KEY, snap)).catch(() => {}); },
  };
}

async function fetchJson(url, init) {
  const r = await fetch(url, init ? { ...init, headers: { 'content-type': 'application/json' } } : { cache: 'no-store', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function relayPairBook(base, quote) {
  const get = async (b, q) => {
    const r = await fetch(`${RELAY}/v1/market/${b}/${q}/orderbook`, { cache: 'no-store', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.offers || []).map((o, i) => { const raw = JSON.parse(JSON.stringify(o)); seqob.normRelayOffer(o); return { ...o, _verified: seqob.verifyOffer(o), _relayJson: raw, _status: (j.statuses || [])[i] || null }; });
  };
  const [a, b] = await Promise.all([get(base, quote), get(quote, base).catch(() => [])]);
  const seen = new Set();
  return [...a, ...b].filter((o) => { const k = (o.maker_pubkey || '') + ':' + (o.offer_id || ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

let pairs = null, pairsAt = 0, genesis = null, arkUp = false;
const arkBtc = new Proxy({}, { get: (_, method) => (arg) => dm.arkLightning(String(method), arg) });

let S = null;
async function siteOrders() {
  if (S) return S;
  const st = await store();
  const tag = await walletTag();
  const engine = createEngine({
    leaves: { command: (cmd, args) => leaves.runUser(String(cmd), args || {}) },
    fetchJson,
    makers: () => LEAF_MAKERS,
    relayBook: (pay, receive) => relayPairBook(receive, pay),
    relayFills: async (pay, receive) => {
      const get = async (b, q) => { const r = await fetch(`${RELAY}/v1/market/${b}/${q}/fills?limit=500`, { cache: 'no-store' }); return r.ok ? ((await r.json()).fills || []) : []; };
      const [a, b] = await Promise.all([get(receive, pay).catch(() => []), get(pay, receive).catch(() => [])]);
      return [...a, ...b];
    },
    outputValue: async (txid, vout) => {
      const r = await fetch(`${ESPLORA}/tx/${txid}`, { cache: 'no-store' }); if (!r.ok) return null;
      const o = ((await r.json()).vout || [])[vout]; return o && o.value != null ? String(o.value) : null;
    },
    admitted: async () => {
      if (!pairs || Date.now() - pairsAt > 300_000) { try { pairs = await (await fetch(USER_PAIRS_URL, { cache: 'no-store' })).json(); pairsAt = Date.now(); } catch { pairs = pairs || { chains: {} }; } }
      if (!genesis) { try { genesis = (await leaves.runAny('info')).genesis_hash; } catch {} }
      return { pairs, genesis };
    },
    get btc() { return arkUp ? arkBtc : null; },
    onchain: null,
    store: st, tag: () => tag || 'default',
    log: (...a) => console.log(...a),
  });
  const orders = makeSiteOrders({
    engine, store: st, tag: () => tag || 'default',
    leaves: { command: (cmd, args) => leaves.runUser(String(cmd), args || {}) },
    assetMeta: (h) => A.assetMeta(h),
    fmtAtoms: (atoms, p) => fmtAtoms(atoms, p),
    log: (...a) => console.log(...a),
  });
  S = { engine, orders, tag };
  return S;
}
// Another wallet opened (or this one removed): its records are another's.
export async function reset() { S = null; mem = null; genesis = null; }

async function fresh() {
  const s = await siteOrders();
  if (s.tag !== (await walletTag())) { await reset(); return await siteOrders(); }
  try { arkUp = await dm.arkIsOpen(); } catch { arkUp = false; }
  return s;
}

// -> { id, display } for the approval window.
export async function quote(params, origin) { return await (await fresh()).orders.quote(params, origin); }
export async function drop(id) { if (S) S.orders.drop(id); }
// Settles an approved order; an order that rests is handed to the listing of orders placed
// from leaves (leaf-trade.js progressOrders), which posts it once it rests.
export async function confirm(id, origin) {
  const s = await fresh();
  const r = await s.orders.confirm(id);
  if (r.order) {
    const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    await R.rememberOrder({ order: r.order, origin, offer_id: hex(crypto.getRandomValues(new Uint8Array(16))), amount: null, at: Date.now() });
  }
  return r;
}
export async function orders(origin) {
  const s = await fresh();
  s.orders.follow().catch(() => {});
  return await s.orders.orders(origin);
}
export async function quoteCancel(params, origin) { return await (await fresh()).orders.quoteCancel(params, origin); }
export async function confirmCancel(id) { return await (await fresh()).orders.confirmCancel(id); }
// Moves open site trades on (called after each leaf sync and on the minute alarm).
export async function follow() { if (S) await S.orders.follow().catch(() => {}); }

// What of each Sequentia asset the wallet holds as leaves and can spend now, as the leaf host
// last reported it (getBalances' `leaves`).
export async function leafBalances() {
  const sum = await leaves.leafSum().catch(() => null);
  const out = {};
  if (!sum || !sum.perAsset) return out;
  for (const [a, v] of Object.entries(sum.perAsset)) {
    const n = BigInt(v || 0) - BigInt((sum.arriving || {})[a] || 0);
    if (n > 0n) out[a] = n.toString();
  }
  return out;
}

// getBalances' one figure per asset wherever it is held (`total`: the chain, leaves and
// Lightning; for BTC the chain, the Bitcoin ark and Lightning), what of it is arriving (held, not
// spendable yet), and, in developer mode, where each part is (`by_place`). Read from what the
// popup's figures read: the leaf host's last report, the ark's, Lightning's cached summary.
export async function figures(bal, developer) {
  const sum = (await leaves.leafSum().catch(() => null)) || {};
  const leafPer = sum.perAsset || {};
  const ark = (await dm.arkSum().catch(() => null)) || null;
  const lnKept = await stGet('local', 'ext.lnSum').catch(() => null);
  const lnPer = (lnKept && lnKept.v && lnKept.v.perKind) || {};
  const keys = new Set(['BTC', ...Object.keys(bal.seq || {}), ...Object.keys(leafPer), ...Object.keys(lnPer)]);
  const total = {}, arriving = {}, byPlace = {};
  for (const k of keys) {
    const chain = BigInt(k === 'BTC' ? (bal.btc || 0) : ((bal.seq || {})[k] || 0));
    const lv = k === 'BTC' ? 0n : BigInt(leafPer[k] || 0);
    const ln = BigInt((lnPer[k] && lnPer[k].units) || 0);
    const ak = k === 'BTC' && ark ? BigInt(ark.total || 0) : 0n;
    const t = chain + lv + ln + ak;
    if (t <= 0n && k !== 'BTC') continue;
    total[k] = t.toString();
    const arr = k === 'BTC' ? BigInt((ark && ark.arriving) || 0) : BigInt((sum.arriving || {})[k] || 0);
    if (arr > 0n) arriving[k] = arr.toString();
    if (developer) byPlace[k] = { chain: chain.toString(), leaves: lv.toString(), lightning: ln.toString(), ark: ak.toString() };
  }
  return developer ? { total, arriving, by_place: byPlace } : { total, arriving };
}
