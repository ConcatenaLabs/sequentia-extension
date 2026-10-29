// The asset chooser: wherever a person picks an asset from a list, in this wallet, in SeqDEX
// and in every wallet that follows docs/DEFAULT_MODE.md ("Choosing an asset"). A search box
// over the whole list; what you hold first, with its balance and value; BTC always among them,
// even at 0; then what the book offers now; everything else, hidden assets included, only
// once searched for; a pasted asset id is an asset too. Rows are drawn in groups ("Your
// assets", then the rest), the rest capped until a search narrows it.
//
// Rows (`items`): { hex, ticker, name, bal: { b, r }, held, hidden, offered, tradable, pin, cur, cls,
// split (HTML), enabled, pasted }. `pin` rows always show first (the other side's asset in a
// swap, "Any" in an anchor menu). The pure parts (pickerMatches, pickerGroups) run in Node;
// openPicker needs a document.

export const PICKER_WORDS = Object.freeze({
  search: 'Search assets',
  yours: 'Your assets',
  all: 'All assets',
  assets: 'Assets',
  none: 'No matching assets.',
  syncing: 'Your wallet is still syncing; your assets appear here in a moment.',
  more: (n) => `+${n} more · keep typing to find them.`,
  hint: 'Type to search every asset, or paste an asset id.',
  hintSearch: 'Type to search every asset.',
})

// Which rows a search shows. No search: the pinned rows, BTC, what you hold, what the book
// offers now and what trades against the other side (`tradable`), hidden assets left out. A search: every row whose ticker, name or id holds it,
// hidden ones included; a 64-hex id that matches nothing is still an asset (`paste(hex)` makes
// its row, marked `pasted`).
export function pickerMatches (items, q, { paste } = {}) {
  q = (q || '').trim()
  if (!q) return items.filter((it) => it.pin || it.hex === 'BTC' || ((it.held || it.offered || it.tradable) && !it.hidden))
  const ql = q.toLowerCase()
  const match = items.filter((it) => (it.ticker + ' ' + (it.name || '') + ' ' + it.hex).toLowerCase().includes(ql))
  if (!match.length && /^[0-9a-fA-F]{64}$/.test(q) && paste) {
    const row = paste(ql)
    if (row) match.push({ held: false, split: '', hidden: false, enabled: true, ...row, hex: ql, pasted: true })
  }
  return match
}

// How the rows a search returned are laid out: pinned rows, then "Your assets" (BTC first, even
// at 0: every wallet is dual-chain), then the rest; within each group what the book offers now
// comes first, then what trades against the other side. The rest is capped at `cap` rows while
// searching.
export function pickerGroups (match, q, cap = 40) {
  const mine = (it) => it.held || it.hex === 'BTC'
  const rank = (it) => (it.offered ? 2 : it.tradable ? 1 : 0)
  const offeredFirst = (a, b) => rank(b) - rank(a)
  const pinned = match.filter((it) => it.pin)
  const held = match.filter((it) => mine(it) && !it.pin).sort((a, b) => (b.hex === 'BTC') - (a.hex === 'BTC') || offeredFirst(a, b))
  const all = match.filter((it) => !mine(it) && !it.pin).sort(offeredFirst)
  const capped = !!q && all.length > cap
  const groups = []
  if (held.length) groups.push([PICKER_WORDS.yours, held])
  if (all.length) groups.push([(q && held.length) ? PICKER_WORDS.all : PICKER_WORDS.assets, capped ? all.slice(0, cap) : all])
  return { pinned, groups, capped, more: capped ? all.length - cap : 0 }
}

