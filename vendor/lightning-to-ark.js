// LIGHTNING TO THE ARK: a wallet made before default mode held its coins in the Ark keeps balances
// in its own hosted Lightning channels. Default mode never pays from them in seconds, so this moves
// them, as the wallet's own upkeep, to where it does:
//
//   BTC      the wallet's BTC channel pays an invoice of the wallet's own Bitcoin ark (btc-ark.js),
//            which the ark wallet claims as soon as its server holds the payment.
//   assets   the asset's channel pays a Lightning receive of the wallet's own leaf wallet
//            (`lightning_receive`: an invoice of the operator's node in the asset, under a hash
//            whose preimage only the leaf wallet holds). The operator holds the payment until it
//            has put the wallet's leaf in the asset's next round; the leaf wallet's sync then claims
//            the leaf with the preimage, which settles the payment. An asset the operator serves
//            without a Lightning node, or one that cannot be held in a channel (a supervised asset),
//            has nothing to move.
//
// Nothing is asked and nothing is lost. Until a move is paid the balance stays in the channel,
// counted in the asset's one figure; while it is on its way it stays in the figure and the line
// under it reads "Moving <amount> <TICKER> so it can be sent in seconds." (DEFAULT_WORDS.moving);
// a payment that fails comes back to the channel. A move is paid only from a channel that is
// locked in, held within the daily limit the page's Lightning signer sets (none by default), and
// never made while a person is using the wallet, nor in developer mode, where channels are the
// person's to use. A payment refused before it left gives its receive up, and the move is tried
// again later. Once a channel is emptied and closing it is cheap and safe, it is closed to an
// address of the wallet, whose coins are then boarded by themselves; otherwise it stays, and
// developer mode says why (closeWhy).
//
// The same move, in the same words, is Ambra's (app/lib/src/data/lightning_to_ark.dart) and the
// extension's. Every amount, fee and refusal is the ark's, the leaf library's or the Lightning
// node's: this module picks the channel, sizes the move and follows it. It has no DOM, so it runs
// under Node (lightning-to-ark.test.mjs).

const big = (v) => { if (typeof v === 'bigint') return v; try { return BigInt(v ?? 0) } catch { return BigInt(Math.trunc(Number(v) || 0)) } }

// The least worth moving, in sats: below it the routing fee is too large a share.
export const MIN_MOVE_SATS = 5000n
// How long after a move, or a move that failed, before a channel is looked at again.
export const RETRY_MS = 15 * 60_000
// How long a move the daily limit refused waits before it is tried again.
export const LIMIT_WAIT_MS = 6 * 3600_000
// How often the asset channels are looked at, at most.
export const ASSET_EVERY_MS = 2 * 60_000
// How long a BTC move is followed for (the ark invoice's own life bounds it too).
export const BTC_FOLLOW_MS = 10 * 60_000
// What the close of an emptied channel must bring back, as a multiple of its fee, to be worth it.
export const CLOSE_WORTH = 4n
// How long a cooperative close is given before the node's own (device-signed) unilateral close.
export const CLOSE_UNILATERAL_S = 600
// How long what a cooperative close pays the wallet is held in the figure, at most, until the
// wallet's own scan sees the close's transaction.
export const CLOSE_HOLD_MS = 2 * 3600_000
// What is kept across a reload, per wallet (+ '.' + the wallet's tag).
export const STORE_KEY = 'swk.lnToArk'

// What of `spendable` in a channel is moved: all of it less the routing fee the channel must also
// pay (1% and 10 atoms, the hosted nodes' fee bound), or null when that is below `min` (for an
// asset, the operator's smallest leaf in it).
export function amountToMove (spendable, min = MIN_MOVE_SATS) {
  const s = big(spendable)
  const a = s - (s / 100n + 10n)
  return a >= big(min) && a > 0n ? a : null
}

