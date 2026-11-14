// Buying a restricted asset with bitcoin as one trade. Bitcoin buys an asset X that the book
// trades for the restricted asset R; the wallet shows one ticket (the bitcoin paid, the R received,
// every fee) and asks for one confirmation. Three things happen, each priced in the ticket:
//
//   1. the engine's own bitcoin purchase of X, which brings X as one coin of the operator's tree;
//   2. that coin, and no other, moved whole to the wallet's own address on the chain (the leaf
//      library's offboard of named coins: what the coin holds less the fee, with no change), its fee
//      priced from the operator's published fees before the coin exists;
//   3. the X that move put on the chain, and no other, traded for R under R's policy server
//      (restricted-engine.js), at terms giving at least the R the ticket showed, for a fee no
//      higher than the ticket's.
//
// Once the first has settled the rest goes by itself. When it cannot go (no offer at those terms,
// a fee above the ticket's, the issuer not approving this wallet now), the person is told what they
// hold and why, and it is tried again until COMPOSED_SECOND_MS have passed since the first settled;
// then the trade ends holding X.
//
// The composed trade keeps a record of its own (source 'composed'); the first and third keep the
// engine's usual records, marked `partOf` the composed one, and are followed as any trade is. The
// third has one record whatever the tries: each try goes on in it. The Trade tab shows the composed
// record; History shows the steps, which are what moved.

import { restrictedQuote } from './restricted-engine.js'

export const COMPOSED_SECOND_MS = 24 * 3600_000
// The rest is asked for at most this often while it cannot go.
export const COMPOSED_RETRY_MS = 60_000
// The exit date a coin the first step brings is priced at: further than a fresh coin's, so the
// move's refresh fee in the ticket is the most it can be.
export const MOVE_PRICED_DAYS = 400
// How often a move under way is looked at: each look asks the library to sync.
export const MOVE_POLL_MS = 10_000

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ENDED = ['returned', 'failed', 'undone']
// The record of a composed trade's trade on the chain: one, whatever the tries.
export const secondId = (rec) => rec.id + '.2'

// The composed ticket for paying `amount` sats for `receiveAsset` (restricted), through the first of
// `vias` that prices every step. `quoteFirst(via)` is the engine's own quote of bitcoin for `via`;
// `drop(choice)` lets go of a firm first step that is not used; `run(cmd, args)` is the leaf
// library; `nowSec()` the time in seconds.
// -> { ok: true, ticket, choice, moving } | { ok: false, first, card } (no via priced every step;
//    `first`: the last first step's answer when it was refused, else null; `card`: the approval
//    card when the issuer does not approve this wallet for what the ticket would bring)
export async function composedQuote (R, { receiveAsset, vias, quoteFirst, drop, run, nowSec }) {
  let first = null
  let card = null
  const address = R.address ? await R.address() : null
  for (const via of vias || []) {
    const q1 = await quoteFirst(via)
    if (!q1 || !q1.ok) { first = q1 || first; continue }
    first = null
    const got = big(q1.ticket.amountOut)
    // The move of the coin the first step brings, whole, priced before it exists.
    let mq = null
    if (address) {
      try { mq = await run('offboard_quote', { asset: via, value: String(got), expiry: nowSec() + MOVE_PRICED_DAYS * 86400, address }) } catch { mq = null }
    }
    if (!mq || !(big(mq.amount) > 0n)) { drop(q1.choice); continue }
    const moved = big(mq.amount)
    const moveFee = got - moved
    // The trade on the chain pays its fee from that X, when its fee is in X.
    const feeAsset = await R.feeAsset(via, receiveAsset)
    const fee = feeAsset === via ? big(await R.fee(via)) : 0n
    const q2 = moved > fee ? await restrictedQuote(R, { payAsset: via, receiveAsset, amount: moved - fee, arriving: moved }).catch(() => null) : null
    if (!q2 || !q2.ok) { if (q2 && q2.why === 'approval') card = q2.card; drop(q1.choice); continue }
    const spent = big(q2.ticket.amountIn) + (q2.choice.feeAsset === via ? big(q2.choice.fee) : 0n)
    const keep = moved - spent
    const ticket = { payAsset: 'BTC', receiveAsset, amountIn: q1.ticket.amountIn, amountOut: q2.ticket.amountOut,
      fees: [...(q1.ticket.fees || []), { asset: via, atoms: String(moveFee) }, ...(q2.ticket.fees || [])], source: 'composed', via,
      ...(keep > 0n ? { keep: String(keep) } : {}) }
    return { ok: true, ticket, moving: !!q1.moving,
      choice: { source: 'composed', first: q1.choice, firstTicket: q1.ticket, via, viaAtoms: String(got), moveFee: String(moveFee),
        moved: String(moved), secondFee: String(q2.choice.fee), secondFeeAsset: q2.choice.feeAsset } }
  }
  return { ok: false, first, card }
}

