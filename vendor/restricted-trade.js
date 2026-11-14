// Restricted assets (OpenAMP: each transfer judged and co-signed by the asset's policy server)
// trade on the chain only, between accounts that server approves. This module is the taker's
// side of both ways such an asset trades, for the default composer's engine (user-trade.js) and
// for tests: it has no DOM, no wasm and no network of its own; the page hands it a host.
//
// - An online maker's quote (offer member 29, RestrictedTerms, quoted in another asset): one
//   transaction moves both legs (delivery against payment). The taker builds it, both sides
//   check the whole of it (checkTrade, the port of seqdex pkg/restricted CheckTrade), the policy
//   server judges it before anyone signs (POST /v1/check), and broadcasts it once both have
//   (POST /v1/cosign with "broadcast": true). The wire is seqdex's XcMsg over the relay courier
//   (internal/seqob/client/xdriver_restricted_dvp.go): dvp_request, dvp_coins, dvp_tx,
//   dvp_signed, dvp_done.
// - A gated order (offer member 30, GatedOrderTerms): a maker's coin that only the policy
//   server's signature fills, at the maker's price. The taker builds the fill with its own inputs
//   signed and the policy server co-signs and broadcasts it in one step.
//
// Bitcoin never pays a restricted asset here directly: a purchase with bitcoin goes through an
// asset that bitcoin buys and that buys the restricted asset (btcRoute), or the screen names the
// assets that buy it now (btcCard). A buyer the asset's issuer has not approved is told whom to
// ask (approvalCard). Nothing here says such an asset cannot be traded.
//
// Asset ids are display hex throughout, as the page uses them; transaction bytes carry them in
// internal order (reversed).

import { sha256 } from './btc.js'
import { bytesToHex, hexToBytes } from './seqob.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
export const rev = (h) => (String(h || '').toLowerCase().match(/../g) || []).reverse().join('')
const key = (txid, vout) => `${String(txid).toLowerCase()}:${Number(vout)}`
const BTC = 'BTC'

// Every input of a trade: final, so it signals no replacement and meets no relative lock
// (seqdex restricted.Sequence). A reorg that un-mines the trade returns it whole to the mempool.
export const FINAL_SEQUENCE = 0xffffffff
// The size a trade's or a fill's fee is reckoned for (seqdex dvpFeeVBytes).
export const TRADE_VBYTES = 1200n
// How long the seller's signatures on a trade stay usable at the policy server.
export const EXPIRY_S = 300
// How long the taker waits for each answer of the maker.
export const STEP_MS = 30_000

// ---------------------------------------------------------------- the transaction, read

// An Elements transaction from its hex: what checkTrade and the signature checks read.
// -> { version, locktime, inputs: [{ txid (display), vout, sequence, witness: [hex] }],
//      outputs: [{ asset (display) | null, value (BigInt) | null, script (hex), nonce }], txid }
export function readTx (hex) {
  const b = hexToBytes(String(hex || ''))
  let p = 0
  const need = (n) => { if (p + n > b.length) throw new Error('the transaction is cut short'); const s = b.subarray(p, p + n); p += n; return s }
  const u32 = () => { const s = need(4); return (s[0] | (s[1] << 8) | (s[2] << 16) | (s[3] << 24)) >>> 0 }
  const varint = () => {
    const f = need(1)[0]
    if (f < 0xfd) return f
    if (f === 0xfd) { const s = need(2); return s[0] | (s[1] << 8) }
    if (f === 0xfe) return u32()
    const lo = u32(); const hi = u32(); return hi * 2 ** 32 + lo
  }
  const vbytes = () => need(varint())
  const conf = (explicitLen, prefixes) => {
    const t = need(1)[0]
    if (t === 0) return { kind: 'null', bytes: new Uint8Array(0) }
    if (t === 1) return { kind: 'explicit', bytes: need(explicitLen) }
    if (prefixes.includes(t)) return { kind: 'commitment', bytes: need(32) }
    throw new Error('an unknown confidential prefix ' + t)
  }
  const start = p
  const version = u32()
  const flags = need(1)[0]
  const afterFlags = p
  const nin = varint()
  const inputs = []
  for (let i = 0; i < nin; i++) {
    const h = need(32); let vout = u32()
    let issuance = false
    if (vout !== 0xffffffff) { issuance = !!(vout & 0x80000000); vout = vout & 0x3fffffff }
    vbytes()
    const sequence = u32()
    if (issuance) { need(64); conf(8, [8, 9]); conf(8, [8, 9]) }
    inputs.push({ txid: bytesToHex(Uint8Array.from(h).reverse()), vout, sequence, issuance, witness: [] })
  }
  const nout = varint()
  const outputs = []
  for (let i = 0; i < nout; i++) {
    const a = conf(32, [10, 11]); const v = conf(8, [8, 9]); const n = conf(32, [2, 3])
    const script = bytesToHex(vbytes())
    let value = null
    if (v.kind === 'explicit') { value = 0n; for (const x of v.bytes) value = (value << 8n) | BigInt(x) }
    outputs.push({ asset: a.kind === 'explicit' ? bytesToHex(Uint8Array.from(a.bytes).reverse()) : null, value, script,
      nonce: n.kind === 'null' ? null : bytesToHex(n.bytes) })
  }
  const lockPos = p
  const locktime = u32()
  const bodyEnd = p
  if (flags & 1) {
    for (const i of inputs) {
      vbytes(); vbytes()
      const n = varint(); for (let k = 0; k < n; k++) i.witness.push(bytesToHex(vbytes()))
      const m = varint(); for (let k = 0; k < m; k++) vbytes()
    }
    for (const o of outputs) { o.surjection = vbytes().length; o.rangeproof = vbytes().length }
  }
  if (p !== b.length) throw new Error('the transaction has bytes past its end')
  // The txid is over the transaction without its witness: flags 0.
  const noWit = new Uint8Array(bodyEnd - start)
  noWit.set(b.subarray(start, afterFlags - 1), 0)
  noWit[afterFlags - 1 - start] = 0
  noWit.set(b.subarray(afterFlags, bodyEnd), afterFlags - start)
  void lockPos
  const txid = bytesToHex(sha256(sha256(noWit)).reverse())
  return { version, locktime, inputs, outputs, txid, bodyEnd }
}

