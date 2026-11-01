// The Trade tab in user mode: what I pay, what I get, how much, one button.
//
// The engine (user-trade.js) reads the single-step book, prices the trade with the wallet's
// own leaf library and settles it in one native step; this module draws it. Before the button
// confirms, it shows three lines: what you pay, what you get, and the fees. After it, the trade
// reads "Sent", then "Settled", or "Returned: nothing traded." Market trades only. Both pickers
// list BTC first. Every word it can show is in USER_WORDS, and none is a word of
// USER_MODE_FORBIDDEN_WORDS (user-trade.test.mjs checks both, the browser drive the page).
//
// ctx: { root (element), engine (createEngine's), assetMeta(hex) -> {ticker, precision},
//   fmtAtoms(atoms, precision) (fmtShow, optional: the same, grouped, for amounts read), parseAtoms(text, precision), knownAssets() -> [hex],
//   held(hex) -> atoms the person holds (the figure the Balance tab shows), admittedReceives(pay)
//   -> [hex] (optional: the receive picker lists those after what is offered now),
//   market: { relay() -> the relay's base URL, pairOf(a, b) -> {base, quote} } (optional: the
//   chosen pair's market above the inputs, market-view.js), isHidden(hex) -> the person hid it
//   (optional), refValue(hex, atoms) -> its value in words, "≈ $…" (optional) }
// Both pickers are the shared asset chooser (asset-picker.js): a search box, your assets first
// with their balances, BTC always, what the book offers now next, the rest found by searching.
// The receive picker lists BTC first, then every asset the book offers for what is paid in one
// step now (engine.offered), then the admitted rest, then every other asset known; it starts on
// the first one offered.

