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
//   held(asset)                -> what the wallet shows it holds of an asset, wherever it is; optional:
//                                 with it, a pay asset held but not payable now is 'not-ready', not
//                                 'no-funds'
//   prepare(asset)             -> asks the wallet to make an asset held but not payable ready (default
//                                 mode boards it); optional
//   store                      -> getItem/setItem (the trade records, persisted before signing)
//   now()                      -> milliseconds
//   sleep(ms), log(...)        -> optional

import { makerEntries, covenantRoundEntries, restingEntries, onchainFillEntries, sizeEntry, chooseCandidate, admittedSources } from './tooling/lsp/single-step-book.mjs'
import { planFillFromMatched } from './covenant-order.js'
import { planSingleStep } from './tooling/lsp/settlement-router.mjs'
import { btcTrades } from './user-trade-btc.js'

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
  'htlc', 'submarine', 'lsp', 'tree', 'anchor', 'unroll', 'exit', 'checkpoint', 'reassignment', 'on-chain', 'lightning', 'bridge', 'gateway'])

export function forbiddenIn (text) {
  const t = String(text || '').toLowerCase()
  return USER_MODE_FORBIDDEN_WORDS.filter((w) => new RegExp(`(^|[^a-z-])${w.replace(/[-]/g, '\\-')}([^a-z-]|$)`).test(t))
}

