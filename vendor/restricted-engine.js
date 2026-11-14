// The default composer's engine (user-trade.js) for a pair with a restricted asset: priced from
// the book's restricted entries (restricted-trade.js), confirmed by the taker's side of the trade,
// followed on the chain. The engine asks this module first; with no restricted asset in the pair,
// or with the page's policy server and relay lacking what it needs, the answer is null and the
// engine trades as it always does.
//
// deps.restricted (the page's, index.html):
//   available()          -> whether the policy server answers eligibility and the relay lists
//                           restricted offers (feature detection; false: as if none existed)
//   isRestricted(asset)  -> whether the asset is one a policy server co-signs
//   book(pay, receive)   -> the relay's verified offers of the pair, both directions
//   sellers(asset, { sell }) -> the assets the book trades `asset` for now, in the trade's direction:
//                           buying it (sell false), the assets offers take for it; selling it (sell
//                           true), the assets offers give for it: [{ asset }]
//   btcBuys(asset, { sell }) -> whether bitcoin buys `asset` in one step now (sell false), or
//                           `asset` buys bitcoin in one step now (sell true)
//   eligible(asset, atoms) -> null when this wallet may receive it, else the approval card
//                           (restricted-trade.js approvalCard)
//   held(asset)          -> what the wallet holds of an asset, wherever it is (a restricted one:
//                           at its enclave)
//   onItsWay(asset)      -> what of it is still on its way in (a payment the wallet settles first)
//   moveQuote(needs)     -> what moving `needs` ([{ hex, atoms }]) to the chain costs and takes, before
//                           anything moves: null when the chain holds them, else { fees, minutes };
//                           throws the library's settle_first
//   moving()             -> whether a move of the wallet's to its own address is under way (a
//                           trade's, followed after its page opened again)
//   feeAsset(pay, receive) -> the asset the fee is paid in (the asset paid, never the restricted
//                           one; selling a restricted asset, the asset received, else another held)
//   fee(asset)           -> the fee of one trade in that asset
//   ensure(needs, say)   -> puts what the trade pays from on the chain ([{ hex, atoms }]), saying
//                           so through say(text) while it waits
//   take(entry, { receive, feeAsset, only?, onTxid }) -> { txid }; onTxid(txid) before the broadcast;
//                           `only`: the outpoints the asset paid comes from, no other coin of it
//   address()            -> the wallet's own unconfidential address on the chain (composed purchases)
//   unspent(outpoint)    -> false once the wallet's coin there is spent (composed purchases)
//   status(txid)         -> 'confirmed' | 'pending' | 'unknown'
//   name(asset)          -> its ticker

import { restrictedEntries, btcRoute, RESTRICTED_WORDS } from './restricted-trade.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const BTC = 'BTC'
// The minutes the trade itself takes once what it pays from is on the chain: the policy server's
// co-signature and a block.
export const TRADE_MINUTES = 2