// ---------------------------------------------------------------- the trade, checked

// What one side checks of a trade before it signs anything of it (seqdex restricted.CheckTrade),
// from the transaction itself and the coins its inputs spend (`coins[i]` for input i:
// { txid, vout, asset, value, script }):
// - lock time 0 and every input final: no time-gated refund shares the trade, and it signals no
//   replacement;
// - every input of ours (by the wallet or a script of ours) is one we offered, and every coin we
//   offered is spent;
// - every output explicit; each of `gets` paid by its own output at a script of ours;
// - per asset, what comes back plus what we agreed to give covers what we put in plus what we are
//   owed: an output counts once;
// - one asset pays the fee, at least feeFloor(asset) of it.
// side: { offered: [coin], walletOwns: Set('txid:vout'), ours: [script hex], gives: {asset: atoms},
//         gets: [{ asset, value, script }], feeFloor(asset) -> atoms (optional) }
// -> null when it passes, else the reason.
export function checkTrade (tx, coins, side) {
  if (tx.locktime !== 0) return `the trade has lock time ${tx.locktime}, not 0`
  if (coins.length !== tx.inputs.length) return `the trade names ${coins.length} coins for ${tx.inputs.length} inputs`
  const ours = (s) => !!s && (side.ours || []).some((o) => o && o.toLowerCase() === String(s).toLowerCase())
  const offered = new Map()
  const into = new Map()
  const add = (m, a, v) => m.set(a, (m.get(a) || 0n) + big(v))
  for (const c of side.offered || []) { offered.set(key(c.txid, c.vout), true); add(into, c.asset, c.value) }
  for (const [i, ti] of tx.inputs.entries()) {
    if (ti.sequence !== FINAL_SEQUENCE && ti.sequence !== 0xfffffffe) return `input ${i} has sequence ${ti.sequence.toString(16)}, which signals replacement or a relative lock`
    const k = key(ti.txid, ti.vout)
    if (key(coins[i].txid, coins[i].vout) !== k) return `input ${i} spends ${k}, and its coin is named ${key(coins[i].txid, coins[i].vout)}`
    if (offered.has(k)) { offered.delete(k); continue }
    if (side.walletOwns && side.walletOwns.has(k)) return `the trade spends ${k}, a coin of ours not offered`
    if (ours(coins[i].script)) return `the trade spends ${k} at a script of ours, not offered`
  }
  if (offered.size) return 'the trade leaves out coins we offered'
  const back = new Map(); const fee = new Map()
  for (const o of tx.outputs) {
    if (o.asset == null || o.value == null || o.nonce) return 'the trade carries a confidential output'
    if (!o.script) add(fee, o.asset, o.value)
    else if (ours(o.script)) add(back, o.asset, o.value)
  }
  const used = new Array(tx.outputs.length).fill(false)
  const owed = new Map()
  for (const g of side.gets || []) {
    if (!ours(g.script)) return `we are to be paid at ${g.script}, a script not ours`
    const i = tx.outputs.findIndex((o, j) => !used[j] && o.script.toLowerCase() === g.script.toLowerCase() && o.asset === g.asset && o.value >= big(g.value))
    if (i < 0) return `the trade does not pay ${g.value} of ${g.asset} to ${g.script}`
    used[i] = true; add(owed, g.asset, g.value)
  }
  for (const a of new Set([...into.keys(), ...owed.keys()])) {
    const inA = into.get(a) || 0n; const owedA = owed.get(a) || 0n; const backA = back.get(a) || 0n; const gives = big((side.gives || {})[a])
    if (backA + gives < inA + owedA) {
      return inA > backA ? `the trade takes ${inA + owedA - backA} of ${a} from us, more than the ${gives} agreed`
        : `the trade pays us ${backA - inA} of ${a}, less than the ${owedA} owed`
    }
  }
  if (fee.size !== 1) return `the trade pays its fee in ${fee.size} assets, not one`
  if (side.feeFloor) {
    for (const [a, v] of fee) {
      let min
      try { min = big(side.feeFloor(a)) } catch (e) { return `the fee in ${a}: ${e && e.message}` }
      if (v < min) return `the trade pays a fee of ${v} ${a}, below our floor of ${min}`
    }
  }
  return null
}

// After a wallet signed: only the inputs it offered carry a witness it added, and nothing else of
// the trade changed. A wallet signs every input it knows; a trade in which it signed another is
// refused (seqdex Node.SignOffered). -> null or the reason.
export function checkSigned (before, after, offeredInputs) {
  if (before.txid !== after.txid) return 'the wallet signed another transaction'
  const may = new Set(offeredInputs)
  for (const [i, ti] of after.inputs.entries()) {
    const had = (before.inputs[i].witness || []).join(',')
    const has = (ti.witness || []).join(',')
    if (has !== had && !may.has(i)) return `the wallet would sign input ${i}, a coin not offered`
  }
  for (const i of may) if (!(after.inputs[i].witness || []).length) return `the wallet did not sign input ${i}`
  return null
}

