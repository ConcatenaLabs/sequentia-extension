// BTC IN DEFAULT MODE LIVES ON THE BITCOIN ARK: native bitcoin, held in a Bark wallet of the same
// phrase on the Bitcoin ark the page names (window.SEQ_BTC_ARK: the ark server, reached over
// gRPC-web, and an Esplora server for testnet4). Never pegged: the coins are bitcoin on Bitcoin,
// and the holder can always take them on chain alone.
//
//   - Receiving: BTC that lands at the wallet's tb1 address and is confirmed is boarded by itself
//     (the page's own key signs the funding, one transaction from the address to the ark), shown
//     as arriving until the ark takes it; a Lightning invoice made in default mode is paid into
//     the ark directly.
//   - Sending: to an invoice, over Lightning from the ark; to an Ark address, inside the ark, in
//     seconds; to a Bitcoin address, out of the ark to the chain. When the ark cannot (too little
//     there, the server unreachable), the old way is taken.
//   - Trading: the BTC desk's hold invoices are paid from the ark (lightning(), the composer's
//     deps.btc), so a BTC-for-asset trade runs from ark BTC.
//
// Nothing here computes a fee, a coin or a verdict: the wallet (btc-ark/worker.js) answers, and
// this module names the route and shows the answer. It has no DOM, so it runs under Node
// (btc-ark.test.mjs).

import { readPayCode } from './pay-code.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// Every string default mode shows for BTC here, in one place, so the words default mode never
// says can be checked against all of them (btc-ark.test.mjs; docs/DEFAULT_MODE.md).
export const BTC_WORDS = Object.freeze({
  arriving: (amount) => `${amount} BTC arriving`,
  review: (amount) => `Send ${amount} BTC?`,
  to: 'To', fee: 'Fee', noFee: 'No fees', send: 'Send', sending: 'Sending…',
  toInvoice: 'An invoice',
  toCode: 'A receive code',
  arrivesNow: 'It arrives in seconds.',
  arrivesBlock: 'It arrives after a Bitcoin block.',
  sent: (amount, secs) => `Sent ${amount} BTC (${secs} s).`,
  sentBlock: (amount) => `Sent ${amount} BTC. It arrives after a Bitcoin block.`,
  upTo: (amount) => `You can send up to ${amount} BTC this way now.`,
  failed: (why) => `Nothing was sent: ${why}`,
  recvTitle: 'Receive BTC with an invoice',
  recvSub: 'Make an invoice for BTC. Once it is paid, the BTC is yours in seconds.',
  invoiceReady: (amount) => `Invoice ready. Share it to receive ${amount} BTC.`,
  received: (amount) => `Received ✓ ${amount} BTC.`,
  invoiceWait: 'Making the invoice…',
  amountHint: 'Amount in BTC (optional)',
  payTitle: 'Pay an invoice',
  paySub: 'Paste an invoice to pay it with your BTC.',
  paying: 'Paying…',
  paid: (amount, fee) => `Paid ✓ ${amount} BTC · fee ${fee} BTC`,
  // The payee holds the payment and has not taken it yet (a hold invoice): it is not paid until
  // they do, and comes back if they do not.
  payWaiting: 'On its way: waiting for the other side to accept it.',
  payCameBack: 'Not paid: the payment came back, and the BTC is in your balance again.',
  payUpTo: (amount) => `You can pay up to ${amount} BTC this way now.`,
  payHint: 'Paste an invoice',
  notBtc: (ticker) => `This invoice asks for ${ticker}. Only invoices for BTC are paid here.`,
})

// How long a worker request may take before the page stops waiting on it (a payment waits for
// its route; everything else answers in seconds).
export const RUN_TIMEOUT_MS = 90_000
export const PAY_TIMEOUT_MS = 180_000
// How often the balance is read again while the page is open (the wallet's own store: cheap), and
// how often the wallet is asked to sync with its server and the chain besides its daemon.
export const REFRESH_MS = 3_000
export const SYNC_MS = 30_000
// How often the wallet asks its server what the phrase's other wallets did (`catch_up`: the coins
// they made or received, a board once its wallet has registered it, and the coins of this store
// they spent), besides once at each open. A browser that opened the phrase before another one
// boarded or was paid learns of it this way.
export const CATCH_UP_MS = 5 * 60_000
// The least a board leaves the on-chain fee and the ark's board fee, over the ark's own least.
export const BOARD_MARGIN_SATS = 1_000n
// testnet4's fee floor for the board's funding (sat/vB).
export const BOARD_FEERATE = 2