// A restricted pair's price for `amount` paid. `arriving`: atoms of the asset paid that a trade
// under way brings first (a composed purchase's first step), counted as held. -> null (not a
// restricted pair: the engine goes on) | the engine's quote answer, with `card` for the approval
// and bitcoin answers.
export async function restrictedQuote (R, { payAsset, receiveAsset, amount, arriving = 0n }) {
  if (!R || !(await R.available())) return null
  const rPay = payAsset !== BTC && R.isRestricted(payAsset)
  const rGet = receiveAsset !== BTC && R.isRestricted(receiveAsset)
  if (!rPay && !rGet) return null
  const A = big(amount)
  if (A <= 0n) return { ok: false, why: 'too-small' }
  const name = (a) => (R.name ? R.name(a) : a)
  // A buyer the asset's issuer has not approved is shown whom to ask, whatever the route.
  if (rGet) {
    const card = await R.eligible(receiveAsset, 1n)
    if (card) return { ok: false, why: 'approval', card }
  }
  // Bitcoin buys a restricted asset through an asset that bitcoin buys and that buys it; selling
  // one for bitcoin goes the same way back. The screen names the asset to trade through, and its
  // button starts the first step (bitcoin for it, or the restricted asset for it).
  if (payAsset === BTC || receiveAsset === BTC) {
    const r = rGet ? receiveAsset : payAsset
    // Each leg in the trade's own direction: buying, bitcoin for X and X for R; selling, R for X
    // and X for bitcoin. A card never names a route the book or the paths do not hold.
    const sell = !rGet
    const others = await R.sellers(r, { sell })
    const route = btcRoute(name(r), others, (x) => R.btcBuys(x, { sell }), name, sell)
    if (route.via) return { ok: false, why: 'btc-route', card: { text: (rGet ? RESTRICTED_WORDS.btcVia : RESTRICTED_WORDS.btcViaSell)(name(r), name(route.via)), choices: [route.via], side: 'get' } }
    return { ok: false, why: 'btc-route', card: { ...route.card, side: rGet ? 'pay' : 'get' } }
  }
  const es = restrictedEntries(await R.book(payAsset, receiveAsset), { payAsset, receiveAsset })
  if (!es.length) {
    const text = rGet ? RESTRICTED_WORDS.noneSelling(name(receiveAsset)) : RESTRICTED_WORDS.noneBuying(name(payAsset))
    return { ok: false, why: 'not-offered', card: { text, choices: [] } }
  }
  // Each entry sized to what is paid: a maker's quote trades whole, a gated order from its least lot.
  const sized = []
  for (const e of es) {
    if (e.whole) { if (e.rateNum <= A) sized.push({ e, give: e.rateNum, receive: e.rateDen }); continue }
    let r = (A * e.rateDen) / e.rateNum
    if (r > e.maxReceive) r = e.maxReceive
    // A remainder below the order's least lot cannot rest: take it all or leave a lot.
    if (r < e.maxReceive && e.maxReceive - r < e.minReceive) r = e.maxReceive - e.minReceive
    if (r < e.minReceive) continue
    sized.push({ e, give: (r * e.rateNum + e.rateDen - 1n) / e.rateDen, receive: r })
  }
  if (!sized.length) return { ok: false, why: 'too-small' }
  // The most received for what is paid.
  sized.sort((a, b) => (b.receive * a.give > a.receive * b.give ? 1 : -1))
  const best = sized[0]
  const feeAsset = await R.feeAsset(payAsset, receiveAsset)
  if (!feeAsset) return { ok: false, why: 'no-funds' }
  const fee = big(await R.fee(feeAsset))
  const need = best.give + (feeAsset === payAsset ? fee : 0n)
  // Money still on its way in (a payment above the wallet's instant limit) counts: it is settled
  // first, as for any trade, and the trade priced again once it is through. Never "you have none".
  const onWay = async (x) => (R.onItsWay ? big(await R.onItsWay(x)) : 0n)
  const short = async (x, n, more = 0n) => {
    const h = big(await R.held(x)) + more
    if (h >= n) return null
    return h + (await onWay(x)) >= n ? { ok: false, why: 'settle-first', payAsset: x, coins: [], held: String(h) } : { ok: false, why: 'no-funds' }
  }
  const s1 = await short(payAsset, need, big(arriving))
  if (s1) return s1
  if (feeAsset !== payAsset) { const s2 = await short(feeAsset, fee); if (s2) return s2 }
  // Approved for one atom is not approved for the amount (an issuer's rules can bound what one
  // account receives): asked again for what this trade brings, before anything moves.
  if (rGet) {
    const card = await R.eligible(receiveAsset, best.receive)
    if (card) return { ok: false, why: 'approval', card }
  }
  // What the trade pays from must be on the chain: when it is not, its move there is priced and
  // timed now, so the ticket shows every fee and the true wait before the person confirms. A move
  // whose coins must go through a round first is settled first, as any trade.
  const needs = []
  if (!rPay) needs.push({ hex: payAsset, atoms: need })
  if (feeAsset !== payAsset) needs.push({ hex: feeAsset, atoms: fee })
  let mv = null
  // A composed purchase's second step (`arriving`) prices its own move (restricted-composed.js).
  if (R.moveQuote && needs.length && !(big(arriving) > 0n)) {
    try { mv = await R.moveQuote(needs) } catch (e) {
      if (e && e.kind === 'settle_first') return { ok: false, why: 'settle-first', payAsset, coins: e.coins || [], held: '0' }
      return { ok: false, why: 'no-funds' }
    }
  }
  const moveFees = ((mv && mv.fees) || []).filter((f) => big(f.atoms) > 0n)
  for (const f of moveFees) {
    const s3 = await short(f.asset, (f.asset === payAsset ? need : f.asset === feeAsset ? fee : 0n) + big(f.atoms))
    if (s3) return s3
  }
  const ticket = { payAsset, receiveAsset, amountIn: String(best.give), amountOut: String(best.receive),
    fees: [{ asset: feeAsset, atoms: String(fee) }, ...moveFees.map((f) => ({ asset: f.asset, atoms: String(f.atoms) }))], source: 'restricted',
    ...(mv ? { minutes: mv.minutes + TRADE_MINUTES } : {}) }
  return { ok: true, ticket, choice: { source: 'restricted', entry: best.e, give: best.give, receive: best.receive, feeAsset, fee,
    moveFees: moveFees.map((f) => ({ asset: f.asset, atoms: big(f.atoms) })) } }
}