import { USER_WORDS, pickerOrder, costLine, tradeStateWord } from './user-trade.js'
import { mountMarketView } from './market-view.js'
import { openPicker, PICKER_WORDS } from './asset-picker.js'

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
  const S = { pay: null, get: null, amount: '', recv: '', fixed: 'pay', ticket: null, choice: null, busy: false, note: '', error: '', timer: null,
    estTimer: null, estSeq: 0,
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
  function payList () { return payAssets(ctx.knownAssets(), ctx.held, S.pay, name) }
  // What is paid starts as the first asset held, in the pickers' order (BTC first when held).
  function defaultPay () { const l = payList(); return l.find((a) => big(ctx.held(a)) > 0n) || l[0] }
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
    if (!e.ok) {
      S.note = e.why === 'not-listed' ? USER_WORDS.notListed(name(S.get), name(S.pay)) : e.why === 'too-small' ? USER_WORDS.tooSmall : USER_WORDS.notOffered(name(S.get), name(S.pay))
      if (other && doc.activeElement !== other) other.value = ''
      paintNote(); return
    }
    const fill = S.fixed === 'pay' ? ctx.fmtAtoms(big(e.receive), prec(S.get)) : ctx.fmtAtoms(big(e.pay), prec(S.pay))
    if (other && doc.activeElement !== other) other.value = fill
    if (S.fixed === 'pay') S.recv = fill; else S.amount = fill
    S.note = e.short ? USER_WORDS.bookUpTo(amt(S.get, e.short.receive)) : ''
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
      const atoms = big(ctx.held(h) || 0n)
      const m = ctx.assetMeta(h) || {}
      return { hex: h, ticker: name(h), name: h === 'BTC' ? 'Bitcoin' : (m.name || ''), held: atoms > 0n,
        hidden: !!(ctx.isHidden && ctx.isHidden(h)), offered: offered.has(h), tradable: tradable.has(h), cur: h === value,
        bal: atoms > 0n ? { b: show(atoms, prec(h)), r: ctx.refValue ? ctx.refValue(h, atoms) : '' } : null }
    }), (hex) => onchange(hex), { hint: PICKER_WORDS.hintSearch })
    return b
  }

  function reset () { S.ticket = null; S.choice = null; S.note = ''; S.error = ''; S.moving = false }

  // "about" beside the amount that follows the price, while it is an estimate.
  function paintAbout () {
    const pa = ctx.root.querySelector('#ucPayAbout'), ra = ctx.root.querySelector('#ucRecvAbout')
    if (pa) pa.textContent = S.fixed === 'receive' && !S.ticket && String(S.amount || '').trim() ? USER_WORDS.about : ''
    if (ra) ra.textContent = S.fixed !== 'receive' && !S.ticket && String(S.recv || '').trim() ? USER_WORDS.about : ''
  }

  function render () {
    const r = ctx.root
    if (!S.pay || !S.payChosen) S.pay = defaultPay()
    r.innerHTML = ''
    const box = el('div', 'ucomp'); box.id = 'userComposer'
    // The chosen pair's market: its chart, price, book and recent trades.
    const mk = el('div', 'uc-market'); mk.id = 'ucMarket'
    if (ctx.market) box.appendChild(mk)
    // You pay
    const row1 = el('div', 'uc-row')
    row1.appendChild(el('label', 'lbl', USER_WORDS.pay))
    row1.appendChild(chooser('ucPay', payList(), S.pay, (v) => { S.pay = v; S.payChosen = true; S.getChosen = false; S.get = null; reset(); render() }))
    const inp = el('input', 'uc-amount'); inp.id = 'ucAmount'; inp.inputMode = 'decimal'; inp.placeholder = USER_WORDS.amount; inp.value = S.amount
    const payAbout = el('span', 'sub uc-about'); payAbout.id = 'ucPayAbout'
    inp.oninput = () => { S.amount = inp.value; S.fixed = 'pay'; S.error = ''; keep(); if (S.ticket) { reset(); paintTicket() } schedule() }
    row1.appendChild(payAbout)
    row1.appendChild(inp)
    const have = el('div', 'sub uc-have'); have.id = 'ucHave'
    have.appendChild(el('span', null, USER_WORDS.balance(amt(S.pay, ctx.held(S.pay) || 0n))))
    const max = el('button', 'ghost uc-max', USER_WORDS.max); max.type = 'button'; max.id = 'ucMax'
    max.onclick = () => { const a = big(ctx.held(S.pay) || 0n); if (a <= 0n) return; S.amount = ctx.fmtAtoms(a, prec(S.pay)); inp.value = S.amount; S.fixed = 'pay'; if (S.ticket) { reset(); paintTicket() } schedule(0) }
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
      S.fixed = S.fixed === 'pay' ? 'receive' : 'pay'; S.payChosen = true; S.getChosen = true
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
    rin.oninput = () => { S.recv = rin.value; S.fixed = 'receive'; S.error = ''; keep(); if (S.ticket) { reset(); paintTicket() } schedule() }
    row2.appendChild(rin)
    box.appendChild(row2)
    // The ticket and the button
    const t = el('div', 'uc-ticket'); t.id = 'ucTicket'; box.appendChild(t)
    const note = el('div', 'sub uc-note'); note.id = 'ucNote'; box.appendChild(note)
    const act = el('div', 'row uc-act'); act.id = 'ucAct'; box.appendChild(act)
    // Trades
    const list = el('div', 'uc-trades'); list.id = 'ucTrades'; box.appendChild(list)
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

  function paintTicket () {
    const t = ctx.root.querySelector('#ucTicket'), note = ctx.root.querySelector('#ucNote'), act = ctx.root.querySelector('#ucAct')
    if (!t) return
    t.innerHTML = ''; act.innerHTML = ''
    note.textContent = S.error || S.note || ''
    note.classList.toggle('err', !!S.error)
    paintAbout()
    const btn = (text, id, f, cls) => { const b = el('button', cls || '', text); b.type = 'button'; b.id = id; b.disabled = S.busy; b.onclick = f; return b }
    if (!S.ticket) {
      act.appendChild(btn(S.busy ? USER_WORDS.pricing : USER_WORDS.review, 'ucReview', review, 'primary'))
      return
    }
    const k = S.ticket
    const line = (label, value, id) => { const d = el('div', 'kv'); d.id = id; d.appendChild(el('span', 'k', label)); d.appendChild(el('span', 'v', value)); t.appendChild(d) }
    line(USER_WORDS.amountIn, amt(k.payAsset, k.amountIn), 'ucIn')
    line(USER_WORDS.amountOut, amt(k.receiveAsset, k.amountOut), 'ucOut')
    const cost = el('div', 'sub uc-cost'); cost.id = 'ucCost'
    const costText = costLine(k.fees, amt, k.payAsset)
    cost.textContent = costText
    t.appendChild(cost)
    if (k.upTo) t.appendChild(el('div', 'sub', USER_WORDS.upTo(amt(k.payAsset, k.upTo))))
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
    S.busy = true; paintTicket()
    try {
      const q = await ctx.engine.quote({ payAsset: S.pay, receiveAsset: S.get, amount: String(atoms) })
      if (q.ok) { S.ticket = q.ticket; S.choice = q.choice; S.moving = !!q.moving }
      else S.error = q.why === 'no-funds' ? USER_WORDS.noFunds(name(S.pay)) : q.why === 'not-ready' ? USER_WORDS.notReady(name(S.pay), q.soon) : q.why === 'redoing' ? USER_WORDS.redoing(name(S.pay)) : q.why === 'busy' ? USER_WORDS.busy(name(S.pay)) : q.why === 'freeing' ? USER_WORDS.freeing(name(S.pay), q.soon) : q.why === 'readying' ? USER_WORDS.readying(name(S.pay), q.soon) : q.why === 'part-ready' ? USER_WORDS.partReady(amt(S.pay, q.ready), name(S.pay), q.soon) : q.why === 'too-small' ? USER_WORDS.tooSmall
        : q.why === 'no-firm-offer' ? USER_WORDS.noFirmOffer
        : q.why === 'btc-moving' ? USER_WORDS.btcMoving(ctx.btcMoveBlocks ? ctx.btcMoveBlocks() : 2)
        : q.why === 'not-listed' ? USER_WORDS.notListed(name(S.get), name(S.pay)) : USER_WORDS.notOffered(name(S.get), name(S.pay))
      // Coins being made ready for this trade: priced again by itself while the person waits,
      // every READY_RETRY_MS, as long as nothing they typed changed.
      if (!q.ok && (q.why === 'readying' || q.why === 'btc-moving')) readyAgain()
    } catch (e) {
      console.warn('[user composer] quote:', e && e.message)
      S.error = USER_WORDS.notOffered(name(S.get), name(S.pay))
    } finally { S.busy = false; paintTicket() }
  }

  let readyTimer = null, readyTries = 0
  function readyAgain () {
    const asked = `${S.pay}|${S.get}|${S.amount}`
    clearTimeout(readyTimer)
    if (++readyTries > READY_TRIES) { readyTries = 0; return }
    readyTimer = setTimeout(() => {
      if (`${S.pay}|${S.get}|${S.amount}` !== asked || S.busy || S.ticket) { readyTries = 0; return }
      review()
    }, READY_RETRY_MS)
  }

  // Trade: the step is taken in the background. If it is not done within CONFIRM_SHOWN_MS, the
  // screen is free again and the trade goes on in Open ("Sending…", then "Sent"), followed whether
  // the person stays or leaves. A refusal that comes at once (the price moved) is said here.
  async function confirm () {
    if (!S.choice) return
    S.busy = true; paintTicket()
    try {
      const done = ctx.engine.confirm(S.choice, S.ticket)
      const later = Symbol('later')
      const first = await Promise.race([done, new Promise((r) => setTimeout(() => r(later), ctx.confirmShownMs ?? CONFIRM_SHOWN_MS))])
      if (first === later) done.catch((e) => console.warn('[user composer] confirm:', e && e.message)).finally(() => { paintTrades(); follow() })
      reset(); S.amount = ''; S.recv = ''
      for (const id of ['#ucAmount', '#ucReceive']) { const i = ctx.root.querySelector(id); if (i) i.value = '' }
    } catch (e) {
      console.warn('[user composer] confirm:', e && e.message)
      // A price no longer held is priced again, and shown before anything is signed.
      if (e && e.code === 'lapsed') { reset(); S.note = USER_WORDS.priceMoved; S.busy = false; await review(); S.note = S.ticket ? USER_WORDS.priceMoved : S.note; paintTicket(); return }
      reset(); S.error = USER_WORDS.failed
    } finally { S.busy = false; paintTicket(); paintTrades(); follow() }
  }

  function stateWord (r) {
    if (r.state === 'returned' && (r.feesPaid || []).length) return USER_WORDS.returnedFees(r.feesPaid.map((f) => amt(f.asset, f.atoms)).join(' and '))
    return tradeStateWord(r, Date.now())
  }

  function paintTrades () {
    const list = ctx.root.querySelector('#ucTrades'); if (!list) return
    list.innerHTML = ''
    // A trade whose step did not answer is shown while it is looked for.
    // A trade being sent shows at once, as "Sending…".
    const recs = ctx.engine.records().filter((r) => (r.state !== 'confirming' || r.uncertain || Date.now() - (r.at || 0) < 10 * 60_000) && r.ticket).slice(-12).reverse()
    if (!recs.length) return
    list.appendChild(el('label', 'lbl', USER_WORDS.recent))
    // The person's open trades, then the past ones.
    const done = (r) => ['settled', 'returned', 'failed'].includes(r.state)
    for (const [word, group] of [[USER_WORDS.openTrades, recs.filter((r) => !done(r))], [USER_WORDS.pastTrades, recs.filter(done).slice(0, 8)]]) {
      if (!group.length) continue
      list.appendChild(el('div', 'sub uc-group', word))
      for (const r of group) {
        const d = el('div', 'kv uc-trade'); d.dataset.trade = r.id; d.dataset.state = r.state
        d.appendChild(el('span', 'k', `${amt(r.ticket.payAsset, r.ticket.amountIn)} → ${amt(r.ticket.receiveAsset, r.ticket.amountOut)}`))
        d.appendChild(el('span', 'v uc-state', stateWord(r)))
        list.appendChild(d)
      }
    }
  }

  // Open trades are moved on every few seconds while any is open, and once when the page opens.
  // The wallet answers one command at a time, and moving a trade on asks it to sync: never while
  // a person is pricing or confirming one, and every half minute for a trade older than two
  // minutes (one still waiting for the other side excepted), so an open trade does not hold up
  // the next.
  async function follow () {
    clearTimeout(S.timer)
    const openRecs = ctx.engine.records().filter((r) => !['settled', 'returned', 'failed'].includes(r.state))
    if (!openRecs.length) return
    if (S.busy) { S.timer = setTimeout(follow, ctx.followMs || 4000); return }
    try { await ctx.engine.resume() } catch (e) { console.warn('[user composer] resume:', e && e.message) }
    paintTrades()
    // A purchase paid with BTC that waits for its asset to be final is followed every few seconds
    // however long it waits: its BTC is paid the moment the asset is, and the person watches it.
    const young = openRecs.some((r) => r.state === 'waiting' || Date.now() - (r.sentAt || r.at || 0) < FOLLOW_FAST_MS)
    S.timer = setTimeout(follow, young ? (ctx.followMs || 4000) : (ctx.followSlowMs || FOLLOW_SLOW_MS))
  }

  return { render, follow, state: S }
}
