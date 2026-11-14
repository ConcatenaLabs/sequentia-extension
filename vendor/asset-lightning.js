// AN ASSET TO ANOTHER OPERATOR'S WALLET, OVER LIGHTNING: the rule that decides, in default mode,
// whether a payment of a Sequentia asset to a receive code goes over Lightning between operators
// or to the code's address on the chain. It is Bitcoin's rule for BTC, in a reference currency:
//
//   1. The code's `sequentia` part names the payer's own operator: paid in the tree (default-arca.js).
//   2. The code carries an invoice in the asset (`lightning=`, an invoice of the receiver's operator
//      for a Lightning receive into its tree) for exactly the amount sent, and the payment is worth
//      no more than the limit in USD (`lightningLimitUsd`), and the payer's operator can carry it
//      (its node in the asset up, as much spendable as the amount), and the invoice's final lock
//      fits what the operator lets its node lock a payment for, with room for a hop on the way: paid over
//      Lightning, out of the tree, through the payer's operator's node to the receiver's.
//   3. Anything else: the code's address, and the review says why in one sentence.
//
// The limit is in USD, never in units of the asset: one unit of GOLD is worth thousands of USDX.
// The page sets it (window.SEQ_ASSET_LN_MAX_USD: a number of USD, or null for none); the default
// is DEFAULT_LIMIT_USD. An asset the price feed does not value cannot be held to it, so it goes to
// the address. A payment that goes over Lightning and fails comes back to the payer as a leaf of
// its own (the leaf library takes its htlc leaf back), and the review then offers the address.
//
// Every amount, fee and refusal of the payment itself is the leaf library's (`lightning_pay_quote`,
// `lightning_pay`): this module only names the route, from the invoice, the price and the
// operator's published information. It has no DOM, so it runs under Node (asset-lightning.test.mjs).
// Ambra mobile (app/lib/src/data/) and the browser extension route receive codes in their own code:
// give them the same rule.

import { decodeBolt11 } from './bolt11.js'

// The most a payment to another operator's wallet goes over Lightning for, in USD, unless the page
// names another. The page names none (null) and holds payments to the operator's published limit
// instead (lnMaxPayment).
export const DEFAULT_LIMIT_USD = 1000

// The operator's limit on one payment over its node for `kind` ('BTC', its Bitcoin gateway, or an
// asset) in direction `dir` ('out': a payment the wallet makes, 'in': one it receives), in atoms, as
// its `info` publishes it (`max_payment`: `send`, `receive`), or null when it publishes none. Its
// channels are shared by every user's payments and by the BTC legs of swaps, so the operator holds
// one payment to a share of what they carry, less what it keeps for swaps, and refuses a payment
// above it. A node that is down publishes 0. The limit is the operator's: the wallet holds none of
// its own, and pays on the chain above it.
export function lnMaxPayment (info, kind, dir) {
  const si = info && (info.server_info || info)
  const node = kind === 'BTC' ? si && si.lightning && si.lightning.bitcoin && si.lightning.bitcoin.node : operatorLeg(info, kind).node
  const v = node && node.max_payment && node.max_payment[dir === 'in' ? 'receive' : 'send']
  if (v == null || !/^\d+$/.test(String(v))) return null
  return big(v)
}

// Whether a payment of `atoms` fits the operator's limit `max` (lnMaxPayment). A limit that is not
// published holds nothing back here: the page then applies its fallback.
export function fitsMax (atoms, max) {
  return max == null || big(atoms) <= big(max)
}

// What one forwarding hop adds to a payment's lock, in blocks, as the rule counts it: well above
// what a SeqLN or Core Lightning node asks for by default (34 blocks), so the check does not hang
// on a node's setting.
export const HOP_CLTV_BLOCKS = 144

// The forwarding hops the lock must leave room for: the payer's operator's node pays the receiver's
// operator's node directly, and one node between them still fits.
export const HOPS_ALLOWED = 1

// The operator's stall margin for a payment out of its tree, in seconds (arcad's default, which its
// `info` does not publish): its node pays an invoice only along a route whose locks add up to at
// most half of the time to the payment leaf's timeout less this margin (arcad's `lock_bound`).
export const STALL_MARGIN_S = 6 * 3600

// How far past the operator's least timeout the leaf library sets a payment's leaf, in seconds.
export const LEAF_TIMEOUT_PAST_S = 600

const big = (v) => { if (typeof v === 'bigint') return v; try { return BigInt(v ?? 0) } catch { return 0n } }

// The page's limit in USD (`limit`, window.SEQ_ASSET_LN_MAX_USD): a positive number, null for
// none (every amount the operator can carry goes over Lightning), DEFAULT_LIMIT_USD when unset or
// not a number.
export function lightningLimitUsd (limit) {
  if (limit === null) return null
  const n = Number(limit)
  return limit !== undefined && limit !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT_USD
}