// A move of `amount` held to what the daily limit allows (`allowance`, in the same atoms; null when
// there is no limit or it cannot be valued now): at most nine tenths of it, so the payment's fee and
// the day's other payments fit, and what is left moves on a later day. Null when nothing worth
// moving is left.
export function withinAllowance (amount, allowance, min = MIN_MOVE_SATS) {
  if (amount == null) return null
  if (allowance == null) return big(amount)
  const cap = big(allowance) * 9n / 10n
  const a = big(amount) < cap ? big(amount) : cap
  return a >= big(min) && a > 0n ? a : null
}

// What the page's Lightning payment limits (window.SEQ_LN_PAYMENT_LIMITS, as seqln.js hands them to
// the signer SDK) let a day's payments of `kind` ('btc' or an asset id) reach, in its atoms, or null
// for no limit. `rate` is the kind's rate in reference atoms per 10^8 of its atoms, or null. The
// signer's own rules: an asset's own limit first, then `default` for every asset, then the
// reference limit (1,000 reference units unless the page names another, null for none) at the
// asset's rate, and 10,000,000 atoms for an asset it cannot value.
export const SIGNER_DEFAULT_REFERENCE = 1000n * 100_000_000n
export const SIGNER_UNVALUED_ATOMS = 10_000_000n
export function allowanceAtoms (limits, kind, rate) {
  const l = limits || {}
  if (l.assets && Object.prototype.hasOwnProperty.call(l.assets, kind)) return l.assets[kind] == null ? null : big(l.assets[kind])
  if (l.default !== undefined) return l.default == null ? null : big(l.default)
  if (l.reference === null) return null
  const ref = l.reference === undefined ? SIGNER_DEFAULT_REFERENCE : big(l.reference)
  const r = l.rates && l.rates[kind] != null ? big(l.rates[kind]) : (rate != null ? big(rate) : null)
  if (r == null || r <= 0n) return SIGNER_UNVALUED_ATOMS
  return ref * 100_000_000n / r
}

// Whether `e` is the signer declining a payment over its limit.
export function isLimitRefusal (e) {
  const s = String((e && (e.message || (e.body && (e.body.error || e.body.reason)))) || e || '')
  return /declined|over the daily limit|payment limit/i.test(s)
}

// Whether channel `c` is locked in and can pay now: CHANNELD_NORMAL with its daemon running. One
// still waiting for its funding counts in the figure but routes nothing.
export function channelLockedIn (c) {
  if (!c || String(c.state || '').toUpperCase() !== 'CHANNELD_NORMAL') return false
  if ('owner' in c && (c.owner === null || c.owner === '')) return false
  return true
}

// The node of the wallet's own channels in `kind` ('BTC' or an asset id) that can pay the most in
// one payment now, with what it can pay and hold: { node_key, spendable, balance, channels } or null.
// `kindOf(c)` names a channel's kind.
export function payingNode (channels, kind, kindOf) {
  const by = new Map()
  for (const c of channels || []) {
    if (!c || !c.node_key || kindOf(c) !== kind || !channelLockedIn(c)) continue
    const n = by.get(c.node_key) || { node_key: c.node_key, spendable: 0n, balance: 0n, channels: [] }
    n.spendable += big(c.spendable_units ?? c.spendable ?? 0)
    n.balance += big(c.balance_units ?? c.spendable_units ?? 0)
    n.channels.push(c)
    by.set(c.node_key, n)
  }
  let best = null
  for (const n of by.values()) if (!best || n.spendable > best.spendable) best = n
  return best
}

// The assets the operator receives over Lightning (`info.server_info.assets[].lightning`: up and
// receiving). A supervised asset is never one: it cannot be held in a channel.
export function lightningLegs (info) {
  const assets = info && info.server_info && Array.isArray(info.server_info.assets) ? info.server_info.assets : []
  return assets.filter((a) => a && typeof a.asset === 'string' && a.supervised == null && a.lightning &&
    a.lightning.state === 'up' && a.lightning.receives === true).map((a) => a.asset)
}

// The operator's smallest leaf in each asset it serves, in atoms.
export function minLeaves (info) {
  const out = new Map()
  const assets = info && info.server_info && Array.isArray(info.server_info.assets) ? info.server_info.assets : []
  for (const a of assets) if (a && typeof a.asset === 'string' && a.min_leaf != null) out.set(a.asset, big(a.min_leaf))
  return out
}

