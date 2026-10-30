// The single-step book: what user mode trades against, and nothing else.
//
// User mode abstracts by restriction, never by bridging (the "Wallets, DEX and apps" design,
// "How user mode hides the rail"): it offers only trades that complete in one native step and
// has no second path to fall back to. This module turns the book's sources into entries for one
// pair, sizes an entry for the amount a person pays, and chooses among the candidates. It is
// pure (no I/O, no DOM, no node: import) and is imported by the browser (user-trade.js) as
// unified-book.mjs is.
//
// The sources, each one step (settlement-router.mjs SINGLE_STEP_SOURCES says how each settles):
//   'leaf-maker'      a live leaf maker's quote of an in-tree swap: it gives the receive asset
//                     for the pay asset in one reassignment in the operator's tree.
//   'covenant-round'  a transparent covenant order on the relay's on-chain book that a round
//                     can take (unified-book caps.leaf_take), taken from leaves.
//   'leaf-resting'    an order resting as a leaf in the operator's tree, listed on the relay's
//                     book (its `resting_leaf` member) by a maker who may be away: one transfer
//                     in the tree that the operator co-signs, filled from the wallet's leaves.
//   'btc-gateway'     a live maker's quote of BTC for an asset, or of an asset for BTC: one
//                     hash-lock, the asset moving in the operator's tree under the hash and the
//                     BTC over Bitcoin Lightning under the same hash (user-trade-btc.js). BTC
//                     is never a leaf.
// A source that is not listed here never enters the book: submarine, sub-asset, pure
// Lightning, bridged and cross-chain on-chain offers stay in developer mode.
//
// Prices are integer ratios: an entry asks `rateNum` atoms of the pay asset for every `rateDen`
// atoms of the receive asset, rounded up against the taker, as both the swap offer and the
// covenant's fill leaf round it. Indicative only: the wallet's leaf library prices the firm
// terms (swap_read, take_quote) and the ticket shows those.

import { classifyRelayOffer } from './unified-book.mjs'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b

// The fewest parties who must act after the person confirms, per source (design 3.2).
export const SOURCE_PARTIES = Object.freeze({ 'onchain-fill': 0, 'covenant-round': 1, 'leaf-resting': 1, 'leaf-maker': 2, 'btc-gateway': 2 })

// The entries of a maker's quotes for the pair: the maker gives `receiveAsset` for `payAsset`.
// A quote names { give_asset, want_asset, rate_num, rate_den, max_give, min_give }, and the
// maker quotes only what it holds (max_give). A quote with BTC on one side ('BTC', in
// satoshis) is a 'btc-gateway' entry; any other is a 'leaf-maker' one.
export function makerEntries (maker, quotes, { payAsset, receiveAsset }) {
  const out = []
  for (const q of quotes || []) {
    if (!q || q.give_asset !== receiveAsset || q.want_asset !== payAsset) continue
    const rateNum = big(q.rate_num), rateDen = big(q.rate_den), max = big(q.max_give), min = big(q.min_give)
    if (rateNum <= 0n || rateDen <= 0n || max <= 0n || max < min) continue
    const source = q.give_asset === 'BTC' || q.want_asset === 'BTC' ? 'btc-gateway' : 'leaf-maker'
    out.push({ source, id: `${maker}#${q.give_asset}:${q.want_asset}`, maker, rateNum, rateDen,
      maxReceive: max, minReceive: min > 0n ? min : 1n, lot: 0n, raw: q })
  }
  return out
}

// The entries of the relay's offers for the pair that a round can take from leaves: transparent
// covenant orders selling `receiveAsset` for `payAsset` (unified-book caps.leaf_take).
export function covenantRoundEntries (offers, { payAsset, receiveAsset }) {
  const out = []
  for (const o of offers || []) {
    if (!o || o._verified === false) continue
    if ((o.offer_asset ?? o.offerAsset) !== receiveAsset || (o.want_asset ?? o.wantAsset) !== payAsset) continue
    const c = o.covenant || o.Covenant
    if (!c) continue
    const e = classifyRelayOffer(o, { quote: payAsset })
    if (!e || !e.meta || !e.meta.caps || !e.meta.caps.leaf_take) continue
    const rateNum = big(c.rate_num), rateDen = big(c.rate_den), locked = big(o.offer_amount), lot = big(c.min_lot)
    if (rateNum <= 0n || rateDen <= 0n || locked <= 0n) continue
    out.push({ source: 'covenant-round', id: `${c.covenant_txid}:${c.covenant_vout}`, rateNum, rateDen,
      maxReceive: locked, minReceive: lot > 0n ? lot : 1n, lot, raw: o })
  }
  return out
}

// The entries of the relay's transparent covenant orders selling `receiveAsset` for `payAsset`,
// taken on the chain from the wallet's own coins: every covenant order, whether or not a round
// could take it. Sized at the relay's live size when it has one.
export function onchainFillEntries (offers, { payAsset, receiveAsset }) {
  const out = []
  for (const o of offers || []) {
    if (!o || o._verified === false) continue
    if ((o.offer_asset ?? o.offerAsset) !== receiveAsset || (o.want_asset ?? o.wantAsset) !== payAsset) continue
    const c = o.covenant || o.Covenant
    if (!c) continue
    const rateNum = big(c.rate_num), rateDen = big(c.rate_den), lot = big(c.min_lot)
    const live = o._status && o._status.active_amount != null ? big(o._status.active_amount) : big(o.offer_amount)
    if (rateNum <= 0n || rateDen <= 0n || live <= 0n) continue
    out.push({ source: 'onchain-fill', id: `${c.covenant_txid}:${c.covenant_vout}`, rateNum, rateDen,
      maxReceive: live, minReceive: lot > 0n ? lot : 1n, lot, raw: o })
  }
  return out
}