// Moves a composed trade on. `E`: the engine's pieces:
//   records() put(rec) now() run(cmd, args)
//   confirm(choice, ticket, extra) -> the step's record (throws on a refusal)
//   stepCoin(rec) -> the coin the first step brought, now: { coin } (live), { waiting } (in a round
//     of the wallet's), { merged } (refreshed together with other coins: no longer that coin alone),
//     { gone } (the wallet holds it no more)
// -> the composed record. The engine runs it under a claim on the trade that no other page of this
// wallet holds at the same time (claimOnce), with the record read from the store inside the claim,
// so two pages never move or take for one trade.
export async function composedAdvance (R, rec, E) {
  const all = E.records()
  const step = (id) => (id ? all.find((r) => r.id === id) || null : null)
  // A page closed between the composed record and its first step: the step is the one marked as its.
  if (!rec.first) {
    const one = all.find((r) => r.partOf === rec.id)
    if (one) rec.first = one.id
    else if (E.now() - (rec.at || 0) >= 10 * 60_000) { rec.state = 'failed'; rec.error = 'the first step was never made' }
    return E.put(rec)
  }
  if (!rec.firstSettledAt) {
    const one = step(rec.first)
    if (!one) {
      // The store keeps every record of an open trade: the step is gone only with the store.
      if (E.now() - (rec.at || 0) >= COMPOSED_SECOND_MS) { rec.state = 'failed'; rec.error = 'the first step\'s record is gone' }
      return E.put(rec)
    }
    // Until its first step settles, the trade is where that step is: waiting for the other side,
    // or sent.
    if (['sent', 'waiting'].includes(one.state) && rec.state !== one.state) {
      rec.state = one.state; rec.sentAt = rec.sentAt || E.now()
      if (one.state === 'waiting') rec.waitingSince = rec.waitingSince || E.now()
    }
    // A first step waiting for the other side: the wait it states is the trade's.
    if (one.state === 'waiting' && rec.state === 'waiting') { rec.waitFirstBy = one.waitFirstBy; rec.waitBy = one.waitBy }
    // The first step came back: nothing of the wallet's moved for good, so nor did the trade.
    if (ENDED.includes(one.state)) {
      rec.state = 'returned'; rec.returnedAt = E.now(); rec.error = one.error || null
      if ((one.feesPaid || []).length) rec.feesPaid = one.feesPaid
      return E.put(rec)
    }
    if (one.state !== 'settled') return E.put(rec)
    rec.firstSettledAt = E.now(); rec.state = 'sent'
  }
  const two = step(secondId(rec))
  if (two) {
    if (two.state === 'settled') { rec.state = 'settled'; rec.settledAt = E.now(); rec.viaHeld = false; rec.card = null; return E.put(rec) }
    if (!ENDED.includes(two.state)) return E.put(rec)
    // The trade on the chain moved nothing as far as the explorer said: the X is still the wallet's,
    // and it is tried again (after COMPOSED_RETRY_MS) in that same record. Each try's transaction is
    // kept with its ticket: one called returned can still land (late, or back after a reorg), and the
    // step's one record would otherwise forget it at the next try.
    if (two.txid && !(rec.secondTries || []).some((t) => t.txid === two.txid)) {
      rec.secondTries = [...(rec.secondTries || []), { txid: two.txid, ticket: two.ticket || null }]
    }
    rec.second = null; rec.viaHeld = true
    if (!rec.waitUntil) rec.waitUntil = E.now() + COMPOSED_RETRY_MS
  }
  const past = E.now() - rec.firstSettledAt >= COMPOSED_SECOND_MS
  const endVia = (why) => {
    rec.state = 'settled'; rec.settledAt = E.now(); rec.viaHeld = true; rec.ended = 'via'; rec.endWhy = why
    return E.put(rec)
  }
  // What cannot go now is asked again after COMPOSED_RETRY_MS; a move under way is looked at again
  // after MOVE_POLL_MS.
  if (rec.waitUntil && E.now() < rec.waitUntil) return E.put(rec)
  rec.waitUntil = null
  const wait = (why, ms = COMPOSED_RETRY_MS) => { rec.viaHeld = true; rec.why = why; rec.waitUntil = E.now() + ms; return E.put(rec) }
  // 2. The coin the first step brought, moved whole to the wallet's address on the chain.
  if (!rec.viaOut) {
    if (!rec.move) {
      if (past) return endVia('time')
      const c = await E.stepCoin(step(rec.first) || { id: rec.first })
      if (c.gone) return endVia('spent')
      if (c.merged) return endVia('merged')
      if (!c.coin) return wait('its coin is in a round')
      rec.viaCoin = c.coin.leaf_id
      const address = await R.address()
      let q
      try { q = await E.run('offboard_quote', { asset: rec.via, coins: [c.coin.leaf_id], address }) } catch (e) {
        if (e && e.kind === 'settle_first') {
          // The coin waits for a round before it can leave the tree, as anywhere in the wallet: put
          // through the next one (the library gives up nothing twice), then moved as it is then.
          try { await E.run('settle_first', { coins: e.coins && e.coins.length ? e.coins : [c.coin.leaf_id] }) } catch {}
          return wait('settling first')
        }
        return wait(String((e && e.message) || e))
      }
      // Never at a fee above the ticket's.
      if (big(q.fee && q.fee.amount) > big(rec.moveFee)) return wait(`moving it costs ${q.fee.amount}, above the ticket's ${rec.moveFee}`)
      rec.why = null
      const r = await E.run('offboard', { asset: rec.via, coins: [c.coin.leaf_id], address, shown: q })
      rec.move = { offboard: r.offboard, amount: String(q.amount), fee: String(q.fee.amount), address, at: E.now() }
      rec.viaHeld = false; rec.waitUntil = E.now() + MOVE_POLL_MS
      return E.put(rec)
    }
    // Carried on by the library's sync: the operator's round, then the unlock into the address.
    try { await E.run('sync') } catch {}
    let list = []
    try { list = (await E.run('offboards')) || [] } catch { return wait(null, MOVE_POLL_MS) }
    const o = list.find((x) => x && x.offboard === rec.move.offboard)
    if (o && o.state === 'paid' && o.txid && o.vout != null) {
      rec.viaOut = { txid: o.txid, vout: Number(o.vout), value: String(o.amount || rec.move.amount) }
    } else {
      // The move did not happen: the coin is the wallet's in the tree again, and is moved again.
      if (!o || o.state === 'not_made' || o.state === 'reclaimed') { rec.move = null; return wait('the move was not made') }
      rec.waitUntil = E.now() + MOVE_POLL_MS
      return E.put(rec)
    }
  }
  // 3. The X on the chain, and no other, traded for R.
  // Spent: by one of this trade's own tries that landed after it was called returned (web wallet
  // #729), or by something else of the wallet's. A try the chain holds settles the trade as bought,
  // with that try's record; one still in the mempool is waited for.
  if (R.unspent && !(await R.unspent(rec.viaOut))) {
    for (const t of rec.secondTries || []) {
      const st = await Promise.resolve(R.status(t.txid)).catch(() => 'unknown')
      if (st === 'confirmed') {
        const one = step(secondId(rec))
        if (one) E.put({ ...one, txid: t.txid, ...(t.ticket ? { ticket: t.ticket } : {}), state: 'settled', settledAt: E.now(), error: null, chainState: st, missingSince: null })
        rec.second = secondId(rec); rec.state = 'settled'; rec.settledAt = E.now(); rec.viaHeld = false; rec.card = null; rec.why = null
        rec.landedLate = t.txid
        return E.put(rec)
      }
      if (st !== 'unknown') return wait('a trade sent earlier is on its way', MOVE_POLL_MS)
    }
    return endVia('spent')
  }
  if (past) return endVia('time')
  const value = big(rec.viaOut.value)
  const fee = rec.secondFeeAsset === rec.via ? big(rec.secondFee) : 0n
  const q = value > fee ? await restrictedQuote(R, { payAsset: rec.via, receiveAsset: rec.ticket.receiveAsset, amount: value - fee, arriving: value }).catch(() => null) : null
  // A buyer the issuer does not approve now: told so, with how to get approved; nothing is taken.
  if (q && q.why === 'approval') { rec.card = q.card; return wait('not approved now') }
  rec.card = null
  // Only at terms giving at least what the ticket showed, for no more fee than it showed.
  if (!q || !q.ok || big(q.ticket.amountOut) < big(rec.ticket.amountOut) || q.choice.feeAsset !== rec.secondFeeAsset ||
      big(q.choice.fee) > big(rec.secondFee)) return wait('no offer at the ticket\'s terms')
  q.choice.only = [{ txid: rec.viaOut.txid, vout: rec.viaOut.vout, asset: rec.via }]
  try {
    const r2 = await E.confirm(q.choice, q.ticket, { partOf: rec.id, id: secondId(rec) })
    rec.second = r2.id; rec.viaHeld = false; rec.secondError = null
  } catch (e) {
    // Refused before anything moved: the X is still the wallet's, and its record says so.
    rec.secondError = String((e && e.message) || e)
    return wait(rec.secondError)
  }
  rec.why = null
  return E.put(rec)
}

// The record of a composed trade's step, which the Trade tab and its notices leave to the composed
// record.
export const isStep = (r) => !!(r && r.partOf)

// The records a store keeps whatever their number: every record of a composed trade still open
// (the trade's own, and each step marked as its), so a trade under way never loses its steps.
export function openComposedIds (list) {
  const open = new Set((list || []).filter((r) => r && r.source === 'composed' && !['settled', ...ENDED].includes(r.state)).map((r) => r.id))
  return new Set((list || []).filter((r) => r && (open.has(r.id) || open.has(r.partOf))).map((r) => r.id))
}

// A claim no other context of this origin holds at the same time (Web Locks: one holder per name,
// across tabs and workers); where there are none (Node), one holder per process.
const holding = new Set()
export async function claimOnce (id, fn, locks = (typeof navigator !== 'undefined' && navigator.locks) || null) {
  if (locks && locks.request) return locks.request('swk-composed-' + id, { ifAvailable: true }, (lock) => (lock ? fn() : undefined))
  if (holding.has(id)) return undefined
  holding.add(id)
  try { return await fn() } finally { holding.delete(id) }
}
