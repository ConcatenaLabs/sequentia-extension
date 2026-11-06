// Which address a receive code shows: the index of the wallet's shared address (the same tb1
// address on both chains) that Receive hands out.
//
// Each New code moves to an address not shown before, starting from the first one neither chain has
// seen used (`nextUnused`). Every address handed out stays within the look-ahead a scan from the
// phrase alone covers: the kit and the Bitcoin scan both read addresses in batches of `gap` and go
// on while a batch has a payment, so a wallet restored from its phrase finds every address up to the
// last one used plus `gap`. New code therefore cycles through the `gap` addresses from `nextUnused`
// on, and a payment to any of them is found after a restore. Once an address is paid, `nextUnused`
// passes it and the window moves on with it.
//
// The same rule in every wallet: Ambra mobile's (app/lib/src/data/receive_index.dart) and the
// browser extension's copy of this file (vendor/receive-index.js). No DOM: it runs under Node
// (receive-index.test.mjs).

export const RECEIVE_GAP = 20

// The index New code moves to from the one shown (`shown`, null when none is).
export function nextReceiveIndex (shown, nextUnused, gap = RECEIVE_GAP) {
  const first = Math.max(0, Number(nextUnused) || 0)
  if (shown == null || !Number.isInteger(Number(shown))) return first
  const next = Math.max(Number(shown) + 1, first)
  return next < first + gap ? next : first
}

// The index to show: the one kept from before (`kept`, null when none is) while it is still within
// the window, else the first unused.
export function shownReceiveIndex (kept, nextUnused, gap = RECEIVE_GAP) {
  const first = Math.max(0, Number(nextUnused) || 0)
  const k = kept == null ? NaN : Number(kept)
  return Number.isInteger(k) && k >= first && k < first + gap ? k : first
}