// The trade's layout (seqdex restricted.BuildDvP): inputs the seller's enclave coins, the buyer's
// coins, the fee payer's coins, each final; outputs 0 the asset to the buyer's enclave, 1 the
// payment to the seller, then the seller's change of the asset home to its enclave, the buyer's
// change, the fee payer's change, the fee. -> { inputs: [coin], outputs: [{ asset, value, script }],
// sellerInputs: [index] }
export function dvpLayout (d) {
  if (d.feeAsset === d.asset) throw new Error('the fee is never paid in the restricted asset')
  const sum = (cs, a) => cs.reduce((n, c) => { if (c.asset !== a) throw new Error(`coin ${c.txid}:${c.vout} is not ${a}`); return n + big(c.value) }, 0n)
  const A = sum(d.sellerCoins, d.asset); const B = sum(d.buyerCoins, d.assetB); const F = sum(d.feeCoins, d.feeAsset)
  if (A < big(d.value) || B < big(d.price) || F < big(d.fee)) throw new Error(`the coins hold ${A} of ${d.value}, ${B} of ${d.price}, ${F} of the fee ${d.fee}`)
  const outputs = [{ asset: d.asset, value: big(d.value), script: d.buyerEnclave }, { asset: d.assetB, value: big(d.price), script: d.sellerRecv }]
  if (A > big(d.value)) outputs.push({ asset: d.asset, value: A - big(d.value), script: d.sellerEnclave })
  if (B > big(d.price)) outputs.push({ asset: d.assetB, value: B - big(d.price), script: d.buyerChange })
  if (F > big(d.fee)) outputs.push({ asset: d.feeAsset, value: F - big(d.fee), script: d.feeChange })
  outputs.push({ asset: d.feeAsset, value: big(d.fee), script: '' })
  const inputs = [...d.sellerCoins, ...d.buyerCoins, ...d.feeCoins]
  return { inputs, outputs, sellerInputs: d.sellerCoins.map((_, i) => i) }
}

// The seller's expiry digest: tagged_hash("openamp-dvp-v1", txid || expires_at), txid the 32
// bytes of the display id, expires_at 8 bytes big-endian (openamp README, "Trades"). The page
// signs it with its enclave key; no site can ask for it (the page API's tag policy refuses
// openamp- tags).
export function expiryDigest (txid, expiresAt) {
  const tag = sha256(new TextEncoder().encode('openamp-dvp-v1'))
  const t = new Uint8Array(8); let v = BigInt(expiresAt)
  for (let i = 7; i >= 0; i--) { t[i] = Number(v & 0xffn); v >>= 8n }
  const m = new Uint8Array(64 + 32 + 8)
  m.set(tag, 0); m.set(tag, 32); m.set(hexToBytes(txid), 64); m.set(t, 96)
  return bytesToHex(sha256(m))
}

// ---------------------------------------------------------------- what the book offers

const rt = (o) => o && o.restricted
const gated = (o) => o && (o.gated_order || o.gatedOrder)
const dirOf = (o) => String(o.trade_dir || o.tradeDir || '')
// The offer's pair, as the relay serves it (`pair`), its base the restricted asset.
const baseOf = (o) => String((o.pair && (o.pair.base_asset || o.pair.baseAsset)) || o.base_asset || o.baseAsset || '').toLowerCase()
const quoteOf = (o) => String((o.pair && (o.pair.quote_asset || o.pair.quoteAsset)) || o.quote_asset || o.quoteAsset || '').toLowerCase()

// The book's restricted entries for a directed pair, the engine's way (single-step-book.mjs):
// rateNum atoms paid per rateDen received. A maker's quote trades whole (its amount, no part);
// a gated order fills from its least lot to what it holds now. Only offers whose signature
// verifies (`_verified`), and never one quoted in bitcoin.
// -> [{ source: 'restricted', kind: 'dvp' | 'gated', id, rateNum, rateDen, minReceive, maxReceive,
//       whole, raw }]
export function restrictedEntries (offers, { payAsset, receiveAsset }) {
  const out = []
  for (const o of offers || []) {
    if (!o || o._verified !== true) continue
    const base = baseOf(o)
    const quote = quoteOf(o)
    const r = rt(o)
    if (r) {
      if (quote === BTC || /^btc$/i.test(quote) || !/^[0-9a-f]{64}$/.test(quote)) continue
      const value = big(o.base_amount || o.baseAmount)
      const sells = /SELL/.test(dirOf(o))
      // A maker selling the base takes the quote asset (want_amount); buying it, pays offer_amount.
      const price = big(sells ? (o.want_amount || o.wantAmount) : (o.offer_amount || o.offerAmount))
      if (value <= 0n || price <= 0n) continue
      if (sells && payAsset === quote && receiveAsset === base) {
        out.push({ source: 'restricted', kind: 'dvp', id: o.offer_id || o.offerId, rateNum: price, rateDen: value, minReceive: value, maxReceive: value, whole: true, raw: o })
      } else if (!sells && payAsset === base && receiveAsset === quote) {
        out.push({ source: 'restricted', kind: 'dvp', id: o.offer_id || o.offerId, rateNum: value, rateDen: price, minReceive: price, maxReceive: price, whole: true, raw: o })
      }
      continue
    }
    const g = gated(o)
    if (g) {
      const a = rev(g.asset_a || g.assetA); const b = rev(g.asset_b || g.assetB)
      // The order's own terms name the pair it is listed under.
      if (a !== base || b !== quote) continue
      if (payAsset !== b || receiveAsset !== a) continue
      const num = big(g.rate_num || g.rateNum); const den = big(g.rate_den || g.rateDen)
      if (num <= 0n || den <= 0n) continue
      const active = o._status && o._status.active_amount != null ? big(o._status.active_amount) : big(o.base_amount || o.baseAmount)
      if (active <= 0n) continue
      const minLot = big(g.min_lot || g.minLot) || 1n
      out.push({ source: 'restricted', kind: 'gated', id: `${g.covenant_txid || g.covenantTxid}:${g.covenant_vout ?? g.covenantVout ?? 0}`,
        rateNum: num, rateDen: den, minReceive: minLot, maxReceive: active, whole: false, raw: o })
    }
  }
  return out
}

// The restricted asset and the policy server an entry trades under.
export function entryAsset (e) {
  const o = e.raw
  if (e.kind === 'gated') { const g = gated(o); return { asset: rev(g.asset_a || g.assetA), policy: g.policy_server || g.policyServer, makerAid: g.maker_aid || g.makerAid } }
  const r = rt(o)
  return { asset: baseOf(o), policy: r.policy_server || r.policyServer, makerAid: r.maker_aid || r.makerAid }
}

