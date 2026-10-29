// A site's market and limit orders (the provider protocol's `placeOrder`, `getOrders`,
// `cancelOrder`), settled the way this wallet's own Trade tab settles a trade.
//
// A market order is one trade of the user composer's engine (user-trade.js): it reads the
// single-step book, has the leaf library price each candidate, and settles the best one in one
// step, from the wallet's leaves or, where the engine is given them, its on-chain coins. A limit
// order is that same trade when the best price meets the limit; otherwise the whole amount rests
// on the book as an order placed from the wallet's leaves (the library's `order_quote` and
// `order_place`), listed by the wallet once it rests, and taken back by its refund once its time
// has run out. Against BTC a limit order only trades: BTC is paid over the wallet's Bitcoin
// Lightning, and nothing of it rests.
//
// Each step answers what the person must approve (`display`, in the words of
// docs/DEFAULT_MODE.md) before anything is signed; the approval itself is the caller's: the web
// wallet's dialog, the extension's approval window, Ambra's sheet. Every amount on it is the
// engine's or the library's; nothing the site sent is trusted beyond the market, the side, the
// amount and the price.
//
// deps:
//   engine            createEngine's (quote, confirm, drop, advance, records)
//   leaves.command(name, args) -> the leaf library's answer
//   assetMeta(hex)    -> { ticker, precision }
//   fmtAtoms(atoms, precision) -> a decimal string
//   store             getItem/setItem; tag() names the wallet
//   list(order, rec)  -> posts an order placed here on the book once it rests; optional
//   busy(on)          told while a review is being priced or settled, so a page's own follow of
//                     its trades waits (the wallet answers one command at a time); optional
//   followTrades      false where the page's own composer already follows every trade it made
//                     (the web wallet's Trade tab); `follow` then lists orders only
//   now()             -> milliseconds; optional
//   log(...)          optional

import { USER_WORDS, costLine } from './user-trade.js'

const HEX64 = /^[0-9a-f]{64}$/
const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
const ceilDiv = (a, b) => (a + b - 1n) / b
const KEY = 'swk.siteorders'
const QUOTE_TTL_MS = 5 * 60 * 1000
const DAY = 86400

export const SITE_WORDS = Object.freeze({
  tradeTitle: 'Trade?',
  restTitle: 'Place an order?',
  takeBackTitle: 'Take back what is left of your order?',
  askedBy: 'Asked by',
  youSell: 'You sell',
  forAtLeast: 'For',
  price: 'Price',
  smallest: 'Smallest part filled',
  takeBack: 'What is left can be taken back from',
  restText: 'Nothing on the book meets your price now, so the order rests on the book at your price: anyone can fill it, all or in parts, while your wallet is closed. What it is paid arrives in your wallet.',
  tradeText: 'One trade, at the best price the book offers now.',
  takeBackText: 'The order comes off the book and what is left of it returns to your wallet.',
  notYet: (when) => `this order can be taken back from ${when}; until then it stays on the book for anyone to fill at your price`,
  priceNotMet: 'Nothing on the book meets that price right now.',
  cannotRest: 'This order could not be placed. Nothing moved.',
  notReady: (t) => `Not enough ${t} is ready to place this order yet: what arrived recently is ready once it settles. Nothing moved.`,
  lapsed: 'This review is no longer current: place the order again.',
})

// The order's terms from the site's params; refuses what is not a market of two assets, a side,
// an amount and (limit) a price.
export function readParams (p) {
  const type = p && p.type === 'limit' ? 'limit' : p && p.type === 'market' ? 'market' : null
  if (!type) throw new Error("type must be 'market' or 'limit'")
  const base = String((p && p.base) || '').toLowerCase()
  const quote = p && p.quote === 'BTC' ? 'BTC' : String((p && p.quote) || '').toLowerCase()
  if (!HEX64.test(base)) throw new Error('base must be a 32-byte hex asset id')
  if (quote !== 'BTC' && !HEX64.test(quote)) throw new Error("quote must be a 32-byte hex asset id or 'BTC'")
  if (base === quote) throw new Error('base and quote must differ')
  const side = p.side === 'buy' || p.side === 'sell' ? p.side : null
  if (!side) throw new Error("side must be 'buy' or 'sell'")
  const amount = String(p.amount ?? '')
  if (!/^\d+$/.test(amount) || big(amount) <= 0n) throw new Error('amount must be a positive number of base atoms')
  let price = null
  if (type === 'limit') {
    price = String(p.price ?? '')
    if (!/^\d+$/.test(price) || big(price) <= 0n) throw new Error('a limit order needs a price: quote atoms per whole base unit')
  }
  return { type, base, quote, side, amount: big(amount), price: price == null ? null : big(price) }
}