// Whether a Lightning receive of `asset` is under way (`receives`: the leaf wallet's
// `lightning_receives`): asked and its invoice not lapsed, or held and its leaf coming. One whose
// payment the wallet saw refused (`givenUp`) is not.
export function receivesUnderWay (receives, asset, nowMs, givenUp = new Set()) {
  for (const [hash, r] of Object.entries(receives || {})) {
    if (!r || r.asset !== asset || givenUp.has(hash)) continue
    if (r.state === 'issuing' || r.state === 'claiming') return true
    if (r.state === 'requested' || r.state === 'waiting') {
      if (r.expires_at == null || Number(r.expires_at) * 1000 > nowMs) return true
    }
  }
  return false
}

// What of each asset is on its way from the wallet's channel to its tree, in atoms: each receive it
// paid from its own channel (`paid`) not yet received, until its leaf is a coin of the wallet's
// (`coins`: the leaf counts in the figure from then). -> Map(asset -> atoms)
export function movingOf (receives, coins, paid, nowMs) {
  const out = new Map()
  const leafValues = new Set((coins || []).filter((c) => c && c.state === 'receiving').map((c) => `${c.asset}:${c.value}`))
  for (const [hash, r] of Object.entries(receives || {})) {
    if (!r || !paid.has(hash)) continue
    if (r.state !== 'waiting' && r.state !== 'issuing') continue
    // An invoice that lapsed unpaid moved nothing.
    if (r.state === 'waiting' && r.expires_at != null && Number(r.expires_at) * 1000 <= nowMs) continue
    if (leafValues.has(`${r.asset}:${r.value}`)) continue
    const a = big(r.amount)
    if (a <= 0n) continue
    out.set(r.asset, (out.get(r.asset) || 0n) + a)
  }
  return out
}

// A channel's part of a figure while something moves out of it: what it held when the move began
// (`from`), whether the channel was read before the payment left it, after, or not at all (a status
// that missed the node). Without `from`, what it reads now with what is moving added.
export function channelPart (read, moving, from) {
  if (moving == null || moving <= 0n) return big(read)
  if (from != null) return big(from)
  return big(read) + big(moving)
}

// Whether an emptied channel is closed now, and if not, why it stays (developer mode's words).
// `left`: this side's balance in it; `fee`: what its close is estimated to cost this side, or null
// when it cannot be priced; `min`: the least a move is.
export function closeVerdict ({ channel, left, spendable, fee, min = MIN_MOVE_SATS, moving = false, moved = false }) {
  if (!moved) return { close: false, why: 'no move has been made from it' }
  if (moving) return { close: false, why: 'a move from it is still on its way' }
  if (!channelLockedIn(channel)) return { close: false, why: 'it is not open for payments now, so it cannot be closed cooperatively' }
  if (amountToMove(spendable, min) != null) return { close: false, why: 'it still holds enough to move' }
  if (big(left) <= 0n) return { close: false, why: 'nothing of this wallet’s is left in it' }
  if (fee == null) return { close: false, why: 'its closing fee cannot be priced now' }
  if (big(left) < big(fee) * CLOSE_WORTH) return { close: false, why: `closing it would cost too much of the ${left} left in it (about ${fee})` }
  return { close: true, why: null }
}