// A gated fill's amounts (the SeqDEX fill covenant behind the policy key): what is paid for
// `filled` atoms, ceil(filled * num / den), and what rests again; a fill and a remainder below
// the order's least lot are refused, as the covenant refuses them. -> { filled, required, remainder }
export function gatedFill (terms, locked, filled) {
  const num = big(terms.rate_num || terms.rateNum); const den = big(terms.rate_den || terms.rateDen)
  const minLot = big(terms.min_lot || terms.minLot)
  locked = big(locked); filled = big(filled)
  if (filled <= 0n || filled > locked) throw new Error(`a fill of ${filled} of ${locked}`)
  if (filled < minLot) throw new Error(`a fill below the order's least lot ${minLot}`)
  const remainder = locked - filled
  if (remainder !== 0n && remainder < minLot) throw new Error(`a remainder below the order's least lot ${minLot}`)
  return { filled, required: (filled * num + den - 1n) / den, remainder }
}

// ---------------------------------------------------------------- words

// Every word the default screen can show for a restricted trade. None is a word of
// USER_MODE_FORBIDDEN_WORDS (restricted-trade.test.mjs checks).
export const RESTRICTED_WORDS = Object.freeze({
  approvalNamed: (issuer, ticker) => `Only holders approved by ${issuer} can hold ${ticker}. Ask them to approve this wallet, then come back to buy.`,
  approvalUnnamed: (ticker) => `Only approved holders can hold ${ticker}. Ask its issuer to approve this wallet and give them your approval code.`,
  copyCode: 'Copy your approval code',
  openPage: (issuer) => `Open ${issuer}'s page`,
  // Why, in plain words, by the policy server's code (openamp README, eligibility), for the
  // refusals approval cures (APPROVAL_CODES).
  reasons: Object.freeze({
    frozen: 'This wallet is paused for this asset by its issuer.',
    category: 'This wallet is not yet approved for this asset.',
    category_denied: 'This wallet is not approved for this asset at the moment.',
    unregistered: 'This wallet is not yet known to this asset\'s issuer.',
    not_whitelisted: 'This wallet is not yet approved for this asset.',
  }),
  sellerHeld: 'The seller cannot sell this asset right now. Try another offer, or come back later.',
  // A refusal that approval does not cure: its own words, and no request for approval.
  waits: Object.freeze({
    lockin: (t, date) => (date ? `${t} can change hands from about ${date}, as its issuer set.` : `${t} cannot change hands yet: its issuer set a date from which it can.`),
    vesting: (t, date) => (date ? `Part of this ${t} is still vesting, until about ${date}. Try a smaller amount, or come back then.` : `Part of this ${t} is still vesting. Try a smaller amount, or come back later.`),
    holder_cap: (t) => `${t} has as many holders as its issuer allows right now. Come back later.`,
    receive_window: (t, date) => (date ? `This wallet can receive ${t} from about ${date}, as its issuer set.` : `This wallet can receive ${t} from a later date, as its issuer set.`),
    limit: () => 'That is more than this asset allows in one trade: try a smaller amount.',
    velocity: () => 'That is more of this asset than can change hands today: try a smaller amount, or come back later.',
    other: (t) => `${t}'s issuer does not allow this trade right now. Come back later.`,
  }),
  btcVia: (ticker, via) => `Bitcoin buys ${via}, and ${via} buys ${ticker}. Get ${via} first, then trade it for ${ticker}.`,
  btcOther: (ticker, list) => `${ticker} is bought with ${list}. Choose one to pay with; paying with bitcoin directly comes with a network upgrade.`,
  payWith: (t) => `Pay with ${t}`,
  getIn: (t) => `Get ${t}`,
  btcViaSell: (ticker, via) => `${ticker} buys ${via}, and ${via} buys bitcoin. Trade ${ticker} for ${via} first, then ${via} for bitcoin.`,
  btcOtherSell: (ticker, list) => `${ticker} is sold for ${list}. Choose what to get; getting bitcoin directly comes with a network upgrade.`,
  noneSelling: (ticker) => `No one is selling ${ticker} right now. Check back later.`,
  noneBuying: (ticker) => `No one is buying ${ticker} right now. Check back later.`,
  viaHeld: (via) => `Your bitcoin bought ${via}; it is yours to trade or send.`,
  viaWaiting: (via, ticker) => `Your bitcoin bought ${via}. It buys ${ticker} by itself as soon as an offer allows; until then the ${via} is yours.`,
  viaKeep: (amount) => `You also get ${amount}.`,
  // The true wait, on the ticket before the person confirms: what it pays from is moved to the chain first.
  takes: (minutes) => `Takes about ${minutes} minutes, as what you pay is first moved to where this trade is made. Keep this page open.`,
  viaApproval: (via, ticker) => `Your bitcoin bought ${via}. It buys ${ticker} once its issuer approves this wallet; until then the ${via} is yours.`,
})

