// An in-tree swap between two wallets that hold leaves of one operator (developer
// mode): the provider's leafSwapOffer, leafSwapAccept, leafSwapComplete, getLeafSwaps and
// leafSwapCancel. One reassignment in the tree moves both assets at once; the two
// wallets pass two texts between them (an offer, then an acceptance), which the site
// carries. Every check, amount and refusal is the leaf library's: the maker's
// `swap_offer` holds its coins and signs nothing, the taker's `swap_read` says what it
// gives, gets and pays before `swap_accept` signs on exactly those terms, and the
// maker's `swap_complete` signs its side and has the operator co-sign.
//
// The records here (chrome.storage.local) only say which site started which swap, and
// what the library answered when it did, so an approval can show it again and a site
// sees only its own swaps.

import { stGet, stSet } from './util.js';

export const KEY = 'ext.leafSwaps';

export async function records() { return (await stGet('local', KEY)) || {}; }
export async function remember(id, rec) {
  const all = await records();
  all[id] = { ...(all[id] || {}), ...rec };
  await stSet('local', KEY, all);
}

// The swap an offer's or an acceptance's text names. The text is the library's: a
// prefix, then its JSON in hex. Read only to find this wallet's record of the swap for
// the approval; the library checks the text itself.
export function textSwapId(text) {
  const m = /^[a-z-]*:([0-9a-f]+)$/i.exec(String(text || '').trim());
  if (!m || m[1].length % 2) return null;
  try {
    const b = new Uint8Array(m[1].length / 2);
    for (let i = 0; i < b.length; i++) b[i] = parseInt(m[1].slice(2 * i, 2 * i + 2), 16);
    const v = JSON.parse(new TextDecoder().decode(b));
    return typeof v.swap === 'string' ? v.swap : null;
  } catch { return null; }
}

// The approval rows, from the library's answers. `amt(atoms, asset)` names an amount.
export function offerRows(o, amt) {
  return [
    ['You give', amt(o.gives.value, o.gives.asset) + ' from your leaves'],
    ['You get', amt(o.gets.value, o.gets.asset) + ' as a leaf, once the other wallet accepts and you complete the swap'],
    ['You pay', amt(o.pays.margin, o.pays.asset) + ' as the reassignment’s margin, and ' + amt(o.pays.margins, o.pays.asset) + ' the margins your coins leave'],
    ['Your coins', 'held for this offer, signed for nothing, until it completes or is cancelled'],
  ];
}

export function readRows(r, amt) {
  const rows = [
    ['You get', amt(r.gets.value, r.gets.asset) + ' as a leaf, in one reassignment both wallets sign and the operator co-signs'],
    ['You give', amt(r.gives.value, r.gives.asset) + ' from your leaves'],
    ['You pay', amt(r.pays.margins, r.pays.asset) + ': the margins your coins leave for the transfer’s fees'],
    ['The other wallet pays', amt(r.maker_pays.margin, r.maker_pays.asset) + ' as the reassignment’s margin'],
    ['Change', r.change && BigInt(r.change.value || '0') > 0n ? amt(r.change.value, r.change.asset) + ' back as a leaf' : 'none'],
  ];
  const d = r.dates || {};
  if (d.exit_deadline != null) {
    rows.push(['Dates', 'the coins you get rest on every coin the swap spends: take them on the chain by '
      + new Date(d.exit_deadline * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') + ' (median time) at the latest'
      + (d.rests_on_board ? '; one rests on a board' : '')]);
  }
  return rows;
}

export function completeRows(rec, amt) {
  return [
    ['Swap', rec.swap],
    ['You give', amt(rec.gives.value, rec.gives.asset) + ' from your leaves'],
    ['You get', amt(rec.gets.value, rec.gets.asset) + ' as a leaf'],
    ['You pay', rec.pays ? amt(rec.pays.margin, rec.pays.asset) + ' margin and ' + amt(rec.pays.margins, rec.pays.asset) + ' of your coins’ margins, as offered' : 'the margins of your offer'],
  ];
}

// What a site sees of its swaps: the library's list, those this site started.
export function forOrigin(list, recs, origin) {
  return (list || []).filter((s) => recs[s.swap] && recs[s.swap].origin === origin)
    .map((s) => ({ swap: s.swap, role: s.role, state: s.state, gives: s.gives, gets: s.gets, ...(s.offer ? { offer: s.offer } : {}) }));
}
