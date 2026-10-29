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
//   fmtAtoms(atoms, precision), parseAtoms(text, precision), knownAssets() -> [hex],
//   held(hex) -> atoms the person holds (the figure the Balance tab shows), admittedReceives(pay)
//   -> [hex] (optional: the receive picker lists those after what is offered now) }
// The receive picker lists BTC first, then every asset the book offers for what is paid in one
// step now (engine.offered), then the admitted rest, then every other asset known; it starts on
// the first one offered.

import { USER_WORDS, pickerOrder, costLine } from './user-trade.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// How long a trade is followed every few seconds, and how often after that.
export const FOLLOW_FAST_MS = 120_000
export const FOLLOW_SLOW_MS = 30_000

// The "You pay" list: BTC always, and an asset only while the wallet holds some of it (or it is
// the one chosen now), in the pickers' order. A fresh wallet pays from BTC alone.
export function payAssets (known, held, current, name) {
  return pickerOrder((known || []).filter((a) => a === 'BTC' || big(held(a)) > 0n || a === current), held, name)
}

export function mountUserComposer (ctx) {
  const S = { pay: null, get: null, amount: '', ticket: null, choice: null, busy: false, note: '', error: '', timer: null,
    offered: { pay: null, list: [], at: 0, loading: false } }
  const OFFERS_MS = ctx.offersMs || 60000
  const doc = ctx.root.ownerDocument || document
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  const name = (h) => (h === 'BTC' ? 'BTC' : ((ctx.assetMeta(h) || {}).ticker || String(h).slice(0, 8)))
  const prec = (h) => (h === 'BTC' ? 8 : ((ctx.assetMeta(h) || {}).precision ?? 0))
  const amt = (h, atoms) => `${ctx.fmtAtoms(big(atoms), prec(h))} ${name(h)}`

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
    old.replaceWith(select('ucGet', gl, S.get, pickGet))
    if (S.get !== was && !S.ticket) { S.error = ''; paintTicket() }
  }
  function pickGet (v) { S.get = v; S.getChosen = true; reset(); render() }

  function select (id, list, value, onchange) {
    const s = el('select', 'uc-pick'); s.id = id
    for (const a of list) { const o = el('option', null, name(a)); o.value = a; if (a === value) o.selected = true; s.appendChild(o) }
    s.onchange = () => onchange(s.value)
    return s
  }

  function reset () { S.ticket = null; S.choice = null; S.note = ''; S.error = '' }

  function render () {
    const r = ctx.root
    if (!S.pay || !S.payChosen) S.pay = defaultPay()
    r.innerHTML = ''
    const box = el('div', 'ucomp'); box.id = 'userComposer'
    // You pay
    const row1 = el('div', 'uc-row')
    row1.appendChild(el('label', 'lbl', USER_WORDS.pay))
    row1.appendChild(select('ucPay', payList(), S.pay, (v) => { S.pay = v; S.payChosen = true; S.getChosen = false; S.get = null; reset(); render() }))
    const inp = el('input', 'uc-amount'); inp.id = 'ucAmount'; inp.inputMode = 'decimal'; inp.placeholder = USER_WORDS.amount; inp.value = S.amount
    inp.oninput = () => { S.amount = inp.value; if (S.ticket) { reset(); paintTicket() } }
    row1.appendChild(inp)
    const have = el('div', 'sub uc-have'); have.id = 'ucHave'; have.textContent = amt(S.pay, ctx.held(S.pay) || 0n)
    row1.appendChild(have)
    box.appendChild(row1)
    // You get
    const row2 = el('div', 'uc-row')
    row2.appendChild(el('label', 'lbl', USER_WORDS.get))
    const gl = getList()
    if (!S.get || !gl.includes(S.get)) S.get = defaultGet(gl)
    row2.appendChild(select('ucGet', gl, S.get, pickGet))
    box.appendChild(row2)
    // The ticket and the button
    const t = el('div', 'uc-ticket'); t.id = 'ucTicket'; box.appendChild(t)
    const note = el('div', 'sub uc-note'); note.id = 'ucNote'; box.appendChild(note)
    const act = el('div', 'row uc-act'); act.id = 'ucAct'; box.appendChild(act)
    // Trades
    const list = el('div', 'uc-trades'); list.id = 'ucTrades'; box.appendChild(list)
    r.appendChild(box)
    paintTicket()
    paintTrades()
    loadOffered()
  }

  function paintTicket () {
    const t = ctx.root.querySelector('#ucTicket'), note = ctx.root.querySelector('#ucNote'), act = ctx.root.querySelector('#ucAct')
    if (!t) return
    t.innerHTML = ''; act.innerHTML = ''
    note.textContent = S.error || S.note || ''
    note.classList.toggle('err', !!S.error)
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
    act.appendChild(btn(S.busy ? USER_WORDS.working : USER_WORDS.confirm, 'ucConfirm', confirm, 'primary'))
    act.appendChild(btn(USER_WORDS.cancel, 'ucCancel', () => { ctx.engine.drop(S.choice); reset(); paintTicket() }, 'ghost'))
  }

  async function review () {
    reset()
    let atoms
    try { atoms = ctx.parseAtoms(String(S.amount || '').trim(), prec(S.pay)) } catch { atoms = 0n }
    if (!(big(atoms) > 0n)) { S.error = USER_WORDS.enter; paintTicket(); return }
    if (!S.get) { S.error = USER_WORDS.notListed('', name(S.pay)); paintTicket(); return }
    S.busy = true; paintTicket()
    try {
      const q = await ctx.engine.quote({ payAsset: S.pay, receiveAsset: S.get, amount: String(atoms) })
      if (q.ok) { S.ticket = q.ticket; S.choice = q.choice }
      else S.error = q.why === 'no-funds' ? USER_WORDS.noFunds(name(S.pay)) : q.why === 'too-small' ? USER_WORDS.tooSmall
        : q.why === 'not-listed' ? USER_WORDS.notListed(name(S.get), name(S.pay)) : USER_WORDS.notOffered(name(S.get), name(S.pay))
    } catch (e) {
      console.warn('[user composer] quote:', e && e.message)
      S.error = USER_WORDS.notOffered(name(S.get), name(S.pay))
    } finally { S.busy = false; paintTicket() }
  }

  async function confirm () {
    if (!S.choice) return
    S.busy = true; paintTicket()
    try {
      await ctx.engine.confirm(S.choice, S.ticket)
      reset(); S.amount = ''
      const i = ctx.root.querySelector('#ucAmount'); if (i) i.value = ''
    } catch (e) {
      console.warn('[user composer] confirm:', e && e.message)
      // A price no longer held is priced again, and shown before anything is signed.
      if (e && e.code === 'lapsed') { reset(); S.note = USER_WORDS.priceMoved; S.busy = false; await review(); S.note = S.ticket ? USER_WORDS.priceMoved : S.note; paintTicket(); return }
      reset(); S.error = USER_WORDS.failed
    } finally { S.busy = false; paintTicket(); paintTrades(); follow() }
  }

  function stateWord (r) {
    if (r.state === 'settled') return USER_WORDS.settled
    if (r.state === 'returned' && (r.feesPaid || []).length) return USER_WORDS.returnedFees(r.feesPaid.map((f) => amt(f.asset, f.atoms)).join(' and '))
    if (r.state === 'returned' || r.state === 'failed') return USER_WORDS.returned
    if (r.state === 'confirming') return USER_WORDS.working
    // Buying with BTC: nothing has left the wallet until its asset is held for it.
    if (r.state === 'waiting') return USER_WORDS.working
    return USER_WORDS.sent
  }

  function paintTrades () {
    const list = ctx.root.querySelector('#ucTrades'); if (!list) return
    list.innerHTML = ''
    // A trade whose step did not answer is shown while it is looked for.
    const recs = ctx.engine.records().filter((r) => (r.state !== 'confirming' || r.uncertain) && r.ticket).slice(-8).reverse()
    if (!recs.length) return
    list.appendChild(el('label', 'lbl', USER_WORDS.recent))
    for (const r of recs) {
      const d = el('div', 'kv uc-trade'); d.dataset.trade = r.id; d.dataset.state = r.state
      d.appendChild(el('span', 'k', `${amt(r.ticket.payAsset, r.ticket.amountIn)} → ${amt(r.ticket.receiveAsset, r.ticket.amountOut)}`))
      d.appendChild(el('span', 'v uc-state', stateWord(r)))
      list.appendChild(d)
    }
  }

  // Open trades are moved on every few seconds while any is open, and once when the page opens.
  // The wallet answers one command at a time, and moving a trade on asks it to sync: never while
  // a person is pricing or confirming one, and every half minute for a trade older than two
  // minutes, so an open trade does not hold up the next.
  async function follow () {
    clearTimeout(S.timer)
    const openRecs = ctx.engine.records().filter((r) => !['settled', 'returned', 'failed'].includes(r.state))
    if (!openRecs.length) return
    if (S.busy) { S.timer = setTimeout(follow, ctx.followMs || 4000); return }
    try { await ctx.engine.resume() } catch (e) { console.warn('[user composer] resume:', e && e.message) }
    paintTrades()
    const young = openRecs.some((r) => Date.now() - (r.sentAt || r.at || 0) < FOLLOW_FAST_MS)
    S.timer = setTimeout(follow, young ? (ctx.followMs || 4000) : (ctx.followSlowMs || FOLLOW_SLOW_MS))
  }

  return { render, follow, state: S }
}
