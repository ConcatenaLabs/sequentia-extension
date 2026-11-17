// What Receive says while it is open about a payment coming in: "Payment arriving…", then
// "Received <amount> <TICKER>.", so whoever holds up the QR code sees the payment land without
// leaving the screen (docs/DEFAULT_MODE.md, "Receive").
//
// It reads only the figures the page already shows. For each asset the page gives what counts now
// (`settled`) and what is on its way and not counted yet (`arriving`). The watch keeps what they
// were when Receive opened, or at the last payment it reported, and compares each reading with it:
//
//   - an asset whose settled and arriving parts together went up while some of it is still on its
//     way: a payment is arriving;
//   - an asset whose settled and arriving parts together went up, with nothing of it on its way any
//     more: received, the amount being what they rose by. Only value the wallet did not hold is a
//     payment: coins of its own that come home (counted as arriving while they do) or that were on
//     their way when Receive opened only move from arriving to settled, and say nothing;
//   - an asset that went down (a payment out): its new figure is the base from then on, so a
//     payment received after it is still seen whole;
//   - one asset down and another up in the same reading: a trade settling, not a payment: nothing
//     is said, and the reading is the new base.
//
// A move of the wallet's own (coins on the chain taken into the tree, BTC onto the Bitcoin ark)
// leaves an asset's total where it was, so it says nothing.
//
// No DOM: it runs under Node (receive-watch.test.mjs).

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

function norm (snap) {
  const out = new Map()
  for (const [asset, v] of Object.entries(snap || {})) out.set(asset, { settled: big(v && v.settled), arriving: big(v && v.arriving) })
  return out
}

export function makeReceiveWatch () {
  let base = null
  let state = null // null | { kind: 'arriving', asset } | { kind: 'received', asset, atoms }

  return {
    // Receive opened: what the wallet holds now is the base, and nothing is said yet.
    start (snap) { base = norm(snap); state = null; return state },
    stop () { base = null; state = null },
    watching: () => base != null,
    state: () => state,
    // A new reading of the figures. -> the state to show.
    update (snap) {
      if (!base) return null
      const now = norm(snap)
      const assets = new Set([...base.keys(), ...now.keys()])
      const zero = { settled: 0n, arriving: 0n }
      const up = [], down = []
      for (const a of assets) {
        const b = base.get(a) || zero, n = now.get(a) || zero
        const d = (n.settled + n.arriving) - (b.settled + b.arriving)
        if (d > 0n) up.push(a)
        if (d < 0n) down.push(a)
      }
      if (down.length && up.some((a) => !down.includes(a))) { base = now; return state }
      for (const a of down) base.set(a, now.get(a) || zero)
      let received = null, arriving = null
      for (const a of up) {
        if (down.includes(a)) continue
        const b = base.get(a) || zero, n = now.get(a) || zero
        if (n.arriving > 0n) { arriving = arriving || a; continue }
        const rise = (n.settled + n.arriving) - (b.settled + b.arriving)
        if (!received || rise > received.atoms) received = { asset: a, atoms: rise }
      }
      if (received) {
        state = { kind: 'received', asset: received.asset, atoms: received.atoms }
        base = now
      } else if (arriving) {
        state = { kind: 'arriving', asset: arriving }
      }
      return state
    },
  }
}