// Every string the user composer shows, in one place, so the word list can be checked against
// all of them (user-trade.test.mjs).
export const USER_WORDS = Object.freeze({
  pay: 'You pay',
  get: 'You get',
  amount: 'Amount',
  review: 'Review',
  confirm: 'Trade',
  cancel: 'Cancel',
  amountIn: 'You pay',
  amountOut: 'You get',
  fees: 'Fees',
  included: 'included above',
  noFees: 'No fees',
  upTo: (x) => `Up to ${x} can be traded now.`,
  notOffered: (get, pay) => `Not offered right now: nobody offers ${get} for ${pay} in one step.`,
  notListed: (get, pay) => `${get} for ${pay} is not offered.`,
  enter: 'Enter how much you pay.',
  tooSmall: 'That amount is too small to trade.',
  noFunds: (pay) => `You have no ${pay} to trade.`,
  // Held, and shown in the balance, but not where a trade can pay it from yet (just arrived, or
  // still being moved in by the wallet): never "you have none".
  notReady: (pay) => `Your ${pay} is not ready to trade yet. It will be in a few minutes; nothing has moved.`,
  pricing: 'Finding the best price…',
  priceMoved: 'The price moved. Here is the new one.',
  sent: 'Sent',
  settled: 'Settled',
  // A trade that waits on Bitcoin blocks says what is already true while it waits.
  waitingOther: 'Waiting for the other side. Nothing has left your wallet yet.',
  receivedSettling: 'Received. Settled after the next Bitcoin blocks.',
  minutes: (word, n) => `${word} (${n} min)`,
  returned: 'Returned: nothing traded.',
  returnedFees: (fees) => `Returned: nothing traded. Fees of ${fees} were paid.`,
  returnedLapsed: 'Returned: nothing traded. The other side\'s offer ran out while the trade waited.',
  working: 'Working…',
  failed: 'This trade could not be made. Nothing moved.',
  recent: 'Your trades',
  openTrades: 'Open',
  pastTrades: 'Past',
})

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
// its settling says so, with the minutes it has waited once it has waited one.
export function tradeStateWord (r, now = Date.now()) {
  const W = USER_WORDS
  if (r.state === 'settled') return W.settled
  if (r.state === 'returned' && (r.feesPaid || []).length) return null
  if (r.state === 'returned' && r.whyKind === 'lapsed') return W.returnedLapsed
  if (r.state === 'returned' || r.state === 'failed') return W.returned
  if (r.state === 'confirming') return W.working
  const since = (t) => Math.floor((now - (t || r.at || now)) / 60000)
  // Buying with BTC: nothing has left the wallet until its asset is held for it.
  if (r.state === 'waiting') { const m = since(r.waitingSince); return m >= 1 ? W.minutes(W.waitingOther, m) : W.waitingOther }
  const m = since(r.sentAt)
  const word = heldAlready(r) ? W.receivedSettling : W.sent
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
// open offline-refresh plan, which the library never spends outside a round.
export function spendableFrom (coins, plans) {
  const planned = new Set(((plans && plans.plans) || []).filter((p) => !/^(done|cancelled|stopped|finished)$/.test(String(p.state || ''))).map((p) => p.coin))
  const out = new Map()
  for (const c of coins || []) {
    if (!c || c.state !== 'live' || planned.has(c.leaf_id)) continue
    out.set(c.asset, (out.get(c.asset) || 0n) + big(c.value))
  }
  return out
}

const TRADES_KEY = 'swk.usertrade'

export function createEngine (deps) {
  // The node scans one wallet at a time; a command that meets another's scan is asked again
  // (the library's own words; nothing else is retried).
  const run = async (cmd, args) => {
    for (let i = 0; ; i++) {
      const t0 = now()
      try { const v = await deps.leaves.command(cmd, args || {}); if (now() - t0 > 2000) log(`[user trade] ${cmd} took ${now() - t0} ms`); return v } catch (e) {
        if (i < 8 && /Scan already in progress/.test(String(e && e.message))) { await sleep(500 + 500 * i); continue }
        throw e
      }
    }
  }
  const now = () => (deps.now ? deps.now() : Date.now())
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
    return spendableFrom(coins, plans)
  }

  // The candidates' entries for a directed pair, from every admitted source.
  async function entries (payAsset, receiveAsset, sources) {
    const out = []
    // A maker quotes in-tree swaps, and, with a Bitcoin Lightning node, BTC in one hash-lock.
    if (sources.includes('leaf-maker') || (sources.includes('btc-gateway') && deps.btc)) {
      for (const m of (deps.makers ? deps.makers() : [])) {
        try {
          const q = await deps.fetchJson(m + '/v1/quotes')
          out.push(...makerEntries(m, q.quotes, { payAsset, receiveAsset }).filter((e) => sources.includes(e.source)))
        } catch (e) { log('[user trade] maker', m, 'did not answer:', e && e.message) }
      }
    }
    const onchain = sources.includes('onchain-fill') && deps.onchain
    const wantBook = (sources.includes('covenant-round') || sources.includes('leaf-resting') || onchain) && deps.relayBook
    const book = wantBook ? await Promise.resolve(deps.relayBook(payAsset, receiveAsset)).catch((e) => { log('[user trade] the book did not answer:', e && e.message); return [] }) : []
    if (sources.includes('leaf-resting') && book.length) {
      // Only orders resting in the tree of the operator the wallet joined.
      const operator = await run('info').then((i) => i && i.operator).catch(() => null)
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
    return out
  }

  // What the operator's rounds can pay of `asset` now (its server's `fundable`), read at most every
  // five seconds; null when the server does not say. A take of a covenant order is paid to its maker
  // in the asset the person pays, from the operator's own coins in its round: a take larger than
  // that would wait for the operator, and a take cannot be called back.
  let infoSeen = null
  async function operatorRoom (asset) {
    if (!infoSeen || now() - infoSeen.at > 5000) infoSeen = { at: now(), info: await run('info').catch(() => null) }
    const a = ((infoSeen.info && infoSeen.info.server_info && infoSeen.info.server_info.assets) || []).find((x) => x && x.asset === asset)
    return a && a.fundable != null ? big(a.fundable) : null
  }

  // Firm terms of one entry for `pay` atoms, priced by the library. -> a candidate or null.
  async function firm (entry, payAsset, receiveAsset, pay, have) {
    planSingleStep(entry.source, { payAsset, receiveAsset, caps: entry.source === 'covenant-round' ? { leaf_take: true } : undefined })
    const size = sizeEntry(entry, pay)
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
        try { q = await run('take_quote', { order: entry.raw._relayJson || entry.raw, amount: String(r), max_fee_ppm: MAX_FEE_PPM }) } catch (e) { log('[user trade] take_quote:', e.message); return null }
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
        try { o = await deps.fetchJson(entry.maker + '/v1/firm', { method: 'POST', body: JSON.stringify({ give_asset: receiveAsset, want_asset: payAsset, give: String(give) }) }) }
        catch (e) { log('[user trade] maker firm:', e.message); return null }
        let t
        try { t = await run('swap_read', { offer: o.offer }) } catch (e) { log('[user trade] swap_read:', e.message); release(entry.maker, o.swap); return null }
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
        // What settling the coins it gets (what it receives, and its change) in the next round
        // costs, from the library: the swap is settled only after the next round.
        let s, sc = null
        const change = big(t.change && t.change.value)
        try {
          s = await run('settle_quote', { asset: receiveAsset, value: String(give), expiry: t.dates && t.dates.expiry })
          if (change > 0n) sc = await run('settle_quote', { asset: payAsset, value: String(change), expiry: t.dates && t.dates.expiry })
        } catch (e) { log('[user trade] settle_quote:', e.message); release(entry.maker, o.swap); return null }
        const total = spend + (sc ? big(sc.fee) : 0n)
        if (total > limit) {
          // Settling the change costs too: what the trade takes in all must fit what is paid.
          await releaseNow(entry.maker, o.swap)
          give = give - ((total - limit) * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
          if (give < entry.minReceive) return null
          continue
        }
        const fees = [{ asset: payAsset, atoms: big(t.pays.margins) }, { asset: receiveAsset, atoms: big(s.fee) }]
        if (sc) fees.push({ asset: payAsset, atoms: big(sc.fee) })
        return { source: entry.source, id: entry.id, entry, receive: big(s.after), give: total, offer: o, terms: t,
          settle: { received: s, change: sc }, fees }
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
  //  | { ok: false, why: 'not-listed'|'not-offered'|'no-funds'|'too-small' }
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

  async function quote ({ payAsset, receiveAsset, amount }) {
    const A = big(amount)
    if (A <= 0n) return { ok: false, why: 'too-small' }
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const sources = admittedSources(ad.pairs, ad.genesis, payAsset, receiveAsset)
    if (!sources.length) return { ok: false, why: 'not-listed' }
    // BTC is paid over the wallet's Bitcoin Lightning, never from a leaf. An order taken on the
    // chain is paid from the wallet's on-chain coins, the rest from its leaves.
    const haveLeaf = payAsset === 'BTC'
      ? (deps.btc ? big(await Promise.resolve(deps.btc.balance()).catch(() => 0n)) : 0n)
      : (await spendable()).get(payAsset) || 0n
    const haveChain = payAsset !== 'BTC' && deps.onchain && sources.includes('onchain-fill')
      ? big(await Promise.resolve(deps.onchain.balance(payAsset)).catch(() => 0n)) : 0n
    if (haveLeaf <= 0n && haveChain <= 0n) {
      // What the wallet shows it holds, though no source can pay from it now: the wallet is asked to
      // make it ready (default mode boards coins on the chain into the tree by itself).
      const held = payAsset !== 'BTC' && deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : 0n
      if (held > 0n) { try { deps.prepare && deps.prepare(payAsset) } catch {} return { ok: false, why: 'not-ready', held: String(held) } }
      return { ok: false, why: 'no-funds' }
    }
    const haveOf = (e) => (e.source === 'onchain-fill' ? haveChain : haveLeaf)
    const es = (await entries(payAsset, receiveAsset, sources)).filter((e) => haveOf(e) > 0n)
    // Indicative first, so only the best few are asked for firm terms (a maker holds its coins
    // for a firm offer).
    const ind = es.map((e) => { const h = haveOf(e); const s = sizeEntry(e, A < h ? A : h); return s ? { e, receive: s.receive } : null }).filter(Boolean)
      .sort((a, b) => (b.receive > a.receive ? 1 : b.receive < a.receive ? -1 : 0))
      // A maker quoting several levels of one pair is asked once, at the level that gives the
      // most for this size: each firm offer holds its coins.
      .filter((x, i, l) => !x.e.maker || l.findIndex((y) => y.e.maker === x.e.maker && y.e.source === x.e.source) === i)
    // Firm terms of the best three that give them: an entry that cannot be firmed (a resting
    // order the wallet's coins are too old for, a maker that ran short) makes way for the next.
    const cands = []
    let tried = 0
    for (const { e } of ind) {
      if (cands.length >= 3 || tried >= 8) break
      tried++
      const c = await firm(e, payAsset, receiveAsset, A, haveOf(e))
      if (c) cands.push(c)
    }
    const best = chooseCandidate(cands)
    for (const c of cands) if (c !== best) drop(c)
    if (!best) return { ok: false, why: es.length ? 'too-small' : 'not-offered' }
    const ticket = { payAsset, receiveAsset, amountIn: String(best.give), amountOut: String(best.receive),
      fees: best.fees.map((f) => ({ asset: f.asset, atoms: String(f.atoms) })), source: best.source }
    const have = haveOf(best.entry)
    if (have < A && best.give <= have) ticket.upTo = String(have)
    return { ok: true, ticket, choice: best }
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
        rec.settleTargets = [{ asset: choice.settle.received.asset, value: choice.settle.received.value, fee: choice.settle.received.fee },
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

  // Moves one trade on as far as it goes now. -> its record.
  async function advance (rec) {
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
        await run('sync').catch(() => {})
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
    await run('sync').catch((e) => log('[user trade] sync:', e.message))
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

  async function participation (pid) {
    return ((await run('participations')) || []).find((p) => p.participation === pid) || null
  }

  // The coins a trade brings, or leaves as change on a reassignment, settled in the operator's
  // next round at no more than the fees its ticket showed: { settle: { coins, participations } }
  // on the record once asked; 'settled' once every round is final. -> 'waiting'|'settled'
  async function settleStep (rec) {
    const targets = rec.settleTargets || []
    if (!targets.length) return 'settled'
    if (!rec.settle) {
      const fresh = ((await run('coins')) || []).filter((c) => !(rec.before || []).includes(c.leaf_id) && c.state === 'live')
      const coins = []
      for (const t of targets) {
        const c = fresh.find((x) => !coins.includes(x) && x.asset === t.asset && String(x.value) === String(t.value))
        if (!c) return 'waiting'
        coins.push(c)
      }
      let q
      try { q = await run('quote', { leaves: coins.map((c) => c.leaf_id), max_fee_ppm: MAX_FEE_PPM }) } catch (e) { log('[user trade] settle quote:', e.message); return 'waiting' }
      for (const qc of q.coins || []) {
        const t = targets[coins.findIndex((c) => c.leaf_id === qc.leaf_id)]
        if (!t || big(qc.fee) > big(t.fee)) { log('[user trade] a settle fee rose above the ticket:', qc.leaf_id, String(qc.fee)); return 'waiting' }
      }
      let r
      try { r = await run('participate', { leaves: coins.map((c) => c.leaf_id), max_fee_ppm: MAX_FEE_PPM, shown: q.coins }) } catch (e) { log('[user trade] participate:', e.message); return 'waiting' }
      const parts = ((r && r.participations) || []).filter((p) => p && !p.error && p.participation)
      if (!parts.length) { log('[user trade] participate:', JSON.stringify(r)); return 'waiting' }
      rec.settle = { coins: coins.map((c) => c.leaf_id), participations: parts.map((p) => p.participation) }
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
    await run('sync').catch((e) => log('[user trade] sync:', e.message))
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
    await run('sync').catch((e) => log('[user trade] sync:', e.message))
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

  return { quote, offered, confirm, advance, resume, records, spendable, release, drop }
}
