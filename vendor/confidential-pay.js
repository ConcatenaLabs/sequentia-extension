// A payment to a confidential address that hides its amount (docs/DEFAULT_MODE.md, Send).
//
// A blinded output hides nothing by itself: when every other value of the transaction is in the
// clear (its inputs, its change, its fee), the payment is what is left. So the payment is made with
// a second blinded output, to the wallet's own confidential address, which takes what the inputs
// hold beyond the payment and its fee: anyone reading the chain then knows only the two together.
//
// What the wallet holds for instant payments is paid out only in the clear, so when the chain does
// not hold enough the wallet first moves coins out to its own address, in an amount that does not
// give the payment away: all it holds of the asset there, or the smallest power of ten above what
// the payment needs (at least one whole unit), whichever is smaller. The chain then shows the coin
// moved and, later, that some part of it was paid; never which part.
//
// The asset is hidden only among the assets of the inputs: a confidential coin of another asset,
// spent to the wallet's own confidential address in the same transaction, hides which of the two
// was paid. Without one, anyone can see the asset.
//
// The same arithmetic in every wallet: Ambra browser copies this file, Ambra mobile ports it
// (app/lib/src/data/confidential_pay.dart). Node (confidential-pay.test.mjs).

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// A margin for the network fees of `vbytes` of transactions, in atoms of an asset whose published
// rate is `rate` (reference atoms per 1e8 of the asset), at the wallet's default fee rate, twice
// over: what is moved for them is never short, and what is left stays the wallet's.
export function feeMarginAtoms (rate, { vbytes = 1000, feeRate = 2000, scale = 100000000 } = {}) {
  const R = big(rate)
  if (R <= 0n) throw new Error('no rate')
  const rfa = BigInt(feeRate) * BigInt(vbytes) * 2n / 1000n
  return (rfa * BigInt(scale) + R - 1n) / R
}

// The smallest power of ten of atoms at least `need`, and at least one whole unit of an asset of
// `precision` decimals.
export function bucketAtoms (need, precision = 8) {
  let b = 10n ** BigInt(Math.max(0, Number(precision) || 0))
  while (b < big(need)) b *= 10n
  return b
}

// What to do for a confidential payment of `amount` atoms whose fee needs `margin`, with `onchain`
// held on the chain (spendable) and `instant` held for instant payments; `minLeaf` is the least the
// operator pays out of the asset. The wallet's own confidential output must take at least `margin`
// for the amount to be hidden.
//   { move, hides: true }    move `move` out first (0: none), then pay: the amount is hidden;
//   { move, hides: false }   the same, but the most the wallet holds leaves too little beside the
//                            payment to hide it: the review says the amount can be worked out;
//   { short }                the wallet holds `short` too little in all.
export function confidentialPlan ({ amount, margin, onchain, instant = 0n, minLeaf = 0n, precision = 8 }) {
  const a = big(amount); const m = big(margin); const on = big(onchain); const inst = big(instant); const least = big(minLeaf)
  const pays = a + m // the payment and its fee
  const hidden = pays + m // and the least the wallet's own output takes beside it
  if (on >= hidden) return { move: 0n, hides: true }
  const total = on + inst
  const canMove = (x) => x > 0n && x <= inst && x >= least
  if (total >= hidden) {
    const bucket = bucketAtoms(hidden, precision)
    const cap = total < bucket ? total : bucket // all of it, or the round amount, whichever is smaller
    const target = cap > hidden ? cap : hidden
    let move = target - on
    if (move < least) move = least
    if (canMove(move)) return { move, hides: true }
  }
  if (on >= pays) return { move: 0n, hides: false }
  if (total >= pays && canMove(inst)) return { move: inst, hides: total >= hidden }
  if (total >= pays && canMove(least) && on + least >= pays) return { move: least, hides: on + least >= hidden }
  return { short: pays - total > 0n ? pays - total : 1n }
}

// The wallet's own confidential output beside the payment: what the chain holds of the asset
// beyond the payment and the fee margin (0n when that is too little to hide the amount).
export function ownShare ({ amount, margin, onchain }) {
  const x = big(onchain) - big(amount) - big(margin)
  return x >= big(margin) ? x : 0n
}

// What the wallet can move out now, by the leaf library's own refusal of a larger move: "the
// wallet's live coins of asset … hold <n> and an offboard of <a> and its fee need <need> …". Coins
// the library holds but cannot pay out (a channel's balance, a coin not final yet) count in the
// balance and not here. -> atoms (the coins less the fee such a move pays), or null when the
// refusal says something else.
export function liveFromRefusal (message) {
  const m = /live coins of asset \S+ hold (\d+) and an offboard of (\d+) and its fee need (\d+)/.exec(String(message || ''))
  if (!m) return null
  const hold = BigInt(m[1]); const fee = BigInt(m[3]) - BigInt(m[2])
  return hold > fee ? hold - fee : 0n
}
