// How much default mode keeps where it pays in seconds, in USD. Only the Bitcoin ark is held to
// figures: its VTXOs can be swept at expiry and leave only when its server has BTC to spare, both
// out of our hands. Sequentia's Ark has no sweep, its operator's capital comes back within a round,
// and a double-spend of an unrefreshed VTXO is covered by the operator's bond: no figures there.
// Three figures:
//   board   the resting level: the wallet moves BTC there from its own address, in one move back
//           up to it, only once the ark holds less than a quarter of it (REFILL_BELOW);
//   hold    the ceiling: once the ark holds this much, everything above `board` moves out to the
//           wallet's own address in one move, so it is back at `board`;
//   direct  one payment of this much or more is paid to the address straight away, never to
//           the ark: a large payment would only be moved out again, and the ark's server has no
//           bond behind what it co-signs.
// BTC: 1500, 3000, 1500. The ark normally holds between 1500 and 3000, at most ~4500 until the
// next move down. Receiving there never stops below `direct`.
// Payments in and out over Lightning are held to the limit the operator publishes instead
// (asset-lightning.js lnMaxPayment), on both chains.
//
// The page sets them (window.SEQ_ARK_LIMITS, the shape of ARK_LIMITS: any figure left out keeps
// its default, null for no limit). An asset the price feed does not value cannot be held to a
// figure in USD: it is boarded and kept as before.
export const ARK_LIMITS = Object.freeze({
  btc: Object.freeze({ board: 1500, hold: 3000, direct: 1500 }),
  asset: Object.freeze({ board: null, hold: null, direct: null }),
})

// The wallet moves BTC into the ark only once it holds less than this share of `board`: one move
// back up to `board` every ~three quarters of it spent, never a board after each payment.
export const REFILL_BELOW = 0.25


const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const figure = (v, d) => (v === null ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== undefined ? Number(v) : d))

// The limits a page set, each figure checked: { btc: { board, hold, direct }, asset: { … } }.
// `hold` is never under `board`.
export function arkLimits (page) {
  const p = page && typeof page === 'object' ? page : {}
  const one = (k) => {
    const q = p[k] && typeof p[k] === 'object' ? p[k] : {}
    const board = figure(q.board, ARK_LIMITS[k].board)
    let hold = figure(q.hold, ARK_LIMITS[k].hold)
    if (hold != null && board != null && hold < board) hold = board
    return { board, hold, direct: figure(q.direct, ARK_LIMITS[k].direct) }
  }
  return { btc: one('btc'), asset: one('asset') }
}

// `usd` dollars of an asset priced `price` USD per whole unit with `precision` decimals, in atoms
// (rounded down). -> BigInt, or null when either is not a number (no limit can be told).
export function usdAtoms (usd, price, precision) {
  const u = Number(usd), p = Number(price)
  if (!(u >= 0) || !(p > 0) || !Number.isFinite(u) || !Number.isFinite(p)) return null
  // Whole cents and a price in millionths keep the sum in integers.
  const cents = BigInt(Math.floor(u * 100)), micro = BigInt(Math.round(p * 1e6))
  if (micro <= 0n) return null
  return (cents * 10n ** BigInt(precision || 0) * 10_000n) / micro
}

// How much the wallet moves into the Ark by itself now, holding `held` atoms there: nothing
// while it holds `refill` of the limit or more, else the rest up to the limit, in one move.
// -> atoms (0n when nothing moves), or null for no limit (none set, or the kind unpriced).
export function boardRoom ({ held, limitUsd, price, precision, refill = REFILL_BELOW }) {
  if (limitUsd == null) return null
  const cap = usdAtoms(limitUsd, price, precision)
  if (cap == null) return null
  if (big(held) * 10_000n >= cap * BigInt(Math.round(refill * 10_000))) return 0n
  const left = cap - big(held)
  return left > 0n ? left : 0n
}

// What moves out to the wallet's own address, holding `held` atoms: once the Ark holds `hold`,
// everything above `board`, in one move (so never less than `hold - board`); else nothing.
// -> atoms.
export function moveOutAtoms ({ held, board, hold, price, precision }) {
  if (board == null || hold == null) return 0n
  const b = usdAtoms(board, price, precision), h = usdAtoms(hold, price, precision)
  if (b == null || h == null || big(held) < h) return 0n
  const over = big(held) - b
  return over > 0n ? over : 0n
}

// The BTC the move down sends to the address (#530): what is above `board` (moveOutAtoms, `over`),
// less the move's own fee, which the ark pays on top of what it sends, so it then rests at `board`
// rather than that fee below it; at most `max`, the most the ark can send there (its fee off).
// -> sats, 0n when nothing is left to move.
export function moveOutSats (over, fee, max = null) {
  let s = big(over) - big(fee)
  if (max != null && s > big(max)) s = big(max)
  return s > 0n ? s : 0n
}

// When the move down may be tried again after `failures` refusals in a row (#523): two minutes
// after the first, doubling each time, at most an hour; at once after none.
export const MOVE_RETRY_MS = 2 * 60_000
export const MOVE_RETRY_MAX_MS = 60 * 60_000
export function moveRetryMs (failures) {
  if (!(failures > 0)) return 0
  return Math.min(MOVE_RETRY_MS * 2 ** (failures - 1), MOVE_RETRY_MAX_MS)
}

// Whether the move down waits for a person (#523): never while a person reviews or makes a BTC
// payment, nor within a minute after one (`personAt`, ms), since both spend the same coins and the
// move is sized on the balance before the payment.
export const PERSON_QUIET_MS = 60_000
export function moveWaits ({ reviewing = false, personAt = 0, now = Date.now() }) {
  return !!reviewing || now - (personAt || 0) < PERSON_QUIET_MS
}

// The USD from which one payment goes to the address rather than the Ark, or null for never.
export function directUsd ({ direct }) {
  return direct == null ? null : direct
}

// Whether a payment of `atoms` goes to the address straight away (directUsd or more).
export function goesToAddress ({ atoms, direct, price, precision }) {
  const usd = directUsd({ direct })
  if (usd == null || !(usd > 0)) return false
  const at = usdAtoms(usd, price, precision)
  return at != null && big(atoms) >= at
}