// Opens the chooser under (or above) `anchorEl`. onPick(hex, row) on a choice. opts:
//   paste(hex) -> a row for a pasted id (optional; without it a pasted id finds nothing)
//   onPasted(hex)    told when a pasted row is chosen
//   badge(hex) -> an element after the ticker (a trust mark), optional
//   synced() -> false while the wallet is still reading its coins (an empty list says so)
//   placeholder      the search box's words (default PICKER_WORDS.search)
//   cap              rows of the rest shown while searching (default 40)
//   hint             the line under the list before a search (default PICKER_WORDS.hint)
let open = null
export function openPicker (anchorEl, items, onPick, opts = {}) {
  closePicker()
  const doc = anchorEl.ownerDocument || document
  const win = doc.defaultView || window
  const el = (t, c, txt) => { const e = doc.createElement(t); if (c) e.className = c; if (txt != null) e.textContent = txt; return e }
  anchorEl.setAttribute('aria-expanded', 'true')
  const pop = el('div', 'swpop'); pop.setAttribute('role', 'listbox')
  const sb = el('div', 'swpop-search'); const inp = el('input'); inp.type = 'search'
  inp.placeholder = opts.placeholder || PICKER_WORDS.search; inp.setAttribute('aria-label', inp.placeholder); inp.autocomplete = 'off'
  sb.appendChild(inp); pop.appendChild(sb)
  const listEl = el('div', 'swpop-list'); pop.appendChild(listEl)
  doc.body.appendChild(pop)
  // Against the anchor, inside the viewport: on the anchor's right edge when it sits on the
  // right, upward when there is more room above, never taller than the room there is.
  const place = () => {
    const r = anchorEl.getBoundingClientRect()
    const vw = win.innerWidth, vh = win.innerHeight, gap = 6, edge = 8
    const below = vh - r.bottom - gap - edge, above = r.top - gap - edge
    pop.style.maxHeight = (vh * 0.6) + 'px'
    const want = pop.offsetHeight
    const up = below < want && above > below
    pop.style.maxHeight = Math.max(160, Math.min(vh * 0.6, up ? above : below)) + 'px'
    const h = pop.offsetHeight, w = pop.offsetWidth
    pop.style.top = (up ? Math.max(edge, r.top - gap - h) : Math.min(r.bottom + gap, vh - edge - h)) + 'px'
    const rightSide = r.left + r.width / 2 > vw / 2
    pop.style.left = Math.max(edge, Math.min(rightSide ? r.right - w : r.left, vw - w - edge)) + 'px'
  }
  const cap = opts.cap || 40
  let kbd = -1, shown = [], optEls = []
  const pickItem = (it) => { if (it.pasted && opts.onPasted) opts.onPasted(it.hex); closePicker(); onPick(it.hex, it) }
  const rowFor = (it) => {
    const b = el('button', 'swopt' + (it.cls ? ' ' + it.cls : '') + (it.cur ? ' swopt-cur' : '')); b.type = 'button'; b.setAttribute('role', 'option')
    b.dataset.hex = it.hex
    if (it.cur) b.setAttribute('aria-selected', 'true')
    if (it.enabled === false) b.disabled = true
    const t = el('span', 'swopt-tk', it.ticker)
    try { const tb = opts.badge && opts.badge(it.hex); if (tb) t.appendChild(tb) } catch {}
    const mid = el('div', 'swopt-mid'); mid.appendChild(el('div', 'swopt-name', it.name || ''))
    if (it.split) { const sp = el('div', 'swopt-split'); sp.innerHTML = it.split; mid.appendChild(sp) }
    const bal = el('div', 'swopt-bal')
    if (it.bal && it.bal.b) bal.appendChild(el('div', 'b', it.bal.b))
    if (it.bal && it.bal.r) bal.appendChild(el('div', 'r', it.bal.r))
    b.appendChild(t); b.appendChild(mid); b.appendChild(bal)
    b.onclick = () => { if (it.enabled !== false) pickItem(it) }
    return b
  }
  const add = (it) => { const b = rowFor(it); const i = shown.length; b.onmouseenter = () => { kbd = i; mark() }; listEl.appendChild(b); shown.push(it); optEls.push(b) }
  const draw = (q) => {
    listEl.innerHTML = ''; kbd = -1; shown = []; optEls = []
    const match = pickerMatches(items, q, { paste: opts.paste })
    if (!match.length) {
      listEl.appendChild(el('div', 'swopt-empty', !q && opts.synced && !opts.synced() ? PICKER_WORDS.syncing : PICKER_WORDS.none))
      return
    }
    const { pinned, groups, capped, more } = pickerGroups(match, q, cap)
    for (const it of pinned) add(it)
    for (const [label, arr] of groups) { listEl.appendChild(el('div', 'swopt-grp', label)); for (const it of arr) add(it) }
    if (capped) listEl.appendChild(el('div', 'swopt-more', PICKER_WORDS.more(more)))
    if (!q) listEl.appendChild(el('div', 'swopt-more', opts.hint || PICKER_WORDS.hint))
  }
  const mark = () => {
    optEls.forEach((c, i) => c.classList.toggle('kbd', i === kbd))
    const cur = optEls[kbd]; if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' })
  }
  inp.addEventListener('input', () => { draw(inp.value.trim()); place() })
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); kbd = Math.min(shown.length - 1, kbd + 1); mark() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); kbd = Math.max(0, kbd - 1); mark() }
    else if (e.key === 'Enter') { e.preventDefault(); const it = shown[kbd] || shown[0]; if (it && it.enabled !== false) pickItem(it) }
    else if (e.key === 'Escape') { closePicker(); anchorEl.focus() }
  })
  draw('')
  place()
  setTimeout(() => inp.focus(), 0)
  // A scroll inside the list itself does not move the chooser; any other scroll or a resize does.
  const onMove = (ev) => { const t = ev && ev.target; if (!(t && t.nodeType && pop.contains(t))) place() }
  const onDoc = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchorEl && !anchorEl.contains(ev.target)) closePicker() }
  open = { pop, anchorEl, onMove, onDoc, doc, win }
  setTimeout(() => { if (open && open.pop === pop) doc.addEventListener('mousedown', onDoc) }, 0)
  win.addEventListener('scroll', onMove, true)
  win.addEventListener('resize', onMove)
  return { close: closePicker, input: inp, element: pop }
}

