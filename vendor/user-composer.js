// The Trade tab in user mode: what I pay, what I get, how much, one button.
//
// The engine (user-trade.js) reads the single-step book, prices the trade with the wallet's
// own leaf library and settles it in one native step; this module draws it. Before the button
// confirms, it shows three lines: what you pay, what you get, and the fees. After it, a card over
// the page follows the trade: "Sent", then "Settled", or "Returned: nothing traded."; closed, the
// trade goes on in Your trades, under the button, and its end is said wherever the person is
// (ctx.notify). Market trades only. Both pickers
// list BTC first. Every word it can show is in USER_WORDS, and none is a word of
// USER_MODE_FORBIDDEN_WORDS (user-trade.test.mjs checks both, the browser drive the page).
//
// ctx: { root (element), engine (createEngine's), assetMeta(hex) -> {ticker, precision},
//   fmtAtoms(atoms, precision) (fmtShow, optional: the same, grouped, for amounts read), parseAtoms(text, precision), knownAssets() -> [hex],
//   held(hex) -> atoms the person holds (the figure the Balance tab shows), vestingAtoms(hex) -> atoms
//   of it that vest later (optional: an asset held only so is listed to pay), admittedReceives(pay)
//   -> [hex] (optional: the receive picker lists those after what is offered now),
//   market: { relay() -> the relay's base URL, pairOf(a, b) -> {base, quote} } (optional: the
//   chosen pair's market under the inputs, market-view.js), isHidden(hex) -> the person hid it
//   (optional), refValue(hex, atoms) -> its value in words, "≈ $…" (optional),
//   links(record) -> [{ chain, href, text }] the transactions a trade made on a chain, in their
//   explorers (optional), notify(text, { sticky, link }) -> said wherever the person is (optional),
//   openHistory() -> shows History (optional) }
// Both pickers are the shared asset chooser (asset-picker.js): a search box, your assets first
// with their balances, BTC always, what the book offers now next, the rest found by searching.
// The receive picker lists BTC first, then every asset the book offers for what is paid in one
// step now (engine.offered), then the admitted rest, then every other asset known; it starts on
// the first one offered.

import { USER_WORDS, QUOTE_FIRM_MS, OFFERED_AGAIN_EVERY_MS, pickerOrder, costLine, tradeStateWord, tradeSteps } from './user-trade.js'
import { settleWords } from './default-arca.js'
import { mountMarketView } from './market-view.js'
import { openPicker, PICKER_WORDS } from './asset-picker.js'
import { RESTRICTED_WORDS } from './restricted-trade.js'
import { isStep } from './restricted-composed.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }
// The chooser button's marks (no words): what nothing chosen shows, and the arrow.
const NONE = '…'
const CARET = '▾'

// How long a trade is followed every few seconds, and how often after that.
// While the wallet gets coins ready for a trade, the trade is priced again this often, this many
// times at most (about ten minutes: a round and its block).
export const READY_RETRY_MS = 20_000
export const READY_TRIES = 30
// How long Trade waits for the trade's step before the screen is free again.
export const CONFIRM_SHOWN_MS = 1500
export const FOLLOW_FAST_MS = 120_000
export const FOLLOW_SLOW_MS = 30_000

// The "You pay" list: BTC always, and an asset only while the wallet holds some of it (or it is
// the one chosen now), in the pickers' order. A fresh wallet pays from BTC alone.
export function payAssets (known, held, current, name) {
  return pickerOrder((known || []).filter((a) => a === 'BTC' || big(held(a)) > 0n || a === current), held, name)
}