// The approval card of a refusal (RA1 design 5.2): whom to ask, taking the first of the asset's
// own page, the contract's domain, its registry entry and the policy server operator's page that
// exists; never an empty name or a dead link. `elig` is GET /v1/eligibility's answer; `asset`:
// { ticker, entity: { name, url } | null, domain }; `code` the approval code (the account id).
// -> { text, reason, code, link: { text, url } | null }
// Only a refusal that approval cures asks for it (APPROVAL_CODES); any other (a lock-in, a holder
// cap, a receive window, vesting, a limit, the issuer's rules, the seller's own state) is said in
// its own words, with the date it ends where the policy server's reason names a height, and
// carries no code and no link. `opts`: { blockSeconds, now() in ms }.
export const APPROVAL_CODES = Object.freeze(new Set(['unregistered', 'not_whitelisted', 'category', 'category_denied', 'frozen']))
export function approvalCard (elig, asset, code, { blockSeconds = 60, now = Date.now } = {}) {
  const ticker = asset.ticker
  const why = elig && elig.code
  if (why && !APPROVAL_CODES.has(why)) {
    const W = RESTRICTED_WORDS.waits
    if (/^sender_/.test(why)) return { text: RESTRICTED_WORDS.sellerHeld, reason: null, code: null, link: null }
    let date = null
    const until = /(?:until|from) height (\d+)/.exec(String(elig.reason || ''))
    const at = Number(elig.height)
    if (until && at > 0 && Number(until[1]) > at) {
      date = new Date(now() + (Number(until[1]) - at) * blockSeconds * 1000).toUTCString().slice(5, 16)
    }
    const f = W[why] || W.other
    return { text: f(ticker, date), reason: null, code: null, link: null }
  }
  const ob = (elig && elig.onboarding) || null
  const op = (elig && elig.operator_onboarding) || null
  const url = (u) => (typeof u === 'string' && /^https:\/\/[^\s/]+/.test(u) ? u : null)
  let name = null; let link = null
  if (ob && url(ob.url)) { name = ob.name || null; link = url(ob.url) }
  else if (asset.domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(asset.domain)) { name = asset.entity && asset.entity.name; link = 'https://' + asset.domain }
  else if (asset.entity && (asset.entity.name || url(asset.entity.url))) { name = asset.entity.name || null; link = url(asset.entity.url) }
  else if (op && url(op.url)) { name = op.name || null; link = url(op.url) }
  name = name && String(name).trim() ? String(name).trim() : null
  const text = name ? RESTRICTED_WORDS.approvalNamed(name, ticker) : RESTRICTED_WORDS.approvalUnnamed(ticker)
  const reason = (elig && RESTRICTED_WORDS.reasons[elig.code]) || null
  return { text, reason, code, link: link ? { text: RESTRICTED_WORDS.openPage(name || ticker + ' issuer'), url: link } : null }
}

// ---------------------------------------------------------------- bitcoin for a restricted asset

// How bitcoin buys a restricted asset R: through an asset X that bitcoin buys on the ordinary
// paths and that buys R from the book. `buyers` are the assets the book takes for R
// ([{ asset, rate }] best first, rate = X atoms per R atom); `btcBuys(X)` says whether bitcoin
// buys X now. -> { via: X } | { card: { text, choices: [X] } }
export function btcRoute (ticker, buyers, btcBuys, name = (a) => a, sell = false) {
  const seen = new Set(); const xs = []
  for (const b of buyers || []) if (b && b.asset && b.asset !== BTC && !seen.has(b.asset)) { seen.add(b.asset); xs.push(b.asset) }
  const via = xs.find((x) => btcBuys(x))
  if (via) return { via }
  if (!xs.length) return { card: { text: sell ? RESTRICTED_WORDS.noneBuying(ticker) : RESTRICTED_WORDS.noneSelling(ticker), choices: [] } }
  const names = xs.map(name)
  const list = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1]
  return { card: { text: (sell ? RESTRICTED_WORDS.btcOtherSell : RESTRICTED_WORDS.btcOther)(ticker, list), choices: xs } }
}

// ---------------------------------------------------------------- the taker

// host (the page's, or a test's):
//   policy(base)           -> { asset(id), enclaveScript(aid, asset), eligibility({ asset, aid, atoms, from }),
//                               check(body), cosign(body) }
//   aid()                  -> the wallet's account id at the policy server
//   enclave(asset)         -> { script, leaf, control } of the wallet's enclave for the asset
//   enclaveCoins(asset)    -> the wallet's unspent explicit coins of the asset at its enclave
//   walletCoins(asset, atoms) -> its own coins of an asset covering atoms (throws when it cannot)
//   walletOwns()           -> Set('txid:vout') of every coin the wallet would sign
//   coinsAt([{ txid, vout }]) -> unspent explicit coins there, or throws
//   newScript()            -> a fresh script of the wallet's (hex)
//   feeAtoms(asset, vbytes) -> the fee in that asset (throws when the network takes no fee in it)
//   build(inputs, outputs) -> the unsigned trade's hex (each input final, lock time 0)
//   signWallet(hex, coins) -> the hex with the wallet's own inputs signed
//   signEnclave(hex, coins, inputs, enclave) -> { 'i': sig } for its enclave inputs
//   signDigest(hex32)      -> a BIP340 signature by its enclave key
//   courier(entry)         -> { send(msg), recv(type, ms), close() } to the entry's maker
//   now()                  -> seconds
//   chainTime()            -> the chain tip's median time, seconds (optional)
// -> { txid }