export function closePicker () {
  if (!open) return
  const o = open; open = null
  o.doc.removeEventListener('mousedown', o.onDoc)
  o.win.removeEventListener('scroll', o.onMove, true)
  o.win.removeEventListener('resize', o.onMove)
  o.anchorEl.setAttribute('aria-expanded', 'false')
  o.pop.remove()
}
export function pickerOpen () { return !!open }

// Puts the chooser in front of a <select> of assets. The select stays, hidden, as the value the
// rest of a page reads and listens to; the button names its choice and opens the chooser over
// its options, and a choice sets the select's value and fires its change event. rowOf(value,
// text) -> the row's other fields ({ ticker, name, held, hidden, bal, offered, tradable });
// opts as openPicker's. -> { button, refresh() } (refresh after setting the value from code).
export function attachChooser (sel, rowOf, opts = {}) {
  const doc = sel.ownerDocument
  const btn = doc.createElement('button'); btn.type = 'button'
  btn.className = 'asset-chooser' + (opts.cls ? ' ' + opts.cls : '')
  btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false')
  const name = doc.createElement('span'); name.className = 'asset-chooser-tk'
  const caret = doc.createElement('span'); caret.className = 'asset-chooser-caret'; caret.textContent = '▾'
  btn.appendChild(name); btn.appendChild(caret)
  sel.style.display = 'none'; sel.setAttribute('aria-hidden', 'true'); sel.tabIndex = -1
  sel.parentNode.insertBefore(btn, sel)
  const refresh = () => { const o = sel.options[sel.selectedIndex]; name.textContent = o ? o.textContent : '…'; btn.dataset.value = sel.value }
  refresh()
  sel.addEventListener('change', refresh)
  try { new doc.defaultView.MutationObserver(refresh).observe(sel, { childList: true, subtree: true }) } catch {}
  btn.onclick = () => openPicker(btn, [...sel.options].filter((o) => !o.disabled).map((o) => ({
    ticker: o.textContent, ...rowOf(o.value, o.textContent), hex: o.value, cur: o.value === sel.value,
  })), (v) => { if (sel.value !== v) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })) } refresh() }, opts)
  return { button: btn, refresh }
}