// The USD value of `atoms` of an asset of `precision` decimals at `usd` per unit, or null when the
// asset is not valued.
export function usdValue (atoms, precision, usd) {
  const p = Number(usd)
  if (!(p > 0) || !Number.isFinite(p)) return null
  return Number(big(atoms)) / Math.pow(10, Number(precision) || 0) * p
}

// Whether a payment whose last hop asks a final lock of `minFinalCltv` blocks fits what the payer's
// operator lets its node lock a payment for, with room for `hops` forwarding hops before the last.
// The operator's bound is arcad's `lock_bound`: the payment's leaf times out `timeoutSeconds`
// (info.lightning.send.timeout_seconds) and LEAF_TIMEOUT_PAST_S from now, and the route's locks may
// add up to half of that less STALL_MARGIN_S, in blocks of `blockSeconds`.
// -> { fits, needs, bound } in blocks.
export function lockFits (minFinalCltv, blockSeconds, timeoutSeconds, hops = HOPS_ALLOWED) {
  const b = Number(blockSeconds) > 0 ? Number(blockSeconds) : 60
  const t = Number(timeoutSeconds) || 0
  const bound = Math.max(0, Math.floor((t + LEAF_TIMEOUT_PAST_S - STALL_MARGIN_S) / 2 / b))
  const needs = (Number(minFinalCltv) >= 0 ? Number(minFinalCltv) : 0) + HOP_CLTV_BLOCKS * Math.max(0, hops)
  return { fits: t > 0 && needs <= bound, needs, bound }
}

// The payer's operator's published facts a payment over Lightning needs, from the leaf library's
// `info` (its `server_info`): the asset's node and the window and block time for a payment.
export function operatorLeg (info, asset) {
  const si = info && (info.server_info || info)
  const a = si && Array.isArray(si.assets) ? si.assets.find((x) => x && x.asset === asset) : null
  const send = si && si.lightning && si.lightning.send
  const recv = si && si.lightning && si.lightning.receive
  return {
    node: (a && a.lightning) || null,
    supervised: !!(a && a.supervised != null),
    timeoutSeconds: send && send.timeout_seconds != null ? Number(send.timeout_seconds) : null,
    blockSeconds: recv && recv.block_seconds != null ? Number(recv.block_seconds) : 60,
  }
}

// How a payment of `atoms` of `asset` to a receive code goes when the code's `sequentia` part is
// not for the payer's operator: { route: 'lightning', invoice } or { route: 'address', why }.
//   invoice      the code's `lightning` part (null when it has none)
//   asset        the asset sent (display hex)
//   atoms        the amount sent, in its atoms
//   precision    the asset's decimals
//   usd          its price in USD per unit, or null
//   limitUsd     lightningLimitUsd(window.SEQ_ASSET_LN_MAX_USD)
//   info         the payer's leaf library's info (null when it holds nothing with an operator)
//   nowSeconds   the time now
// `why` is one of: 'none' (no invoice in the asset, or no operator: nothing to say, the address is
// simply the way), 'amount' (the code asks another amount), 'expired', 'limit' (worth more than the
// limit), 'unpriced', 'unavailable' (the operator's node in the asset is down or missing), 'liquidity'
// (the operator cannot carry that much now), 'capacity' (more than the operator takes in one payment:
// its published limit, lnMaxPayment), 'lock' (the invoice's lock does not fit the window).
export function assetLightningRoute ({ invoice, asset, atoms, precision, usd, limitUsd, info, nowSeconds }) {
  if (!invoice || !info) return { route: 'address', why: 'none' }
  const d = decodeBolt11(String(invoice).toLowerCase())
  if (!d || !d.ok || d.chain !== 'seq' || !d.asset || d.asset !== asset) return { route: 'address', why: 'none' }
  if (d.amountMsat == null || d.amountMsat % 1000n !== 0n || d.amountMsat / 1000n !== big(atoms)) return { route: 'address', why: 'amount' }
  const now = Number(nowSeconds) || Math.floor(Date.now() / 1000)
  if (d.timestamp != null && d.expiry != null && Number(d.timestamp) + Number(d.expiry) <= now + 60) return { route: 'address', why: 'expired' }
  if (limitUsd != null) {
    const v = usdValue(atoms, precision, usd)
    if (v == null) return { route: 'address', why: 'unpriced' }
    if (v > limitUsd) return { route: 'address', why: 'limit' }
  }
  const leg = operatorLeg(info, asset)
  if (leg.supervised || !leg.node || leg.node.state !== 'up') return { route: 'address', why: 'unavailable' }
  if (leg.node.spendable != null && big(leg.node.spendable) < big(atoms)) return { route: 'address', why: 'liquidity' }
  if (!fitsMax(atoms, lnMaxPayment(info, asset, 'out'))) return { route: 'address', why: 'capacity' }
  if (!lockFits(d.minFinalCltv, leg.blockSeconds, leg.timeoutSeconds).fits) return { route: 'address', why: 'lock' }
  return { route: 'lightning', invoice: String(invoice).toLowerCase() }
}