// A maker's quote: the trade, one transaction. `entry` from restrictedEntries; `feeAsset` the
// asset the taker pays the fee in (never the restricted one).
export async function takeDvP (host, entry, { feeAsset, onTxid }) {
  const o = entry.raw; const r = rt(o)
  const asset = baseOf(o)
  const assetB = quoteOf(o)
  const makerSells = /SELL/.test(dirOf(o))
  const value = big(o.base_amount || o.baseAmount)
  const price = big(makerSells ? (o.want_amount || o.wantAmount) : (o.offer_amount || o.offerAmount))
  if (!feeAsset || feeAsset === asset) throw refusal('the fee is paid in an asset other than the one sold')
  const policy = host.policy(r.policy_server || r.policyServer)
  // The offer's policy key is the one its policy server lists for the asset.
  const px = policyKeyOf(await policy.asset(asset))
  if (px !== String(r.policy_x || r.policyX || '').toLowerCase()) throw refusal('the offer\'s policy key is not the one its policy server lists')
  const aid = host.aid()
  const makerAid = r.maker_aid || r.makerAid
  const policyUrl = r.policy_server || r.policyServer
  const mine = await host.enclave(asset, policyUrl)
  const makerEnclave = await policy.enclaveScript(makerAid, asset)
  const fee = big(await host.feeAtoms(feeAsset, TRADE_VBYTES))
  const owns = await host.walletOwns()
  const c = await host.courier(entry)
  // Until the trade goes to its broadcast, nothing of the wallet's has left it signed: a maker that
  // refuses, does not answer or answers out of turn before then has moved nothing, and the trade
  // is refused at once, never followed as one that may have been made (#697).
  let sent = false
  try {
    return await dvpSteps()
  } catch (e) {
    if (sent || (e && e.kind === 'refused')) throw e
    throw refusal(String((e && e.message) || e))
  } finally { try { c.close() } catch {} }

  async function dvpSteps () {
    await c.send({ type: 'dvp_request', taker_aid: aid, seq_amount: Number(value) })
    const m = await c.recv('dvp_coins', STEP_MS)
    const theirs = await host.coinsAt((m.dvp_coins || []).map((x) => ({ txid: x.Txid ?? x.txid, vout: x.Vout ?? x.vout })))
    for (const t of theirs) {
      if (owns.has(key(t.txid, t.vout)) || t.script === mine.script) { await c.fail('bad_terms', 'the maker\'s coins include ours'); throw refusal('the maker named a coin of ours') }
    }
    const sameAsset = makerSells && feeAsset === assetB
    const feeCoins = sameAsset ? [] : await host.walletCoins(feeAsset, fee)
    const feeChange = await host.newScript()
    let plan; let side
    if (makerSells) {
      if (theirs.some((t) => t.asset !== asset || t.script !== makerEnclave)) throw refusal('the maker\'s coins are not its enclave\'s')
      const pay = await host.walletCoins(assetB, sameAsset ? price + fee : price)
      const change = await host.newScript()
      plan = { asset, value, assetB, price, sellerCoins: theirs, sellerEnclave: makerEnclave, sellerRecv: await host.scriptOf(r.maker_recv_address || r.makerRecvAddress),
        buyerCoins: sameAsset ? [] : pay, buyerEnclave: mine.script, buyerChange: change,
        feeCoins: sameAsset ? pay : feeCoins, feeAsset, fee, feeChange: sameAsset ? change : feeChange, shared: sameAsset }
      side = { offered: sameAsset ? pay : [...pay, ...feeCoins], walletOwns: owns, ours: [mine.script, change, feeChange],
        gives: { [assetB]: price + (sameAsset ? fee : 0n), ...(sameAsset ? {} : { [feeAsset]: fee }) }, gets: [{ asset, value, script: mine.script }] }
    } else {
      if (theirs.some((t) => t.asset !== assetB)) throw refusal('the maker\'s coins are not the price\'s asset')
      if (!m.dvp_change) throw refusal('the maker named no change script')
      const held = await host.enclaveCoins(asset, policyUrl)
      const sell = []; let sum = 0n
      for (const h of held) { if (sum >= value) break; sell.push(h); sum += big(h.value) }
      if (sum < value) throw refusal('the wallet holds less of the asset than the trade')
      const recvB = await host.newScript()
      plan = { asset, value, assetB, price, sellerCoins: sell, sellerEnclave: mine.script, sellerRecv: recvB,
        buyerCoins: theirs, buyerEnclave: makerEnclave, buyerChange: m.dvp_change, feeCoins, feeAsset, fee, feeChange }
      side = { offered: [...sell, ...feeCoins], walletOwns: owns, ours: [mine.script, recvB, feeChange],
        gives: { [asset]: value, [feeAsset]: fee }, gets: [{ asset: assetB, value: price, script: recvB }] }
    }
    // With the price and the fee in one asset, one set of coins pays both.
    const unsigned = plan.shared ? sharedLayout(plan) : dvpLayout(plan)
    const hex = await host.build(unsigned.inputs, unsigned.outputs)
    const tx = readTx(hex)
    const why = checkTrade(tx, unsigned.inputs, side)
    if (why) { await c.fail('bad_terms', why); throw refusal(why) }
    const sellerAid = makerSells ? makerAid : aid
    const sellerIns = unsigned.sellerInputs
    const body = { tx: hex, asset, sender_aid: sellerAid, inputs: sellerIns }
    try { await policy.check(body) } catch (e) { await c.fail('refused', String(e.message || e)); throw e }
    await c.send({ type: 'dvp_tx', dvp_tx: hex })
    const sm = await c.recv('dvp_signed', STEP_MS)
    const offeredIdx = indicesOf(unsigned.inputs, side.offered)
    let txid
    if (makerSells) {
      if (!(Number(sm.expires_at) > await chainNow(host))) throw refusal('the maker\'s signatures have already expired')
      const signed = await host.signWallet(hex, unsigned.inputs)
      const bad = checkSigned(tx, readTx(signed), offeredIdx)
      if (bad) { await c.fail('bad_terms', bad); throw refusal(bad) }
      sent = true
      txid = await broadcast(policy, { ...body, tx: signed, broadcast: true, user_sigs: sm.user_sigs, expires_at: Number(sm.expires_at), expiry_sig: sm.expiry_sig }, tx.txid, onTxid)
    } else {
      const theirsSigned = readTx(sm.dvp_tx)
      if (theirsSigned.txid !== tx.txid) throw refusal('the maker signed another transaction')
      // The maker's witnesses, on the maker's inputs only.
      const makerIdx = new Set(indicesOf(unsigned.inputs, theirs))
      // The wallet library signs from a PSET that carries no witness: it signs the unsigned trade,
      // is checked against it, and only then are the maker's witnesses laid on the maker's inputs.
      const ours = await host.signWallet(hex, unsigned.inputs)
      const bad = checkSigned(tx, readTx(ours), offeredIdx.filter((i) => !sellerIns.includes(i)))
      if (bad) { await c.fail('bad_terms', bad); throw refusal(bad) }
      const signed = withWitnesses(ours, theirsSigned, makerIdx)
      const exp = await chainNow(host) + EXPIRY_S
      const sigs = await host.signEnclave(signed, unsigned.inputs, sellerIns, mine)
      const es = await host.signDigest(expiryDigest(tx.txid, exp))
      sent = true
      txid = await broadcast(policy, { ...body, tx: signed, broadcast: true, user_sigs: sigs, expires_at: exp, expiry_sig: es }, tx.txid, onTxid)
    }
    await c.send({ type: 'dvp_done', settle_txid: txid }).catch(() => {})
    return { txid }
  }
}

