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
//   buying an asset with BTC   the maker makes a Bitcoin invoice; the wallet asks to receive the
//                              asset under its hash; the maker's leaf pays it; once the wallet's
//                              leaf has come and is final, with its home date far enough off, the
//                              wallet pays the maker's invoice, learns the preimage, and claims.
// Neither side can take what it gets before paying: the leaf received under the hash opens only
// with the preimage, and the preimage comes out only when the BTC is paid.
//
// deps.btc, the wallet's Bitcoin Lightning (null when it has none): balance(), invoice({sats}),
// decode(invoice), invoiceStatus(hash), cancelInvoice(hash), pay({invoice, maxFeeSats, maxDelay}),
// payStatus(hash), payRoute?(invoice) -> {fee, delay} or payFee?(invoice) — see tooling/cln-rpc.mjs
// clnBitcoinWallet and btc-lightning.js for two.
//
// A payment of BTC is bounded by the whole lock of its route (`delay`, the final delta and every hop's
// on the way), when the wallet can say what it is; else by the invoice's final delta alone, which only a
// payment to a direct peer meets.

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

// The seconds of median time the leaf received under the hash must keep before its home date,
// for a Bitcoin payment of an invoice whose final delta is `minFinalCltv` blocks.
export function needSeconds (minFinalCltv) {
  return (Number(minFinalCltv || 18) + EXTRA_BLOCKS) * BITCOIN_BLOCK_SECONDS + REACTION_SECONDS
}

export function btcTrades ({ run, deps, put, log, now, settleStep, maxFeePpm, firmMarginMs }) {
  // Read at each use: a page learns whether its Bitcoin Lightning is there after it starts.
  const B = () => deps.btc
  const post = (url, b) => deps.fetchJson(url, { method: 'POST', body: JSON.stringify(b) })
  const release = (maker, swap) => { if (maker && swap) Promise.resolve(post(maker + '/v1/btc/release', { swap })).catch(() => {}) }
  // Before a smaller offer is asked for, the larger one is let go of and the maker has answered:
  // it holds what an offer gives until the offer is released.
  const releaseNow = async (maker, swap) => { if (maker && swap) { try { await post(maker + '/v1/btc/release', { swap }) } catch {} } }

  // Firm terms of one entry (source 'btc-gateway') for `pay` of the pay asset.
  async function firm (entry, payAsset, receiveAsset, pay, have, sized) {
    if (!B()) return null
    let size = sized
    if (receiveAsset === 'BTC') {
      // Selling an asset for BTC: the wallet's invoice first, so the maker's receive is under the
      // wallet's hash.
      let sats = size.receive
      for (let i = 0; i < 4; i++) {
        let inv, o, q
        try { inv = await B().invoice({ sats, description: 'trade' }) } catch (e) { log('[user trade] btc invoice:', e.message); return null }
        try { o = await post(entry.maker + '/v1/btc/firm', { give_asset: 'BTC', want_asset: payAsset, give: String(sats), invoice: inv.invoice }) }
        catch (e) { log('[user trade] maker btc firm:', e.message); B().cancelInvoice(inv.payment_hash).catch(() => {}); return null }
        const drop = () => { release(entry.maker, o.swap); B().cancelInvoice(inv.payment_hash).catch(() => {}) }
        try { q = await run('lightning_pay_quote', { invoice: o.invoice, asset: payAsset, max_fee_ppm: maxFeePpm }) } catch (e) { log('[user trade] lightning_pay_quote:', e.message); drop(); return null }
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
      try { o = await post(entry.maker + '/v1/btc/firm', { give_asset: receiveAsset, want_asset: 'BTC', give: String(give) }) }
      catch (e) { log('[user trade] maker btc firm:', e.message); return null }
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
      const r = await run('lightning_pay', { invoice: o.invoice, asset: choice.btc.quote.asset, max_fee_ppm: maxFeePpm, shown: choice.btc.quote })
      rec.change = r.change || null
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
    // Nothing of the wallet's is locked until it pays the BTC, which waits for its leaf. From here
    // the trade is under way whatever the maker answers now: a lock it refused is asked for again
    // as the trade is followed, and a receive it never pays lapses and the trade comes back.
    rec.state = 'waiting'; rec.waitingSince = now()
    put(rec)
    try { await post(rec.maker + '/v1/btc/lock', { swap: rec.swap, invoice: r.invoice }) } catch (e) { log('[user trade] the maker did not lock yet:', e.message) }
    return rec
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
    rec.receiveState = rcv.state || null
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
      if (!r.ready) return put(rec)
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
      if (st.state === 'none') st = await B().pay({ invoice: rec.invoiceBtc, maxFeeSats: big(rec.routeFee), maxDelay: Number(rec.routeDelay || rec.minFinalCltv || 18) + EXTRA_BLOCKS })
      if (st.state === 'failed') {
        // Nothing was paid: the leaf stays unclaimed and goes back to the maker.
        rec.state = 'returned'; rec.returnedAt = now(); rec.why = st.reason || 'the payment failed'; return put(rec)
      }
      if (st.state !== 'complete') return put(rec)
      rec.preimage = st.preimage
      put(rec)
      await run('lightning_receive_preimage', { hash: rec.hash, preimage: st.preimage })
      await run('sync').catch((e) => log('[user trade] sync:', e.message))
    }
    if (rec.preimage) {
      const r2 = ((await run('lightning_receives')) || {})[rec.hash] || {}
      rec.receiveState = r2.state || null
      if (r2.state !== 'received') return put(rec)
      // The claimed coin is settled in the next round, at no more than the ticket's fee.
      if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
    }
    return put(rec)
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
