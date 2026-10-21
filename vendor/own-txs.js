// The page's own recent broadcasts, put back into the wollet after a scan that has not
// returned them yet.
//
// A full scan's Update is computed from what the explorer showed when the scan started. If
// the page broadcast a transaction after that, applying the Update forgets it: its inputs
// read as unspent again and the next build spends them twice. So the page keeps what it
// broadcast in the last hour and applies each one again after every scan.
//
// Only the ones the wollet does not hold. The kit's applyTransaction writes every wallet
// output of the transaction it is given into the unspent set, whether or not another
// transaction the wollet holds spends it, and marks it unconfirmed. Given again a
// transaction the scan has already returned, it brings back as spendable a change output
// that something other than this page has spent since: a board of the leaf wallet (same
// keys), another device, a covenant. That coin then counts in the balance and the headline,
// and every send that picks it is refused as already spent, until the hour is over.
export const OWN_TX_MAX_AGE_MS = 60 * 60_000

// ring: [{ hex, at }]; pruned in place of entries older than maxAgeMs.
// toTx(hex) -> a kit Transaction. Answers the txids applied.
export function reapplyUnseen (wollet, ring, toTx, now = Date.now(), maxAgeMs = OWN_TX_MAX_AGE_MS) {
  const cutoff = now - maxAgeMs
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].at < cutoff) ring.splice(i, 1)
  let held = null
  try { held = new Set(wollet.transactions().map((t) => t.txid().toString())) } catch {}
  const applied = []
  for (const e of ring) {
    try {
      const tx = toTx(e.hex)
      const id = tx.txid().toString()
      if (held && held.has(id)) continue
      wollet.applyTransaction(tx)
      applied.push(id)
    } catch {}
  }
  return applied
}