// The layout when the buyer pays the price and the fee in one asset from one set of coins: the
// seller's coins, the buyer's, then one change and the fee.
function sharedLayout (d) {
  const A = d.sellerCoins.reduce((n, c) => n + big(c.value), 0n)
  const P = d.feeCoins.reduce((n, c) => n + big(c.value), 0n)
  if (A < d.value || P < d.price + d.fee) throw new Error(`the coins hold ${A} of ${d.value}, ${P} of ${d.price + d.fee}`)
  const outputs = [{ asset: d.asset, value: d.value, script: d.buyerEnclave }, { asset: d.assetB, value: d.price, script: d.sellerRecv }]
  if (A > d.value) outputs.push({ asset: d.asset, value: A - d.value, script: d.sellerEnclave })
  if (P > d.price + d.fee) outputs.push({ asset: d.assetB, value: P - d.price - d.fee, script: d.buyerChange })
  outputs.push({ asset: d.assetB, value: d.fee, script: '' })
  return { inputs: [...d.sellerCoins, ...d.feeCoins], outputs, sellerInputs: d.sellerCoins.map((_, i) => i) }
}

// A gated order: the fill, the taker's inputs signed, co-signed and broadcast by the policy
// server in one step. `receive` the atoms of the restricted asset taken.
export async function takeGated (host, entry, { receive, feeAsset, onTxid }) {
  const g = gated(entry.raw)
  const asset = rev(g.asset_a || g.assetA); const assetB = rev(g.asset_b || g.assetB)
  if (!feeAsset || feeAsset === asset) throw refusal('the fee is paid in an asset other than the one bought')
  const policy = host.policy(g.policy_server || g.policyServer)
  const px = policyKeyOf(await policy.asset(asset))
  if (px !== String(g.policy_x || g.policyX || '').toLowerCase()) throw refusal('the order\'s policy key is not the one its policy server lists')
  const at = { txid: g.covenant_txid || g.covenantTxid, vout: Number(g.covenant_vout ?? g.covenantVout ?? 0) }
  const [order] = await host.coinsAt([at])
  if (order.asset !== asset) throw refusal('the order holds another asset')
  // The order's script is the one its terms build (the page's wasm, when it has it).
  if (host.gatedScript) {
    const want = await host.gatedScript(g)
    if (want && want.toLowerCase() !== String(order.script).toLowerCase()) throw refusal('the order\'s coin is not at the script its terms build')
  }
  const f = gatedFill(g, order.value, receive)
  const mine = await host.enclave(asset, g.policy_server || g.policyServer)
  const fee = big(await host.feeAtoms(feeAsset, TRADE_VBYTES))
  const owns = await host.walletOwns()
  const same = feeAsset === assetB
  const pay = await host.walletCoins(assetB, same ? f.required + fee : f.required)
  const feeCoins = same ? [] : await host.walletCoins(feeAsset, fee)
  const change = await host.newScript()
  const feeChange = same ? change : await host.newScript()
  const makerScript = '51' + '20' + String(g.maker_prog || g.makerProg).toLowerCase()
  const P = pay.reduce((n, c) => n + big(c.value), 0n); const F = feeCoins.reduce((n, c) => n + big(c.value), 0n)
  // The covenant at input 0 reads output 0, the maker's credit, and output 1: the remainder
  // resting again at the order's script, or, for a whole fill, any explicit output of another
  // asset (covenant.js planFill).
  const back = same ? P - f.required - fee : P - f.required
  const rest = []
  if (back > 0n) rest.push({ asset: assetB, value: back, script: change })
  if (!same && F > fee) rest.push({ asset: feeAsset, value: F - fee, script: feeChange })
  rest.push({ asset: feeAsset, value: fee, script: '' })
  const outputs = [{ asset: assetB, value: f.required, script: makerScript }]
  if (f.remainder > 0n) outputs.push({ asset, value: f.remainder, script: order.script })
  else outputs.push(rest.shift())
  outputs.push({ asset, value: f.filled, script: mine.script }, ...rest)
  const inputs = [order, ...pay, ...feeCoins]
  const hex = await host.build(inputs, outputs)
  const tx = readTx(hex)
  const side = { offered: [...pay, ...feeCoins], walletOwns: owns, ours: [mine.script, change, feeChange],
    gives: same ? { [assetB]: f.required + fee } : { [assetB]: f.required, [feeAsset]: fee }, gets: [{ asset, value: f.filled, script: mine.script }] }
  const why = checkTrade(tx, inputs, side)
  if (why) throw refusal(why)
  const body = { tx: hex, asset, sender_aid: g.maker_aid || g.makerAid, order_inputs: [{ input: 0 }] }
  await policy.check(body)
  const signed = await host.signWallet(hex, inputs)
  const bad = checkSigned(tx, readTx(signed), inputs.map((_, i) => i).filter((i) => i > 0))
  if (bad) throw refusal(bad)
  return { txid: await broadcast(policy, { ...body, tx: signed, broadcast: true }, tx.txid, onTxid) }
}

// The trade sent through its policy server, which co-signs and broadcasts it. The trade's own txid
// is told first (`onTxid`), so an answer that never arrives leaves the trade followed by it, never
// called "nothing moved" while it is mined; an answer naming another transaction is not taken for
// this trade's. -> the trade's txid.
async function broadcast (policy, body, txid, onTxid) {
  if (onTxid) { try { onTxid(txid) } catch {} }
  const r = await policy.cosign(body)
  const named = r && r.txid ? String(r.txid).toLowerCase() : ''
  if (!named) throw new Error(`the policy server named no transaction; the trade ${txid} is followed`)
  if (named !== txid) throw new Error(`the policy server named another transaction (${named}); the trade ${txid} is followed`)
  return txid
}

