// The user-mode composer's BTC trades: an asset for BTC, or BTC for an asset, in one hash-lock.
//
// The asset moves inside the operator's tree under a payment hash (the leaf library's
// `lightning_pay` and `lightning_receive` under a hash, the operator settling it between its own
// two wallets); the BTC moves over Bitcoin Lightning under the same hash, between the person's
// Bitcoin Lightning wallet and the maker's node. BTC is never a leaf and never pegged.
//
// The hash is always the one whoever receives the BTC makes, and whoever gives the asset locks
// first; the BTC is paid only once the leaf received under the hash is held for good:
//   selling an asset for BTC   the wallet makes a Bitcoin invoice (its own preimage); the maker
//                              asks to receive the asset under that hash; the wallet's leaf pays
//                              it; once the maker's leaf has come it pays the wallet's invoice,
//                              learns the preimage from it, and claims. The wallet then hands
//                              the preimage to the operator too, so its own payment is settled
//                              even if the maker never claims.
//   buying an asset with BTC   the maker makes a Bitcoin invoice; the wallet asks for the asset
//                              under its hash, two ways at once, and the maker takes one:
//                              - a lock straight to the wallet (`htlc-2`, the library's
//                                `lock_request`), when the maker offers it (its firm answer's
//                                `lock`), the operator co-signs locks and the lock fits the
//                                wallet's instant limit: the maker's coins move into a leaf the
//                                wallet claims with the preimage and the maker takes back by
//                                script from its timeout. It is the wallet's at once, out of
//                                round, so the wallet pays once `lock_ready` says it is held (its
//                                record the request's, its rounds final, its home date far
//                                enough off): no round is waited for. Just before it pays, the
//                                library marks the lock paid (`lock_paid`), so it is taken home
//                                at its home date unless claimed;
//                              - a receive through the operator (`htlc-1`), which the maker's leaf
//                                pays: the wallet's leaf is made in the operator's next round, and
//                                the wallet pays once that leaf is held and final, with its home
//                                date far enough off.
//                              Either way the wallet then pays the maker's invoice, learns the
//                              preimage, hands it to the operator at once (so any device of the
//                              wallet claims, the page open or not), and claims.
// Neither side can take what it gets before paying: the lock or the leaf received under the hash
// opens to the wallet only with the preimage (a lock comes back to the maker by script from its
// timeout), and the preimage comes out only when the BTC is paid.
//
// deps.refAtoms(asset, atoms), when given: what `atoms` of `asset` are worth in reference atoms at the
// node's fee rate (null when the node gives none), the measure of the library's instant limit.
//
// deps.btc, the wallet's Bitcoin Lightning (null when it has none): balance(), invoice({sats}),
// decode(invoice), invoiceStatus(hash), cancelInvoice(hash), pay({invoice, maxFeeSats, maxDelay}),
// payStatus(hash), payRoute?(invoice) -> {fee, delay} or payFee?(invoice) — see tooling/cln-rpc.mjs
// clnBitcoinWallet and btc-lightning.js for two.
//
// A payment of BTC is bounded by the whole lock of its route (`delay`, the final delta and every hop's
// on the way), when the wallet can say what it is; else by the invoice's final delta alone, which only a
// payment to a direct peer meets.

import { nextFinalBy, settleMinutesOf } from './default-arca.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

const ceilDiv = (a, b) => (a + b - 1n) / b

// What the wallet allows the Bitcoin leg: a Bitcoin block at half its pace (the clocks meet only
// in wall time), the blocks a payment's lock may run past its final delta, and the hour the
// receiver keeps to claim after the latest moment the preimage can come out.
export const BITCOIN_BLOCK_SECONDS = 1200
export const EXTRA_BLOCKS = 6
export const REACTION_SECONDS = 3600
// Buying with BTC, how long the wallet waits for the maker to pay its asset into the wallet's
// receive. Nothing of the wallet's has moved by then: past it the trade comes back.
export const MAKER_LOCK_MS = 5 * 60 * 1000
// A Bitcoin invoice the wallet pays must have at least this long to run.
export const INVOICE_LEFT_SECONDS = 600
// Buying with BTC on a lock straight from the maker, the wait the page states before the library's
// first answer: what the maker's lock usually takes, and the wallet's read of it. No rule bounds it:
// past MAKER_LOCK_MS the trade comes back.
export const LOCK_WAIT_MS = 60 * 1000
// What a lock's timeout leaves beyond the earliest the wallet's payment can use it, for the time
// between asking for the lock and paying (the maker's lock landing, the wallet reading it).
export const LOCK_PAY_SLACK_SECONDS = 1800
// What the maker adds to the earliest timeout the wallet takes (the desk's LOCK_SPARE_SECONDS).
export const LOCK_SPARE_SECONDS = 3600
// A purchase found ready longer ago than this, its BTC not paid yet (the page closed, the wallet's
// Lightning did not answer), is checked to be held still before the BTC goes out.
export const RECHECK_MS = 10 * 1000

