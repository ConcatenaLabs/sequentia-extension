// The user-mode composer's engine: one market trade, in one native step.
//
// The person names what they pay, what they get and how much they pay. The engine reads the
// single-step book (tooling/lsp/single-step-book.mjs), asks the wallet's leaf library to price
// each candidate it can fill, picks one (the most received, then the fewest parties), and makes
// the ticket: amount in, amount out, one cost line. On confirm it settles that one candidate the
// way the settlement router names (tooling/lsp/settlement-router.mjs planSingleStep), and follows
// it to "Settled", or to "Returned" when nothing traded. It never falls back to another source.
//
// Every amount on a ticket is the leaf library's answer (swap_read, take_quote, settle_quote);
// this file compares the library's numbers and adds the ones it shows, and decides nothing the
// library decides. It has no DOM and no node: import, so the page (user-composer.js) and the
// drill (tooling/user-mode-drill.mjs) run the same code.
//
// deps:
//   leaves.command(name, args) -> the library's answer (a promise or a value)
//   fetchJson(url, init?)      -> the parsed JSON of a GET or POST, throwing on an HTTP error
//   makers()                   -> the base URLs of the live leaf makers to ask
//   relayBook(pay, receive)    -> the relay's offers that sell `receive` for `pay` (each with
//                                 `_verified`, its relay JSON `_relayJson`, and its order
//                                 status `_status`, the book's statuses[i] of offers[i])
//   relayFills(pay, receive)   -> the relay's fill records of the pair (an order resting in the
//                                 tree is settled once its fill's record is final), or absent
//   outputValue(txid, vout)    -> the atoms an order's output holds on the chain now, or null
//                                 (the relay keeps an offer's signed amount after a part fill)
//   admitted()                 -> { pairs, genesis }: user-mode/pairs.json and this chain's genesis
//   btc                        -> the wallet's Bitcoin Lightning, for BTC trades (user-trade-btc.js),
//                                 or null: then nothing is traded for or with BTC
//   onchain                    -> the wallet's own on-chain coins, for covenant orders taken on the
//                                 chain ('onchain-fill'), or null: { balance(asset) -> atoms it can
//                                 spend now, fee(payAsset) -> { asset, atoms } of one fill's network
//                                 fee, take(matched, { fee, onTxid }) -> { txid } (builds, signs and
//                                 broadcasts the FILL at the fee shown; onTxid(txid) before the
//                                 broadcast),
//                                 status(txid) -> 'final' | 'confirmed' | 'pending' | 'unknown' }
//   anchorDepth()              -> the Bitcoin blocks the operator waits for after a block is certified
//                                 before a coin in it can be traded (the library's `info`
//                                 `anchor_depth`), or null; optional: at 0 a coin not ready yet is
//                                 on its way and ready in a minute or two
//   vesting(asset)             -> what of an asset vests later ([{ asset, vest, vests, atoms }], the
//                                 wallet's last `claims` reading, default-arca.js vestingLots); optional:
//                                 with it, a pay amount that needs what has not vested is 'vesting'
//   held(asset)                -> what the wallet shows it holds of an asset, wherever it is; optional:
//                                 with it, a pay asset held but not payable now is 'not-ready', not
//                                 'no-funds'
//   prepare(asset)             -> asks the wallet to make an asset held but not payable ready (default
//                                 mode boards it); optional
//   release(asset, leaves)     -> asks the wallet to free `leaves`, live coins of `asset` kept by an open
//                                 offline-refresh plan, in its next round (plan_release); optional:
//                                 with it, a pay asset held only in such coins is 'freeing'
//   changed(record)            -> told when a trade moves on in a way that changes what the wallet
//                                 holds; optional (the page reads its balance again)
//   store                      -> getItem/setItem (the trade records, persisted before signing)
//   now()                      -> milliseconds
//   sleep(ms), log(...)        -> optional

import { makerEntries, covenantRoundEntries, restingEntries, onchainFillEntries, sizeEntry, chooseCandidate, admittedSources, SLOW_SOURCES, SLOW_PREMIUM_BPS } from './tooling/lsp/single-step-book.mjs'
import { planFillFromMatched } from './covenant-order.js'
import { planSingleStep } from './tooling/lsp/settlement-router.mjs'
import { btcTrades } from './user-trade-btc.js'
import { DEFAULT_WORDS, vestingShort } from './default-arca.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// How long the wallet waits for a maker to complete a swap it accepted before it cancels it and
// takes its coins back (the maker completes in seconds; the cancel and a late completion exclude
// each other at the operator's signer).
export const MAKER_COMPLETE_MS = 120_000
// A step whose outcome is unknown (the operator did not answer, so the library may still complete
// it at its next sync) is looked for this long before the trade is called returned.
export const UNCERTAIN_MS = 10 * 60 * 1000
// A maker's firm offer is accepted only while at least this long is left before it lapses.
export const FIRM_MARGIN_MS = 20_000
// The most the operator's fee may be of a price, in millionths, for a trade in user mode.
export const MAX_FEE_PPM = 10_000

// Words a default screen must never show (design 1.4). Lower case; matched as whole words.
export const USER_MODE_FORBIDDEN_WORDS = Object.freeze(['rail', 'rails', 'round', 'rounds', 'leaf', 'leaves', 'operator', 'covenant',
  'covenants', 'expiry', 'atom', 'atoms', 'forfeit', 'forfeits', 'channel', 'channels', 'relay', 'maker', 'makers', 'hash', 'preimage',
  'htlc', 'submarine', 'lsp', 'tree', 'anchor', 'unroll', 'exit', 'checkpoint', 'reassignment', 'on-chain', 'lightning', 'bridge', 'gateway',
  'node', 'nodes', 'claim', 'claims', 'distribution', 'distributions', 'lapse', 'lapses', 'lapsed', 'locktime', 'locktimes'])

export function forbiddenIn (text) {
  const t = String(text || '').toLowerCase()
  return USER_MODE_FORBIDDEN_WORDS.filter((w) => new RegExp(`(^|[^a-z-])${w.replace(/[-]/g, '\\-')}([^a-z-]|$)`).test(t))
}

// Every string the user composer shows, in one place, so the word list can be checked against
// all of them (user-trade.test.mjs).
export const USER_WORDS = Object.freeze({
  pay: 'You pay',
  get: 'You receive',
  // The control between the two sides: it exchanges them, each amount staying with its asset.
  flip: 'Swap You pay and You receive',
  flipMark: '⇅',
  amount: 'Amount',
  max: 'Max',
  balance: (x) => `balance ${x}`,
  // What the book can fill now, when less than asked: said beside the amounts as they are typed.
  bookUpTo: (x) => `The book can fill up to ${x} now.`,
  review: 'Review',
  confirm: 'Trade',
  cancel: 'Cancel',
  amountIn: 'You pay',
  amountOut: 'You receive',
  fees: 'Fees',
  included: 'included above',
  noFees: 'No fees',
  upTo: (x) => `Up to ${x} can be traded now.`,
  notOffered: (get, pay) => `Not offered right now: nobody offers ${get} for ${pay} in one step.`,
  notListed: (get, pay) => `${get} for ${pay} is not offered.`,
  // Nothing to choose under You receive: no pair admitted for what is paid, or none read yet.
  nothingOffered: (pay) => `Not offered right now: nobody offers anything for ${pay}.`,
  enter: 'Enter how much you pay.',
  tooSmall: 'That amount is too small to trade.',
  noFirmOffer: 'Nobody could confirm a price for this just now. Nothing has moved: try again in a moment.',
  noFunds: (pay) => `You have no ${pay} to trade.`,
  // More than can be traded now, the rest vesting later (the wallet's one sentence for it).
  notVested: DEFAULT_WORDS.notVested,
  // Held, and shown in the balance, but not where a trade can pay it from yet (just arrived, or
  // still being moved in by the wallet): never "you have none". `soon`: the operator calls a coin
  // ready once its block is certified (anchor depth 0), so it is ready in a minute or two.
  notReady: (pay, soon) => soon ? `Your ${pay} is on its way: it is ready to trade in a minute or two. Nothing has moved.`
    : `Your ${pay} is not ready to trade yet: it is once the next Bitcoin blocks settle it. Nothing has moved.`,
  // Part of what is paid can be traded now, too little for any offer; the rest settles first.
  partReady: (ready, pay, soon) => soon ? `Only ${ready} of your ${pay} can be traded now, too little for any offer: the rest is on its way, ready in a minute or two. Nothing has moved.`
    : `Only ${ready} of your ${pay} can be traded now, too little for any offer: the rest is ready once the next Bitcoin blocks settle it. Nothing has moved.`,
  // A coin that was ready, taken back out of the chain with its Bitcoin block: still the wallet's,
  // and in its balance, while the network takes it in again.
  redoing: (pay) => `Your ${pay} is being redone after a Bitcoin reorganisation: it is still yours, and ready to trade again once that settles. Nothing has moved.`,
  busy: (pay) => `Your ${pay} is held by an order you placed or a move your wallet is making, and can be traded once that completes. Nothing has moved.`,
  // Kept by the wallet's plan to refresh it while the wallet is closed, which only a round can end:
  // the wallet gives it up in its next round for a coin it can trade.
  // The best offers are orders resting in the tree that only coins expiring later can fill: the
  // wallet refreshes its older coins in the next round, and prices the trade again once they are in.
  readying: (pay, soon) => soon ? `Getting your ${pay} ready for this trade: it is ready in a minute or two. Nothing has moved.`
    : `Getting your ${pay} ready for this trade: it is ready once the next Bitcoin blocks settle it. Nothing has moved.`,
  freeing: (pay, soon) => soon ? `Your ${pay} is being made ready to trade: it is ready in a minute or two. Nothing has moved.`
    : `Your ${pay} is being made ready to trade: it is ready once the next Bitcoin blocks settle it. Nothing has moved.`,
  // The amount not typed, while it follows the book's price now: an estimate, said as one.
  about: 'about',
  // Review, while the sources are asked for terms they hold to: the amount shown is the estimate.
  pricing: 'Getting the exact price…',
  // BTC held at the wallet's address, which a trade cannot pay from until the wallet has moved it
  // where trades pay BTC from (the Bitcoin ark): a move confirmed by `blocks` Bitcoin blocks (no
  // time: Bitcoin's blocks keep none).
  btcMoving: (blocks) => `Your BTC is being moved so it can be traded. It is ready after ${btcBlocks(blocks)}. Nothing has moved yet.`,
  btcMore: (blocks) => `More of your BTC is being moved so it can be traded, ready after ${btcBlocks(blocks)}.`,
  priceMoved: 'The price moved. Here is the new one.',
  sent: 'Sent',
  settled: 'Settled',
  // A trade that waits on Bitcoin blocks says what is already true while it waits.
  waitingOther: 'Waiting for the other side. Nothing has left your wallet yet.',
  // A purchase of BTC whose payment is made: the BTC comes once the other side pays it out.
  btcOnItsWay: 'Paid. Your BTC is on its way.',
  // What the trade brings is the wallet's; only its settling with the network is left. One word on
  // every surface, with no time: how long settling takes is the network's, not the trade's.
  received: 'Received, settling',
  receivedSlow: 'Received, and yours to use. Settling with the network is taking longer than usual.',
  minutes: (word, n) => `${word} (${n} min)`,
  returned: 'Returned: nothing traded.',
  returnedFees: (fees) => `Returned: nothing traded. Fees of ${fees} were paid.`,
  returnedLapsed: 'Returned: nothing traded. The other side\'s offer ran out while the trade waited.',
  // A trade confirmed and being sent: the screen is free at once, the trade goes on in Open.
  sending: 'Sending…',
  failed: 'This trade could not be made. Nothing moved.',
  recent: 'Your trades',
  openTrades: 'Open',
  pastTrades: 'Past',
})