// Whether a refusal of the leaf library or the operator, before or after a payment over Lightning
// left, means the way cannot carry it now (no route, too little on the way, the node down), as
// opposed to a refusal about the payer's own coins: the address is offered then.
export function isRouteRefusal (e) {
  const s = String((e && (e.message || e.reason)) || e || '')
  return /no route|route not found|unable to route|insufficient|liquidity|capacity|temporary_channel_failure|channel_disabled|node in asset .* is down|runs no Lightning node|failed/i.test(s)
}

// The receive side: the assets this wallet's operator receives over Lightning in (up, receiving,
// not supervised), from the leaf library's `info`.
export function receivableAssets (info) {
  const si = info && (info.server_info || info)
  const assets = si && Array.isArray(si.assets) ? si.assets : []
  return assets.filter((a) => a && typeof a.asset === 'string' && a.supervised == null && a.lightning &&
    a.lightning.state === 'up' && a.lightning.receives === true).map((a) => a.asset)
}

// What a Lightning receive the wallet asked for, as the leaf library lists it (`lightning_receives`
// under its hash), means for the code that carries its invoice: 'open' while it can still be paid,
// 'paid' once a payment is held for it (the code then shows a new one), 'gone' when it lapsed or
// failed.
export function receiveState (rec, nowSeconds) {
  if (!rec) return 'gone'
  const s = String(rec.state || '')
  if (s === 'requested' || s === 'waiting') {
    const now = Number(nowSeconds) || Math.floor(Date.now() / 1000)
    return rec.expires_at == null || Number(rec.expires_at) > now ? 'open' : 'gone'
  }
  if (s === 'failed') return 'gone'
  return 'paid'
}

// A payment of one of the wallet's invoices in an asset reaches it only through `sync`: the library
// asks the operator how the receive stands, follows the participation that wants its leaf in the
// operator's next round, and claims the leaf, which the operator releases to no one but this
// wallet. On the library's own schedule that sync comes a quarter of the operator's receive window
// after the invoice was asked (90 minutes on a six-hour window), while the payer reads "paying".
//
// So the page follows every such receive itself, whatever the Receive card shows and with the tab
// in front or behind (the payer is most often another tab). While nothing is paid it asks the
// operator only how the receive stands (`lightning_receive_status`, one small request): every
// RECEIVE_STATUS_MS while the invoice is fresh, every RECEIVE_STATUS_IDLE_MS once it is older. It
// syncs once the operator holds a payment for it, and then every RECEIVE_SYNC_MS until the leaf is
// the wallet's: the leaf comes in a round, about a minute, and the sync is what takes it.
export const RECEIVE_STATUS_MS = 3_000
export const RECEIVE_STATUS_IDLE_MS = 30_000
export const RECEIVE_SYNC_MS = 10_000
// How long an invoice counts as fresh, measured from its lapse back by the operator's invoice
// expiry (RECEIVE_INVOICE_EXPIRY_S when the operator's info does not say).
export const RECEIVE_FRESH_S = 10 * 60
export const RECEIVE_INVOICE_EXPIRY_S = 3600

// Whether a receive the library lists (`lightning_receives` under its hash) still waits on a sync to
// move on: asked and not lapsed (`requested`, `waiting`: the operator may hold a payment for it),
// or held and its leaf on the way (`issuing`, `claiming`). `received` and `failed` are done.
export function receiveMovesOnSync (rec, nowSeconds) {
  if (!rec) return false
  const s = String(rec.state || '')
  if (s === 'issuing' || s === 'claiming') return true
  return receiveState(rec, nowSeconds) === 'open'
}

// What the page does next for one receive, and how often: { action: 'status' | 'sync', everyMs },
// or null when it waits on nothing. `waiting` is asked about (`status`); `requested` (the operator
// never answered the request) and a payment held (`issuing`, `claiming`) are synced.
export function receivePlan (rec, nowSeconds, expiryS = RECEIVE_INVOICE_EXPIRY_S) {
  if (!receiveMovesOnSync(rec, nowSeconds)) return null
  const s = String(rec.state || '')
  if (s === 'issuing' || s === 'claiming') return { action: 'sync', everyMs: RECEIVE_SYNC_MS }
  if (s === 'requested') return { action: 'sync', everyMs: RECEIVE_STATUS_IDLE_MS }
  const age = rec.expires_at == null ? Infinity : Number(expiryS) - (Number(rec.expires_at) - Number(nowSeconds))
  return { action: 'status', everyMs: age < RECEIVE_FRESH_S ? RECEIVE_STATUS_MS : RECEIVE_STATUS_IDLE_MS }
}

// Whether the operator's answer to `lightning_receive_status` means the wallet should sync now: a
// payment is held for the receive (`accepted`), its leaf claimed already (`claimed`), or it was
// failed back (`cancelled`), which the library records only in a sync.
export function statusMovesOn (status) {
  const s = String((status && status.state) || '')
  return s === 'accepted' || s === 'claimed' || s === 'cancelled'
}

export const __test__ = { big }