// The move, mounted on a page or a background. deps:
// Each read may answer at once or as a promise (a page answers at once, the extension's service
// worker asks its offscreen hosts).
//   dev()                     developer mode is on
//   personBusy()              a person is using the wallet now
//   channels()                the wallet's own channels as the Lightning service last reported them
//   kindOf(c)                 'BTC' or the display-order asset id of channel c
//   refreshChannels()         reads the channels again
//   connect(kind)             brings the wallet's own node for `kind` online -> its node key
//   pay({ node_key, bolt11 }) the node pays the invoice -> { paid, preimage? } (throws when refused)
//   payStatus({ node_key, payment_hash }) -> { state: 'none'|'pending'|'complete'|'failed' }
//   ark                       { isOpen(), invoice(sats, description), received(hash), refresh() } or null
//   leaves                    { isOpen(), info(), coins(), run(command, args), refresh()? } or null
//   allowance(kind)           -> what the daily limit lets a payment of kind reach, atoms, or null
//   closeFee(kind, channel)   -> the estimated cost of closing it to this side, atoms, or null
//   close({ kind, channel })  closes it cooperatively to an address of the wallet
//   seen(kind, txid, address) whether the wallet's own scan counts the close's payment to it yet;
//                             without it, what a close pays is not held in the figure
//   store                     localStorage-like; tag() the wallet's tag
//   onChange(), log(...), now(), sleep(ms)
export function mountLightningToArk (deps) {
  const now = deps.now || (() => Date.now())
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = (...a) => { try { (deps.log || console.log)('[ln to ark]', ...a) } catch {} }
  const changed = () => { try { deps.onChange && deps.onChange() } catch {} }
  const key = () => STORE_KEY + '.' + ((deps.tag && deps.tag()) || 'default')

  // Kept across a reload: the BTC move on its way, the receives paid from the channels, those given
  // up, the nodes moves were paid from, and the closes made.
  function load () {
    let v = null; try { v = JSON.parse(deps.store.getItem(key()) || 'null') } catch {}
    return { btc: null, assets: {}, paid: [], givenUp: [], moved: {}, closed: {}, ownHashes: [], ...(v || {}) }
  }
  function save (s) { try { deps.store.setItem(key(), JSON.stringify(s)) } catch {} }
  const tail = (l) => l.length > 50 ? l.slice(l.length - 50) : l
  function update (f) { const s = load(); f(s); save(s); return s }

  const S = { btcRunning: false, btcLast: null, assetsRunning: false, assetsLast: null, refused: new Map(),
    movingAssets: new Map(), movingFrom: new Map(), closeWhy: new Map(), said: new Set(), closing: false }
  // What was moving when the wallet last looked, so a reload shows it at once.
  for (const [a, v] of Object.entries(load().assets || {})) {
    try { S.movingAssets.set(a, big(v.moving)); if (v.from != null) S.movingFrom.set(a, big(v.from)) } catch {}
  }
  const why = (w) => { if (!S.said.has(w)) { S.said.add(w); log(w) } }
  const kindOf = deps.kindOf

  // ---- BTC: the channel pays an invoice of the wallet's own ark ----
  // One pass at a time each, however often they are called.
  const single = (f) => { let on = null; return () => on || (on = f().finally(() => { on = null })) }
  const tick = single(tickBtc)
  async function tickBtc () {
    const ark = deps.ark
    if (S.btcRunning || (await deps.dev()) || !ark || !(await ark.isOpen())) return
    const pending = load().btc
    if (pending) return followBtc(pending)
    if (await deps.personBusy()) return why('BTC: waiting while a person uses the wallet')
    if (S.btcLast != null && now() - S.btcLast < RETRY_MS) return
    const n = payingNode(await deps.channels(), 'BTC', kindOf)
    if (!n) return why('BTC: no channel that is locked in')
    const amount = withinAllowance(amountToMove(n.spendable), await deps.allowance('btc'))
    if (amount == null) { why(`BTC: ${n.spendable} sat in the channel, too little to move`); return closeEmptied('BTC') }
    S.btcRunning = true
    S.btcLast = now()
    try {
      const inv = await ark.invoice(amount, 'From your Lightning channel')
      const rec = { hash: inv.payment_hash, invoice: inv.invoice, sats: String(amount), from: String(n.balance), node_key: n.node_key,
        at: now(), expires_at: inv.expires_at || null }
      update((s) => { s.btc = rec; s.ownHashes = tail([...s.ownHashes, rec.hash]); s.moved['BTC:' + n.node_key] = now() })
      changed()
      log('moving', String(amount), 'sat of', String(n.spendable), 'from the BTC channel to the ark, hash', rec.hash)
      const node_key = await deps.connect('BTC')
      // The pay call returns once the ark's server took the payment, which waits for the ark wallet
      // to claim it: claim alongside.
      const paying = deps.pay({ node_key, bolt11: inv.invoice }).then((r) => ({ r }), (e) => ({ e }))
      await followBtc({ ...rec, node_key }, paying)
    } catch (e) {
      S.btcLast = isLimitRefusal(e) ? now() + LIMIT_WAIT_MS - RETRY_MS : now()
      log('BTC not moved now:', (e && e.message) || e)
      update((s) => { s.btc = null })
      changed()
    } finally { S.btcRunning = false }
  }

  // Follows the BTC move `rec` until the ark holds it, the payment came back, or its invoice lapsed.
  async function followBtc (rec, paying = null) {
    const ark = deps.ark
    if (S.btcFollowing) return
    S.btcFollowing = true
    const t0 = now()
    let refused = null
    if (paying) paying.then((o) => { if (o.e) refused = o.e })
    try {
      for (;;) {
        let r = null
        try { r = await ark.received(rec.hash) } catch (e) { log('BTC receive status:', (e && e.message) || e) }
        if (r && r.state === 'paid') {
          log('BTC move received in the ark,', rec.sats, 'sat, in', Math.round((now() - rec.at) / 1000), 's')
          return await done(true)
        }
        if (refused) {
          // Refused before it left, or failed on the way: nothing moved, the BTC is in the channel.
          let st = null; try { st = await deps.payStatus({ node_key: rec.node_key, payment_hash: rec.hash }) } catch {}
          if (!st || st.state !== 'pending') {
            if (isLimitRefusal(refused)) S.btcLast = now() + LIMIT_WAIT_MS - RETRY_MS
            log('BTC not moved now:', (refused && refused.message) || refused)
            return await done(false)
          }
        }
        const lapsed = rec.expires_at != null && Number(rec.expires_at) * 1000 + 60_000 < now()
        if (lapsed || now() - rec.at > BTC_FOLLOW_MS) {
          let st = null; try { st = await deps.payStatus({ node_key: rec.node_key, payment_hash: rec.hash }) } catch {}
          if (!st || st.state !== 'pending') { log('BTC move given up: its invoice was not paid'); return await done(false) }
          // Still held on the way: followed again at the next look, and shown as moving meanwhile.
          if (now() - t0 > BTC_FOLLOW_MS) return false
        }
        await sleep(3000)
      }
    } finally { S.btcFollowing = false }

    async function done (ok) {
      update((s) => { s.btc = null })
      try { await ark.refresh() } catch {}
      try { await deps.refreshChannels() } catch {}
      changed()
      if (ok) await closeEmptied('BTC')
      return ok
    }
  }

  // ---- assets: each channel pays a Lightning receive of the wallet's own leaf wallet ----
  async function receives () {
    try { return (await deps.leaves.run('lightning_receives', {})) || {} } catch (e) { why('assets: the leaf wallet did not list its receives: ' + ((e && e.message) || e)); return {} }
  }
  async function setMoving (rcv) {
    const s = load()
    const next = movingOf(rcv, (await deps.leaves.coins()) || [], new Set(s.paid), now())
    for (const a of [...S.movingFrom.keys()]) if (!next.has(a)) S.movingFrom.delete(a)
    const same = next.size === S.movingAssets.size && [...next].every(([a, v]) => S.movingAssets.get(a) === v)
    const ended = [...S.movingAssets.keys()].filter((a) => !next.has(a))
    S.movingAssets = next
    if (!same) {
      update((x) => { x.assets = Object.fromEntries([...next].map(([k, v]) => [k, { moving: String(v), from: S.movingFrom.has(k) ? String(S.movingFrom.get(k)) : null }])) })
      changed()
    }
    return ended
  }

  const tickAssets = single(tickAssetsOnce)
  async function tickAssetsOnce () {
    const leaves = deps.leaves
    if (S.assetsRunning || (await deps.dev())) return
    if (!leaves || !(await leaves.isOpen())) return why('assets: the leaf wallet is not open')
    if (await deps.personBusy()) return why('assets: waiting while a person uses the wallet')
    S.assetsRunning = true
    try {
      const rcv = await receives()
      const ended = await setMoving(rcv)
      for (const a of ended) { try { await deps.refreshChannels() } catch {} await closeEmptied(a) }
      if (S.assetsLast != null && now() - S.assetsLast < ASSET_EVERY_MS) return
      S.assetsLast = now()
      const info = await leaves.info()
      const legs = lightningLegs(info)
      if (!legs.length) return why('assets: the operator receives no asset over Lightning')
      const mins = minLeaves(info)
      const givenUp = new Set(load().givenUp)
      for (const asset of legs) {
        if (await deps.personBusy()) break
        const a8 = asset.slice(0, 8)
        const n = payingNode(await deps.channels(), asset, kindOf)
        if (!n) continue
        if (receivesUnderWay(rcv, asset, now(), givenUp)) { why(`${a8}: a move is under way`); continue }
        const refused = S.refused.get(asset)
        if (refused != null && now() - refused < RETRY_MS) { why(`${a8}: refused, tried again later`); continue }
        const min = mins.get(asset) ?? 1n
        const amount = withinAllowance(amountToMove(n.spendable, min), await deps.allowance(asset), min)
        if (amount == null) { why(`${a8}: ${n.spendable} in the channel, too little to move (smallest leaf ${min})`); await closeEmptied(asset); continue }
        try {
          S.movingFrom.set(asset, n.balance)
          await moveAsset(asset, amount, n)
        } catch (e) {
          S.refused.set(asset, isLimitRefusal(e) ? now() + LIMIT_WAIT_MS - RETRY_MS : now())
          S.movingFrom.delete(asset)
          log(`${a8} not moved now:`, (e && e.message) || e)
        }
      }
      await setMoving(await receives())
    } catch (e) {
      log('asset channels not read now:', (e && e.message) || e)
    } finally { S.assetsRunning = false }
  }

  async function moveAsset (asset, amount, n) {
    const leaves = deps.leaves
    const a8 = asset.slice(0, 8)
    // What the operator charges and what the claim's margins take is the library's to check (its
    // bound refuses more); a quote refused says why nothing moves.
    await leaves.run('lightning_receive_quote', { asset, amount: String(amount) })
    const r = await leaves.run('lightning_receive', { asset, amount: String(amount), description: 'From your Lightning channel to the tree' })
    const hash = String(r.payment_hash)
    update((s) => { if (!s.paid.includes(hash)) s.paid = tail([...s.paid, hash]); s.ownHashes = tail([...s.ownHashes, hash]); s.moved[asset + ':' + n.node_key] = now() })
    log(`moving ${amount} of ${n.spendable} ${a8} from the channel to the tree, leaf ${r.value}, fee ${r.fee}, hash ${hash}`)
    await setMoving(await receives())
    const node_key = await deps.connect(asset)
    try {
      // Held by the operator until the leaf's round: the call may outlast the service's wait, and
      // the payment goes on; the leaf wallet's sync claims the leaf and settles it.
      const p = await deps.pay({ node_key, bolt11: String(r.invoice) })
      log(`${a8} paid:`, !!(p && p.paid))
    } catch (e) {
      let st = null; try { st = await deps.payStatus({ node_key, payment_hash: hash }) } catch {}
      if (st && (st.state === 'pending' || st.state === 'complete')) { log(`${a8} payment still on its way (${(e && e.message) || e})`); return }
      // Refused before anything left the channel (no route, the daily limit): the receive is given
      // up, and nothing is moving.
      update((s) => { s.paid = s.paid.filter((h) => h !== hash); s.givenUp = tail([...s.givenUp, hash]) })
      await setMoving(await receives())
      throw e
    }
    try { await deps.refreshChannels() } catch {}
    try { leaves.refresh && leaves.refresh() } catch {}
  }

  // ---- emptied channels: closed when that is cheap and safe, or kept with the reason ----
  async function closeEmptied (kind) {
    if (S.closing || (await deps.dev()) || !deps.close) return
    const s = load()
    const mins = deps.leaves && (await deps.leaves.isOpen()) ? minLeaves(await deps.leaves.info()) : new Map()
    const min = kind === 'BTC' ? MIN_MOVE_SATS : (mins.get(kind) ?? 1n)
    const moving = kind === 'BTC' ? !!s.btc : S.movingAssets.has(kind)
    for (const c of (await deps.channels()) || []) {
      if (!c || !c.node_key || kindOf(c) !== kind) continue
      const id = c.short_channel_id || c.node_key
      if (s.closed[id]) continue
      const moved = !!s.moved[kind + ':' + c.node_key]
      let fee = null; try { fee = await deps.closeFee(kind, c) } catch {}
      const v = closeVerdict({ channel: c, left: big(c.balance_units ?? c.spendable_units ?? 0), spendable: big(c.spendable_units ?? 0), fee, min, moving, moved })
      S.closeWhy.set(id, v.why)
      if (!v.close) { if (moved) why(`${kind.slice(0, 8)} channel ${id} stays open: ${v.why}`); continue }
      S.closing = true
      try {
        log(`closing the emptied ${kind.slice(0, 8)} channel ${id}, ${c.balance_units} left in it, fee about ${fee}`)
        const r = await deps.close({ kind, channel: c })
        update((x) => { x.closed[id] = { at: now(), txid: (r && r.closing_txid) || null, type: (r && r.type) || null, kind,
          left: String(c.balance_units ?? c.spendable_units ?? 0), address: (r && r.destination) || null } })
        S.closeWhy.set(id, null)
        log(`closed ${id}:`, (r && r.type) || '', (r && r.closing_txid) || '')
        try { await deps.refreshChannels() } catch {}
        changed()
      } catch (e) {
        S.closeWhy.set(id, 'its close was refused now, and is tried again later: ' + ((e && e.message) || e))
        log(`close of ${id} refused:`, (e && e.message) || e)
      } finally { S.closing = false }
    }
  }

  // What cooperative closes paid the wallet that its own scan does not count yet, in `kind`'s atoms:
  // the channel has left the status, and its balance is on its way to the wallet's address.
  function closing (kind) {
    if (!deps.seen) return 0n
    let n = 0n
    for (const v of Object.values(load().closed || {})) {
      if (v && v.kind === kind && v.txid && v.type !== 'unilateral' && !v.seen && now() - v.at < CLOSE_HOLD_MS) n += big(v.left)
    }
    return n
  }
  // Asks the wallet whether it counts each close's payment yet.
  async function checkClosed () {
    if (!deps.seen) return
    for (const [id, v] of Object.entries(load().closed || {})) {
      if (!v || !v.txid || v.seen || now() - v.at >= CLOSE_HOLD_MS) continue
      let yes = false; try { yes = !!(await deps.seen(v.kind, v.txid, v.address)) } catch {}
      if (yes) { update((x) => { if (x.closed[id]) x.closed[id].seen = now() }); changed() }
    }
  }

  return {
    tick: async () => { await checkClosed(); return tick() },
    tickAssets,
    // What of BTC is on its way from the channel to the ark, in sats, or null; and what its channel
    // held when the move began.
    movingBtc: () => { const b = load().btc; return b ? big(b.sats) : null },
    // What of `kind` is on its way from its channels, in atoms, or null.
    moving: (kind) => kind === 'BTC' ? (load().btc ? big(load().btc.sats) : null) : (S.movingAssets.get(kind) ?? null),
    // The channels' part of `kind`'s figure, `read` as last read.
    channelPart: (kind, read) => {
      if (kind === 'BTC') { const b = load().btc; return (b ? channelPart(read, big(b.sats), big(b.from)) : big(read)) + closing(kind) }
      return channelPart(read, S.movingAssets.get(kind) ?? null, S.movingFrom.get(kind) ?? null) + closing(kind)
    },
    // Asks whether each close's payment is counted yet (each pass does).
    checkClosed,
    // The payment hashes of the wallet's own moves: History lists them as no payment.
    ownHashes: () => new Set(load().ownHashes),
    // Why an emptied channel (its short id) stays open, or null.
    closeWhy: (id) => S.closeWhy.get(id) ?? null,
    closed: () => load().closed,
    state: S,
  }
}