function btcBlocks (n) { return Number(n) === 1 ? 'a Bitcoin block' : `${Number(n) || 2} Bitcoin blocks` }

// Whether what an open trade brings is held already, and only its settling is left: a purchase
// with BTC once the BTC is paid and the asset claimed, a sale for BTC once the BTC came, a swap once
// the maker completed it, a take once its round released the coin.
export function heldAlready (r) {
  if (!r) return false
  if (r.source === 'btc-gateway') return r.dir === 'sell' ? !!r.btcPaid : !!(r.preimage && r.receiveState === 'received')
  if (r.source === 'leaf-maker') return r.swapState === 'done'
  if (r.source === 'covenant-round') return r.takeState === 'released'
  return false
}

// What the list of trades says of one: Sent, then Settled; a trade waiting on the other side or on
// its settling says so, with the minutes it has waited once it has waited one. The same words in the
// Trade tab's Open trades, in History and on every other surface: none of them promises a time.
export function tradeStateWord (r, now = Date.now()) {
  const W = USER_WORDS
  if (r.state === 'settled') return W.settled
  if (r.state === 'returned' && (r.feesPaid || []).length) return null
  if (r.state === 'returned' && r.whyKind === 'lapsed') return W.returnedLapsed
  if (r.state === 'returned' || r.state === 'failed') return W.returned
  if (r.state === 'confirming') return W.sending
  const since = (t) => Math.floor((now - (t || r.at || now)) / 60000)
  // Buying with BTC: nothing has left the wallet until its asset is held for it.
  if (r.state === 'waiting') { const m = since(r.waitingSince); return m >= 1 ? W.minutes(W.waitingOther, m) : W.waitingOther }
  const m = since(r.sentAt)
  // Received, its settling still waiting with the network after ten minutes (the network had no
  // room for it yet): said so, the coins being the wallet's all along.
  const held = heldAlready(r)
  const word = held ? (m >= SLOW_SETTLE_MIN && (r.settleState || []).some((x) => x && x !== 'released') ? W.receivedSlow : W.received)
    : r.source === 'btc-gateway' && r.dir === 'sell' ? W.btcOnItsWay : W.sent
  return m >= 1 ? W.minutes(word, m) : word
}

// The fees a ticket counts, as one line: each fee in the asset it is paid in, summed per asset.
// `fmt(asset, atoms)` names an amount. Fees in the asset paid come first.
export function costLine (fees, fmt, payAsset) {
  const per = new Map()
  for (const f of fees || []) { if (!f || big(f.atoms) <= 0n) continue; per.set(f.asset, (per.get(f.asset) || 0n) + big(f.atoms)) }
  if (!per.size) return USER_WORDS.noFees
  const order = [...per.keys()].sort((a, b) => (a === payAsset ? -1 : b === payAsset ? 1 : 0))
  const parts = order.map((a) => fmt(a, per.get(a)))
  return `${USER_WORDS.fees} ${parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]}, ${USER_WORDS.included}`
}

// The pickers' order: BTC first whatever is held, then what the wallet holds, then the rest,
// each group by name.
export function pickerOrder (assets, held, name) {
  const nm = (a) => String((name && name(a)) || a)
  const rest = (assets || []).filter((a) => a !== 'BTC')
  const h = rest.filter((a) => big(held && held(a)) > 0n).sort((a, b) => nm(a).localeCompare(nm(b)))
  const o = rest.filter((a) => !(big(held && held(a)) > 0n)).sort((a, b) => nm(a).localeCompare(nm(b)))
  return ['BTC', ...new Set([...h, ...o])]
}