// Confirms a restricted choice into `rec`: what it pays from is put on the chain, then the
// trade is taken. -> the record, 'sent' with its txid.
export async function restrictedConfirm (R, choice, rec, put) {
  const { ticket } = rec
  const needs = []
  if (!R.isRestricted(ticket.payAsset)) needs.push({ hex: ticket.payAsset, atoms: choice.give + (choice.feeAsset === ticket.payAsset ? choice.fee : 0n) })
  if (choice.feeAsset !== ticket.payAsset) needs.push({ hex: choice.feeAsset, atoms: choice.fee })
  rec.entry = choice.entry.id
  // While what it pays from is moved to the chain, the record says so (`movingSince`): a page that
  // opens again meanwhile follows the move, and never ends the trade as not made while it runs.
  rec.movingSince = Date.now()
  put(rec)
  try { await R.ensure(needs, (text) => { rec.note = text; put(rec) }) } finally { delete rec.movingSince }
  rec.note = null
  // The trade's txid is recorded before the broadcast: a broadcast whose answer is lost is
  // followed by it (the engine's uncertain step), never reported as nothing moved.
  // `only`: the coins of the asset paid that the trade pays from, and no other (a composed
  // purchase's second step pays from what its move put on the chain).
  const r = await R.take(choice.entry, { receive: choice.receive, feeAsset: choice.feeAsset, ...(choice.only ? { only: choice.only } : {}),
    onTxid: (txid) => { rec.txid = txid; put(rec) } })
  rec.txid = r.txid; rec.state = 'sent'; rec.sentAt = Date.now()
  return put(rec)
}

// Follows a restricted trade: Settled once a block holds it; Returned when the chain never shows
// it for `uncertainMs`.
export async function restrictedAdvance (R, rec, put, { now = Date.now, uncertainMs }) {
  const st = rec.txid ? await Promise.resolve(R.status(rec.txid)).catch(() => 'unknown') : 'unknown'
  rec.chainState = st
  if (st === 'confirmed') { rec.state = 'settled'; rec.settledAt = now() }
  else if (st === 'unknown') {
    if (rec.missingSince == null) rec.missingSince = now()
    if (now() - rec.missingSince >= uncertainMs) { rec.state = 'returned'; rec.error = 'the trade never reached the chain' }
  } else rec.missingSince = null
  return put(rec)
}
