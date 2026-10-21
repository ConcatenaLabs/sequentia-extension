// The records of a site's trades and resting orders (`placeOrder`, `getOrders`,
// `cancelOrder`), kept for each wallet in chrome.storage.local by the wallet's tag.
//
// A trade record is what the wallet took from the book in one approval: the orders it
// filled (each a transaction), and for a trade against BTC the job that settled it.
// An order record is a resting order the wallet placed with what a limit order did not
// fill: everything needed to post it to the relay and to take it back after its time
// runs out, written BEFORE its funding is broadcast, so a worker that dies in between
// never strands the coins (the outpoint is found again by its script).
//
// Where a fill or an order stands is never kept here: it is read from the relay's
// records of the chain each time.

import { stGet, stSet } from './util.js';
import { walletTag } from './mode.js';

const TRADES_KEY = 'ext.market.trades';   // { [walletTag]: [trade record] }
const ORDERS_KEY = 'ext.market.orders';   // { [walletTag]: [order record] }

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

export async function tradeRecords() { return (await readAll(TRADES_KEY)).list; }
export async function rememberTrade(rec) {
  const { tag, all, list } = await readAll(TRADES_KEY);
  if (!tag) throw new Error('open the wallet first');
  await writeList(TRADES_KEY, tag, all, [...list.filter((r) => r.id !== rec.id), rec]);
}
export async function updateTrade(id, patch) {
  const { tag, all, list } = await readAll(TRADES_KEY);
  if (!tag) return;
  await writeList(TRADES_KEY, tag, all, list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export async function orderRecords() { return (await readAll(ORDERS_KEY)).list; }
export async function rememberOrder(rec) {
  const { tag, all, list } = await readAll(ORDERS_KEY);
  if (!tag) throw new Error('open the wallet first');
  await writeList(ORDERS_KEY, tag, all, [...list.filter((r) => r.id !== rec.id), rec]);
}
export async function updateOrder(id, patch) {
  const { tag, all, list } = await readAll(ORDERS_KEY);
  if (!tag) return;
  await writeList(ORDERS_KEY, tag, all, list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

// The next index of the taproot payout an order's maker credit is paid to: one per
// order, never reused, so two orders' credits never share an address.
export function nextMakerIndex(records) {
  let mx = -1;
  for (const r of records || []) if (Number.isInteger(r.maker_index) && r.maker_index > mx) mx = r.maker_index;
  return mx + 1;
}

// Whether an order record must be posted to the relay now: its coin is on the chain
// (funded, the outpoint known), it was never listed, and nothing ended it.
export function postDue(rec) {
  return !!rec && !!rec.txid && rec.vout != null && !rec.posted_at && !rec.withdrawn_txid;
}

// The relay's answer to a post of an offer it already lists.
export function alreadyListed(message) {
  return /already resting/i.test(String(message || ''));
}
// The relay's answer for an order whose funding is not in a block yet.
export function fundingNotYetSeen(message) {
  return /not an unspent output at the tip|liveness|not found/i.test(String(message || ''));
}