// The seconds of median time the leaf received under the hash must keep before its home date,
// for a Bitcoin payment of an invoice whose final delta is `minFinalCltv` blocks.
export function needSeconds (minFinalCltv) {
  return (Number(minFinalCltv || 18) + EXTRA_BLOCKS) * BITCOIN_BLOCK_SECONDS + REACTION_SECONDS
}

// Whether the operator, by its `info` (the leaf library's `server_info`), co-signs locks between two
// holders (`htlc-2`).
export function operatorLocks (serverInfo) {
  const l = serverInfo && serverInfo.templates && serverInfo.templates.list
  return Array.isArray(l) && l.includes('htlc-2')
}

// The earliest timeout (a median time) the wallet takes for a lock it pays for with a Bitcoin
// payment that needs `need` seconds (needSeconds): its home date, the timeout less the unroll of its
// path (the library allows the larger of two blocks a step and the operator's unroll; twice the
// unroll is taken here), its exit delay and ten minutes, still `need` and the slack away. `info` is
// the leaf library's `info`. -> the median time, or null when the lock would run past the
// operator's furthest with the maker's spare hour.
export function lockMinTimeout (info, need, nowSeconds) {
  const median = Number(info && info.tip && info.tip.median_time) || nowSeconds
  const si = (info && info.server_info) || {}
  const exit = Number((info && info.exit_delay_units) || 0) * 512
  const unroll = Number(si.locks && si.locks.unroll_seconds) || 3600
  const t = median + Number(need) + exit + 2 * unroll + 600 + LOCK_PAY_SLACK_SECONDS
  const most = Number(si.locks && si.locks.max_seconds) || 14 * 86400
  return t + LOCK_SPARE_SECONDS <= median + most ? t : null
}

// Whether a lock of `atoms` of `asset` fits the wallet's instant room now, by the library's
// `coin_places` (`instant_limit.room`, in reference atoms) and the asset's worth (`refAtoms`): always
// while the wallet sets no limit; never while the asset has no rate. A lock goes into no round, so
// one past the room would never be held: it is not asked for. Nine tenths of the room, for the
// coins that arrive meanwhile.
export function lockFits (places, worth) {
  const lim = places && places.instant_limit
  if (!lim) return true
  if (worth == null) return false
  return big(worth) * 10n <= big(lim.room) * 9n
}