// The entries of the relay's orders resting in the tree of the wallet's operator (`operator`, its
// key) that sell `receiveAsset` for `payAsset`: an order of another operator cannot be filled from
// this wallet's leaves. Sized at the relay's live size (statuses[i].active_amount, kept on an offer
// as `_status`); a fill takes at least a lot and leaves nothing or at least a lot.
export function restingEntries (offers, { payAsset, receiveAsset, operator }) {
  const out = []
  for (const o of offers || []) {
    if (!o || o._verified === false) continue
    const t = o.resting_leaf || o.restingLeaf
    if (!t || !operator || String(t.operator_key ?? t.operatorKey ?? '').toLowerCase() !== String(operator).toLowerCase()) continue
    if (String(t.asset_a ?? t.assetA) !== receiveAsset || String(t.asset_b ?? t.assetB) !== payAsset) continue
    const id = String(t.order_id ?? t.orderId ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(id)) continue
    const rateNum = big(t.rate_num ?? t.rateNum), rateDen = big(t.rate_den ?? t.rateDen), lot = big(t.min_lot ?? t.minLot)
    const live = o._status && o._status.active_amount != null ? big(o._status.active_amount) : big(t.value)
    if (rateNum <= 0n || rateDen <= 0n || live <= 0n) continue
    out.push({ source: 'leaf-resting', id, rateNum, rateDen, maxReceive: live, minReceive: lot > 0n ? lot : 1n, lot, raw: o })
  }
  return out
}

// What an entry gives for `payAtoms` of the pay asset, at its price, before fees: the most
// atoms of the receive asset whose price fits, within what it holds and its lot rules. A
// covenant order fills whole or leaves at least its min_lot resting. -> { receive, pay } or null.
export function sizeEntry (entry, payAtoms) {
  const pay = big(payAtoms)
  if (pay <= 0n) return null
  let r = (pay * entry.rateDen) / entry.rateNum
  if (r > entry.maxReceive) r = entry.maxReceive
  if (entry.lot > 0n && r < entry.maxReceive && entry.maxReceive - r < entry.lot) r = entry.maxReceive - entry.lot
  if (r < entry.minReceive || r <= 0n) return null
  return { receive: r, pay: ceilDiv(r * entry.rateNum, entry.rateDen) }
}

// The best of the candidates (design 3.2): the most received, then the fewest parties, then the
// lower id. A candidate is { source, id, receive (atoms, net of fees taken from it) }.
// Sources whose coin is the person's only once a round or a block is final, which waits on Bitcoin
// blocks (minutes, or longer when Bitcoin is slow): a take of a covenant order is paid in the
// operator's round, a fill on the chain in a block. The others hand the coin over in seconds.
export const SLOW_SOURCES = new Set(['covenant-round', 'onchain-fill'])
// How much more a slow source must give than the best fast one to be chosen, in basis points.
export const SLOW_PREMIUM_BPS = 50n

function bestOf (list) {
  const l = [...list]
  l.sort((a, b) => {
    const d = big(b.receive) - big(a.receive)
    if (d !== 0n) return d > 0n ? 1 : -1
    const p = (SOURCE_PARTIES[a.source] ?? 9) - (SOURCE_PARTIES[b.source] ?? 9)
    if (p) return p
    return String(a.id).localeCompare(String(b.id))
  })
  return l[0] || null
}

// The candidate a trade takes: the one that gives the most, except that one whose coin waits on
// Bitcoin blocks is taken over one handed over in seconds only when it gives SLOW_PREMIUM_BPS more.
export function chooseCandidate (cands) {
  const list = (cands || []).filter((c) => c && big(c.receive) > 0n)
  const fast = bestOf(list.filter((c) => !SLOW_SOURCES.has(c.source)))
  const slow = bestOf(list.filter((c) => SLOW_SOURCES.has(c.source)))
  if (!fast || !slow) return fast || slow
  return big(slow.receive) * 10000n > big(fast.receive) * (10000n + SLOW_PREMIUM_BPS) ? slow : fast
}

// The pairs and sources the drill has admitted on a chain (user-mode/pairs.json): the sources a
// pair may trade through in user mode, or [] when it is not admitted. A pair is directed (what is
// paid, what is received).
export function admittedSources (pairs, genesis, payAsset, receiveAsset) {
  const chain = pairs && pairs.chains && pairs.chains[genesis]
  if (!chain) return []
  const p = (chain.pairs || []).find((x) => x.pay === payAsset && x.receive === receiveAsset)
  return p ? [...(p.sources || [])] : []
}

// The assets the receive picker offers for a pay asset: those an admitted pair names.
export function admittedReceives (pairs, genesis, payAsset) {
  const chain = pairs && pairs.chains && pairs.chains[genesis]
  if (!chain) return []
  return [...new Set((chain.pairs || []).filter((x) => x.pay === payAsset && (x.sources || []).length).map((x) => x.receive))]
}