// Now for an expiry: the later of the device's clock and the chain's median time, as the policy
// server reads it (a device clock behind the chain would sign an expiry already past).
async function chainNow (host) {
  let mtp = 0
  if (host.chainTime) { try { mtp = Number(await host.chainTime()) || 0 } catch {} }
  return Math.max(Number(host.now()), mtp)
}

// The policy key a policy server lists for an asset it co-signs (GET /v1/assets/{id}). An asset
// enforced otherwise (a network-enforced one) never trades by this server's co-signature.
export function policyKeyOf (listed) {
  if (!listed || (listed.enforcement && listed.enforcement !== 'cosign')) throw refusal('the asset is not one its policy server co-signs')
  const px = String(listed.policy_pub || '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(px)) throw refusal('the policy server lists no policy key for the asset')
  return px
}

function indicesOf (inputs, coins) {
  const set = new Set(coins.map((c) => key(c.txid, c.vout)))
  return inputs.map((c, i) => (set.has(key(c.txid, c.vout)) ? i : -1)).filter((i) => i >= 0)
}

// The unsigned trade's hex with the witnesses of `from` placed on `inputs` only.
export function withWitnesses (hex, from, inputs) {
  const t = readTx(hex)
  const stacks = t.inputs.map((ti, i) => (inputs.has(i) ? from.inputs[i].witness : ti.witness))
  return setWitnesses(hex, stacks)
}

// Rewrites a transaction's input witnesses (output witnesses empty: a trade is explicit).
export function setWitnesses (hex, stacks) {
  const t = readTx(hex)
  const b = hexToBytes(hex)
  const parts = [b.subarray(0, 4), Uint8Array.of(1), b.subarray(5, t.bodyEnd)]
  const vi = (n) => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8))
  for (const s of stacks) {
    parts.push(Uint8Array.of(0, 0), vi(s.length))
    for (const w of s) { const x = hexToBytes(w); parts.push(vi(x.length), x) }
    parts.push(Uint8Array.of(0))
  }
  for (let i = 0; i < t.outputs.length; i++) parts.push(Uint8Array.of(0, 0))
  let n = 0; for (const p of parts) n += p.length
  const out = new Uint8Array(n); let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return bytesToHex(out)
}

function refusal (m) { const e = new Error('refused: ' + m); e.kind = 'refused'; return e }

// ---------------------------------------------------------------- the transaction, written

const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff)
function compact (n) {
  if (n < 0xfd) return Uint8Array.of(n)
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8)
  return Uint8Array.of(0xfe, ...u32le(n))
}
const cat = (parts) => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length } return o }
const vb = (b) => cat([compact(b.length), b])
const be8 = (v) => { v = big(v); const o = new Uint8Array(8); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n } return o }
// One explicit Elements output: asset, value, no nonce, script.
export function txOutBytes ({ asset, value, script }) {
  return cat([Uint8Array.of(1), hexToBytes(rev(asset)), Uint8Array.of(1), be8(value), Uint8Array.of(0), vb(hexToBytes(script || ''))])
}

// The unsigned trade: every input final, lock time 0, every output explicit, no witness.
export function buildTx (inputs, outputs, version = 2) {
  const parts = [u32le(version), Uint8Array.of(0), compact(inputs.length)]
  for (const c of inputs) parts.push(hexToBytes(rev(c.txid)), u32le(Number(c.vout)), Uint8Array.of(0), u32le(FINAL_SEQUENCE))
  parts.push(compact(outputs.length))
  for (const o of outputs) parts.push(txOutBytes(o))
  parts.push(u32le(0))
  return bytesToHex(cat(parts))
}

// The same trade as a PSET (version 2), each input carrying the coin it spends, for the wallet
// library to add its own details to and sign (`Pset`, `addDetails`, `Signer.sign`, `finalize`).
// `derivations[i]`, for an input of the wallet's own: { pubkey (33-byte hex), fingerprint (4-byte
// hex), path: [u32] }, written as the input's key origin so the signer knows the key.
export function psetOf (txHex, coins, derivations = []) {
  const t = readTx(txHex)
  const kv = (type, data, value) => cat([vb(cat([Uint8Array.of(type), data || new Uint8Array(0)])), vb(value)])
  const prop = (sub, value) => cat([vb(cat([Uint8Array.of(0xfc), vb(new TextEncoder().encode('pset')), Uint8Array.of(sub)])), vb(value)])
  const le8 = (v) => be8(v).reverse()
  const parts = [Uint8Array.of(0x70, 0x73, 0x65, 0x74, 0xff),
    kv(0x02, null, u32le(t.version)), kv(0x03, null, u32le(t.locktime)), kv(0x04, null, compact(t.inputs.length)),
    kv(0x05, null, compact(t.outputs.length)), kv(0xfb, null, u32le(2)), Uint8Array.of(0)]
  for (const [i, ti] of t.inputs.entries()) {
    const c = coins[i]
    parts.push(kv(0x01, null, txOutBytes(c)), kv(0x0e, null, hexToBytes(rev(ti.txid))), kv(0x0f, null, u32le(ti.vout)),
      kv(0x10, null, u32le(ti.sequence)))
    const d = derivations[i]
    if (d) parts.push(kv(0x06, hexToBytes(d.pubkey), cat([hexToBytes(d.fingerprint), ...d.path.map((n) => u32le(n))])))
    parts.push(Uint8Array.of(0))
  }
  for (const o of t.outputs) {
    parts.push(kv(0x03, null, le8(o.value)), kv(0x04, null, hexToBytes(o.script)), prop(0x02, hexToBytes(rev(o.asset))), Uint8Array.of(0))
  }
  const b = cat(parts)
  let s = ''; for (const x of b) s += String.fromCharCode(x)
  return btoa(s)
}