export function btcTrades ({ run, deps, put, log, now, settleStep, maxFeePpm, firmMarginMs }) {
  // Read at each use: a page learns whether its Bitcoin Lightning is there after it starts.
  const B = () => deps.btc
  const post = (url, b) => deps.fetchJson(url, { method: 'POST', body: JSON.stringify(b) })
  const release = (maker, swap) => { if (maker && swap) Promise.resolve(post(maker + '/v1/btc/release', { swap })).catch(() => {}) }
  // Before a smaller offer is asked for, the larger one is let go of and the maker has answered:
  // it holds what an offer gives until the offer is released.
  const releaseNow = async (maker, swap) => { if (maker && swap) { try { await post(maker + '/v1/btc/release', { swap }) } catch {} } }

  // Firm terms of one entry (source 'btc-gateway') for `pay` of the pay asset. `onStep(key)`, when
  // given, is told each step as it starts (user-trade.js tradeSteps); `onRefused(e)` is told the
  // wallet's own refusal of the payment it checks.
  async function firm (entry, payAsset, receiveAsset, pay, have, sized, onStep = null, onRefused = null) {
    if (!B()) return null
    const step = (k) => { if (onStep) try { onStep(k) } catch {} }
    let size = sized
    if (receiveAsset === 'BTC') {
      // Selling an asset for BTC: the wallet's invoice first, so the maker's receive is under the
      // wallet's hash.
      let sats = size.receive
      for (let i = 0; i < 4; i++) {
        let inv, o, q
        step('invoice')
        try { inv = await B().invoice({ sats, description: 'trade' }) } catch (e) { log('[user trade] btc invoice:', e.message); return null }
        step('firm')
        try { o = await post(entry.maker + '/v1/btc/firm', { give_asset: 'BTC', want_asset: payAsset, give: String(sats), invoice: inv.invoice }) }
        catch (e) { log('[user trade] maker btc firm:', e.message); B().cancelInvoice(inv.payment_hash).catch(() => {}); return null }
        const drop = () => { release(entry.maker, o.swap); B().cancelInvoice(inv.payment_hash).catch(() => {}) }
        step('check')
        // The wallet's own refusal (its coins of the asset fall short now) is told to the quote, which
        // then says so, never that the other side gave no price (#666).
        try { q = await run('lightning_pay_quote', { invoice: o.invoice, asset: payAsset, max_fee_ppm: maxFeePpm }) } catch (e) { log('[user trade] lightning_pay_quote:', e.message); if (onRefused) try { onRefused(e, { paying: big(o.want) }) } catch {} drop(); return null }
        // The maker's invoice is under the wallet's own hash, for the asset paid, at the price quoted.
        const fair = ceilDiv(sats * entry.rateNum, entry.rateDen)
        if (q.payment_hash !== inv.payment_hash || q.asset !== payAsset || big(q.amount) !== big(o.want) || big(o.want) > fair) { log('[user trade] the maker\'s btc terms are not the quote\'s'); drop(); return null }
        // The change the payment leaves is settled in the operator's next round as part of the trade,
        // so a wallet that sells again and again does not pile up reassignments on it; the settle's
        // fee, at the change's expiry (the earliest of the coins it comes from), is on the ticket.
        let sc = null
        if (big(q.change) > 0n && Array.isArray(q.gives)) {
          try {
            const given = ((await run('coins')) || []).filter((c) => q.gives.includes(c.leaf_id))
            const expiry = Math.min(...given.map((c) => Number(c.expiry)).filter((x) => x > 0))
            sc = await run('settle_quote', { asset: payAsset, value: String(q.change), expiry })
          } catch (e) { log('[user trade] settle_quote:', e.message); drop(); return null }
        }
        const spends = big(q.spends) + (sc ? big(sc.fee) : 0n)
        const limit = pay < have ? pay : have
        if (spends > limit) {
          B().cancelInvoice(inv.payment_hash).catch(() => {})
          await releaseNow(entry.maker, o.swap)
          sats = sats - ((spends - limit) * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
          if (sats < entry.minReceive) return null
          continue
        }
        return { source: entry.source, id: entry.id, entry, receive: sats, give: spends, dir: 'sell',
          fees: [{ asset: payAsset, atoms: spends - big(q.amount) }], btc: { invoice: inv, offer: o, quote: q, settle: sc } }
      }
      return null
    }
    // Buying an asset with BTC: the maker's invoice, and what the wallet's leaf would hold.
    let give = size.receive
    for (let i = 0; i < 4; i++) {
      let o, d, rq, sq
      step('firm')
      try { o = await post(entry.maker + '/v1/btc/firm', { give_asset: receiveAsset, want_asset: 'BTC', give: String(give) }) }
      catch (e) { log('[user trade] maker btc firm:', e.message); return null }
      step('check')
      try { d = await B().decode(o.invoice) } catch (e) { log('[user trade] btc decode:', e.message); release(entry.maker, o.swap); return null }
      const fair = ceilDiv(give * entry.rateNum, entry.rateDen)
      if (big(d.sats) !== big(o.want) || big(d.sats) > fair || d.expires_at * 1000 - now() < (INVOICE_LEFT_SECONDS + 1800) * 1000) {
        log('[user trade] the maker\'s btc invoice is not the quote\'s'); release(entry.maker, o.swap); return null
      }
      // The route's fee and whole lock, which the payment is held to (a payment to the maker's
      // node through another takes the hops' deltas as well as the invoice's).
      const rt = B().payRoute ? await B().payRoute(o.invoice).catch(() => null) : null
      const fee = rt ? big(rt.fee) : big(B().payFee ? await B().payFee(o.invoice).catch(() => null) : 0n)
      const routeDelay = rt && Number(rt.delay) > 0 ? Number(rt.delay) : Number(d.min_final_cltv || 18)
      try {
        rq = await run('lightning_receive_quote', { asset: receiveAsset, amount: String(give), max_fee_ppm: maxFeePpm })
        // The leaf is settled in the operator's next round, at the fee a fresh coin pays.
        sq = await run('settle_quote', { asset: receiveAsset, value: rq.claimed, expiry: Math.floor(now() / 1000) + 400 * 86400 })
      } catch (e) { log('[user trade] receive quote:', e.message); release(entry.maker, o.swap); return null }
      const spends = big(d.sats) + fee
      const limit = pay < have ? pay : have
      if (spends > limit) {
        await releaseNow(entry.maker, o.swap)
        give = give - ((spends - limit) * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
        if (give < entry.minReceive) return null
        continue
      }
      const fees = [{ asset: receiveAsset, atoms: big(rq.fee) + big(rq.claim_margins) + big(sq.fee) }]
      if (fee > 0n) fees.unshift({ asset: 'BTC', atoms: fee })
      return { source: entry.source, id: entry.id, entry, receive: big(sq.after), give: spends, dir: 'buy', fees,
        btc: { offer: o, decoded: d, receiveQuote: rq, settle: sq, routeFee: fee, routeDelay } }
    }
    return null
  }

  // Takes the one step of a confirmed BTC trade; the record is written before anything is signed.
  async function confirm (choice, rec) {
    const o = choice.btc.offer
    if (o.expires_at && Number(o.expires_at) * 1000 - now() < firmMarginMs) {
      rec.state = 'failed'; rec.error = 'the firm offer lapsed before it was confirmed'; put(rec)
      release(choice.entry.maker, o.swap)
      if (choice.btc.invoice) B().cancelInvoice(choice.btc.invoice.payment_hash).catch(() => {})
      const e = new Error('the price is no longer held'); e.code = 'lapsed'; throw e
    }
    rec.maker = choice.entry.maker; rec.swap = o.swap; rec.dir = choice.dir
    rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
    if (choice.dir === 'sell') {
      rec.hash = choice.btc.invoice.payment_hash; rec.invoiceX = o.invoice; rec.sats = String(choice.receive)
      rec.spends = choice.btc.quote.spends; rec.amount = choice.btc.quote.amount
      const sc = choice.btc.settle
      rec.settleTargets = sc ? [{ asset: sc.asset, value: sc.value, fee: sc.fee }] : []
      put(rec)
      let r
      try { r = await run('lightning_pay', { invoice: o.invoice, asset: choice.btc.quote.asset, max_fee_ppm: maxFeePpm, shown: choice.btc.quote }) } catch (e) {
        // What the payment would spend changed since the ticket was shown (the wallet's coins moved
        // meanwhile: a coin arrived or settled, and another one is chosen): nothing was signed, and
        // the price is asked again and shown, never paid on terms nobody saw.
        if (!/changed since it was shown/.test(String(e && e.message))) throw e
        rec.state = 'failed'; rec.error = 'what the payment spends changed before it was confirmed'; put(rec)
        release(choice.entry.maker, o.swap)
        if (choice.btc.invoice) B().cancelInvoice(choice.btc.invoice.payment_hash).catch(() => {})
        const x = new Error('the price is no longer held'); x.code = 'lapsed'; x.cause = e; throw x
      }
      rec.change = r.change || null
      // The change coin by its id: the payment's transfer makes the payment's leaf, then the change.
      // Named, it is followed even once the wallet pays on it, which the next trade often does.
      const outs = r.transfer && Array.isArray(r.transfer.outputs) ? r.transfer.outputs : []
      if (rec.settleTargets.length === 1 && big(r.change) > 0n && typeof outs[1] === 'string' && outs[1]) rec.settleTargets = [{ ...rec.settleTargets[0], leaf_id: outs[1] }]
      rec.state = 'sent'; rec.sentAt = now()
      put(rec)
      post(rec.maker + '/v1/btc/paid', { swap: rec.swap }).catch(() => {})
      return rec
    }
    rec.hash = choice.btc.decoded.payment_hash; rec.invoiceBtc = o.invoice; rec.sats = String(choice.btc.decoded.sats)
    rec.minFinalCltv = choice.btc.decoded.min_final_cltv; rec.routeFee = String(choice.btc.routeFee); rec.routeDelay = choice.btc.routeDelay
    rec.receiveAsset = choice.btc.receiveQuote.asset; rec.claimed = choice.btc.receiveQuote.claimed
    rec.settleTargets = [{ asset: choice.btc.settle.asset, value: choice.btc.settle.value, fee: choice.btc.settle.fee }]
    put(rec)
    const r = await run('lightning_receive', { asset: rec.receiveAsset, amount: choice.btc.receiveQuote.amount, hash: rec.hash, max_fee_ppm: maxFeePpm })
    if (r.fee !== choice.btc.receiveQuote.fee || r.value !== choice.btc.receiveQuote.value) throw new Error('the receive changed since it was shown')
    rec.invoiceX = r.invoice
    put(rec)
    // The asset as a lock straight from the maker too, when it offers one: the receive stays, for a
    // maker that locks through the operator instead.
    const info = await run('info').catch(() => null)
    const lockReq = await askLock(rec, o, info, choice.btc.receiveQuote.amount)
    // Nothing of the wallet's is locked until it pays the BTC, which waits for its asset to be held.
    // From here the trade is under way whatever the maker answers now: a lock it refused is asked for
    // again as the trade is followed, and one it never makes lapses and the trade comes back.
    rec.state = 'waiting'; rec.waitingSince = now()
    // What the page says the wait is before the library's first answer: on a lock straight from the
    // maker, the maker's lock (LOCK_WAIT_MS); through the operator, the library's own figure for a
    // leaf made by the operator's next round (settleMinutes, its step "round").
    rec.waitFirstBy = rec.waitingSince + (lockReq ? LOCK_WAIT_MS : settleMinutesOf(info) * 60_000)
    put(rec)
    try { await post(rec.maker + '/v1/btc/lock', lockBody(rec)) } catch (e) { log('[user trade] the maker did not lock yet:', e.message) }
    return rec
  }

  // What the wallet asks the maker to lock: the receive's invoice, and the lock request when it made one.
  const lockBody = (rec) => ({ swap: rec.swap, invoice: rec.invoiceX, ...(rec.leg === 'htlc-2' && rec.lockRequest ? { lock: rec.lockRequest } : {}) })

  // The wallet's lock request for a purchase (`lock_request`), when the maker's offer `o` locks that
  // way, the operator co-signs locks, the lock fits the instant room and its timeout the operator's
  // furthest: kept on the record (`leg` 'htlc-2'). -> the request, or null (the purchase then waits
  // for its leaf through the operator, as before).
  async function askLock (rec, o, info, amount) {
    if (!(Array.isArray(o.lock) && o.lock.includes('htlc-2'))) return null
    try {
      if (!info || !operatorLocks(info.server_info)) return null
      const worth = deps.refAtoms ? deps.refAtoms(rec.receiveAsset, amount) : null
      if (!lockFits(await run('coin_places'), worth)) { log('[user trade] a lock of', String(amount), 'would not fit the instant room: through the operator'); return null }
      const min = lockMinTimeout(info, needSeconds(rec.routeDelay || rec.minFinalCltv), Math.floor(now() / 1000))
      if (min == null) return null
      const req = await run('lock_request', { asset: rec.receiveAsset, amount: String(amount), hash: rec.hash, min_timeout: min })
      rec.leg = 'htlc-2'; rec.lockRequest = req; put(rec)
      return req
    } catch (e) { log('[user trade] no lock asked:', e.message); return null }
  }

  // Buying on a lock straight from the maker, while waiting: -> 'pay' once the lock is held (the
  // record is then 'sent'), 'wait' while it is not yet, 'htlc-1' when the maker paid the receive
  // through the operator instead (the record goes on as such).
  async function waitLock (rec, rcv) {
    let r
    try { r = await run('lock_ready', { hash: rec.hash, need_seconds: needSeconds(rec.routeDelay || rec.minFinalCltv) }) } catch (e) {
      // Only the library's refusal says the lock will never do (nothing of the wallet's has left);
      // an operator that does not answer now is asked again.
      if (!(e && (e.kind === 'refused' || /^refused\b/i.test(String(e.message))))) { log('[user trade] not ready yet:', e.message); return 'wait' }
      log('[user trade] the lock will not do:', e.message); rec.state = 'returned'; rec.returnedAt = now(); rec.why = e.message; return 'wait'
    }
    if (r.ready) { rec.receiveState = 'held'; rec.state = 'sent'; rec.sentAt = now(); rec.paying = true; put(rec); return 'pay' }
    if (/has not come/.test(String(r.why || ''))) {
      // The maker paid the receive through the operator instead: the purchase goes on that way.
      if (rcv.state && rcv.state !== 'waiting' && rcv.state !== 'failed') { rec.leg = 'htlc-1'; log('[user trade] the maker locked through the operator'); return 'htlc-1' }
      // A maker that has not locked by now is not going to: nothing of the wallet's has moved, so
      // the trade comes back and the maker lets its offer go.
      if (now() - (rec.waitingSince ?? rec.at ?? now()) >= MAKER_LOCK_MS) {
        release(rec.maker, rec.swap)
        rec.state = 'returned'; rec.returnedAt = now(); rec.why = 'the maker did not lock its side in time'; return 'wait'
      }
      post(rec.maker + '/v1/btc/lock', lockBody(rec)).catch(() => {})
      rec.waitBy = { finalBy: (rec.waitingSince ?? rec.at) + MAKER_LOCK_MS, step: 'payment' }
      return 'wait'
    }
    // The lock has come and is not held yet (the round its coins rest on is not final): a round's
    // wait at most, as the library's settle states it.
    rec.receiveState = 'held'
    if (rec.notReady !== (r.why || '')) { rec.notReady = r.why || ''; log('[user trade] the lock is not held yet:', rec.notReady) }
    if (!rec.waitBy || rec.waitBy.step === 'payment') rec.waitBy = { finalBy: now() + settleMinutesOf(await run('info').catch(() => null)) * 60_000, step: 'round' }
    return 'wait'
  }

  async function advance (rec) {
    await run('sync').catch((e) => log('[user trade] sync:', e.message))
    return rec.dir === 'sell' ? advanceSell(rec) : advanceBuy(rec)
  }

  // Selling: the BTC comes to the wallet's invoice; its payment of the asset is settled with the
  // preimage, which the wallet hands the operator too.
  async function advanceSell (rec) {
    const pays = (await run('lightning_payments')) || {}
    const p = pays[rec.hash] || {}
    rec.payState = p.state || null
    const inv = await B().invoiceStatus(rec.hash).catch(() => ({ status: 'unknown' }))
    if (inv.status === 'paid') {
      rec.btcPaid = true
      if (p.state !== 'paid' && inv.preimage && !rec.posted) {
        try { await run('lightning_post_preimage', { hash: rec.hash, preimage: inv.preimage }); rec.posted = true } catch (e) { log('[user trade] post preimage:', e.message) }
      }
      // Settled once the wallet's payment is settled too, and the change it left is settled in a
      // round that is final.
      if (p.state === 'paid' && (await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
      return put(rec)
    }
    if (p.state === 'returned') {
      // The maker never paid: the payment failed back and its leaf came back, less its margins.
      rec.state = 'returned'; rec.returnedAt = now()
      B().cancelInvoice(rec.hash).catch(() => {})
      const back = ((await run('coins')) || []).filter((c) => c.state === 'live' && !(rec.before || []).includes(c.leaf_id) && c.asset === rec.ticket.payAsset)
        .reduce((n, c) => n + big(c.value), 0n) - big(rec.change)
      const lost = big(rec.spends) - back
      if (lost > 0n) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: String(lost) }]
      return put(rec)
    }
    return put(rec)
  }

  // Buying: wait for the leaf, then pay the BTC, then claim and settle the leaf.
  async function advanceBuy (rec) {
    const rcv = ((await run('lightning_receives')) || {})[rec.hash] || {}
    if (rec.leg !== 'htlc-2') rec.receiveState = rcv.state || null
    if (rec.state === 'waiting' && rec.leg === 'htlc-2') {
      const next = await waitLock(rec, rcv)
      if (next === 'wait') return put(rec)
      if (next === 'htlc-1') rec.receiveState = rcv.state || null
    }
    if (rec.state === 'waiting') {
      if (rcv.state === 'failed') { rec.state = 'returned'; rec.returnedAt = now(); return put(rec) }
      // A maker that has not paid the asset in by now is not going to: nothing of the wallet's has
      // moved, so the trade comes back and the maker lets its offer go. The wallet never pays BTC
      // for a trade it has called returned.
      if ((rcv.state === 'waiting' || !rcv.state) && now() - (rec.waitingSince ?? rec.at ?? now()) >= MAKER_LOCK_MS) {
        release(rec.maker, rec.swap)
        rec.state = 'returned'; rec.returnedAt = now(); rec.why = 'the maker did not lock its side in time'; return put(rec)
      }
      // The maker's lock, asked for again in case it missed it.
      if (rcv.state === 'waiting') post(rec.maker + '/v1/btc/lock', { swap: rec.swap, invoice: rec.invoiceX }).catch(() => {})
      let r
      try { r = await run('lightning_receive_ready', { hash: rec.hash, need_seconds: needSeconds(rec.routeDelay || rec.minFinalCltv) }) }
      catch (e) {
        // Only the library's refusal says the leaf will never do (nothing of the wallet's has left);
        // an operator that does not answer now is asked again.
        if (!(e && (e.kind === 'refused' || /^refused\b/i.test(String(e.message))))) { log('[user trade] not ready yet:', e.message); return put(rec) }
        log('[user trade] the leaf will not do:', e.message); rec.state = 'returned'; rec.returnedAt = now(); rec.why = e.message; return put(rec)
      }
      // Why the asset is not final yet, said once each time it changes.
      if (!r.ready) {
        if (rec.notReady !== (r.why || '')) { rec.notReady = r.why || ''; log('[user trade] the asset is not final yet:', rec.notReady) }
        // The wait the page states: the library's own (`usual_in_seconds`, else `final_in_seconds`,
        // and its step), kept while the step stands or moves on. While the maker has not paid in
        // (`payment`, which no round bounds) it is the time the maker has to lock its side.
        rec.waitBy = r.waiting_for === 'payment'
          ? { finalBy: (rec.waitingSince ?? rec.at) + MAKER_LOCK_MS, step: 'payment' }
          : nextFinalBy(rec.waitBy && rec.waitBy.step !== 'payment' ? rec.waitBy : null, r, now())
        return put(rec)
      }
      rec.state = 'sent'; rec.sentAt = now(); rec.paying = true
      put(rec)
    }
    if (rec.state === 'sent' && !rec.preimage) {
      let st = await B().payStatus(rec.hash).catch(() => ({ state: 'none' }))
      // The asset is final only after Bitcoin blocks, which can outlast the maker's invoice: one
      // that runs out soon is renewed by the maker under the same hash, for the same amount, on no
      // longer a lock or a higher fee, or the trade comes back with nothing paid.
      if (st.state === 'none') {
        const fresh = await freshInvoice(rec)
        if (!fresh) {
          release(rec.maker, rec.swap)
          rec.state = 'returned'; rec.returnedAt = now(); rec.why = 'the maker\'s invoice ran out while the trade waited'; rec.whyKind = 'lapsed'
          return put(rec)
        }
      }
      if (st.state === 'none' && (await beforePay(rec)) !== 'pay') return put(rec)
      if (st.state === 'none') st = await B().pay({ invoice: rec.invoiceBtc, maxFeeSats: big(rec.routeFee), maxDelay: Number(rec.routeDelay || rec.minFinalCltv || 18) + EXTRA_BLOCKS })
      if (st.state === 'failed') {
        // Nothing was paid: the leaf stays unclaimed and goes back to the maker.
        rec.state = 'returned'; rec.returnedAt = now(); rec.why = st.reason || 'the payment failed'; return put(rec)
      }
      if (st.state !== 'complete') return put(rec)
      rec.preimage = st.preimage
      put(rec)
      // The operator is handed the preimage before anything else, so what was bought never rests on
      // this page staying open: the operator serves it, and the wallet on any device (one restored
      // from the phrase included) claims the asset at its next sync. Safe to hand on: it opens the
      // wallet's leaf only with the wallet's own key, and the maker, paid, knows it already.
      // On a lock straight from the maker, `lock_preimage` does all of it: the preimage kept, handed
      // to the operator and the wallet's watchtowers, and the lock claimed out of round.
      if (rec.leg === 'htlc-2') await handLock(rec)
      else {
        await postPreimage(rec)
        await run('lightning_receive_preimage', { hash: rec.hash, preimage: st.preimage })
      }
      await run('sync').catch((e) => log('[user trade] sync:', e.message))
    }
    // Handed on once more while the claim has not run, should the first try have failed.
    if (rec.preimage && !rec.posted && rec.receiveState !== 'received') await (rec.leg === 'htlc-2' ? handLock(rec) : postPreimage(rec))
    if (rec.preimage) {
      let leaf = null
      if (rec.leg === 'htlc-2') {
        const l = ((await run('locks').catch(() => null)) || []).find((x) => x && x.role === 'payee' && x.hash === rec.hash) || {}
        rec.receiveState = l.state === 'claimed' ? 'received' : 'held'
        // The claim is the library's (`lock_preimage` above, and every sync): read until it is made.
        if (l.state !== 'claimed') return put(rec)
        leaf = Array.isArray(l.claimed_into) ? l.claimed_into[0] : null
      } else {
        const r2 = ((await run('lightning_receives')) || {})[rec.hash] || {}
        rec.receiveState = r2.state || null
        if (r2.state !== 'received') return put(rec)
        leaf = r2.leaf
      }
      // The coin the claim made is the one settled, named by its id: its value is the quote's only
      // while the operator's fee rates hold, and a coin looked for by a value it no longer has is
      // never found.
      if (leaf && (rec.settleTargets || []).length === 1 && !rec.settleTargets[0].leaf_id) { rec.settleTargets = [{ ...rec.settleTargets[0], leaf_id: leaf }]; put(rec) }
      // The claimed coin is settled in the next round, at no more than the ticket's fee.
      if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
    }
    return put(rec)
  }

  // Just before the BTC goes out. A purchase found ready a while ago (RECHECK_MS: the page closed, or
  // the wallet's Lightning did not answer, since) is checked to be held still, as when it was found
  // ready: a lock or a leaf that will never do returns the trade, nothing paid; one not held yet
  // sends it back to waiting. On a lock the library then marks it paid (`lock_paid`), kept before
  // the BTC goes out: from the lock's home date the wallet takes it on the chain unless claimed,
  // even if the page never learns the preimage and the operator neither co-signs the claim nor
  // serves it. A library that cannot mark it never sees the BTC paid. -> 'pay', or 'wait' (the
  // record says why).
  async function beforePay (rec) {
    const refused = (e) => !!e && (e.kind === 'refused' || e.kind === 'parse' || /^refused\b/i.test(String(e.message)))
    if (now() - (rec.sentAt ?? rec.at ?? 0) > RECHECK_MS) {
      const need = needSeconds(rec.routeDelay || rec.minFinalCltv)
      let r
      try { r = await run(rec.leg === 'htlc-2' ? 'lock_ready' : 'lightning_receive_ready', { hash: rec.hash, need_seconds: need }) } catch (e) {
        if (!refused(e)) { log('[user trade] not checked again yet:', e.message); return 'wait' }
        log('[user trade] no longer held:', e.message)
        release(rec.maker, rec.swap)
        rec.state = 'returned'; rec.returnedAt = now(); rec.why = e.message; return 'wait'
      }
      if (!r.ready) {
        log('[user trade] not held any more, waiting again:', r.why || '')
        rec.state = 'waiting'; rec.paying = false; rec.notReady = r.why || ''; return 'wait'
      }
      rec.sentAt = now(); put(rec)
    }
    if (rec.leg === 'htlc-2' && !rec.markedPaid) {
      try { await run('lock_paid', { hash: rec.hash }); rec.markedPaid = true; put(rec) } catch (e) {
        if (!refused(e)) { log('[user trade] the lock is not marked paid yet:', e.message); return 'wait' }
        log('[user trade] the lock cannot be marked paid, so nothing is paid:', e.message)
        release(rec.maker, rec.swap)
        rec.state = 'returned'; rec.returnedAt = now(); rec.why = 'the wallet could not mark its lock paid: ' + e.message; return 'wait'
      }
    }
    return 'pay'
  }

  // Hands the library the preimage of a purchase on a lock whose BTC is paid (`lock_preimage`: kept,
  // posted to the operator and the watchtowers, the lock claimed); `rec.posted` once it took it. A
  // claim that failed (the operator away) is made again by the library's sync, and asked again here.
  async function handLock (rec) {
    try { await run('lock_preimage', { hash: rec.hash, preimage: rec.preimage }); rec.posted = true; put(rec) }
    catch (e) { log('[user trade] lock preimage:', e.message); if (/holds no lock/.test(String(e.message))) { rec.posted = true; put(rec) } }
  }

  // Hands the operator the preimage of a purchase whose BTC is paid; `rec.posted` once it took it.
  async function postPreimage (rec) {
    try { await run('lightning_post_preimage', { hash: rec.hash, preimage: rec.preimage }); rec.posted = true; put(rec) }
    catch (e) { log('[user trade] post preimage:', e.message) }
  }

  // The maker's invoice for a purchase, renewed when it runs out within INVOICE_LEFT_SECONDS: the
  // same hash and amount, a lock and fee no greater than the trade allowed. -> true when it can be
  // paid now, false when it cannot (the maker gives no new one, or not one like it).
  async function freshInvoice (rec) {
    const left = async (inv) => { const d = await B().decode(inv); return { d, left: d.expires_at - now() / 1000 } }
    let cur
    try { cur = await left(rec.invoiceBtc) } catch { return false }
    if (cur.left >= INVOICE_LEFT_SECONDS) return true
    let o
    try { o = await post(rec.maker + '/v1/btc/invoice', { swap: rec.swap }) } catch (e) { log('[user trade] the maker gave no new invoice:', e.message); return false }
    let n
    try { n = await left(o.invoice) } catch { return false }
    if (n.d.payment_hash !== rec.hash || big(n.d.sats) !== big(rec.sats) || n.left < INVOICE_LEFT_SECONDS ||
        Number(n.d.min_final_cltv || 18) > Number(rec.minFinalCltv || 18)) { log('[user trade] the maker\'s new invoice is not the trade\'s'); return false }
    const rt = B().payRoute ? await B().payRoute(o.invoice).catch(() => null) : null
    if (rt && (big(rt.fee) > big(rec.routeFee) || Number(rt.delay) > Number(rec.routeDelay || rec.minFinalCltv || 18))) { log('[user trade] the new invoice\'s route costs more than the trade allowed'); return false }
    rec.invoiceBtc = o.invoice; put(rec)
    log('[user trade] the maker renewed its invoice for', rec.swap)
    return true
  }

  return { firm, confirm, advance, release }
}