// What a limit order rests as: what it sells, for what, at which rate (want atoms per sold atoms).
// `unit` is 10^(base precision): the price is quote atoms per whole base unit.
// The rate is kept in lowest terms: a fill multiplies by it in 64-bit arithmetic.
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a }
export function restTerms (o, unit) {
  const g = gcd(o.price, unit)
  if (o.side === 'sell') return { sell: o.base, want: o.quote, amount: o.amount, rate_num: o.price / g, rate_den: unit / g }
  return { sell: o.quote, want: o.base, amount: ceilDiv(o.amount * o.price, unit), rate_num: unit / g, rate_den: o.price / g }
}

// Whether a ticket meets a limit: a sale gets at least the price per base, a purchase pays at most it.
export function meetsLimit (o, ticket, unit) {
  const inA = big(ticket.amountIn); const out = big(ticket.amountOut)
  if (inA <= 0n || out <= 0n) return false
  // sell: out(quote) / in(base) >= price / unit; buy: in(quote) / out(base) <= price / unit
  return o.side === 'sell' ? out * unit >= o.price * inA : inA * unit <= o.price * out
}

export function makeSiteOrders (d) {
  const now = () => (d.now ? d.now() : Date.now())
  const log = d.log || (() => {})
  const tag = () => { try { return d.tag ? d.tag() : 'default' } catch { return 'default' } }
  const key = () => KEY + '.' + tag()
  const read = () => { try { return JSON.parse(d.store.getItem(key()) || '{}') || {} } catch { return {} } }
  const write = (v) => { try { d.store.setItem(key(), JSON.stringify(v)) } catch {} }
  const db = () => { const v = read(); v.trades = v.trades || {}; v.orders = v.orders || {}; return v }
  const pending = new Map()

  const meta = (h) => { if (h === 'BTC') return { ticker: 'BTC', precision: 8 }; try { return d.assetMeta(h) || {} } catch { return {} } }
  const tick = (h) => { const m = meta(h); return m.ticker && m.ticker !== '?' ? m.ticker : String(h).slice(0, 8) + '…' }
  const prec = (h) => Number(meta(h).precision || 0)
  const fmt = (h, atoms) => d.fmtAtoms(big(atoms), prec(h)) + ' ' + tick(h)
  const unitOf = (h) => 10n ** BigInt(prec(h))
  const when = (unix) => new Date(Number(unix) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const priceText = (o) => d.fmtAtoms(o.price, prec(o.quote)) + ' ' + tick(o.quote) + ' per ' + tick(o.base)
  const nid = () => `${now()}-${Math.random().toString(16).slice(2, 10)}`
  // The fees' one line, under its own label: "<amount>, included above", or "No fees".
  const feeRow = (fees, pay) => { const l = costLine(fees, fmt, pay); return [USER_WORDS.fees, l.startsWith(USER_WORDS.fees + ' ') ? l.slice(USER_WORDS.fees.length + 1) : l] }

  function refusal (q, pay, get) {
    const W = USER_WORDS
    if (q.why === 'not-listed') return W.notListed(tick(get), tick(pay))
    if (q.why === 'not-offered') return W.notOffered(tick(get), tick(pay))
    if (q.why === 'no-funds') return W.noFunds(tick(pay))
    if (q.why === 'not-ready') return W.notReady(tick(pay))
    return W.tooSmall
  }

  // One trade of the engine for the order: a sale pays its amount; a purchase pays what the book
  // asks for its amount, read from a first price for all the wallet can pay.
  async function tradeQuote (o) {
    const pay = o.side === 'sell' ? o.base : o.quote
    const get = o.side === 'sell' ? o.quote : o.base
    if (o.side === 'sell') return { pay, get, q: await d.engine.quote({ payAsset: pay, receiveAsset: get, amount: o.amount }) }
    const probeAmount = o.price != null ? ceilDiv(o.amount * o.price, unitOf(o.base)) : 10n ** 18n
    const probe = await d.engine.quote({ payAsset: pay, receiveAsset: get, amount: probeAmount })
    if (!probe.ok) return { pay, get, q: probe }
    const t = probe.ticket
    if (big(t.amountOut) <= o.amount) return { pay, get, q: probe }
    try { d.engine.drop(probe.choice) } catch {}
    const want = ceilDiv(o.amount * big(t.amountIn), big(t.amountOut))
    return { pay, get, q: await d.engine.quote({ payAsset: pay, receiveAsset: get, amount: want }) }
  }

  // While a review is priced or settled, the page's own follow of its trades waits.
  const busy = (fn) => async (...a) => { try { d.busy && d.busy(true) } catch {} try { return await fn(...a) } finally { try { d.busy && d.busy(false) } catch {} } }

  // -> { id, display }: what the person approves. Nothing is signed yet.
  async function quote (params, origin) {
    const o = readParams(params)
    const asked = [SITE_WORDS.askedBy, String(origin || '')]
    let tq = null
    const t0 = now()
    try { tq = await tradeQuote(o) } catch (e) { log('[site orders] no price:', e && e.message); tq = null }
    log(`[site orders] ${o.type} ${o.side}: priced in ${now() - t0} ms:`, tq && tq.q ? (tq.q.ok ? `${tq.q.ticket.amountIn} -> ${tq.q.ticket.amountOut}` : tq.q.why) : 'no price')
    const unit = unitOf(o.base)
    const takes = tq && tq.q && tq.q.ok && (o.type === 'market' || meetsLimit(o, tq.q.ticket, unit))
    if (takes) {
      const t = tq.q.ticket
      const id = nid()
      pending.set(id, { kind: 'take', o, origin, choice: tq.q.choice, ticket: t, at: now() })
      const rows = [[USER_WORDS.amountIn, fmt(t.payAsset, t.amountIn)], [USER_WORDS.amountOut, fmt(t.receiveAsset, t.amountOut)],
        feeRow(t.fees, t.payAsset)]
      if (t.upTo) rows.push(['', USER_WORDS.upTo(fmt(t.payAsset, t.upTo))])
      rows.push(asked)
      return { id, kind: 'take', display: { title: SITE_WORDS.tradeTitle, text: SITE_WORDS.tradeText, rows } }
    }
    if (tq && tq.q && tq.q.ok) { try { d.engine.drop(tq.q.choice) } catch {} }
    if (o.type === 'market' || o.quote === 'BTC') {
      if (o.type === 'limit') throw new Error(SITE_WORDS.priceNotMet)
      throw new Error(tq && tq.q ? refusal(tq.q, tq.pay, tq.get) : USER_WORDS.failed)
    }
    // Rest the whole amount at the price, from the wallet's leaves.
    const terms = restTerms(o, unit)
    const sch = await d.leaves.command('schedule', {})
    const args = { sell: terms.sell, want: terms.want, amount: String(terms.amount), rate_num: String(terms.rate_num), rate_den: String(terms.rate_den),
      min_lot: String(terms.amount / 10n > 0n ? terms.amount / 10n : 1n), expiry: String(Number(sch.now) + DAY) }
    let q
    const t1 = now()
    try { q = await d.leaves.command('order_quote', args); log(`[site orders] order_quote in ${now() - t1} ms`) } catch (e) {
      log('[site orders] order_quote:', e && e.message)
      const short = /live coins of asset/.test(String(e && e.message))
      const x = new Error(short ? SITE_WORDS.notReady(tick(args.sell)) : SITE_WORDS.cannotRest); x.cause = e; throw x
    }
    const id = nid()
    pending.set(id, { kind: 'rest', o, origin, args, quote: q, at: now() })
    const fee = q.fee || {}
    const rows = [[SITE_WORDS.youSell, fmt(args.sell, args.amount)], [SITE_WORDS.forAtLeast, fmt(args.want, q.full_price)],
      [SITE_WORDS.price, priceText(o)], [SITE_WORDS.smallest, fmt(args.sell, q.min_lot ?? args.min_lot)],
      // The placement's fee is paid on top of what is sold.
      [USER_WORDS.fees, fee.amount && big(fee.amount) > 0n ? fmt(fee.asset || args.sell, fee.amount) + ', on top' : USER_WORDS.noFees],
      [SITE_WORDS.takeBack, when(q.expiry_locktime ?? args.expiry)], asked]
    return { id, kind: 'rest', display: { title: SITE_WORDS.restTitle, text: SITE_WORDS.restText, rows } }
  }

  // A review the person declined, or that lapsed: what it held is let go.
  function drop (id) {
    const p = pending.get(id); pending.delete(id)
    if (p && p.kind === 'take') { try { d.engine.drop(p.choice) } catch {} }
  }

  // Settles an approved review. -> placeOrder's answer.
  async function confirm (id) {
    const p = pending.get(id); pending.delete(id)
    if (!p || now() - p.at > QUOTE_TTL_MS) { if (p) drop(id); throw new Error(SITE_WORDS.lapsed) }
    const market = { base: p.o.base, quote: p.o.quote }
    if (p.kind === 'take') {
      const rec = await d.engine.confirm(p.choice, p.ticket)
      if (rec.state === 'failed') throw new Error(USER_WORDS.failed)
      const gave = p.ticket.amountIn, got = p.ticket.amountOut
      // In the market's terms: base and quote atoms of the one fill.
      const fill = p.o.side === 'sell' ? { base: String(gave), quote: String(got) } : { base: String(got), quote: String(gave) }
      const v = db(); v.trades[rec.id] = { origin: p.origin, market, side: p.o.side, type: p.o.type, at: now(), ...fill }; write(v)
      return { trade: rec.id, filled: 1, failed: [], order: null, order_error: null, gave, got }
    }
    const offerId = [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, '0')).join('')
    const rec = { origin: p.origin, market, side: p.o.side, price: String(p.o.price), amount: String(p.o.amount),
      sell: p.args.sell, sold: p.args.amount, rate_num: p.args.rate_num, rate_den: p.args.rate_den, offer_id: offerId, at: now() }
    // Written before the library is asked, so an order whose page closed while it was placed is
    // still this site's: it shows as being placed until the library's orders name it.
    let v = db(); v.placing = v.placing || {}; v.placing[offerId] = rec; write(v)
    let r
    try { r = await d.leaves.command('order_place', { ...p.args, shown: p.quote }) } catch (e) {
      v = db(); if (v.placing) delete v.placing[offerId]; write(v); throw e
    }
    v = db(); if (v.placing) delete v.placing[offerId]
    v.orders[r.order] = rec
    write(v)
    return { trade: null, filled: 0, failed: [], order: r.order, order_error: null, gave: '0', got: '0' }
  }

  // Moves this wallet's site trades on, and lists the orders placed here that rest now.
  async function follow () {
    const v = db()
    const recs = d.followTrades === false ? [] : (d.engine.records ? d.engine.records() : []).filter((r) => v.trades[r.id] && !['settled', 'returned', 'failed'].includes(r.state))
    for (const r of recs) { try { await d.engine.advance(r) } catch (e) { log('[site orders] follow:', e && e.message) } }
    const mine = Object.keys(v.orders)
    if (!mine.length || !d.list) return
    let lib = []
    try { lib = (await d.leaves.command('orders', {})) || [] } catch (e) { log('[site orders] orders:', e && e.message); return }
    for (const o of lib) {
      const rec = v.orders[o.order]
      if (!rec || rec.listed || o.state !== 'resting') continue
      try {
        const res = await d.list(o, rec)
        const w = db(); w.orders[o.order] = { ...w.orders[o.order], listed: o.rests_at, relay_expires: res && res.relay_expires }; write(w)
      } catch (e) { log('[site orders] list:', e && e.message) }
    }
  }

  function tradeState (r) {
    if (!r) return 'sent'
    if (r.state === 'settled') return 'settled'
    if (r.state === 'failed' || r.state === 'returned') return 'failed'
    return 'sent'
  }
  function orderState (o, rec) {
    const s = String(o && o.state || 'waiting')
    if (s === 'filled') return 'filled'
    if (s === 'refunded' || s === 'spent' || s === 'not_placed') return 'withdrawn'
    if (s !== 'resting') return 'placing'
    return big(o.holds) < big(rec.sold) ? 'filling' : 'open'
  }

  // getOrders' answer: the trades and orders this site made through this wallet.
  async function orders (origin) {
    const v = db()
    const recs = d.engine.records ? d.engine.records() : []
    const byId = new Map(recs.map((r) => [r.id, r]))
    const trades = Object.entries(v.trades).filter(([, t]) => t.origin === origin).map(([id, t]) => {
      const r = byId.get(id)
      const state = tradeState(r)
      return { trade: id, at: t.at, market: t.market, side: t.side, type: t.type, kind: 'take', order: null, state,
        fills: t.base != null ? [{ txid: id, base: t.base, quote: t.quote, state }] : [] }
    })
    const placing = Object.entries(v.placing || {}).filter(([, o]) => o.origin === origin)
    let ids = Object.entries(v.orders).filter(([, o]) => o.origin === origin)
    let lib = []
    if (ids.length || placing.length) { try { lib = (await d.leaves.command('orders', {})) || [] } catch (e) { log('[site orders] orders:', e && e.message) } }
    // An order placed while its page closed: the library's order of the same amount sold, made after
    // the record and named by no other record, is it.
    if (placing.length && lib.length) {
      const known = new Set(Object.keys(v.orders))
      for (const [pid, rec] of placing) {
        const o = lib.find((x) => !known.has(x.order) && String(x.amount ?? x.holds ?? '') === String(rec.sold))
        if (!o) continue
        known.add(o.order); v.orders[o.order] = rec; delete v.placing[pid]
      }
      write(v)
      ids = Object.entries(v.orders).filter(([, o]) => o.origin === origin)
    }
    const byOrder = new Map(lib.map((o) => [o.order, o]))
    const t = Math.floor(now() / 1000)
    const out = ids.map(([id, rec]) => {
      const o = byOrder.get(id) || null
      const state = orderState(o, rec)
      const soldNow = big(rec.sold) - big(o ? o.holds : rec.sold)
      // In base atoms: a sale filled what it sold; a purchase what it was paid, at its rate.
      const filled = rec.side === 'sell' ? soldNow : (soldNow * big(rec.rate_num)) / big(rec.rate_den)
      const from = o && o.refund_from != null ? Number(o.refund_from) : null
      return { order: id, market: rec.market, side: rec.side, price: rec.price, at: rec.at, amount: rec.amount,
        filled: String(filled < 0n ? 0n : filled), holds: String(o ? o.holds ?? '0' : rec.sold), sell: rec.sell, state, settled: state === 'filled',
        take_back_from: from, take_back_from_text: from ? when(from) : '', can_take_back: !!from && t >= from && (state === 'open' || state === 'filling'),
        fills: [], note: o && o.note ? String(o.note) : '' }
    })
    for (const [pid, rec] of Object.entries(v.placing || {}).filter(([, o]) => o.origin === origin)) {
      out.push({ order: pid, market: rec.market, side: rec.side, price: rec.price, at: rec.at, amount: rec.amount, filled: '0', holds: rec.sold,
        sell: rec.sell, state: 'placing', settled: false, take_back_from: null, take_back_from_text: '', can_take_back: false, fills: [], note: '' })
    }
    return { orders: out, trades }
  }

  // -> { id, display } for taking back one of this site's orders, once its time has run out.
  async function quoteCancel (params, origin) {
    const id = String((params && params.order) || '')
    const v = db(); const rec = v.orders[id]
    if (!rec || rec.origin !== origin) throw new Error('no such order of this site')
    const lib = (await d.leaves.command('orders', {})) || []
    const o = lib.find((x) => x.order === id)
    const from = o && o.refund_from != null ? Number(o.refund_from) : null
    if (!from || Math.floor(now() / 1000) < from) throw new Error(SITE_WORDS.notYet(from ? when(from) : 'its refund date'))
    const qid = nid()
    pending.set(qid, { kind: 'cancel', order: id, at: now() })
    return { id: qid, display: { title: SITE_WORDS.takeBackTitle, text: SITE_WORDS.takeBackText,
      rows: [[SITE_WORDS.youSell, fmt(rec.sell, rec.sold)], [SITE_WORDS.price, priceText({ ...rec, base: rec.market.base, quote: rec.market.quote, price: big(rec.price) })], [SITE_WORDS.askedBy, String(origin || '')]] } }
  }
  async function confirmCancel (qid) {
    const p = pending.get(qid); pending.delete(qid)
    if (!p || p.kind !== 'cancel') throw new Error(SITE_WORDS.lapsed)
    const r = await d.leaves.command('order_refund', { order: p.order })
    // The library answers the refund's txid as `refund`.
    return { order: p.order, txid: (r && (r.refund || r.txid || r.refund_txid)) || null }
  }

  return { quote: busy(quote), confirm: busy(confirm), drop, follow, orders, quoteCancel, confirmCancel: busy(confirmCancel) }
}