export function mountUserComposer (ctx) {
  // `card`: the open trade's card over the page ({ id, m }); `answer`: a restricted asset's card in
  // place of Trade (whom to ask, what to pay with). Two things: resetting the ticket after Trade
  // must not orphan the trade's card.
  const S = { pay: null, get: null, amount: '', recv: '', fixed: 'pay', ticket: null, choice: null, busy: false, note: '', error: '', timer: null,
    estTimer: null, estSeq: 0, card: null, answer: null, ended: null, progress: null, openedAt: Date.now(),
    offered: { pay: null, list: [], at: 0, loading: false } }
  const OFFERS_MS = ctx.offersMs || 60000
  // The pair and the amount typed are kept for the browser tab's session (ctx.session, a
  // sessionStorage), so a reload, or a tab the browser put to sleep, opens on them again. A ticket
  // is never kept: its price is asked again.
  const KEPT = ['pay', 'get', 'amount', 'recv', 'fixed', 'payChosen', 'getChosen']
  const keptKey = () => 'swk.composer.' + (ctx.tag ? ctx.tag() : 'default')
  try { const k = ctx.session && JSON.parse(ctx.session.getItem(keptKey()) || 'null'); if (k && typeof k === 'object') for (const f of KEPT) if (k[f] != null) S[f] = k[f] } catch {}
  function keep () { try { if (ctx.session) { const k = {}; for (const f of KEPT) k[f] = S[f] ?? null; ctx.session.setItem(keptKey(), JSON.stringify(k)) } } catch {} }
  const doc = ctx.root.ownerDocument || document
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const name = (h) => (h === 'BTC' ? 'BTC' : ((ctx.assetMeta(h) || {}).ticker || String(h).slice(0, 8)))
  const prec = (h) => (h === 'BTC' ? 8 : ((ctx.assetMeta(h) || {}).precision ?? 0))
  // Amounts the person reads are grouped as Balance groups them; an amount put in a field is plain.
  const show = (atoms, p) => (ctx.fmtShow || ctx.fmtAtoms)(atoms, p)
  const amt = (h, atoms) => `${show(big(atoms), prec(h))} ${name(h)}`

  // What can be paid: BTC always, and an asset only while the wallet holds some (a fresh wallet
  // pays from BTC alone); what can be got is every asset the book knows.
  // An asset held only as what vests later is listed too, so a trade of it says from when it can be;
  // and one with a payment on its way (ctx.onItsWay), which a trade settles first and then pays.
  const listed = (a) => big(ctx.held(a)) + (ctx.vestingAtoms ? big(ctx.vestingAtoms(a)) : 0n) + (ctx.onItsWay ? big(ctx.onItsWay(a) || 0n) : 0n)
  function payList () { return payAssets(ctx.knownAssets(), listed, S.pay, name) }
  // What is paid starts as the first asset held, in the pickers' order (BTC first when held).
  function defaultPay () { const l = payList(); return l.find((a) => big(ctx.held(a)) > 0n) || l.find((a) => ctx.onItsWay && big(ctx.onItsWay(a) || 0n) > 0n) || l[0] }
  function offeredNow () { return S.offered.pay === S.pay ? S.offered.list.filter((a) => a !== S.pay) : [] }
  function getList () {
    const admitted = (ctx.admittedReceives ? ctx.admittedReceives(S.pay) : []).filter((a) => a !== S.pay)
    const all = pickerOrder(ctx.knownAssets(), ctx.held, name).filter((a) => a !== S.pay)
    // BTC first, then what the book offers for this asset now, then what is admitted, then the rest.
    const head = S.pay !== 'BTC' ? ['BTC'] : []
    return [...new Set([...head, ...offeredNow(), ...admitted, ...all])].filter((a) => a !== S.pay)
  }
  // What is received starts as the first asset offered, until the person picks one.
  function defaultGet (gl) { const o = offeredNow(); return gl.find((a) => o.includes(a)) || gl[0] || null }

  // The book's offers for what is paid, asked when that changes and again after a minute; the
  // receive picker is redrawn in place, so typing is not disturbed.
  async function loadOffered () {
    const pay = S.pay
    if (!ctx.engine.offered || S.offered.loading || (S.offered.pay === pay && Date.now() - S.offered.at < OFFERS_MS)) return
    S.offered.loading = true
    let list = []
    try { list = await ctx.engine.offered(pay) } catch (e) { console.warn('[user composer] offers:', e && e.message) }
    S.offered = { pay, list: list || [], at: Date.now(), loading: false }
    // What is paid may have changed while the book was asked: ask again for that.
    if (pay === S.pay) paintGet(); else loadOffered()
  }
  function paintGet () {
    const old = ctx.root.querySelector('#ucGet'); if (!old) return
    const gl = getList()
    const was = S.get
    if (!S.getChosen || !gl.includes(S.get)) S.get = S.ticket || S.busy ? S.get : defaultGet(gl)
    old.replaceWith(chooser('ucGet', gl, S.get, pickGet))
    if (S.get !== was && !S.ticket) { S.error = ''; paintTicket() }
    if (S.get !== was && S.market) S.market.refresh().catch(() => {})
  }
  function pickGet (v) { S.get = v; S.getChosen = true; reset(); render(); schedule(0) }

  // ---- You pay and You receive, tethered ----
  // The amount typed stays as typed; the other follows the book's best single-step price now
  // (engine.estimate), again a moment after each keystroke and every few seconds while shown.
  function schedule (ms = 350) {
    clearTimeout(S.estTimer)
    S.estTimer = setTimeout(() => { estimateNow().catch((e) => console.warn('[user composer] estimate:', e && e.message)) }, ms)
  }
  async function estimateNow () {
    if (!ctx.engine.estimate || !S.pay || !S.get || S.ticket || S.busy) return
    const typed = S.fixed === 'pay' ? S.amount : S.recv
    const asset = S.fixed === 'pay' ? S.pay : S.get
    let atoms
    try { atoms = ctx.parseAtoms(String(typed || '').trim(), prec(asset)) } catch { atoms = 0n }
    const other = ctx.root.querySelector(S.fixed === 'pay' ? '#ucReceive' : '#ucAmount')
    if (!(big(atoms) > 0n)) { if (other && doc.activeElement !== other) { other.value = ''; if (S.fixed === 'pay') S.recv = ''; else S.amount = '' } S.note = ''; paintNote(); return }
    const seq = ++S.estSeq
    const e = await ctx.engine.estimate({ payAsset: S.pay, receiveAsset: S.get, ...(S.fixed === 'pay' ? { pay: String(atoms) } : { receive: String(atoms) }) })
    if (seq !== S.estSeq || S.ticket) return
    if (!e.ok && e.why === 'restricted') { S.note = ''; paintNote(); return }
    if (!e.ok) {
      S.note = e.why === 'not-listed' ? USER_WORDS.notListed(name(S.get), name(S.pay)) : e.why === 'too-small' ? USER_WORDS.tooSmall
        : e.why === 'btc-ahead' ? USER_WORDS.btcAhead
        : e.why === 'soon' ? USER_WORDS.notOfferedSoon(name(S.get), name(S.pay))
        : e.again ? USER_WORDS.offeredAgain(name(S.get), name(S.pay)) : USER_WORDS.notOffered(name(S.get), name(S.pay))
      if (other && doc.activeElement !== other) other.value = ''
      // Offered a moment ago: estimated again shortly, by itself (#698).
      if (e.again) schedule(OFFERED_AGAIN_EVERY_MS)
      paintNote(); return
    }
    const fill = S.fixed === 'pay' ? ctx.fmtAtoms(big(e.receive), prec(S.get)) : ctx.fmtAtoms(big(e.pay), prec(S.pay))
    if (other && doc.activeElement !== other) other.value = fill
    if (S.fixed === 'pay') S.recv = fill; else S.amount = fill
    S.note = e.short ? (e.short.soon ? USER_WORDS.bookUpToSoon : USER_WORDS.bookUpTo)(amt(S.get, e.short.receive)) : ''
    paintNote()
    paintAbout()
  }
  function paintNote () {
    const n = ctx.root.querySelector('#ucNote'); if (!n || S.ticket) return
    n.textContent = S.error || S.note || ''; n.classList.toggle('err', !!S.error)
  }

  // A picker: a button naming the asset chosen, which opens the shared chooser over `list`.
  function chooser (id, list, value, onchange) {
    const b = el('button', 'uc-pick'); b.type = 'button'; b.id = id; b.dataset.value = value || ''
    b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false')
    b.appendChild(el('span', 'uc-pick-tk', value ? name(value) : NONE))
    b.appendChild(el('span', 'uc-pick-caret', CARET))
    const offered = new Set(offeredNow())
    const tradable = new Set(ctx.admittedReceives && id === 'ucGet' ? ctx.admittedReceives(S.pay) : [])
    b.onclick = () => openPicker(b, list.map((h) => {
      // The figure the Balance tab shows: what is held, and what of it vests later.
      const atoms = big(ctx.held(h) || 0n) + (ctx.vestingAtoms ? big(ctx.vestingAtoms(h)) : 0n)
      const m = ctx.assetMeta(h) || {}
      return { hex: h, ticker: name(h), name: h === 'BTC' ? 'Bitcoin' : (m.name || ''), held: atoms > 0n,
        hidden: !!(ctx.isHidden && ctx.isHidden(h)), offered: offered.has(h), tradable: tradable.has(h), cur: h === value,
        bal: atoms > 0n ? { b: show(atoms, prec(h)), r: ctx.refValue ? ctx.refValue(h, atoms) : '' } : null }
    }), (hex) => onchange(hex), { hint: PICKER_WORDS.hintSearch })
    return b
  }

  function reset () { S.ticket = null; S.choice = null; S.note = ''; S.error = ''; S.moving = false; S.answer = null; S.stays = 0n }

  // "about" beside the amount that follows the price, while it is an estimate.
  function paintAbout () {
    const pa = ctx.root.querySelector('#ucPayAbout'), ra = ctx.root.querySelector('#ucRecvAbout')
    if (pa) pa.textContent = S.fixed === 'receive' && !S.ticket && String(S.amount || '').trim() ? USER_WORDS.about : ''
    if (ra) ra.textContent = S.fixed !== 'receive' && !S.ticket && String(S.recv || '').trim() ? USER_WORDS.about : ''
    paintValues()
  }
  // Under each amount, its value in the currency the page shows values in (ctx.refValue, "≈ 50 USD"),
  // when the asset has a price; nothing otherwise.
  function valueOf (asset, typed) {
    if (!ctx.refValue || !asset || !String(typed || '').trim()) return ''
    let atoms
    try { atoms = ctx.parseAtoms(String(typed).trim(), prec(asset)) } catch { return '' }
    if (!(big(atoms) > 0n)) return ''
    try { return ctx.refValue(asset, big(atoms)) || '' } catch { return '' }
  }
  function paintValues () {
    const pv = ctx.root.querySelector('#ucPayValue'), rv = ctx.root.querySelector('#ucRecvValue')
    if (pv) pv.textContent = valueOf(S.pay, S.amount)
    if (rv) rv.textContent = valueOf(S.get, S.recv)
  }

  function render () {
    const r = ctx.root
    if (!S.pay || !S.payChosen) S.pay = defaultPay()
    r.innerHTML = ''
    const box = el('div', 'ucomp'); box.id = 'userComposer'
    // The chosen pair's market (its chart, price, book and recent trades) goes under the button:
    // the assets are chosen first, then the market of the pair they make.
    const mk = el('div', 'uc-market'); mk.id = 'ucMarket'
    // You pay
    const row1 = el('div', 'uc-row')
    row1.appendChild(el('label', 'lbl', USER_WORDS.pay))
    row1.appendChild(chooser('ucPay', payList(), S.pay, (v) => { S.pay = v; S.maxed = false; S.payChosen = true; S.getChosen = false; S.get = null; reset(); render() }))
    const inp = el('input', 'uc-amount'); inp.id = 'ucAmount'; inp.inputMode = 'decimal'; inp.placeholder = USER_WORDS.amount; inp.value = S.amount
    const payAbout = el('span', 'sub uc-about'); payAbout.id = 'ucPayAbout'
    inp.oninput = () => { S.amount = inp.value; S.fixed = 'pay'; S.maxed = false; S.error = ''; keep(); if (S.ticket) { reset(); paintTicket() } paintValues(); schedule() }
    row1.appendChild(payAbout)
    row1.appendChild(inp)
    const payValue = el('div', 'sub uc-value'); payValue.id = 'ucPayValue'
    row1.appendChild(payValue)
    const have = el('div', 'sub uc-have'); have.id = 'ucHave'
    const haveLine = el('span', null, haveWords()); haveLine.id = 'ucHaveLine'
    have.appendChild(haveLine)
    const max = el('button', 'ghost uc-max', USER_WORDS.max); max.type = 'button'; max.id = 'ucMax'
    // What can be traded: the balance, and a payment on its way, which the trade settles first.
    // Max asks for all of it, the fees in (the person's figure is all-in): the trade empties the
    // coins, and the ticket's You pay is that same figure. When one trade cannot take all of it, the
    // amount becomes what goes, and the ticket names what stays (S.maxed and S.maxOf, cleared by
    // anything typed or chosen).
    max.onclick = () => { const a = big(ctx.held(S.pay) || 0n) + onWay(S.pay); if (a <= 0n) return; S.amount = ctx.fmtAtoms(a, prec(S.pay)); inp.value = S.amount; S.fixed = 'pay'; S.maxed = true; S.maxOf = a; S.maxAgain = false; if (S.ticket) { reset(); paintTicket() } schedule(0) }
    have.appendChild(max)
    row1.appendChild(have)
    box.appendChild(row1)
    // ⇅ exchanges the two sides; the amount typed stays with its asset, now on the other side.
    const flipRow = el('div', 'uc-flip-row')
    const flip = el('button', 'ghost uc-flip', USER_WORDS.flipMark); flip.type = 'button'; flip.id = 'ucFlip'
    flip.title = USER_WORDS.flip; flip.setAttribute('aria-label', USER_WORDS.flip); flip.disabled = !S.get
    flip.onclick = () => {
      if (!S.get) return
      ;[S.pay, S.get] = [S.get, S.pay]; [S.amount, S.recv] = [S.recv, S.amount]
      S.fixed = S.fixed === 'pay' ? 'receive' : 'pay'; S.payChosen = true; S.getChosen = true; S.maxed = false
      reset(); render(); schedule(0)
    }
    flipRow.appendChild(flip)
    box.appendChild(flipRow)
    // You receive
    const row2 = el('div', 'uc-row')
    row2.appendChild(el('label', 'lbl', USER_WORDS.get))
    const gl = getList()
    if (!S.get || !gl.includes(S.get)) S.get = defaultGet(gl)
    row2.appendChild(chooser('ucGet', gl, S.get, pickGet))
    const rin = el('input', 'uc-amount'); rin.id = 'ucReceive'; rin.inputMode = 'decimal'; rin.placeholder = USER_WORDS.amount; rin.value = S.recv
    // The amount not typed follows the book's price now: an estimate until Review, so it reads as
    // one ("about"); Review's ticket gives the exact amounts.
    const recvAbout = el('span', 'sub uc-about'); recvAbout.id = 'ucRecvAbout'
    row2.appendChild(recvAbout)
    rin.oninput = () => { S.recv = rin.value; S.fixed = 'receive'; S.maxed = false; S.error = ''; keep(); if (S.ticket) { reset(); paintTicket() } paintValues(); schedule() }
    row2.appendChild(rin)
    const recvValue = el('div', 'sub uc-value'); recvValue.id = 'ucRecvValue'
    row2.appendChild(recvValue)
    box.appendChild(row2)
    // The ticket and the button
    const t = el('div', 'uc-ticket'); t.id = 'ucTicket'; box.appendChild(t)
    const note = el('div', 'sub uc-note'); note.id = 'ucNote'; box.appendChild(note)
    const act = el('div', 'row uc-act'); act.id = 'ucAct'; box.appendChild(act)
    // Trades, under the button and above the market, where a trade just sent is seen.
    const list = el('div', 'uc-trades'); list.id = 'ucTrades'; box.appendChild(list)
    if (ctx.market) box.appendChild(mk)
    r.appendChild(box)
    keep()
    paintTicket()
    paintTrades()
    loadOffered()
    // The amount not typed follows the price every few seconds while the tab is shown.
    if (!S.refresh) S.refresh = setInterval(() => { if (ctx.root.isConnected && doc.visibilityState !== 'hidden' && (!ctx.market || !ctx.market.visible || ctx.market.visible())) schedule(0) }, 10000)
    schedule(0)
    if (ctx.market) {
      if (S.market) S.market.stop()
      S.market = mountMarketView(mk, { meta: ctx.assetMeta, fmtAtoms: ctx.fmtAtoms, dev: false, relay: ctx.market.relay,
        pair: () => (S.pay && S.get ? ctx.market.pairOf(S.pay, S.get) : null), visible: ctx.market.visible })
    }
  }

  // The card a restricted asset's trade shows in place of Confirm: the approval card (whom to
  // ask, the approval code to give them) or the assets to pay or be paid with.
  function paintAnswerCard (t, act, btn) {
    const c = S.answer
    const box = el('div', 'uc-card'); box.id = 'ucCard'
    box.appendChild(el('div', '', c.text))
    if (c.reason) box.appendChild(el('div', 'sub', c.reason))
    t.appendChild(box)
    if (c.code) {
      act.appendChild(btn(RESTRICTED_WORDS.copyCode, 'ucCopyCode', () => { try { navigator.clipboard.writeText(c.code) } catch {} }, 'primary'))
    }
    if (c.link) {
      const a = el('a', 'btn ghost', c.link.text); a.id = 'ucOpenPage'; a.href = c.link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'
      act.appendChild(a)
    }
    for (const x of c.choices || []) {
      act.appendChild(btn((c.side === 'get' ? RESTRICTED_WORDS.getIn : RESTRICTED_WORDS.payWith)(name(x)), 'ucVia-' + x.slice(0, 8), () => {
        if (c.side === 'get') { S.get = x; S.getChosen = true } else { S.pay = x; S.payChosen = true }
        reset(); render()
      }, (c.choices || []).length === 1 ? 'primary' : 'ghost'))
    }
  }

  // The balance line under You pay, read again from the wallet's figure (what Balance shows): after
  // every trade that settles or returns, and whenever the ticket is painted (#674).
  function paintHave () {
    const h = ctx.root.querySelector('#ucHaveLine')
    if (h && S.pay) h.textContent = haveWords()
  }
  const onWay = (a) => (ctx.onItsWay && a ? big(ctx.onItsWay(a) || 0n) : 0n)
  // "balance 0 USDX · 500000 USDX arriving, in about a minute" while a payment is on its way.
  function haveWords () {
    const w = USER_WORDS.balance(amt(S.pay, ctx.held(S.pay) || 0n)), o = onWay(S.pay)
    return o > 0n ? w + ' \u00b7 ' + USER_WORDS.arriving(amt(S.pay, o)) : w
  }

  function paintTicket () {
    paintHave()
    const t = ctx.root.querySelector('#ucTicket'), note = ctx.root.querySelector('#ucNote'), act = ctx.root.querySelector('#ucAct')
    if (!t) return
    t.innerHTML = ''; act.innerHTML = ''
    note.textContent = S.error || S.note || ''
    note.classList.toggle('err', !!S.error)
    paintAbout()
    const btn = (text, id, f, cls) => { const b = el('button', cls || '', text); b.type = 'button'; b.id = id; b.disabled = S.busy; b.onclick = f; return b }
    if (!S.ticket && S.answer) { paintAnswerCard(t, act, btn); return }
    if (!S.ticket) {
      act.appendChild(btn(S.busy ? (S.pricingLong ? USER_WORDS.pricingLong : USER_WORDS.pricing) : USER_WORDS.review, 'ucReview', review, 'primary'))
      return
    }
    const k = S.ticket
    const line = (label, value, id) => { const d = el('div', 'kv'); d.id = id; d.appendChild(el('span', 'k', label)); d.appendChild(el('span', 'v', value)); t.appendChild(d) }
    line(USER_WORDS.amountIn, amt(k.payAsset, k.amountIn), 'ucIn')
    // What is paid waits for a round first (the engine's ticket to wait and go): the book's price
    // now, the least it goes for with its fees, and how long it waits. Trade accepts that; the
    // trade then goes by itself, or comes back with nothing traded.
    line(USER_WORDS.amountOut, k.indicative ? USER_WORDS.about + ' ' + amt(k.receiveAsset, k.about) : amt(k.receiveAsset, k.amountOut), 'ucOut')
    const cost = el('div', 'sub uc-cost'); cost.id = 'ucCost'
    const costText = k.indicative ? USER_WORDS.atLeast(amt(k.receiveAsset, k.amountOut)) : costLine(k.fees, amt, k.payAsset)
    cost.textContent = costText
    t.appendChild(cost)
    // A refresh the operator charges for is paid out of what is paid: its fee, on its own line.
    if (k.indicative && (k.fees || []).length) { const f = el('div', 'sub', costLine(k.fees, amt, k.payAsset)); f.id = 'ucFees'; t.appendChild(f) }
    // The wait, only as the wallet gave it; with none given, no time is promised.
    if (k.indicative) { const w = el('div', 'sub', k.finalBy == null ? USER_WORDS.settling : settleWords(k.finalBy, 1, Date.now(), USER_WORDS)); w.id = 'ucWait'; t.appendChild(w) }
    if (k.upTo) t.appendChild(el('div', 'sub', USER_WORDS.upTo(amt(k.payAsset, k.upTo))))
    // After Max, what one trade could not take: named, never left unsaid.
    if (S.stays > 0n) { const st = el('div', 'sub', USER_WORDS.stays(amt(k.payAsset, S.stays))); st.id = 'ucStays'; t.appendChild(st) }
    // Paid with money the wallet moves in first: how long it takes, said before it is confirmed.
    if (k.bringIn) { const w = el('div', 'sub', USER_WORDS.bringIn(k.bringIn)); w.id = 'ucBringIn'; t.appendChild(w) }
    if (k.minutes) { const w = el('div', 'sub', RESTRICTED_WORDS.takes(k.minutes)); w.id = 'ucTakes'; t.appendChild(w) }
    if (k.keep && k.via) { const kp = el('div', 'sub', RESTRICTED_WORDS.viaKeep(amt(k.via, k.keep))); kp.id = 'ucKeep'; t.appendChild(kp) }
    if (S.moving) { const mv = el('div', 'sub', USER_WORDS.btcMore(ctx.btcMoveBlocks ? ctx.btcMoveBlocks() : 2)); mv.id = 'ucMoving'; t.appendChild(mv) }
    act.appendChild(btn(S.busy ? USER_WORDS.sending : USER_WORDS.confirm, 'ucConfirm', confirm, 'primary'))
    act.appendChild(btn(USER_WORDS.cancel, 'ucCancel', () => { ctx.engine.drop(S.choice); reset(); paintTicket() }, 'ghost'))
  }

  async function review () {
    reset()
    let atoms
    try { atoms = ctx.parseAtoms(String(S.amount || '').trim(), prec(S.pay)) } catch { atoms = 0n }
    if (!(big(atoms) > 0n)) { S.error = USER_WORDS.enter; paintTicket(); return }
    if (!S.get) { S.error = USER_WORDS.nothingOffered(name(S.pay)); paintTicket(); return }
    // A wallet still opening (a restore finding what it holds) is waited for, saying so, as a
    // payment waits for it (ctx.opening(say), the page's one wait): the trade is priced once it has
    // opened. One that cannot open says why, in the page's words.
    if (ctx.opening) {
      S.busy = true; paintTicket()
      let why = null
      try { why = await ctx.opening((t) => { S.note = t; paintTicket() }) } catch (e) { console.warn('[user composer] opening:', e && e.message) }
      S.note = ''
      if (why) { S.busy = false; S.error = why; paintTicket(); return }
    }
    S.busy = true; S.pricingLong = false; paintTicket()
    let allOf = null
    // Past the makers' window the wallet may still be checking the price it was given: said so.
    const longTimer = setTimeout(() => { if (S.busy && !S.ticket) { S.pricingLong = true; paintTicket() } }, QUOTE_FIRM_MS + 1000)
    const withBtc = S.pay === 'BTC' || S.get === 'BTC'
    if (withBtc) openProgress(S.pay, S.get)
    try {
      const q = await ctx.engine.quote({ payAsset: S.pay, receiveAsset: S.get, amount: String(atoms),
        onStep: withBtc ? (k) => paintProgress(k) : null })
      if (withBtc && q.ok) paintProgress('priced')
      if (q.ok) {
        S.ticket = q.ticket; S.choice = q.choice; S.moving = !!q.moving
        // After Max: the amount is what the trade pays in all, and what it could not take stays,
        // named on the ticket.
        if (S.maxed && S.fixed === 'pay' && S.maxOf != null && q.ticket.payAsset === S.pay) {
          const paid = big(q.ticket.amountIn)
          if (paid < S.maxOf) {
            S.stays = S.maxOf - paid
            S.amount = ctx.fmtAtoms(paid, prec(S.pay))
            const i = ctx.root.querySelector('#ucAmount'); if (i) i.value = S.amount
          }
        }
      }
      // A restricted asset: whom to ask for approval, or what to pay with; never an error.
      else if (q.card) S.answer = q.card
      // Max asked for all of it and no trade takes that much: what emptying the coins the wallet
      // can pay from pays in all (the engine's `all`, the fees in) is priced, once.
      else if (q.why === 'own-short' && q.all && S.maxed && !S.maxAgain && S.fixed === 'pay' && big(q.all) < big(atoms)) { S.maxAgain = true; allOf = big(q.all) }
      else S.error = q.why === 'vesting' ? USER_WORDS.notVested(show(big(q.atoms), prec(S.pay)), name(S.pay), q.vests) : q.why === 'no-funds' ? USER_WORDS.noFunds(name(S.pay)) : q.why === 'not-ready' ? USER_WORDS.notReady(name(S.pay), q.soon) : q.why === 'redoing' ? USER_WORDS.redoing(name(S.pay)) : q.why === 'busy' ? USER_WORDS.busy(name(S.pay)) : q.why === 'freeing' ? USER_WORDS.freeing(name(S.pay), q.soon) : q.why === 'readying' ? USER_WORDS.readying(name(S.pay), q.soon) : q.why === 'restoring' ? USER_WORDS.restoring : q.why === 'part-ready' ? USER_WORDS.moreThanHeld(amt(S.pay, q.ready)) : q.why === 'too-small' ? USER_WORDS.tooSmall
        : q.why === 'own-short' ? USER_WORDS.ownShort(amt(S.pay, q.most))
        : q.why === 'no-firm-offer' ? USER_WORDS.noFirmOffer
        : q.why === 'wallet-busy' ? USER_WORDS.walletBusy
        : q.why === 'btc-ahead' ? USER_WORDS.btcAhead
        : q.why === 'btc-moving' ? USER_WORDS.btcMoving(ctx.btcMoveBlocks ? ctx.btcMoveBlocks() : 2)
        : q.why === 'chain-stays' ? (q.stays === 'frozen' ? USER_WORDS.chainFrozen(amt(S.pay, q.frozen), big(q.most) > 0n ? amt(S.pay, q.most) : '') : q.stays === 'dust' ? USER_WORDS.chainDust(name(S.pay)) : USER_WORDS.chainStays(name(S.pay)))
        : q.why === 'not-listed' ? USER_WORDS.notListed(name(S.get), name(S.pay))
        : q.again ? USER_WORDS.offeredAgain(name(S.get), name(S.pay)) : USER_WORDS.notOffered(name(S.get), name(S.pay))
      // Coins being made ready for this trade: priced again by itself while the person waits,
      // every READY_RETRY_MS, as long as nothing they typed changed. A pair offered a moment ago
      // that nobody offers now (a maker reading its coins again after a trade, #698): every
      // OFFERED_AGAIN_EVERY_MS, while it was offered within OFFERED_AGAIN_MS: the engine's window
      // bounds it, not a count of tries, so the last answer, once past it, is the words shown.
      // Behind a purchase paid with BTC that is still to pay: priced again by itself, so the ticket
      // comes once that one is paid.
      if (!q.ok && (q.why === 'readying' || q.why === 'btc-moving' || q.why === 'btc-ahead')) readyAgain()
      else if (!q.ok && q.again) readyAgain(OFFERED_AGAIN_EVERY_MS, false)
    } catch (e) {
      console.warn('[user composer] quote:', e && e.message)
      S.error = USER_WORDS.notOffered(name(S.get), name(S.pay))
    } finally { clearTimeout(longTimer); S.busy = false; S.pricingLong = false; closeProgress(); paintTicket() }
    if (allOf != null) {
      S.amount = ctx.fmtAtoms(allOf, prec(S.pay))
      const i = ctx.root.querySelector('#ucAmount'); if (i) i.value = S.amount
      return review()
    }
  }

  // ---- The price's progress ----
  // While the price of a trade with BTC is made (up to a minute), a pop-up says each step as it
  // starts, with a bar. It never holds the page: its Close, a click outside it and Escape all close
  // it, and closing it stops nothing. It closes by itself once the price is in or refused, which
  // the page then shows as always.
  function openProgress (payAsset, receiveAsset) {
    closeProgress()
    const m = el('div', 'modal uc-progress-modal'); const c = el('div', 'card uc-progress'); m.appendChild(c)
    m.onclick = (e) => { if (e.target === m) closeProgress() }
    const onKey = (e) => { if (e.key === 'Escape') closeProgress() }
    doc.addEventListener('keydown', onKey)
    doc.body.appendChild(m)
    S.progress = { m, onKey, payAsset, receiveAsset, at: null }
    paintProgress(null)
  }
  function closeProgress () {
    if (!S.progress) return
    doc.removeEventListener('keydown', S.progress.onKey)
    S.progress.m.remove(); S.progress = null
  }
  function paintProgress (k) {
    const P = S.progress; if (!P) return
    if (k) P.at = k
    const c = P.m.querySelector('.uc-progress'); c.innerHTML = ''
    c.appendChild(el('div', 'sent-title', USER_WORDS.pricingTitle))
    // The steps before the price, and the first after it, greyed: what Confirm starts.
    const steps = tradeSteps({ quote: P.at, payAsset: P.payAsset, receiveAsset: P.receiveAsset, name })
    const upTo = steps.findIndex((s) => s.key === 'priced')
    stepList(c, steps.slice(0, upTo + 1))
    const act = el('div', 'row'); act.style.marginTop = '14px'
    const close = el('button', 'ghost', USER_WORDS.closeProgress); close.type = 'button'; close.onclick = closeProgress; act.appendChild(close)
    c.appendChild(act)
    c.appendChild(el('div', 'sub', USER_WORDS.closeHint))
  }
  // A trade's steps as a bar and a list: done ones ticked, the current one turning, the rest grey.
  function stepList (c, steps) {
    const done = steps.filter((s) => s.state === 'done').length, now = steps.some((s) => s.state === 'now') ? 0.5 : 0
    const bar = el('div', 'uc-bar'); const fill = el('div', 'uc-bar-fill')
    fill.style.width = Math.round(100 * Math.min(1, (done + now) / Math.max(1, steps.length))) + '%'
    bar.appendChild(fill); c.appendChild(bar)
    const ol = el('ol', 'uc-steps')
    for (const s of steps) {
      const li = el('li', 'uc-step uc-step-' + s.state); li.dataset.step = s.key
      if (s.state === 'now') li.appendChild(el('span', 'spin'))
      li.appendChild(el('span', null, s.text))
      ol.appendChild(li)
    }
    c.appendChild(ol)
  }

  let readyTimer = null, readyTries = 0
  function readyAgain (ms = READY_RETRY_MS, counted = true) {
    const asked = `${S.pay}|${S.get}|${S.amount}`
    clearTimeout(readyTimer)
    if (counted && ++readyTries > READY_TRIES) { readyTries = 0; return }
    readyTimer = setTimeout(() => {
      if (`${S.pay}|${S.get}|${S.amount}` !== asked || S.busy || S.ticket) { readyTries = 0; return }
      review()
    }, ms)
  }

  // Trade: the step is taken in the background. If it is not done within CONFIRM_SHOWN_MS, the
  // screen is free again and the trade goes on in Open ("Sending…", then "Sent"), followed whether
  // the person stays or leaves. A refusal that comes at once (the price moved) is said here.
  async function confirm () {
    if (!S.choice) return
    S.busy = true; paintTicket()
    seenEnds()
    const before = new Set(ctx.engine.records().map((r) => r.id))
    try {
      const done = ctx.engine.confirm(S.choice, S.ticket)
      const later = Symbol('later')
      const first = await Promise.race([done, new Promise((r) => setTimeout(() => r(later), ctx.confirmShownMs ?? CONFIRM_SHOWN_MS))])
      if (first === later) done.catch((e) => console.warn('[user composer] confirm:', e && e.message)).finally(() => { paintTrades(); follow() })
      // The engine writes the trade's record before its step: the new one is this trade.
      const rec = first !== later && first && first.id ? first : ctx.engine.records().find((r) => !before.has(r.id))
      if (rec) openCard(rec.id)
      reset(); S.amount = ''; S.recv = ''
      for (const id of ['#ucAmount', '#ucReceive']) { const i = ctx.root.querySelector(id); if (i) i.value = '' }
    } catch (e) {
      console.warn('[user composer] confirm:', e && e.message)
      // A trade refused at once is said here, under the button: no notice repeats it.
      seenEnds()
      // A price no longer held is priced again, and shown before anything is signed.
      if (e && e.code === 'lapsed') { reset(); S.note = USER_WORDS.priceMoved; S.busy = false; await review(); S.note = S.ticket ? USER_WORDS.priceMoved : S.note; paintTicket(); return }
      // A record the browser has no room to keep refuses the trade before anything is signed: said as it is.
      reset(); S.error = e && e.code === 'storage-full' ? e.message : /require-checkpoint-exit/.test(String((e && e.message) || '')) ? USER_WORDS.notYet : USER_WORDS.failed
    } finally { S.busy = false; paintTicket(); paintTrades(); follow() }
  }

  function stateWord (r) {
    // A purchase with bitcoin whose second step has not gone: what the person now holds.
    // A restricted trade moving what it pays from to the chain: what the move says, with its wait.
    if (r.source === 'restricted' && r.state === 'confirming' && r.note) return r.note
    // Not approved now: says so, and the card shows how to get approved.
    if (r.source === 'composed' && r.viaHeld && r.via) {
      if (r.state === 'settled') return RESTRICTED_WORDS.viaHeld(name(r.via))
      return (r.card ? RESTRICTED_WORDS.viaApproval : RESTRICTED_WORDS.viaWaiting)(name(r.via), name(r.ticket.receiveAsset))
    }
    if (r.state === 'returned' && (r.feesPaid || []).length) return USER_WORDS.returnedFees(r.feesPaid.map((f) => amt(f.asset, f.atoms)).join(' and '))
    return tradeStateWord(r, Date.now())
  }

  const ENDED = ['settled', 'returned', 'failed', 'undone']
  // A trade's transactions on a chain: a composed trade's are its steps'.
  function linksOf (r) {
    if (!ctx.links) return []
    const all = ctx.engine.records()
    const recs = r.source === 'composed' ? [r.first, r.second].map((id) => all.find((x) => x.id === id)).filter(Boolean) : [r]
    return recs.flatMap((x) => ctx.links(x))
  }
  // What a trade brought: a composed purchase that ended at its first step brought that step's asset.
  // What it holds of that asset: what the move put on the chain once it has, else the coin itself.
  const got = (r) => (r.source === 'composed' && r.ended === 'via' ? amt(r.via, r.viaOut ? r.viaOut.value : r.viaAtoms) : amt(r.ticket.receiveAsset, r.ticket.amountOut))
  // The fees a trade paid: a composed purchase that ended holding its first step's asset, that
  // step's and, once made, the move's.
  const feesOf = (r) => (r.ended !== 'via' ? r.ticket.fees : [...(r.firstFees || []), ...(r.viaOut && r.move ? [{ asset: r.via, atoms: r.move.fee }] : [])])
  const what = (r) => `${amt(r.ticket.payAsset, r.ticket.amountIn)} → ${got(r)}`

  function paintTrades () {
    noteEnds()
    paintCard()
    paintHave()
    const list = ctx.root.querySelector('#ucTrades'); if (!list) return
    list.innerHTML = ''
    // A trade whose step did not answer is shown while it is looked for.
    // A trade being sent shows at once, as "Sending…".
    // An ended trade stays here only while the page that saw it end is open; after a reload it is
    // in History alone, so trades never push the market down the page.
    const endedAt = (r) => r.settledAt || r.returnedAt || r.failedAt || r.endedAt || r.at || 0
    // A step of a composed trade is shown as the trade it is part of.
    const recs = ctx.engine.records().filter((r) => !isStep(r) && (r.state !== 'confirming' || r.uncertain || Date.now() - (r.at || 0) < 10 * 60_000) && r.ticket)
      .filter((r) => !ENDED.includes(r.state) || endedAt(r) >= S.openedAt).slice(-12).reverse()
    list.classList.toggle('uc-has-open', recs.some((r) => !ENDED.includes(r.state)))
    if (!recs.length) return
    list.appendChild(el('label', 'lbl', USER_WORDS.recent))
    // The person's open trades, then the past ones. A trade opens its card again.
    const done = (r) => ENDED.includes(r.state)
    for (const [word, group] of [[USER_WORDS.openTrades, recs.filter((r) => !done(r))], [USER_WORDS.pastTrades, recs.filter(done).slice(0, 8)]]) {
      if (!group.length) continue
      list.appendChild(el('div', 'sub uc-group', word))
      for (const r of group) {
        const d = el('button', 'kv uc-trade'); d.type = 'button'; d.dataset.trade = r.id; d.dataset.state = r.state
        d.onclick = () => openCard(r.id)
        d.appendChild(el('span', 'k', what(r)))
        d.appendChild(el('span', 'v uc-state', stateWord(r)))
        list.appendChild(d)
      }
    }
  }

  // ---- A trade's card ----
  // Once a trade is sent, a card over the page says so: what is paid, what is received, the fees,
  // and the trade's status, which it follows until the trade ends. A transaction the trade made on
  // a chain links to that chain's explorer (ctx.links); a trade settled without one has no link.
  // Closed, the trade goes on in Your trades.
  function openCard (id) {
    closeCard()
    const m = el('div', 'modal uc-card-modal'); m.appendChild(el('div', 'card uc-card'))
    m.onclick = (e) => { if (e.target === m) closeCard() }
    doc.body.appendChild(m)
    S.card = { id, m }
    paintCard()
  }
  function closeCard () { if (S.card) { S.card.m.remove(); S.card = null } }
  function paintCard () {
    if (!S.card) return
    if (!S.card.m.isConnected) { S.card = null; return }
    const r = ctx.engine.records().find((x) => x.id === S.card.id)
    if (!r || !r.ticket) { closeCard(); return }
    const c = S.card.m.querySelector('.uc-card'); c.innerHTML = ''
    const ended = ENDED.includes(r.state), ok = r.state === 'settled'
    const head = el('div', 'sent-head')
    const mark = el('div', 'sent-check uc-mark' + (ended && !ok ? ' uc-back' : ''), ok ? USER_WORDS.markDone : ended ? USER_WORDS.markBack : null)
    if (!ended) mark.appendChild(el('span', 'spin'))
    head.appendChild(mark)
    const ht = el('div')
    ht.appendChild(el('div', 'sent-title', ok ? USER_WORDS.cardSettled : ended ? USER_WORDS.cardReturned : USER_WORDS.cardSent))
    ht.appendChild(el('div', 'sub', `${name(r.ticket.payAsset)} → ${name(r.ticket.receiveAsset)}`))
    head.appendChild(ht); c.appendChild(head)
    const line = (label, value, cls) => { const d = el('div', 'kv'); d.appendChild(el('span', 'k', label)); const v = el('span', 'v' + (cls ? ' ' + cls : '')); if (typeof value === 'string') v.textContent = value; else v.appendChild(value); d.appendChild(v); c.appendChild(d); return d }
    line(USER_WORDS.amountIn, amt(r.ticket.payAsset, r.ticket.amountIn))
    line(USER_WORDS.amountOut, got(r))
    // A composed purchase that ended at its first step paid that step's fees alone.
    c.appendChild(el('div', 'sub uc-cost', costLine(feesOf(r), amt, r.ticket.payAsset)))
    line(USER_WORDS.cardState, stateWord(r), 'uc-card-state').dataset.state = r.state
    // A composed purchase waiting on the issuer's approval: whom to ask, as before a purchase.
    let cardAct = null
    if (r.source === 'composed' && r.card && !ended) {
      const k = r.card
      const box = el('div', 'uc-card'); box.id = 'ucCardApproval'
      box.appendChild(el('div', '', k.text))
      if (k.reason) box.appendChild(el('div', 'sub', k.reason))
      c.appendChild(box)
      cardAct = el('div', 'row')
      if (k.code) { const b = el('button', 'ghost', RESTRICTED_WORDS.copyCode); b.type = 'button'; b.id = 'ucCopyCodeCard'; b.onclick = () => { try { navigator.clipboard.writeText(k.code) } catch {} }; cardAct.appendChild(b) }
      if (k.link) { const a = el('a', 'btn ghost', k.link.text); a.id = 'ucOpenPageCard'; a.href = k.link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; cardAct.appendChild(a) }
      c.appendChild(cardAct)
    }
    if (r.source === 'btc-gateway') {
      const steps = tradeSteps({ r, name })
      if (steps) { c.appendChild(el('div', 'lbl uc-steps-title', USER_WORDS.stepsTitle)); stepList(c, steps) }
    }
    for (const k of linksOf(r)) {
      const a = el('a', null, k.text); a.href = k.href; a.target = '_blank'; a.rel = 'noopener'
      line(USER_WORDS.txOn(k.chain), a, 'mono')
    }
    const act = el('div', 'row'); act.style.marginTop = '16px'
    const close = el('button', 'primary', USER_WORDS.done); close.type = 'button'; close.onclick = closeCard; act.appendChild(close)
    if (ctx.openHistory) { const h = el('button', 'ghost', USER_WORDS.viewHistory); h.type = 'button'; h.onclick = () => { closeCard(); ctx.openHistory() }; act.appendChild(h) }
    c.appendChild(act)
  }

  // A trade that ends while its card is closed is said wherever the person is (ctx.notify), once.
  // The trades ended before the page looked are not said again.
  function endedIds () { return ctx.engine.records().filter((r) => r.ticket && !isStep(r) && ENDED.includes(r.state)).map((r) => r.id) }
  function seenEnds () { S.ended = new Set(endedIds()) }
  function noteEnds () {
    if (!S.ended) { seenEnds(); return }
    for (const r of ctx.engine.records()) {
      if (!r.ticket || isStep(r) || !ENDED.includes(r.state) || S.ended.has(r.id)) continue
      S.ended.add(r.id)
      if ((S.card && S.card.id === r.id) || !ctx.notify) continue
      ctx.notify(USER_WORDS.ended(what(r), stateWord(r)), { sticky: r.state !== 'settled', link: linksOf(r)[0] || null })
    }
  }

  // Open trades are moved on every few seconds while any is open, and once when the page opens.
  // The wallet answers one command at a time, and moving a trade on asks it to sync: never while
  // a person is pricing or confirming one, and every half minute for a trade older than two
  // minutes (one still waiting for the other side excepted), so an open trade does not hold up
  // the next.
  // One follow at a time: one asked while another runs (the page opening, a change of mode, the
  // follow after a confirmation) runs once that one has ended, never beside it.
  function follow () {
    if (S.following) { S.followAgain = true; return S.following }
    S.following = followOnce().finally(() => {
      S.following = null
      if (S.followAgain) { S.followAgain = false; follow() }
    })
    return S.following
  }
  async function followOnce () {
    clearTimeout(S.timer)
    const openRecs = ctx.engine.records().filter((r) => !['settled', 'returned', 'failed', 'undone'].includes(r.state))
    if (!openRecs.length) return
    if (S.busy) { S.timer = setTimeout(follow, ctx.followMs || 4000); return }
    // A trade written since the last paint (a site's, accepted as waiting) has its row before the
    // pass over the trades, which waits on the wallet.
    paintTrades()
    try { await ctx.engine.resume() } catch (e) { console.warn('[user composer] resume:', e && e.message) }
    // Painted whether the tab is shown or not: an ending is said wherever the person is.
    paintTrades()
    // A purchase paid with BTC that waits for its asset to be final is followed every few seconds
    // however long it waits: its BTC is paid the moment the asset is, and the person watches it.
    const young = openRecs.some((r) => r.state === 'waiting' || Date.now() - (r.sentAt || r.at || 0) < FOLLOW_FAST_MS)
    S.timer = setTimeout(follow, young ? (ctx.followMs || 4000) : (ctx.followSlowMs || FOLLOW_SLOW_MS))
  }

  return { render, follow, state: S, paintHave }
}