// The page's Bitcoin ark, as configured, or null when it names none (or names it wrongly).
export function arkConfig (cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  const { server, esplora, network } = cfg
  if (typeof server !== 'string' || !/^https?:\/\//.test(server)) return null
  if (typeof esplora !== 'string' || !/^https?:\/\//.test(esplora)) return null
  if (!['testnet4', 'signet', 'regtest', 'bitcoin'].includes(network)) return null
  return { server: server.replace(/\/+$/, ''), esplora: esplora.replace(/\/+$/, ''), network }
}

// Where a BTC payment to `text` goes: 'invoice' (a Bitcoin Lightning invoice), 'ark' (an Ark
// address), 'chain' (a Bitcoin address), or null. `decode` is bolt11.js decodeBolt11.
export function routeOf (text, decode) {
  return destination(text, decode)?.route ?? null
}

// The route and the destination a BTC payment to `text` takes: a receive code (pay-code.js) is
// paid at its Ark address when it has one, else at its address. -> { route, dest } or null.
export function destination (text, decode) {
  let s = String(text || '').trim()
  if (/^bitcoin:/i.test(s)) {
    let c = null
    try { c = readPayCode(s) } catch { return null }
    if (!c) return null
    s = c.ark || c.address || ''
  }
  const r = bareRoute(s, decode)
  return r ? { route: r, dest: s.replace(/^lightning:/i, '') } : null
}

function bareRoute (s, decode) {
  if (!s) return null
  if (/^(lightning:)?ln(tb|bc|bcrt|tbs)[0-9a-z]+$/i.test(s)) {
    const d = decode ? decode(s.replace(/^lightning:/i, '')) : null
    return d && d.ok && d.chain === 'btc' ? 'invoice' : null
  }
  if (/^t?ark1[02-9ac-hj-np-z]{20,}$/i.test(s)) return 'ark'
  if (/^(tb1|bc1|bcrt1)[02-9ac-hj-np-z]{8,}$/i.test(s) || /^[mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) return 'chain'
  return null
}

// One figure from the wallet's balance: everything it holds in the ark, spendable or on its way.
export function arkFigures (b) {
  if (!b) return { total: 0n, spendable: 0n, arriving: 0n }
  const spendable = big(b.spendable)
  const arriving = big(b.pending_board) + big(b.claimable_lightning_receive) + big(b.pending_in_round)
  return { total: big(b.total), spendable, arriving }
}

// What a board of the confirmed coins `utxos` (each { value }) carries: what is left after the
// funding's fee at `feerate` (one P2WPKH input each, one taproot output) and the ark's board fee,
// or null when that is below the ark's least board. -> { amount, chainFee } or null.
export function boardAmount (utxos, info, boardFee, feerate = BOARD_FEERATE) {
  const conf = (utxos || []).filter((u) => u && u.confirmed !== false)
  if (!conf.length || !info) return null
  const sum = conf.reduce((n, u) => n + big(u.value), 0n)
  const vbytes = BigInt(Math.ceil(10.75 + 68 * conf.length + 43))
  const chainFee = vbytes * BigInt(feerate)
  const amount = sum - chainFee
  const min = big(info.min_board_sat) + big(boardFee) + BOARD_MARGIN_SATS
  if (amount < min) return null
  const max = info.max_vtxo_sat != null ? big(info.max_vtxo_sat) : null
  return { amount: max != null && amount > max ? max : amount, chainFee, inputs: conf.length }
}

// The wallet in its worker, and what the page does with it.
//
// deps:
//   makeWorker()            a new Worker running btc-ark/worker.js (module type)
//   mnemonic()              the page's phrase
//   config                  arkConfig(window.SEQ_BTC_ARK)
//   decode(bolt11)          bolt11.js decodeBolt11
//   onChange()              called when the balance changes
//   log(...)
export function mountBtcArk ({ makeWorker, mnemonic, config, decode, onChange = () => {}, log = () => {}, now = () => Date.now() }) {
  let worker = null, seq = 0, opened = null, isOpen = false, figures = arkFigures(null), info = null, timer = null
  const waiting = new Map()

  function call (op, args, timeout = RUN_TIMEOUT_MS) {
    if (!worker) {
      worker = makeWorker()
      worker.onmessage = (ev) => {
        const { id, ok, value, error } = ev.data || {}
        const w = waiting.get(id); if (!w) return
        waiting.delete(id); clearTimeout(w.t)
        ok ? w.resolve(value) : w.reject(new Error((error && error.message) || 'the wallet refused'))
      }
    }
    const id = ++seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { waiting.delete(id); reject(new Error('the wallet did not answer in time')) }, timeout)
      waiting.set(id, { resolve, reject, t })
      worker.postMessage({ id, op, args })
    })
  }
  const run = (command, args = {}, timeout) => call('run', { command, args }, timeout)

  // The other wallets of the phrase, caught up from the server; the figure follows.
  function catchUp () {
    const t0 = now()
    return run('catch_up', {}, PAY_TIMEOUT_MS)
      .then((r) => {
        const got = (r && r.recovered) || [], gone = (r && r.spent_elsewhere) || []
        log('[btc ark] caught up in', now() - t0, 'ms:', got.length, 'coin(s) taken in (', (r && r.recovered_sat) || '0', 'sat),', gone.length, 'spent elsewhere')
        return refresh()
      })
      .catch((e) => log('[btc ark] catch up:', e && e.message))
  }

  // A coin left past its expiry is swept by the server's watchman. Bark's server still takes it in
  // a round when the wallet refreshes it later, but by its own choice, so the wallet has its coins
  // renewed before they expire, whether or not the page is open. When it opens and after
  // each sync it schedules, for every coin that has none yet, a renewal the server runs by
  // itself shortly before the coin's expiry (`schedule_refreshes`), and the wallet takes the
  // renewed coin in at its next sync. Then Bark's own refresh renews, in the server's next round,
  // a coin that is due and has no renewal scheduled (`refresh`), an expired one included. One
  // pass at a time; nothing is renewed when nothing is due.
  let renewing = null
  function renewDue () {
    if (!isOpen || renewing) return renewing || Promise.resolve(null)
    const t0 = now()
    renewing = run('schedule_refreshes', {}, PAY_TIMEOUT_MS)
      .then((s) => {
        const n = ((s && s.scheduled) || []).reduce((k, r) => k + ((r.vtxos && r.vtxos.length) || 0), 0)
        if (n) log('[btc ark] renewal scheduled for', n, 'coin(s), heights', s.scheduled.map((r) => r.height).join(','))
      })
      .catch((e) => log('[btc ark] scheduling renewals:', e && e.message))
      .then(() => run('refresh', {}, PAY_TIMEOUT_MS))
      .then((r) => { if (r && r.refreshed) { log('[btc ark] renewed', r.refreshed, 'coin(s) near their expiry in', now() - t0, 'ms'); return refresh().then(() => r) } return r })
      .catch((e) => { log('[btc ark] renewing coins near their expiry:', e && e.message); return null })
      .finally(() => { renewing = null })
    return renewing
  }

  async function refresh () {
    if (!isOpen) return figures
    const b = await run('balance')
    const f = arkFigures(b)
    const changed = f.total !== figures.total || f.spendable !== figures.spendable || f.arriving !== figures.arriving
    figures = f
    if (changed) { try { onChange(f) } catch {} }
    return f
  }

  function open () {
    if (opened) return opened
    if (!config) return Promise.reject(new Error('the page names no Bitcoin ark'))
    const t0 = now()
    opened = call('open', { network: config.network, mnemonic: mnemonic(), server: config.server, esplora: config.esplora }, 120_000)
      .then(async () => {
        isOpen = true
        info = await run('info')
        await refresh()
        log('[btc ark] open in', now() - t0, 'ms')
        catchUp().then(() => renewDue())
        if (!timer) {
          let lastSync = now(), lastCatchUp = now()
          timer = setInterval(() => {
            if (now() - lastCatchUp >= CATCH_UP_MS) { lastCatchUp = now(); catchUp() }
            else if (now() - lastSync >= SYNC_MS) { lastSync = now(); run('sync').then(() => refresh()).then(() => renewDue()).catch(() => {}) } else refresh().catch(() => {})
          }, REFRESH_MS)
        }
        return true
      })
      .catch((e) => { opened = null; isOpen = false; throw e })
    return opened
  }

  // Can the ark pay `sats` to `to` now? -> { route, fee, sats } or { route, short: why } or null
  // when the destination is not one the ark pays.
  async function quote (to, sats) {
    const d0 = destination(to, decode)
    if (!d0 || !isOpen) return null
    const { route, dest } = d0
    let amount = big(sats)
    if (route === 'invoice') {
      const d = decode(dest)
      if (d.amountMsat == null) return { route, short: 'This invoice names no amount.' }
      amount = (big(d.amountMsat) + 999n) / 1000n
    }
    if (amount <= 0n) return { route, short: 'Enter an amount.' }
    let fee
    if (route === 'ark') fee = big((await run('send_fee', { sats: String(amount) })).fee)
    else if (route === 'invoice') fee = big((await run('pay_fee', { sats: String(amount) })).fee)
    else fee = big((await run('offboard_fee', { address: dest, sats: String(amount) })).fee)
    await refresh().catch(() => {})
    if (figures.spendable < amount + fee) return { route, dest, sats: amount, fee, short: 'not enough here' }
    return { route, dest, sats: amount, fee }
  }

  // Pays what quote() priced. -> { route, txid? , preimage? }
  async function send (to, sats) {
    const q = await quote(to, sats)
    if (!q) throw new Error('the ark does not pay this destination')
    if (q.short) throw new Error(q.short)
    const dest = q.dest
    let r
    if (q.route === 'ark') r = await run('send', { address: dest, sats: String(q.sats) })
    else if (q.route === 'invoice') {
      r = await run('pay', { invoice: dest, max_fee_sats: String(q.fee), wait: true }, PAY_TIMEOUT_MS)
      if (r.state === 'failed') throw new Error(r.reason || 'the payment failed')
      // 'complete' once the payee took it; 'pending' while they hold it (payOutcome follows it).
      const d = decode(dest)
      r = { ...r, hash: d && d.ok ? d.paymentHash : null }
    } else r = await run('offboard', { address: dest, sats: String(q.sats) }, PAY_TIMEOUT_MS)
    refresh().catch(() => {})
    return { route: q.route, fee: q.fee, sats: q.sats, ...r }
  }

  // A payment the payee holds, followed to its end: 'complete' when they take it, 'came-back' when
  // it fails back (the wallet's coins are its own again), or 'pending' still at `untilMs`.
  async function payOutcome (hash, { untilMs = 30 * 60_000, everyMs = 3000 } = {}) {
    const t0 = now()
    for (;;) {
      let r = null
      try { r = await run('pay_status', { hash, drive: true }) } catch (e) { log('[btc ark] payment status:', e && e.message) }
      if (r && r.state === 'complete') { refresh().catch(() => {}); return { state: 'complete', preimage: r.preimage } }
      if (r && (r.state === 'none' || r.state === 'failed')) { refresh().catch(() => {}); return { state: 'came-back' } }
      if (now() - t0 >= untilMs) return { state: 'pending' }
      await new Promise((resolve) => setTimeout(resolve, everyMs))
    }
  }

  // Boards the page's confirmed on-chain BTC, signed by the page's own key. `chain`:
  //   utxos()                        the page's coins, each { value, confirmed }
  //   buildUnsigned(address, sats)   -> { psbtHex, txid, finish() -> { hex } }: one output to the
  //                                  address, the page's coins in, no change
  //   broadcast(hex)                 -> txid
  // -> the board's answer, or null when nothing is boarded.
  let boarding = null
  function board (chain) {
    if (boarding) return boarding
    boarding = (async () => {
      if (!isOpen) return null
      const utxos = (await chain.utxos()).filter((u) => u.confirmed)
      const first = boardAmount(utxos, info, 0n)
      if (!first) return null
      const ba = await run('board_address', { sats: String(first.amount) })
      const plan = boardAmount(utxos, info, big(ba.fee))
      if (!plan) return null
      const built = await chain.buildUnsigned(ba.address, plan.amount)
      // The server cosigns the board before the funding is signed and sent: the wallet then waits
      // for the funding to appear on the chain.
      const r = await run('board_psbt', { psbt: built.psbtHex, key_index: ba.key_index, expiry_height: ba.expiry_height })
      const { hex } = built.finish()
      const txid = await chain.broadcast(hex)
      log('[btc ark] boarded', String(plan.amount), 'sat in', txid)
      // The wallet counts a board once it has seen its funding: it looks now, before the page reads
      // its own coins again, so the figure does not dip between the two.
      await run('sync').catch(() => {})
      await refresh().catch(() => {})
      return { ...r, txid, amount: String(plan.amount) }
    })().finally(() => { boarding = null })
    return boarding
  }

  // A Lightning invoice paid into the ark. -> { invoice, payment_hash, expires_at }
  async function invoice (sats, description = 'Receive BTC') {
    await open()
    return run('invoice', { sats: String(sats), description })
  }
  // Whether it was paid: the wallet's daemon claims a payment as soon as the server holds it.
  async function received (hash) {
    const r = await run('receive_status', { hash, claim: true })
    if (r.state === 'paid') refresh().catch(() => {})
    return r
  }

  // The composer's deps.btc (user-trade-btc.js), on the ark: its invoices, its payments.
  function lightning () {
    if (!isOpen) return null
    const read = (inv) => {
      const d = decode(inv)
      if (!d || !d.ok) throw new Error((d && d.error) || 'the invoice does not decode')
      if (d.chain !== 'btc') throw new Error('the invoice is not a Bitcoin invoice')
      if (d.amountMsat == null) throw new Error('the invoice names no amount')
      return { sats: big(d.amountMsat) / 1000n, msat: big(d.amountMsat), payment_hash: d.paymentHash, expires_at: d.timestamp + d.expiry, min_final_cltv: d.minFinalCltv }
    }
    return {
      async balance () { return (await refresh()).spendable },
      async invoice ({ sats, description = 'trade' }) { return invoice(sats, description) },
      async decode (inv) { return read(inv) },
      async invoiceStatus (hash) {
        const r = await run('receive_status', { hash, claim: true })
        if (r.state === 'paid') return { status: 'paid', preimage: r.preimage }
        if (r.state === 'unknown') return { status: 'unknown' }
        return { status: 'unpaid' }
      },
      async cancelInvoice () {},
      async pay ({ invoice: inv, maxFeeSats = 0n, maxDelay }) {
        const r = await run('pay', { invoice: inv, max_fee_sats: String(maxFeeSats), ...(maxDelay ? { max_delay: Number(maxDelay) } : {}), wait: true }, PAY_TIMEOUT_MS)
        refresh().catch(() => {})
        if (r.state === 'complete') return { state: 'complete', preimage: r.preimage }
        if (r.state === 'failed') return { state: 'failed', reason: r.reason }
        return { state: 'pending' }
      },
      async payStatus (hash) {
        const r = await run('pay_status', { hash, drive: true })
        if (r.state === 'complete') return { state: 'complete', preimage: r.preimage }
        if (r.state === 'none') return { state: 'none' }
        return { state: 'pending' }
      },
      // The fee the ark charges and the longest lock its server's payment may take.
      async payRoute (inv) {
        const d = read(inv)
        const f = await run('pay_fee', { sats: String(d.sats) })
        return { fee: big(f.fee), delay: Number(f.max_route_delay) }
      },
      async payFee (inv) { return (await this.payRoute(inv)).fee },
    }
  }

  return {
    open, isOpen: () => isOpen, refresh, renewDue, figures: () => figures, info: () => info,
    route: (to) => routeOf(to, decode), quote, send, payOutcome, board, invoice, received, lightning, run,
    close () { if (timer) clearInterval(timer); timer = null; if (worker) worker.terminate(); worker = null; isOpen = false; opened = null },
  }
}
