// Speeding up the wallet's transactions on the chain (child pays for parent), on both chains.
//
// A transaction that waits in the mempool for a block is sped up by a child: a transaction of the
// wallet's own that spends one of the waiting transaction's outputs to the wallet and pays enough
// for both, which a producer (a Bitcoin miner, a Sequentia block producer) takes as a pair. On
// Sequentia the child's fee may be in any asset the network accepts, and the pair is valued in the
// reference unit; a coin of an asset no node takes for fees is sped up by a child that adds a second
// input of an accepted one. Exits and the other steps the leaf wallet takes on the chain are sped up
// by the leaf library itself (its `sync`, and `speed_up` in developer mode).
//
// Default mode does it by itself: a transaction the wallet sent or receives that has waited
// STUCK_BLOCKS blocks is sped up to twice the network's floor, the rate doubling at each further
// wait, at most MAX_RAISES times; the History row then says so in SPEED_WORDS. Developer mode
// offers a "Speed up" control on every waiting transaction instead, and does nothing by itself.
//
// This module holds what is decided, with no page or network in it: which transactions are due,
// the rate, the child's fee and its inputs. The page builds, signs and broadcasts.

export const STUCK_BLOCKS = 2
export const MAX_RAISES = 6

export const SPEED_WORDS = {
  spedUp: 'Taking longer than usual: the wallet paid a little more to speed it up.',
  cannot: 'Taking longer than usual.',
}

// `book` keeps, for each waiting transaction, the tip it was first seen waiting at, how often it
// was raised and the tip of the last raise: { [txid]: { seen, raises, raisedAt } }. `waiting` is
// every transaction the wallet holds that is not in a block yet; anything else leaves the book.
// Answers the transactions due a speed-up now, the longest waiting first.
export function dueNow (book, waiting, tip) {
  const now = new Set(waiting)
  for (const id of Object.keys(book)) if (!now.has(id)) delete book[id]
  const due = []
  for (const id of waiting) {
    const e = book[id] || (book[id] = { seen: tip, raises: 0, raisedAt: null })
    if (tip < e.seen + STUCK_BLOCKS) continue
    if (e.raisedAt != null && tip < e.raisedAt + STUCK_BLOCKS) continue
    if (e.raises >= MAX_RAISES) continue
    due.push(id)
  }
  return due.sort((a, b) => book[a].seen - book[b].seen)
}

export function markRaised (book, txid, tip) {
  const e = book[txid] || (book[txid] = { seen: tip, raises: 0, raisedAt: null })
  e.raises += 1
  e.raisedAt = tip
  return e
}

// The rate of the next raise: twice `floor`, doubled for every raise before it.
export function raiseRate (floor, raises) {
  return floor * Math.pow(2, raises + 1)
}

// The fee a child of `childVsize` vbytes pays so that it and its parent (`parentVsize`, paying
// `parentFee`) pay `rate` a vbyte together; never less than the child's own share at that rate.
export function childFee ({ parentVsize, parentFee, childVsize, rate }) {
  const pair = BigInt(Math.ceil(rate * (parentVsize + childVsize)))
  const own = BigInt(Math.ceil(rate * childVsize))
  const need = pair - BigInt(parentFee)
  return need > own ? need : own
}

// A Bitcoin child: `handles` are the wallet's outputs in the waiting transaction ({ txid, vout,
// value }), `extra` its other coins, largest first, added only when the handles cannot pay.
// `vsizeOf(nInputs)` is the child's size with one output. Answers { inputs, fee, change }, or
// throws in plain words when the wallet holds nothing to pay with.
export function btcChildPlan ({ handles, extra = [], parentVsize, parentFee, rate, vsizeOf, dust }) {
  if (!handles.length) throw new Error('Nothing in this transaction is this wallet\'s to speed it up with.')
  const inputs = [...handles]
  let held = inputs.reduce((s, u) => s + BigInt(u.value), 0n)
  const pool = [...extra]
  for (;;) {
    const fee = childFee({ parentVsize, parentFee, childVsize: vsizeOf(inputs.length), rate })
    if (held - fee >= BigInt(dust)) return { inputs, fee, change: held - fee }
    const next = pool.shift()
    if (!next) throw new Error('This wallet holds too little BTC to speed this up.')
    inputs.push(next)
    held += BigInt(next.value)
  }
}