// What the library can pay now, per asset, out of round: its live coins, less the coin of every
// open offline-refresh plan, which the library never spends outside a round. With `waiting`, also
// every coin given up in a refresh still waiting for a round (`refresh_waiting`): a trade takes
// that refresh back first and pays with the coin, and its quote prices it so.
// What a payment the library refused for want of funds is short by, in atoms of the asset paid: what
// it takes with its margins less what the wallet holds, or the operator's smallest leaf when the
// change would fall below it (paying that much less leaves change of at least that). 0n otherwise.
export function shortBy (message) {
  const m = String(message || '')
  const s = m.match(/holds (\d+) of asset \S+ in live coins, and paying \d+ takes (\d+)/)
  if (s) return BigInt(s[2]) > BigInt(s[1]) ? BigInt(s[2]) - BigInt(s[1]) : 0n
  const d = m.match(/change would be below the operator's smallest leaf in asset \S+ \((\d+) atoms\)/)
  return d ? BigInt(d[1]) : 0n
}

// The indicative entries worth asking for firm terms, best first: a source whose coin waits on
// Bitcoin blocks is chosen over one handed over in seconds only when it gives SLOW_PREMIUM_BPS
// more (chooseCandidate), so one that does not give that much more than the best such indicative
// entry is never asked; its firm terms (a take quoted by the operator) cost the person time.
export function worthFirming (ind) {
  const fast = ind.filter((x) => !SLOW_SOURCES.has(x.e.source))
  const bestFast = fast.length ? fast[0].receive : 0n
  return ind.filter((x) => !SLOW_SOURCES.has(x.e.source) || x.receive * 10000n > bestFast * (10000n + SLOW_PREMIUM_BPS))
}

export function plannedCoins (plans) {
  return new Set(((plans && plans.plans) || []).filter((p) => !/^(done|cancelled|stopped|finished)$/.test(String(p.state || ''))).map((p) => p.coin))
}
export function spendableFrom (coins, plans, { waiting = false } = {}) {
  const planned = plannedCoins(plans)
  const out = new Map()
  for (const c of coins || []) {
    if (!c || planned.has(c.leaf_id)) continue
    if (c.state !== 'live' && !(waiting && c.state === 'given' && c.refresh_waiting)) continue
    out.set(c.asset, (out.get(c.asset) || 0n) + big(c.value))
  }
  return out
}

const TRADES_KEY = 'swk.usertrade'
// How long a quote waits before it asks once more for firm terms that none gave.
const FIRM_RETRY_MS = 3000
// How long a quote may take, from Review: every source worth asking for firm terms is asked at
// once, and one that has not answered by then is left out of the ticket (a late answer is let go
// of), so a slow maker, or a source waiting on its chain, never holds the person's price up. The
// firm terms always get at least QUOTE_FIRM_MIN_MS of it.
export const QUOTE_FIRM_MS = 8000
const QUOTE_FIRM_MIN_MS = 3000
// When the BTC desk is the only source a trade can take (buying or selling BTC), its firm terms
// (an offer and a Lightning invoice) are waited for this long, not QUOTE_FIRM_MS: there is no
// other answer to take instead, and a late one was a refusal for nothing.
export const BTC_ONLY_FIRM_MS = 20000
// How long a refresh asked to get coins ready for a resting order is waited on before it is asked
// again: its round, and the round's block being certified.
export const READYING_MS = 10 * 60_000
// The book's entries read while the amount was typed stand for the quote this long.
const ENTRIES_FRESH_MS = 8000
// The states of a coin held by something under way (a live one here is planned for a refresh).
const BUSY_STATES = ['given', 'offered', 'sending', 'forfeited', 'receiving', 'paying', 'live']
// How far, as a factor either way, an entry's price may be from the price feed's and stand.
const FEED_REACH = 2
// The least time between two syncs the engine asks for.
const SYNC_EVERY_MS = 10000
// Minutes after which a received trade still settling is said to be slow.
const SLOW_SETTLE_MIN = 10

// The library's commands the engine runs that only read, which it runs one after another for a
// quote or a pass over its trades: each asks the library to answer from a look at the chain made
// a moment ago (shared_view) rather than its own, which a wallet on a slow link pays a round trip
// for. Every command that takes a coin, signs or broadcasts looks first, whatever it is asked.
export const SHARED_VIEW_READS = new Set(['info', 'coins', 'plans', 'participations', 'swaps', 'balance', 'swap_read', 'take_quote',
  'settle_quote', 'quote', 'order_fill_resting_quote', 'order_cancel_resting_quote'])

export function createEngine (deps) {
  // The node scans one wallet at a time; a command that meets another's scan is asked again
  // (the library's own words; nothing else is retried).
  const run = async (cmd, args) => {
    const a = SHARED_VIEW_READS.has(cmd) ? { ...(args || {}), shared_view: true } : (args || {})
    for (let i = 0; ; i++) {
      const t0 = now()
      try { const v = await deps.leaves.command(cmd, a); if (now() - t0 > 2000) log(`[user trade] ${cmd} took ${now() - t0} ms`); return v } catch (e) {
        if (i < 8 && /Scan already in progress/.test(String(e && e.message))) { await sleep(500 + 500 * i); continue }
        throw e
      }
    }
  }
  const now = () => (deps.now ? deps.now() : Date.now())
  const firmMs = deps.quoteFirmMs || QUOTE_FIRM_MS
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = deps.log || (() => {})
  const key = () => TRADES_KEY + '.' + (deps.tag ? deps.tag() : 'default')

  // Orders the operator refused to take as not final yet (its chain does not yet hold their
  // transaction as final, whatever the wallet's node says): not offered again for a while.
  const NOT_FINAL_MS = 15 * 60 * 1000
  const nfKey = () => key() + '.notfinal'
  function notFinal () { try { const m = JSON.parse(deps.store.getItem(nfKey()) || '{}'); for (const k of Object.keys(m)) if (m[k] <= now()) delete m[k]; return m } catch { return {} } }
  function markNotFinal (id) { const m = notFinal(); m[id] = now() + NOT_FINAL_MS; try { deps.store.setItem(nfKey(), JSON.stringify(m)) } catch {} }

  function records () { try { return JSON.parse(deps.store.getItem(key()) || '[]') } catch { return [] } }
  function save (list) { deps.store.setItem(key(), JSON.stringify(list)) }
  function put (rec) { const l = records(); const i = l.findIndex((r) => r.id === rec.id); if (i >= 0) l[i] = rec; else l.push(rec); save(l); return rec }
  const btcT = btcTrades({ run, deps, put, log, now, settleStep: (rec) => settleStep(rec), maxFeePpm: MAX_FEE_PPM, firmMarginMs: FIRM_MARGIN_MS })

  // A wallet that holds no leaves (it joined no operator) can pay nothing from them.
  async function spendable () {
    let coins
    try { coins = await run('coins') } catch (e) { log('[user trade] no leaves:', e && e.message); return new Map() }
    const plans = await run('plans').catch(() => ({ plans: [] }))
    return spendableFrom(coins, plans, { waiting: true })
  }

  // The candidates' entries for a directed pair, from every admitted source.
  async function entries (payAsset, receiveAsset, sources) {
    const out = []
    // A maker quotes in-tree swaps, and, with a Bitcoin Lightning node, BTC in one hash-lock.
    if (sources.includes('leaf-maker') || (sources.includes('btc-gateway') && deps.btc)) {
      // Every maker at once: one that does not answer costs its own wait, not the others'.
      const got = await Promise.all((deps.makers ? deps.makers() : []).map(async (m) => {
        try {
          const q = await deps.fetchJson(m + '/v1/quotes')
          return makerEntries(m, q.quotes, { payAsset, receiveAsset }).filter((e) => sources.includes(e.source))
        } catch (e) { log('[user trade] maker', m, 'did not answer:', e && e.message); return [] }
      }))
      for (const g of got) out.push(...g)
    }
    const onchain = sources.includes('onchain-fill') && deps.onchain
    const wantBook = (sources.includes('covenant-round') || sources.includes('leaf-resting') || onchain) && deps.relayBook
    const book = wantBook ? await Promise.resolve(deps.relayBook(payAsset, receiveAsset)).catch((e) => { log('[user trade] the book did not answer:', e && e.message); return [] }) : []
    if (sources.includes('leaf-resting') && book.length) {
      // Only orders resting in the tree of the operator the wallet joined.
      const operator = await operatorInfo().then((i) => i && i.operator)
      out.push(...restingEntries(book, { payAsset, receiveAsset, operator }))
    }
    if (onchain && book.length) out.push(...onchainFillEntries(book, { payAsset, receiveAsset }))
    if (sources.includes('covenant-round') && deps.relayBook) {
      try {
        const nf = notFinal()
        for (const e of covenantRoundEntries(book, { payAsset, receiveAsset })) {
          if (nf[e.id]) { log('[user trade] not offered: the operator holds order', e.id, 'not final yet'); continue }
          // What the order can be filled for now: the relay's status of it (statuses[i] of
          // offers[i]; the signed offer_amount overstates it after a part fill), else the chain.
          const active = e.raw && e.raw._status && e.raw._status.active_amount
          if (active != null) {
            e.maxReceive = big(active)
            if (e.maxReceive <= 0n) continue
          } else if (deps.outputValue) {
            const [txid, vout] = e.id.split(':')
            const v = await Promise.resolve(deps.outputValue(txid, Number(vout))).catch(() => null)
            if (v == null) continue
            e.maxReceive = big(v)
          }
          out.push(e)
        }
      } catch (e) { log('[user trade] the book did not answer:', e && e.message) }
    }
    return out.filter((e) => nearFeed(e, payAsset, receiveAsset))
  }

  // Whether an entry's price is within reach of the price feed's: an entry giving more than twice,
  // or less than half, of what the feed says the pay asset is worth in the receive asset is
  // mispriced at its source (a maker that read a bad price, an order posted inverted), and is
  // never shown or taken. Without a feed price for either asset, every entry stands.
  function nearFeed (e, payAsset, receiveAsset) {
    const fair = deps.fairRate ? deps.fairRate(payAsset, receiveAsset) : null
    if (!(fair > 0)) return true
    // Atoms received per atom paid, at the entry's price.
    const at = Number(e.rateDen) / Number(e.rateNum)
    const ok = at <= fair * FEED_REACH && at >= fair / FEED_REACH
    if (!ok) log('[user trade] an entry far off the price feed is left out:', e.source, e.id, 'gives', at, 'per atom against the feed\'s', fair)
    return ok
  }

  // What the operator's rounds can pay of `asset` now (its server's `fundable`), read at most every
  // five seconds; null when the server does not say. A take of a covenant order is paid to its maker
  // in the asset the person pays, from the operator's own coins in its round: a take larger than
  // that would wait for the operator, and a take cannot be called back.
  // One sync serves every trade moving on at the same time, and none runs again within
  // SYNC_EVERY_MS of the last: the library runs one command at a time, and a trade that waits
  // (a take waiting for its round) synced at every pass, so a slow node kept every quote waiting
  // behind syncs.
  let syncAsk = null
  function syncShared () {
    if (syncAsk && (syncAsk.pending || now() - syncAsk.at < SYNC_EVERY_MS)) return syncAsk.p
    const a = { at: now(), pending: true }
    a.p = run('sync').then(() => {}, (e) => log('[user trade] sync:', e && e.message)).finally(() => { a.pending = false; a.at = now() })
    syncAsk = a
    return a.p
  }

  // One `info` serves every caller for five seconds, those asking at the same time included: the
  // library runs one command at a time, and a quote asks from several candidates at once.
  let infoAsk = null
  function operatorInfo () {
    if (!infoAsk || now() - infoAsk.at > 5000) infoAsk = { at: now(), p: run('info').catch(() => null) }
    return infoAsk.p
  }
  async function operatorRoom (asset) {
    const info = await operatorInfo()
    const a = ((info && info.server_info && info.server_info.assets) || []).find((x) => x && x.asset === asset)
    return a && a.fundable != null ? big(a.fundable) : null
  }

  // Firm terms of one entry for `pay` atoms, priced by the library. -> a candidate or null.
  async function firm (entry, payAsset, receiveAsset, pay, have, until = Date.now() + firmMs) {
    planSingleStep(entry.source, { payAsset, receiveAsset, caps: entry.source === 'covenant-round' ? { leaf_take: true } : undefined })
    // Sized on what the wallet can pay, never on more: a site asks the price of all the wallet can
    // pay with a large probe amount, and a maker asked for its whole level refuses what it does
    // not hold.
    const size = sizeEntry(entry, pay < have ? pay : have)
    if (!size) return null
    if (entry.source === 'btc-gateway') return btcT.firm(entry, payAsset, receiveAsset, pay, have, size)
    if (entry.source === 'leaf-resting') return firmResting(entry, payAsset, receiveAsset, pay, have, size)
    if (entry.source === 'onchain-fill') return firmOnchain(entry, payAsset, receiveAsset, pay, have)
    if (entry.source === 'covenant-round') {
      // No more than the operator can pay its maker in this round now.
      const room = await operatorRoom(payAsset)
      let sized = size
      if (room != null && room < size.pay) {
        sized = room > 0n ? sizeEntry(entry, room) : null
        if (!sized) { log('[user trade] the operator cannot pay this take in a round now:', entry.id, String(room)); return null }
      }
      // The take's price and the operator's fee come from the library: size down until what it
      // gives fits what the person pays and what the wallet can pay now.
      let r = sized.receive
      const limit = pay < have ? pay : have
      for (let i = 0; i < 4; i++) {
        let q
        try { q = await run('take_quote', { order: entry.raw._relayJson || entry.raw, amount: String(r), max_fee_ppm: MAX_FEE_PPM }) } catch (e) {
          log('[user trade] take_quote:', e.message)
          // Short by the margins, or change below the smallest leaf: ask for less, by what is missing.
          const over = shortBy(e.message)
          if (over <= 0n || i >= 3) return null
          const s3 = sizeEntry(entry, (r * entry.rateNum) / entry.rateDen - over - 1n)
          if (!s3 || s3.receive >= r) return null
          r = s3.receive
          continue
        }
        // What leaves the wallet in all: the price, the operator's fee, and the margins of a
        // payment to itself when it holds no coin of exactly that much.
        let gives = big(q.spends ?? q.gives)
        // A payment to itself leaves change resting on a reassignment: it is settled in the next
        // round as part of the trade, so no coin of the wallet piles up reassignments, and that
        // fee is on the ticket too.
        let sc = null
        const ch = q.pays_itself && big(q.pays_itself.change)
        if (ch > 0n) {
          try { sc = await run('settle_quote', { asset: payAsset, value: String(ch), expiry: q.pays_itself.expiry }) } catch (e) { log('[user trade] settle_quote:', e.message); return null }
          gives += big(sc.fee)
        }
        if (gives <= limit) {
          return { source: entry.source, id: entry.id, entry, receive: big(q.filled), give: gives,
            fees: [{ asset: payAsset, atoms: big(q.fee) + (big(q.spends ?? q.gives) - big(q.gives)) + (sc ? big(sc.fee) : 0n) }], quote: q,
            settle: sc ? { change: sc } : null }
        }
        // Over by the fee: size the fill down by what the excess buys, and fit the lot rules again.
        const s2 = sizeEntry(entry, (r * entry.rateNum) / entry.rateDen - (gives - limit) - 1n)
        if (!s2 || s2.receive >= r) return null
        r = s2.receive
      }
      return null
    }
    if (entry.source === 'leaf-maker') {
      // Ask the maker for a firm offer of what the size gives, then read it with the library: what
      // the wallet gets, gives and pays, and the dates of the coin it gets.
      let give = size.receive
      for (let i = 0; i < 4; i++) {
        let o
        // A maker that does not answer a firm offer by the quote's deadline is left out of it;
        // acceptances and releases, which must complete, are never cut short.
        try { o = await deps.fetchJson(entry.maker + '/v1/firm', { method: 'POST', body: JSON.stringify({ give_asset: receiveAsset, want_asset: payAsset, give: String(give) }), signal: AbortSignal.timeout(Math.max(1000, until - Date.now())) }) }
        catch (e) {
          log('[user trade] maker firm:', e.message)
          // The maker holds less than its quote now (its last trade spent some): ask for half.
          if (/does not hold that much/.test(String(e.message))) {
            give = give / 2n
            if (give < entry.minReceive) return null
            continue
          }
          return null
        }
        let t
        try { t = await run('swap_read', { offer: o.offer }) } catch (e) {
          log('[user trade] swap_read:', e.message)
          // Paying that much would take all the wallet holds, with the margins its transactions leave
          // for their fees, or leave change below the operator's smallest leaf: ask again for less, by
          // what is missing (a site's probe sizes on all the wallet can pay).
          const over = shortBy(e.message)
          if (over > 0n && i < 3) {
            await releaseNow(entry.maker, o.swap)
            give = give - (over * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
            if (give < entry.minReceive) return null
            continue
          }
          release(entry.maker, o.swap); return null
        }
        if (t.gets.asset !== receiveAsset || t.gives.asset !== payAsset || big(t.gets.value) !== give) { release(entry.maker, o.swap); return null }
        const spend = big(t.gives.value) + big(t.pays.margins)
        const limit = pay < have ? pay : have
        if (spend > limit) {
          await releaseNow(entry.maker, o.swap)
          const over = spend - limit
          give = give - (over * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
          if (give < entry.minReceive) return null
          continue
        }
        // The coins the swap makes (what the wallet gets, and its change) are settled in a round
        // only when they would sit one reassignment short of the operator's limit: otherwise they
        // are the wallet's to use the moment the maker completes, and nothing waits for a round.
        // What settling costs, when it is needed, comes from the library.
        const most = await depthLimit()
        const settles = t.hops == null || most == null || Number(t.hops) >= most - 1
        let s = { asset: receiveAsset, value: String(give), fee: '0', after: String(give) }, sc = null
        const change = big(t.change && t.change.value)
        if (settles) {
          try {
            s = await run('settle_quote', { asset: receiveAsset, value: String(give), expiry: t.dates && t.dates.expiry })
            if (change > 0n) sc = await run('settle_quote', { asset: payAsset, value: String(change), expiry: t.dates && t.dates.expiry })
          } catch (e) { log('[user trade] settle_quote:', e.message); release(entry.maker, o.swap); return null }
        }
        const total = spend + (sc ? big(sc.fee) : 0n)
        if (total > limit) {
          // Settling the change costs too: what the trade takes in all must fit what is paid.
          await releaseNow(entry.maker, o.swap)
          give = give - ((total - limit) * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
          if (give < entry.minReceive) return null
          continue
        }
        const fees = [{ asset: payAsset, atoms: big(t.pays.margins) }]
        if (settles) fees.push({ asset: receiveAsset, atoms: big(s.fee) })
        if (sc) fees.push({ asset: payAsset, atoms: big(sc.fee) })
        return { source: entry.source, id: entry.id, entry, receive: big(s.after), give: total, offer: o, terms: t,
          settle: settles ? { received: s, change: sc } : null, fees }
      }
      return null
    }
    return null
  }

  // Firm terms of a fill of an order resting in the tree, priced by the library
  // (`order_fill_resting_quote`, from the operator's own view of the order): what leaves the wallet
  // is the coins it gives less the change, and the coins the fill brings (what it gets, and the
  // change) are settled in the next round, at the fee a coin of their expiry pays.
  async function firmResting (entry, payAsset, receiveAsset, pay, have, size) {
    const limit = pay < have ? pay : have
    let r = size.receive
    for (let i = 0; i < 4; i++) {
      let q
      try { q = await run('order_fill_resting_quote', { order: entry.id, amount: String(r) }) } catch (e) {
        // A fill spends only the wallet's coins no older than the order's: when those hold less
        // than the fill takes, the library says how much they hold, and the fill is sized to it.
        const m = /the outputs take (\d+) of asset \S+, more than the (\d+) the inputs hold/.exec(String(e && e.message))
        if (m && BigInt(m[1]) > 0n) {
          const r2 = (r * BigInt(m[2])) / BigInt(m[1]) - 1n
          const s2 = r2 > 0n ? sizeEntry(entry, (r2 * entry.rateNum) / entry.rateDen) : null
          if (s2 && s2.receive < r) { r = s2.receive; continue }
        }
        // Only coins expiring no earlier than the order's coin fill it, and the wallet's that do
        // hold too little: noted, so a quote that finds no other offer gets those coins ready.
        const old = /that expire no earlier than the order's coin \(median time (\d+)\) keep (\d+) past their checkpoints/.exec(String(e && e.message))
        if (old) tooOldFrom = Math.max(tooOldFrom || 0, Number(old[1]))
        log('[user trade] order_fill_resting_quote:', e.message); return null
      }
      if (!q.gets || q.gets.asset !== receiveAsset || big(q.gets.amount) !== r || !q.fee || q.fee.asset !== payAsset) { log('[user trade] the resting fill is not the one asked'); return null }
      const coins = (await run('coins')) || []
      const given = coins.filter((c) => (q.gives || []).includes(c.leaf_id))
      if (given.length !== (q.gives || []).length) return null
      const spends = given.reduce((n, c) => n + big(c.value), 0n) - big(q.change)
      const expiry = Math.min(...given.map((c) => Number(c.expiry)).filter((x) => x > 0), Number((q.served && q.served.expiry) || Infinity))
      let s, sc = null
      try {
        s = await run('settle_quote', { asset: receiveAsset, value: String(r), expiry })
        if (big(q.change) > 0n) sc = await run('settle_quote', { asset: payAsset, value: String(q.change), expiry })
      } catch (e) { log('[user trade] settle_quote:', e.message); return null }
      const total = spends + (sc ? big(sc.fee) : 0n)
      if (total <= limit) {
        return { source: entry.source, id: entry.id, entry, receive: big(s.after), give: total, quote: q,
          settle: { received: s, change: sc },
          fees: [{ asset: payAsset, atoms: spends - big(q.paid) + (sc ? big(sc.fee) : 0n) }, { asset: receiveAsset, atoms: big(s.fee) }] }
      }
      const s2 = sizeEntry(entry, (r * entry.rateNum) / entry.rateDen - (total - limit) - 1n)
      if (!s2 || s2.receive >= r) return null
      r = s2.receive
    }
    return null
  }

  // Firm terms of a covenant order taken on the chain: the FILL's own amounts (covenant-order.js
  // plans them exactly, as the taker's transaction must pay them) and one fill's network fee, in
  // the asset the wallet pays fees in. What leaves the wallet is the price, plus the fee when it is
  // paid in the same asset.
  async function firmOnchain (entry, payAsset, receiveAsset, pay, have) {
    let fee
    try { fee = await deps.onchain.fee(payAsset) } catch (e) { log('[user trade] on-chain fee:', e.message); return null }
    if (!fee || !fee.asset || big(fee.atoms) <= 0n) return null
    const sameFee = fee.asset === payAsset
    let limit = (pay < have ? pay : have) - (sameFee ? big(fee.atoms) : 0n)
    for (let i = 0; i < 4 && limit > 0n; i++) {
      const size = sizeEntry(entry, limit)
      if (!size) return null
      const c = entry.raw.covenant || entry.raw.Covenant
      const matched = { offer_id: entry.raw.offer_id, resting_is_covenant: true, covenant: c, covenant_locked: String(entry.maxReceive), fill_base_amount: String(size.receive) }
      let recipe
      try { recipe = planFillFromMatched(matched, null, {}) } catch (e) { log('[user trade] the order cannot be filled:', e.message); return null }
      // A covenant names its assets in the chain's internal byte order, the wallet in display order.
      const internal = (h) => String(h).match(/../g).reverse().join('')
      if (recipe.covenantAsset !== internal(receiveAsset) || recipe.creditAsset !== internal(payAsset)) { log('[user trade] the order does not sell what it is listed as selling'); return null }
      const price = big(recipe.creditValue)
      const give = price + (sameFee ? big(fee.atoms) : 0n)
      if (give <= (pay < have ? pay : have)) {
        return { source: entry.source, id: entry.id, entry, receive: size.receive, give, matched, price,
          fees: [{ asset: fee.asset, atoms: big(fee.atoms) }], fee }
      }
      limit -= give - (pay < have ? pay : have)
    }
    return null
  }

  function release (maker, swap) {
    if (!maker || !swap) return
    Promise.resolve(deps.fetchJson(maker + '/v1/release', { method: 'POST', body: JSON.stringify({ swap }) })).catch(() => {})
  }
  // A firm offer let go of before the maker is asked again for a smaller one: the maker holds its
  // coins for an offer until it is released, and refuses a second offer they would have paid.
  async function releaseNow (maker, swap) {
    if (!maker || !swap) return
    try { await deps.fetchJson(maker + '/v1/release', { method: 'POST', body: JSON.stringify({ swap }) }) } catch {}
  }

  // A firm answer within `ms`, or null: a source that answers later is let go of (drop), so the
  // offer it holds frees the maker's coins.
  function inTime (p, ms) {
    let late = false, timer = null
    const settled = Promise.resolve(p).then((c) => { if (late) { if (c) { log('[user trade] a source answered after the quote, let go:', c.source); drop(c) } return null } return c }, (e) => { log('[user trade] firm:', e && e.message); return null })
    const out = Promise.race([settled, new Promise((resolve) => { timer = setTimeout(() => { late = true; resolve(null) }, Math.max(0, ms)) })])
    return out.finally(() => clearTimeout(timer))
  }

  // Lets go of a priced choice that is not taken: the maker's held offer, and the wallet's own
  // Bitcoin invoice for it.
  function drop (c) {
    if (!c) return
    if (c.offer) release(c.entry.maker, c.offer.swap)
    if (c.btc) {
      btcT.release(c.entry.maker, c.btc.offer && c.btc.offer.swap)
      if (c.btc.invoice && deps.btc) Promise.resolve(deps.btc.cancelInvoice(c.btc.invoice.payment_hash)).catch(() => {})
    }
  }

  // The ticket for paying `amount` atoms of `payAsset` for `receiveAsset`.
  // -> { ok: true, ticket: { payAsset, receiveAsset, amountIn, amountOut, fees, upTo? }, choice }
  //  | { ok: false, why: 'not-listed'|'not-offered'|'no-funds'|'not-ready'|'redoing'|'busy'|'freeing'|'readying'|'too-small'|'no-firm-offer',
  //      soon? } (soon: what is not ready yet is ready in a minute or two)
  //  | { ok: false, why: 'part-ready', ready } (atoms payable now, too few for any offer)
  // What can be received for `payAsset` in one step now: each admitted pair's asset that some
  // source in the book offers, whatever the wallet holds. BTC counts only with the wallet's
  // Bitcoin Lightning (the gateway pays it there).
  async function offered (payAsset) {
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const chain = ad.pairs && ad.pairs.chains && ad.pairs.chains[ad.genesis]
    const pairs = ((chain && chain.pairs) || []).filter((p) => p.pay === payAsset && p.receive !== payAsset && (p.sources || []).length)
    const found = await Promise.all(pairs.map((p) => entries(payAsset, p.receive, p.sources)
      .then((es) => es.some((e) => e.source !== 'btc-gateway' || deps.btc) ? p.receive : null).catch(() => null)))
    return [...new Set(found.filter(Boolean))]
  }

  // Indicative terms in either direction, for the two amounts while a person types: the book's
  // best single-step source for paying `pay`, or the least paid to receive `receive`. No maker is
  // asked for firm terms (a firm offer holds the maker's coins); Review does that, fees and all.
  // The book's entries are read once every few seconds per pair.
  // -> { ok: true, pay, receive, short: { pay, receive } | null (the most one source fills now) }
  //  | { ok: false, why: 'not-listed'|'not-offered'|'too-small' }
  const estimates = new Map()
  async function estimate ({ payAsset, receiveAsset, pay, receive }) {
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const sources = admittedSources(ad.pairs, ad.genesis, payAsset, receiveAsset)
    if (!sources.length) return { ok: false, why: 'not-listed' }
    const key = payAsset + '>' + receiveAsset
    let c = estimates.get(key)
    if (!c || now() - c.at > 8000) {
      c = { at: now(), es: await entries(payAsset, receiveAsset, sources).catch(() => []) }
      estimates.set(key, c)
    }
    const es = c.es.filter((e) => (e.source !== 'btc-gateway' || deps.btc) && big(e.maxReceive) > 0n)
    if (!es.length) return { ok: false, why: 'not-offered' }
    const cdiv = (a, b) => (a + b - 1n) / b
    let most = null
    for (const e of es) { const r = big(e.maxReceive); if (!most || r > most.receive) most = { receive: r, pay: cdiv(r * e.rateNum, e.rateDen) } }
    const out = (p, r, short) => ({ ok: true, pay: String(p), receive: String(r), short: short ? { pay: String(most.pay), receive: String(most.receive) } : null })
    if (pay != null) {
      const A = big(pay)
      if (A <= 0n) return { ok: false, why: 'too-small' }
      let best = null
      for (const e of es) { const s = sizeEntry(e, A); if (s && (!best || s.receive > best.receive)) best = { ...s, e } }
      if (!best) return { ok: false, why: 'too-small' }
      // Short only when the source cannot take the whole amount (its size or its lot rules): what
      // the price's rounding leaves of the amount, less than one atom of what is received, is not.
      return out(A, best.receive, best.receive < (A * best.e.rateDen) / best.e.rateNum)
    }
    const R = big(receive)
    if (R <= 0n) return { ok: false, why: 'too-small' }
    let best = null
    for (const e of es) {
      if (R > big(e.maxReceive) || R < big(e.minReceive || 0)) continue
      const p = cdiv(R * e.rateNum, e.rateDen)
      if (!best || p < best) best = p
    }
    if (best != null) return out(best, R, false)
    return R > most.receive ? out(most.pay, most.receive, true) : { ok: false, why: 'too-small' }
  }

  // What a person is waiting on comes first: while a quote or a confirmation runs, no trade is moved
  // on (advance), so the library's one-at-a-time queue holds no follow-up of another trade (a sync of
  // many seconds on a slow link) ahead of it. The trades move on at the next pass after it.
  let asked = 0
  // The wallet's own upkeep waits too, for the whole of it, not only while a command runs: a sync
  // started between the steps of a quote (while a maker answers) held the next step for its whole
  // length (deps.leaves.hold, leaves.js asking).
  // The least expiry (median time) a resting order's coin asked of the wallet's coins in this
  // quote, when one refused them for expiring sooner; null otherwise.
  let tooOldFrom = null
  // When the wallet last asked a refresh of an asset's coins for a resting order (ms), so a quote
  // asked again while that round runs says so rather than asking again.
  const readyingSince = new Map()
  // Refreshes the wallet's live coins of `asset` that expire before median time `from`, in the
  // operator's next round (planned ones through their release): its new coins expire later than
  // any order resting now. Whether coins are being made ready.
  async function readyCoins (asset, from) {
    const since = readyingSince.get(asset)
    if (since && now() - since < READYING_MS) return true
    const coins = ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === asset && c.state === 'live')
    const planned = plannedCoins(await run('plans').catch(() => ({ plans: [] })))
    const old = coins.filter((c) => Number(c.expiry || 0) < from)
    if (!old.length) return false
    const kept = old.filter((c) => planned.has(c.leaf_id)).map((c) => c.leaf_id)
    const free = old.filter((c) => !planned.has(c.leaf_id)).map((c) => c.leaf_id)
    try {
      if (kept.length && deps.release) await Promise.resolve(deps.release(asset, kept))
      if (free.length) {
        const q = await run('quote', { leaves: free })
        await run('participate', { leaves: free, shown: q && q.coins })
      }
    } catch (e) { log('[user trade] getting coins ready:', e && e.message); return false }
    readyingSince.set(asset, now())
    log('[user trade] coins of', String(asset).slice(0, 8), 'refreshed for a resting order:', free.length + kept.length)
    return true
  }

  // Asks the wallet to free the live coins of `asset` an open offline-refresh plan keeps, in its
  // next round (deps.release): the library pays such a coin out of round only once a round has
  // freed it. Whether it asked. `mine`: the wallet's coins of the asset, when already read.
  async function freePlanned (asset, mine) {
    if (!deps.release) return false
    const coins = mine || ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === asset)
    const planned = plannedCoins(await run('plans').catch(() => ({ plans: [] })))
    const kept = coins.filter((c) => c.state === 'live' && planned.has(c.leaf_id)).map((c) => c.leaf_id)
    if (!kept.length) return false
    try { await Promise.resolve(deps.release(asset, kept)) } catch (e) { log('[user trade] release:', e && e.message) }
    return true
  }

  // Whether the operator calls a coin ready once its block is certified (anchor depth 0).
  function soon () {
    try { const d = deps.anchorDepth ? deps.anchorDepth() : null; return d !== null && d !== undefined && Number(d) === 0 } catch { return false }
  }

  const personWaits = (f) => async (...a) => {
    asked++
    try { return await (deps.leaves && deps.leaves.hold ? deps.leaves.hold(() => f(...a)) : f(...a)) } finally { asked-- }
  }

  async function quote ({ payAsset, receiveAsset, amount }) {
    const started = Date.now()
    tooOldFrom = null
    const A = big(amount)
    if (A <= 0n) return { ok: false, why: 'too-small' }
    // More than the wallet holds to spend, the rest vesting later: refused with the date from
    // which all of it can be used (default-arca.js vestingShort), whatever the pair. Nothing is
    // asked of a maker.
    if (payAsset !== 'BTC' && deps.vesting) {
      const lots = await Promise.resolve(deps.vesting(payAsset)).catch(() => [])
      if (lots && lots.length) {
        const can = deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : ((await spendable()).get(payAsset) || 0n)
        const v = vestingShort(lots, payAsset, A, can)
        // Vested, and being taken up by the wallet: ready in a moment.
        if (v && v.arriving) return { ok: false, why: 'not-ready', held: String(can + v.atoms), soon: true }
        if (v) return { ok: false, why: 'vesting', atoms: String(v.atoms), vests: v.vests }
      }
    }
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const sources = admittedSources(ad.pairs, ad.genesis, payAsset, receiveAsset)
    if (!sources.length) return { ok: false, why: 'not-listed' }
    // BTC is paid over the wallet's Bitcoin Lightning, never from a leaf. An order taken on the
    // chain is paid from the wallet's on-chain coins, the rest from its leaves.
    const haveLeaf = payAsset === 'BTC'
      ? (deps.btc ? big(await Promise.resolve(deps.btc.balance()).catch(() => 0n)) : 0n)
      : (await spendable()).get(payAsset) || 0n
    // BTC the wallet holds at its address, which a trade cannot pay from until it is moved where
    // trades pay BTC from: moved for the trade by itself (deps.btcMove), and said so; never "no BTC".
    let moving = false
    if (payAsset === 'BTC' && haveLeaf < A && deps.btcMove && deps.btcAtAddress) {
      const atAddress = big(await Promise.resolve(deps.btcAtAddress()).catch(() => 0n))
      if (atAddress > 0n) {
        try { deps.btcMove(A - haveLeaf); moving = true } catch (e) { log('[user trade] btc move:', e && e.message) }
        if (haveLeaf <= 0n) return { ok: false, why: 'btc-moving', moving: true }
      }
    }
    const haveChain = payAsset !== 'BTC' && deps.onchain && sources.includes('onchain-fill')
      ? big(await Promise.resolve(deps.onchain.balance(payAsset)).catch(() => 0n)) : 0n
    // A coin not ready yet is ready in a minute or two when the operator calls it ready once its
    // block is certified.
    const soonNow = soon()
    if (haveLeaf <= 0n && haveChain <= 0n) {
      // What the wallet shows it holds, though no source can pay from it now: the wallet is asked to
      // make it ready (default mode boards coins on the chain into the tree by itself).
      const held = payAsset !== 'BTC' && deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : 0n
      if (held > 0n) {
        try { deps.prepare && deps.prepare(payAsset) } catch {}
        // Not yet the wallet's to spend (a board waiting for its blocks), or held by something under
        // way: an order placed from it, a move the wallet is making, a refresh planned for it.
        const mine = ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === payAsset)
        // Live coins kept by an open offline-refresh plan are freed through the wallet's next round
        // (deps.release, the page's plan_release), as a payment from them is.
        if (await freePlanned(payAsset, mine)) return { ok: false, why: 'freeing', held: String(held), soon: soonNow }
        const busy = !mine.some((c) => c.state === 'pending') && mine.some((c) => BUSY_STATES.includes(c.state))
        // Coins a Bitcoin reorganisation took back out of the chain, being redone: never a loss.
        if (!busy && mine.some((c) => c.redoing === true)) return { ok: false, why: 'redoing', held: String(held) }
        return { ok: false, why: busy ? 'busy' : 'not-ready', held: String(held), soon: soonNow }
      }
      return { ok: false, why: 'no-funds' }
    }
    const haveOf = (e) => (e.source === 'onchain-fill' ? haveChain : haveLeaf)
    // The entries read for the estimate a moment ago stand: the firm terms are what the ticket shows.
    const fresh = estimates.get(payAsset + '>' + receiveAsset)
    const all = fresh && now() - fresh.at <= ENTRIES_FRESH_MS ? fresh.es : await entries(payAsset, receiveAsset, sources)
    const es = all.filter((e) => haveOf(e) > 0n)
    // Indicative first, so only the best few are asked for firm terms (a maker holds its coins
    // for a firm offer).
    const ind = es.map((e) => { const h = haveOf(e); const s = sizeEntry(e, A < h ? A : h); return s ? { e, receive: s.receive } : null }).filter(Boolean)
      .sort((a, b) => (b.receive > a.receive ? 1 : b.receive < a.receive ? -1 : 0))
      // A maker quoting several levels of one pair is asked once, at the level that gives the
      // most for this size: each firm offer holds its coins.
      .filter((x, i, l) => !x.e.maker || l.findIndex((y) => y.e.maker === x.e.maker && y.e.source === x.e.source) === i)
    // The amount would trade, but what the wallet can pay now is less than any offer takes: the
    // rest of what it holds is not ready yet (coins waiting on their blocks). Said so, never
    // "too small".
    if (!ind.length && es.some((e) => haveOf(e) < A && sizeEntry(e, A))) {
      if (payAsset === 'BTC' && moving) return { ok: false, why: 'btc-moving', moving: true }
      // The rest may be held in coins an offline-refresh plan keeps: those are freed through the
      // wallet's next round, whatever the free coins hold, never left waiting for nothing.
      if (payAsset !== 'BTC' && await freePlanned(payAsset)) return { ok: false, why: 'freeing', held: String(haveLeaf), soon: soonNow }
      const ready = es.reduce((m, e) => (haveOf(e) > m ? haveOf(e) : m), 0n)
      return { ok: false, why: 'part-ready', ready: String(ready), soon: soonNow }
    }
    // Firm terms of the best eight, all asked at once, within QUOTE_FIRM_MS: an entry that cannot
    // be firmed (a resting order the wallet's coins are too old for, a maker that ran short) or
    // that has not answered by then is left out, and a late answer is let go of. When none gives
    // firm terms and there is time left, they are asked once more a moment later.
    const cands = []
    const worth = worthFirming(ind).slice(0, 8)
    // Wall-clock time: the person's wait (deps.now may be a test's stand-in clock).
    const btcOnly = worth.length > 0 && worth.every(({ e }) => e.source === 'btc-gateway')
    const window = btcOnly ? Math.max(firmMs, deps.btcOnlyFirmMs || BTC_ONLY_FIRM_MS) : firmMs
    const until = Math.max(started + window, Date.now() + Math.min(QUOTE_FIRM_MIN_MS, window))
    for (let round = 0; round < 2 && !cands.length; round++) {
      if (round) { if (until - Date.now() < Math.min(FIRM_RETRY_MS + 2000, window / 2)) break; await sleep(FIRM_RETRY_MS) }
      const got = await Promise.all(worth.map(({ e }) => inTime(firm(e, payAsset, receiveAsset, A, haveOf(e), until), until - Date.now())))
      for (const c of got) if (c) cands.push(c)
    }
    const best = chooseCandidate(cands)
    for (const c of cands) if (c !== best) drop(c)
    // Offered, but nobody gave firm terms: that is not the amount's fault.
    // No firm offer, and the resting orders refused the wallet's coins only for expiring before
    // the order's coin: those coins are refreshed in the next round (a new coin expires later
    // than any order resting now), and the trade is priced again once they are in.
    if (!best && tooOldFrom != null && payAsset !== 'BTC' && await readyCoins(payAsset, tooOldFrom)) {
      return { ok: false, why: 'readying', held: String(haveLeaf), soon: soonNow }
    }
    if (!best) return { ok: false, why: !es.length ? 'not-offered' : ind.length ? 'no-firm-offer' : 'too-small' }
    const ticket = { payAsset, receiveAsset, amountIn: String(best.give), amountOut: String(best.receive),
      fees: best.fees.map((f) => ({ asset: f.asset, atoms: String(f.atoms) })), source: best.source }
    const have = haveOf(best.entry)
    if (have < A && best.give <= have) ticket.upTo = String(have)
    return { ok: true, ticket, choice: best, moving }
  }

  // Confirms a ticket's choice: writes the trade's record, then takes the one step. Answers the
  // record; `advance` follows it.
  async function confirm (choice, ticket) {
    const id = `${now()}-${Math.random().toString(16).slice(2, 10)}`
    const rec = put({ id, at: now(), source: choice.source, state: 'confirming', ticket })
    try {
      if (choice.source === 'covenant-round') {
        rec.order = choice.entry.id
        rec.orderJson = choice.entry.raw._relayJson || choice.entry.raw
        // The participations the wallet has now, so a take the page closed on is found again.
        rec.beforeParts = ((await run('participations')) || []).map((p) => p.participation)
        put(rec)
        // What a payment to itself costs is spent even when the take is voided later (its margins
        // come back at that coin's next refresh): a return then says so.
        rec.selfPayCost = String(big(choice.quote.spends ?? choice.quote.gives) - big(choice.quote.gives))
        rec.settleTargets = choice.settle && choice.settle.change ? [{ asset: choice.settle.change.asset, value: choice.settle.change.value, fee: choice.settle.change.fee }] : []
        rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
        put(rec)
        let r
        try { r = await run('take', { order: rec.orderJson, amount: choice.quote.filled, max_fee_ppm: MAX_FEE_PPM, shown: choice.quote }) } catch (e) {
          if (/order_not_final/.test(String(e && e.message))) markNotFinal(rec.order)
          throw e
        }
        rec.take = r.take; rec.state = 'sent'; rec.sentAt = now()
        return put(rec)
      }
      if (choice.source === 'leaf-maker') {
        if (choice.offer.expires_at && Number(choice.offer.expires_at) * 1000 - now() < FIRM_MARGIN_MS) {
          rec.state = 'failed'; rec.error = 'the firm offer lapsed before it was confirmed'; put(rec)
          release(choice.entry.maker, choice.offer.swap)
          const e = new Error('the price is no longer held'); e.code = 'lapsed'; throw e
        }
        rec.maker = choice.entry.maker; rec.swap = choice.offer.swap; rec.give = choice.terms.gets.value
        rec.receiveAsset = choice.terms.gets.asset
        rec.settleTargets = !choice.settle ? [] : [{ asset: choice.settle.received.asset, value: choice.settle.received.value, fee: choice.settle.received.fee },
          ...(choice.settle.change ? [{ asset: choice.settle.change.asset, value: choice.settle.change.value, fee: choice.settle.change.fee }] : [])]
        // The coins the wallet holds now, so the coin the swap brings is the one it did not hold.
        rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
        put(rec)
        const a = await run('swap_accept', { offer: choice.offer.offer, shown: choice.terms })
        rec.accept = a.accept; rec.state = 'sent'; rec.sentAt = now()
        put(rec)
        try { await deps.fetchJson(rec.maker + '/v1/accept', { method: 'POST', body: JSON.stringify({ swap: rec.swap, accept: rec.accept }) }) }
        catch (e) { log('[user trade] the maker did not take the acceptance yet:', e.message) }
        return put(rec)
      }
      if (choice.source === 'btc-gateway') return await btcT.confirm(choice, rec)
      if (choice.source === 'onchain-fill') {
        rec.order = choice.entry.id
        rec.fee = { asset: choice.fee.asset, atoms: String(choice.fee.atoms) }
        put(rec)
        const r = await deps.onchain.take(choice.matched, { fee: choice.fee, onTxid: (txid) => { rec.txid = txid; put(rec) } })
        rec.txid = r.txid; rec.state = 'sent'; rec.sentAt = now()
        return put(rec)
      }
      if (choice.source === 'leaf-resting') {
        rec.order = choice.entry.id
        rec.receiveAsset = choice.quote.gets.asset
        rec.settleTargets = [{ asset: choice.settle.received.asset, value: choice.settle.received.value, fee: choice.settle.received.fee },
          ...(choice.settle.change ? [{ asset: choice.settle.change.asset, value: choice.settle.change.value, fee: choice.settle.change.fee }] : [])]
        rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
        put(rec)
        const args = { order: rec.order, amount: choice.quote.filled }
        let r
        try { r = await run('order_fill_resting', { ...args, shown: choice.quote }) } catch (e) {
          if (!(e && (e.code === 'order_moved' || /order_moved/.test(String(e.message))))) throw e
          // Another taker filled first and the order rests at a new coin: filled there only for the
          // same amount at the same price and no higher fee, as shown.
          const again = await run('order_fill_resting_quote', args)
          const same = again.filled === choice.quote.filled && again.paid === choice.quote.paid && again.fee && again.fee.asset === choice.quote.fee.asset &&
            big(again.fee.amount) <= big(choice.quote.fee.amount) && big(again.change) === big(choice.quote.change)
          if (!same) { const x = new Error('the price is no longer held'); x.code = 'lapsed'; throw x }
          rec.movedFrom = choice.quote.coin
          r = await run('order_fill_resting', { ...args, shown: again })
        }
        rec.transfer = r.answer && r.answer.transfer_id
        rec.state = 'sent'; rec.sentAt = now()
        return put(rec)
      }
      throw new Error('no such source')
    } catch (e) {
      // A refusal (the library's or the operator's) leaves nothing moved. Any other error leaves
      // the outcome unknown: the library may still complete the step at its next sync, so the trade
      // stays open and is looked for (advance), and is called returned only if it never shows.
      const refused = e && (e.code === 'lapsed' || e.kind === 'refused' || e.kind === 'server_refused' || /^refused\b/i.test(String(e.message)))
      if (rec.state === 'confirming') {
        if (refused) { rec.state = 'failed'; rec.error = e.message; put(rec); throw e }
        rec.uncertain = true; rec.uncertainAt = now(); rec.error = e.message
        log('[user trade] the step did not answer; the trade is followed:', e.message)
        return put(rec)
      }
      throw e
    }
  }

  // Moves one trade on as far as it goes now. -> its record. When that changes what the wallet holds
  // (the trade's state, or what it brings held already), deps.changed is told, so the page reads its
  // balance again: an asset just received is one the person can pay with at once.
  async function advance (rec) {
    if (asked > 0) return rec
    const was = rec ? rec.state + '|' + heldAlready(rec) : null
    const r = await advanceOnce(rec)
    if (r && deps.changed && r.state + '|' + heldAlready(r) !== was) { try { deps.changed(r) } catch {} }
    return r
  }

  async function advanceOnce (rec) {
    if (!rec || ['settled', 'returned', 'failed'].includes(rec.state)) return rec
    if (rec.state === 'confirming') {
      // The page closed between the record and the step, or the step did not answer. A take or an
      // acceptance the library made is in its own store; read it there. A step that did not answer
      // is looked for until UNCERTAIN_MS has passed.
      const notFound = (why) => { if (rec.uncertain && now() - (rec.uncertainAt || 0) < UNCERTAIN_MS) return; rec.state = 'failed'; rec.error = why }
      if (rec.source === 'leaf-maker' && rec.swap) {
        const s = ((await run('swaps')) || []).find((x) => x.swap === rec.swap)
        if (s && s.role === 'taker') { rec.state = 'sent'; rec.sentAt = now() } else notFound('not accepted')
      } else if (rec.source === 'covenant-round') {
        // A take is a participation; one the wallet did not have before, and no other trade
        // names, is this trade's.
        const known = new Set([...(rec.beforeParts || []), ...records().map((r) => r.take).filter(Boolean)])
        const p = ((await run('participations')) || []).find((x) => !known.has(x.participation) && (x.new_leaves || []).some((n) => n.asset === rec.ticket.receiveAsset))
        if (p) { rec.take = p.participation; rec.state = 'sent'; rec.sentAt = now() } else notFound('not taken')
      } else if (rec.source === 'leaf-resting') {
        // A fill the page closed on is sent again by the library's next sync; the coin it brings
        // is then the wallet's.
        await syncShared()
        const got = ((await run('coins')) || []).find((c) => !(rec.before || []).includes(c.leaf_id) && c.asset === rec.receiveAsset && c.state === 'live')
        if (got) { rec.state = 'sent'; rec.sentAt = now() } else notFound('not filled')
      } else if (rec.source === 'onchain-fill') {
        // A FILL whose broadcast did not answer: it is the wallet's once the node knows it.
        const st = rec.txid ? await Promise.resolve(deps.onchain.status(rec.txid)).catch(() => 'unknown') : 'unknown'
        if (st !== 'unknown') { rec.state = 'sent'; rec.sentAt = now() } else notFound('not broadcast')
      } else if (rec.source === 'btc-gateway' && rec.hash) {
        // Selling: a payment under the hash is the wallet's lock. Buying: a receive under it.
        const mine = rec.dir === 'sell' ? ((await run('lightning_payments')) || {})[rec.hash] : ((await run('lightning_receives')) || {})[rec.hash]
        if (mine) { rec.state = rec.dir === 'sell' ? 'sent' : 'waiting'; rec.sentAt = now() } else notFound('not made')
      } else notFound('not made')
      put(rec)
      if (rec.state !== 'sent' && rec.state !== 'waiting') return rec
    }
    if (rec.source === 'covenant-round') return advanceTake(rec)
    if (rec.source === 'leaf-maker') return advanceSwap(rec)
    if (rec.source === 'btc-gateway') return btcT.advance(rec)
    if (rec.source === 'leaf-resting') return advanceResting(rec)
    if (rec.source === 'onchain-fill') return advanceOnchain(rec)
    return rec
  }

  // A covenant order taken on the chain: Settled once its FILL is final. A FILL the chain never
  // takes (another taker spent the order first, and the node dropped it) moved nothing: Returned
  // once it has not been seen for UNCERTAIN_MS.
  async function advanceOnchain (rec) {
    const st = await Promise.resolve(deps.onchain.status(rec.txid)).catch(() => 'unknown')
    rec.chainState = st
    if (st === 'final') { rec.state = 'settled'; rec.settledAt = now() }
    else if (st === 'unknown') {
      if (rec.missingSince == null) rec.missingSince = now()
      if (now() - rec.missingSince >= UNCERTAIN_MS) { rec.state = 'returned'; rec.error = 'the fill never reached the chain' }
    } else rec.missingSince = null
    return put(rec)
  }

  // A fill of a resting order: Settled once the relay records the fill final and the coins it
  // brought are settled in a round that is final.
  async function advanceResting (rec) {
    await syncShared()
    if (deps.relayFills && rec.transfer && !rec.fillFinal) {
      const fills = await Promise.resolve(deps.relayFills(rec.ticket.payAsset, rec.ticket.receiveAsset)).catch(() => [])
      const f = (fills || []).find((x) => x && x.txid === rec.transfer)
      rec.fillState = f ? f.state : null
      if (f && f.state === 'final') rec.fillFinal = true
    }
    // A fill whose answer never came carries no transfer id to find at the relay: its coins' round
    // alone says it is final.
    if ((await settleStep(rec)) === 'settled' && (rec.fillFinal || !deps.relayFills || !rec.transfer)) { rec.state = 'settled'; rec.settledAt = now() }
    return put(rec)
  }

  // The participation of the wallet's own that took coin `c`: named on a coin given up to it
  // (`refresh_waiting`, or the library's note "participation <id>"), and on one it spent once
  // released (`spent_by`). -> id | null
  function roundOf (c) {
    if (!c) return null
    const named = (v) => ((/^participation ([0-9a-f]{64})$/.exec(String(v || '')) || [])[1]) || null
    if (c.state === 'given') return c.refresh_waiting || named(c.note)
    if (c.state === 'spent') return named(c.spent_by)
    return null
  }
  // A coin the wallet paid on, or put into an order, a distribution or an offboard of its own,
  // after the trade brought it.
  const movedOn = (c) => c.state === 'spent' || c.state === 'given'

  // The operator's limit on reassignments since a round (`info.depth_limit`); null when unknown.
  async function depthLimit () {
    const info = await operatorInfo()
    const v = info && info.server_info && info.server_info.depth_limit
    return v != null ? Number(v) : null
  }

  async function participation (pid) {
    return ((await run('participations')) || []).find((p) => p.participation === pid) || null
  }

  // The coins a trade brings, or leaves as change on a reassignment, settled in the operator's
  // next round at no more than the fees its ticket showed: { settle: { coins, participations } }
  // on the record once asked; 'settled' once every round is final. A coin the library has already
  // given up to a round of its own (its refresh of received coins takes a coin as soon as it lands)
  // is settled by that round, followed under its own id; one paid on out of round leaves nothing of
  // the trade to settle. -> 'waiting'|'settled'
  async function settleStep (rec) {
    const targets = rec.settleTargets || []
    if (!targets.length) return 'settled'
    if (!rec.settle) {
      const all = ((await run('coins')) || []).filter((c) => c && !(rec.before || []).includes(c.leaf_id))
      const coins = []
      const taken = []
      const used = new Set()
      const targetOf = new Map()
      for (const t of targets) {
        // A target that names its coin is that coin; otherwise the coin of its asset and value.
        const c = t.leaf_id ? all.find((x) => x.leaf_id === t.leaf_id)
          : all.find((x) => !used.has(x) && x.asset === t.asset && String(x.value) === String(t.value) && (x.state === 'live' || roundOf(x)))
        if (c) used.add(c)
        const pid = roundOf(c)
        if (pid) { taken.push({ coin: c.leaf_id, participation: pid }); continue }
        if (c && c.state === 'live') { coins.push(c); targetOf.set(c.leaf_id, t); continue }
        if (c && t.leaf_id && movedOn(c)) continue
        const why = t.leaf_id ? `coin ${t.leaf_id} is not live yet` : `no live coin of ${t.value} of ${t.asset} yet`
        if (rec.settleWhy !== why) { rec.settleWhy = why; put(rec); log('[user trade] settle waits:', why) }
        return 'waiting'
      }
      // Only a coin one reassignment short of the operator's limit needs a round now: the rest stay
      // spendable at once (a round can take minutes, and holds the coin meanwhile), and the wallet's
      // own upkeep refreshes them before their dates. A library that does not count hops settles
      // every coin, as before.
      const limit = coins.length ? await depthLimit() : null
      const deep = coins.filter((c) => c.hops == null || limit == null || Number(c.hops) >= limit - 1)
      if (!deep.length && !taken.length) return 'settled'
      const parts = []
      if (deep.length) {
        let q
        try { q = await run('quote', { leaves: deep.map((c) => c.leaf_id), max_fee_ppm: MAX_FEE_PPM }) } catch (e) { log('[user trade] settle quote:', e.message); return 'waiting' }
        for (const qc of q.coins || []) {
          const t = targetOf.get(qc.leaf_id)
          if (!t || big(qc.fee) > big(t.fee)) { log('[user trade] a settle fee rose above the ticket:', qc.leaf_id, String(qc.fee)); return 'waiting' }
        }
        let r
        try { r = await run('participate', { leaves: deep.map((c) => c.leaf_id), max_fee_ppm: MAX_FEE_PPM, shown: q.coins }) } catch (e) { log('[user trade] participate:', e.message); return 'waiting' }
        const ok = ((r && r.participations) || []).filter((p) => p && !p.error && p.participation)
        if (!ok.length) { log('[user trade] participate:', JSON.stringify(r)); return 'waiting' }
        parts.push(...ok.map((p) => p.participation))
      }
      rec.settle = { coins: [...deep.map((c) => c.leaf_id), ...taken.map((t) => t.coin)], participations: [...new Set([...parts, ...taken.map((t) => t.participation)])] }
      put(rec)
      return 'waiting'
    }
    const ps = await Promise.all(rec.settle.participations.map((id) => participation(id)))
    rec.settleState = ps.map((p) => p && p.state)
    if (ps.every((p) => p && p.state === 'released' && (p.new_leaves || []).every((n) => n.state === 'live'))) return 'settled'
    if (ps.some((p) => p && ['void', 'expired', 'refused', 'lost'].includes(p.state))) rec.settle = null // asked again at the next pass
    return 'waiting'
  }

  async function advanceTake (rec) {
    await syncShared()
    const p = await participation(rec.take)
    if (!p) return rec
    rec.takeState = p.state
    if (p.state === 'released' && (p.new_leaves || []).every((n) => n.state === 'live')) {
      if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
    } else if (['void', 'expired', 'refused', 'lost'].includes(p.state)) {
      // The take never ran; the library gives its coin back on its own.
      const back = (p.gives || []).every((g) => g.state === 'live')
      if (back) { rec.state = 'returned'; rec.returnedAt = now(); if (big(rec.selfPayCost) > 0n) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: rec.selfPayCost }] }
    }
    return put(rec)
  }

  async function advanceSwap (rec) {
    await syncShared()
    const s = ((await run('swaps')) || []).find((x) => x.swap === rec.swap)
    rec.swapState = s && s.state
    if (s && s.state === 'cancelled') { rec.state = 'returned'; rec.returnedAt = now(); return put(rec) }
    if (s && s.state === 'accepted') {
      // The maker has not completed it: hand the acceptance over again (it may have missed it),
      // and after the wait take the coins back.
      try { await deps.fetchJson(rec.maker + '/v1/accept', { method: 'POST', body: JSON.stringify({ swap: rec.swap, accept: rec.accept }) }) } catch {}
      if (now() - (rec.sentAt || 0) > MAKER_COMPLETE_MS) {
        try {
          const held = ((await run('coins')) || []).filter((c) => c.state === 'offered')
          const c = await run('swap_cancel', { swap: rec.swap })
          if (c && c.cancelled) {
            rec.state = 'returned'; rec.returnedAt = now()
            // A cancel moves the coins signed into the acceptance to a fresh coin of the wallet's
            // own, a transfer that leaves margins: the return names them.
            if (c.respent && c.respent.length) {
              const was = held.filter((x) => c.respent.includes(x.leaf_id)).reduce((n, x) => n + big(x.value), 0n)
              const now2 = ((await run('coins')) || []).filter((x) => x.state === 'live' && !(rec.before || []).includes(x.leaf_id) && x.asset === rec.ticket.payAsset)
              const got = now2.reduce((n, x) => n + big(x.value), 0n)
              if (was > got) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: String(was - got) }]
            }
          }
        } catch (e) { log('[user trade] swap_cancel:', e.message) }
      }
      return put(rec)
    }
    if (!s || s.state !== 'done') return put(rec)
    // Done: the coins it brings are operator-confirmed until the next round settles them.
    if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
    return put(rec)
  }

  // Every open trade, moved on.
  async function resume () {
    const out = []
    for (const r of records()) {
      if (['settled', 'returned', 'failed'].includes(r.state)) continue
      try { out.push(await advance(r)) } catch (e) { log('[user trade] resume', r.id, e.message) }
    }
    return out
  }

  return { quote: personWaits(quote), estimate, offered, confirm: personWaits(confirm), advance, resume, records, spendable, release, drop, soon }
}
