// DEFAULT MODE ON THE OPERATOR'S TREE: what the wallet decides by itself, so that a person in
// default mode never takes a step, sees a choice or reads a word of how value moves.
//
// The page names one operator (window.SEQ_ARCA: its server, the node the leaf wallet follows the
// chain through, and the operator's key, pinned). In default mode a wallet that has not joined
// one joins that operator by itself, once its server shows the pinned key; a phrase restored here
// finds the coins it holds there. Coins then live in the tree by default:
//
//   - Receiving gives a receive code (the leaf library's single-use receive request), which the
//     faucet and another wallet of the same operator pay into the tree; coins that land at the
//     wallet's address on the chain are boarded by themselves, shown as arriving until the board
//     is final.
//   - Sending to a receive code of the same operator and chain pays it in the tree, in seconds;
//     anything else (an address, an invoice, an account id) goes the way it always went.
//   - Where the tree cannot do what was asked, the old way is taken; where neither can, the
//     refusal says so in plain words and nothing is signed.
//
// Nothing here computes a leaf, a fee or a verdict about a coin: those are the library's. This
// module reads its answers (balance, info) and names the route. It has no DOM, so it runs under
// Node (default-arca.test.mjs).

import { expandRequest } from './pay-code.js'

// The words default mode shows for all of this. None is in user-trade.js's
// USER_MODE_FORBIDDEN_WORDS (default-arca.test.mjs checks it). They are the kit's default-mode
// contract (docs/DEFAULT_MODE.md), the same in every Concatena wallet: change it there first.
// When a payment out of the tree arrives, from the operator's interval in minutes.
function arrivesWords (minutes) {
  if (!minutes) return 'It arrives shortly.'
  return minutes <= 5 ? 'It arrives in a few minutes.' : `It arrives in about ${minutes} minutes.`
}

// When coins moved out of the Ark are ready, from the operator's interval in minutes.
function readyWords (minutes) {
  if (!minutes) return 'They are ready shortly.'
  return minutes <= 5 ? 'They are ready in a few minutes.' : `They are ready in about ${minutes} minutes.`
}

export const DEFAULT_WORDS = Object.freeze({
  arriving: (amount, ticker) => `${amount} ${ticker} arriving`,
  // Held, spendable before, and taken back out of the chain with the Bitcoin block it rested on:
  // still the wallet's, and counted, while the network takes it in again.
  redoing: (amount, ticker) => `${amount} ${ticker} being redone after a Bitcoin reorganisation`,
  // Not refreshed while the wallet was away: taken on the chain under its own key before it could
  // be swept, and put back by itself once the wallet is open again. Part of the figure meanwhile.
  keptSafe: (amount, ticker) => `${amount} ${ticker} moved out of the Ark to keep it safe while you were away`,
  // Held where it cannot be sent in seconds (a wallet's own Lightning channel, in a wallet made
  // before), on its way to where it can (lightning-to-ark.js). Part of the figure meanwhile.
  moving: (amount, ticker) => `Moving ${amount} ${ticker} so it can be sent in seconds.`,
  codeLabel: 'Receive code',
  receiveTip: 'Any asset, any amount. A payment from another Sequentia wallet arrives in seconds. Each code is paid once; a new one shows when it is.',
  receiveWait: 'Making your receive code\u2026',
  copyCode: 'Copy receive code',
  showAddress: 'Show address',
  showCode: 'Show receive code',
  newCode: 'New code',
  addressTip: 'Your address, the same tb1 address on both chains. For BTC, and for senders that ask for an address.',
  // Receive's Confidential switch: the code is then the wallet's confidential address alone. A
  // payment that arrives in seconds is never confidential (the operator publishes every leaf of
  // a round, its asset and value), so the code carries none of those ways; BTC never is either.
  confidential: 'Confidential',
  receiveTipConf: 'Any Sequentia asset, any amount, paid to your confidential address.',
  // What a payment to a confidential address is moved out of the Ark for (movingOut).
  confidentialPurpose: 'sent confidentially',
  confidentialTip: 'Hides the asset and amount of a payment from everyone but you and the payer.',
  confidentialNote: 'Everyone can still see that a payment was made. A payment that arrives in seconds is never confidential, so this one arrives after the next block, in about a minute. BTC is never confidential: to receive BTC, turn this off.',
  sendTitle: (amount, ticker) => `Send ${amount} ${ticker}?`,
  sendLine: 'It arrives in seconds.',
  // The fee line of a payment in the Ark: none, said so rather than left out.
  feeLabel: 'Fee',
  noFee: 'No fees',
  // Max for an asset held in the Ark, to a destination it pays with a fee: type the amount.
  maxArkElsewhere: 'Max sizes a payment to a receive code. For this recipient, type the amount.',
  // A receive code paid at its address, because nothing the wallet holds pays it in seconds.
  byAddress: (arrives) => `This can't arrive in seconds from what you hold now, so it goes to the address. ${arrives}`,
  arrivesNextBlock: 'It arrives after the next block, in about a minute.',
  // A receive code of a wallet elsewhere whose invoice is not used (asset-lightning.js): above the
  // page's limit, or when the way to that wallet cannot carry the payment now.
  byAddressAbove: (limit) => `A payment of more than ${limit} USD to this wallet goes to the address.`,
  byAddressLarge: (usd) => `A payment of ${usd} USD or more goes to the address.`,
  byAddressNoWay: 'This can’t arrive in seconds right now, so it goes to the address.',
  // Receive's invoice card, for an amount that goes to the address (ark-limits.js) or that the
  // operator does not take in one payment (its published limit, asset-lightning.js lnMaxPayment):
  // no invoice, and the receive code, which carries the address, instead.
  giveCode: 'Give the receive code instead: it is paid there.',
  invoiceNoWay: 'This can’t arrive in seconds right now. Give the receive code instead: it is paid at the address.',
  // A payment to a wallet elsewhere, in seconds: held until that wallet takes it; refused or come
  // back, it is offered to the address.
  lnOnItsWay: 'On its way: it arrives once the other wallet takes it.',
  lnNotThrough: 'This couldn’t go through in seconds, and nothing was sent. Send it to the address instead? It arrives after the next block, in about a minute.',
  lnCameBack: 'This couldn’t go through in seconds and came back to you. Send it to the address instead? It arrives after the next block, in about a minute.',
  toAddress: 'Send to the address',
  // Receive: the optional amount when it is asked in an asset rather than BTC.
  amountHint: 'Amount (optional)',
  send: 'Send',
  sending: 'Sending\u2026',
  sent: (amount, ticker, seconds) => `Sent ${amount} ${ticker} (${seconds} s).`,
  stillArriving: (ticker) => `Part of this ${ticker} is still arriving: try again in a moment.`,
  codeBtc: 'A receive code takes Sequentia assets. For BTC, use an address or an invoice.',
  codeMixed: 'A receive code is paid on its own: send it without other recipients.',
  addressShort: 'This amount can\u2019t be sent to an address right now. Send it to a receive code, or pay an invoice.',
  arrivesWithin: (minutes) => arrivesWords(minutes),
  fee: (amount, ticker) => `Fee ${amount} ${ticker}`,
  sentLater: (amount, ticker, minutes) => `Sent ${amount} ${ticker}. ${arrivesWords(minutes)}`,
  faucetReceived: (what) => `Received ${what}.`,
  // The faucet has paid and the wallet has not taken the coin in yet (it was busy with an update).
  faucetOnItsWay: (what) => `The faucet sent ${what}. It shows in your balance as soon as your wallet has taken it in, usually within a few minutes.`,
  // A stake, a pool's delegation and a mix are made from coins the wallet holds on the chain: what
  // they need is moved out of the Ark first, by the wallet itself.
  movingOut: (what, purpose, minutes) => `Moving ${what} out of the Ark so it can be ${purpose}. ${readyWords(minutes)} Keep this page open.`,
  movingWaits: (what, purpose) => `${what} cannot be moved out of the Ark yet: the network moves it as soon as it can, and it stays yours meanwhile. It is ${purpose} then, while this page is open; or come back later and press the button again.`,
  cannotMoveNow: (what) => `${what} cannot be moved out of the Ark right now: the network has too little of it free. Nothing has moved: try again later.`,
  notEnough: (amount, ticker) => `Not enough ${ticker}: ${amount} ${ticker} short.`,
  stillOpening: 'Your wallet is still opening: try again in a moment.',
  waitOpening: 'Your wallet is still opening; this goes on by itself once it has.',
  notMoved: 'This could not be moved out of the Ark just now. Nothing was spent: try again in a moment.',
  notReady: 'What was moved out of the Ark has not arrived yet. It stays yours: try again in a few minutes.',
  stakeFeeOther: (ticker) => `Not enough tSEQ for the stake and its fee: the fee is paid in ${ticker} instead, chosen below. Press Review stake again.`,
  stakeFeeShort: 'Not enough tSEQ for the stake and its fee: stake a little less, or hold an asset that can pay the fee.',
  // What the wallet holds that nothing can move before a date (a vesting allocation): part of the
  // figure, one line under it for each date, never counted as what can be spent.
  vests: (amount, ticker, date) => `${amount} ${ticker} vests on ${date}`,
  vestsOn: (date) => `Vests on ${date}`,
  // Any action asked for more than can be spent now, the rest of it held until a date.
  notVested: (amount, ticker, date) => `${amount} ${ticker} of this vests on ${date}, and can be used from then. Nothing has moved.`,
  // The same, refused by the network, which names only the date.
  vestingRefused: (date) => `Part of this vests on ${date}, and can be used from then. Nothing has moved.`,
  vestingRefusedUndated: 'Part of this has not vested yet, and can be used once it has. Nothing has moved.',
  // The service that holds the wallet's coins for instant payments does not answer: the coins are
  // still the wallet's, and go home to its own address from what the wallet holds and the chain
  // alone (leaves.js homeOffer, homeQuote, takeHome).
  homeLine: 'The service that holds your coins for instant payments is not answering. Your coins are still yours: wait for it to come back, or take them home to your own address now.',
  homeButton: 'Take my coins home',
  homeQuoting: 'Working out what it costs\u2026',
  homeTitle: 'Take your coins home?',
  homeAsset: (amount, ticker, fees) => `${amount} ${ticker}` + (fees ? `, network fees about ${fees}` : ''),
  homeWhen: (hours) => hours > 0
    ? `They reach your own address in about ${hours} hours, and cannot be sent until then. Open this wallet again after that to finish.`
    : 'They reach your own address shortly, and cannot be sent until then.',
  homeConfirm: 'Take them home',
  homeWorking: 'Taking your coins home\u2026',
  homeNotNow: (amount, ticker) => `${amount} ${ticker} cannot be taken home right now. Nothing of it was sent: try again later.`,
  homeNothing: 'None of your coins can be taken home right now. Nothing was sent: try again later.',
  homeOnWay: (amount, ticker, hours) => hours > 0
    ? `${amount} ${ticker} on its way to your own address: it arrives in about ${hours} hours, once this wallet is open.`
    : `${amount} ${ticker} on its way to your own address.`,
})

// The hours a wait of `seconds` reads as, rounded up; 0 for none.
export function homeHours (seconds) {
  const n = Number(seconds)
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 3600) : 0
}

// What taking every coin home would move and cost, by asset, from the library's quotes (leaves.js
// homeQuote): each coin's value, and the fees the wallet pays (the claim's, and those of the steps
// a coin of the wallet's pays; steps paid from their own reserve cost the holder nothing), each in
// its own asset; the longest exit delay; a channel's value with no fee known before it goes; and
// what the library refused. Atoms throughout. Nothing here prices anything: the fees are the
// quotes'.
// -> { assets: [{ asset, atoms, fees: [{ asset, atoms }] }], refused: [{ asset, atoms }], delaySeconds, count }
export function homeSummary (q) {
  const by = new Map()
  const row = (a) => { if (!by.has(a)) by.set(a, { asset: a, atoms: 0n, fees: new Map() }); return by.get(a) }
  let delay = 0
  let count = 0
  for (const { coin, quote } of (q && q.quotes) || []) {
    const r = row(coin.asset); r.atoms += big(coin.value); count++
    const fee = (f) => { for (const x of f || []) r.fees.set(x.asset, (r.fees.get(x.asset) || 0n) + big(x.amount)) }
    for (const st of (quote && quote.steps) || []) if (st.paid_by !== 'its own reserve') fee(st.fee)
    if (quote && quote.claim && !quote.claim.error) fee(quote.claim.fee)
    delay = Math.max(delay, Number((quote && quote.exit_delay_seconds) || 0))
  }
  for (const coin of (q && q.channels) || []) { row(coin.asset).atoms += big(coin.value); count++ }
  const refused = new Map()
  for (const { coin } of (q && q.refused) || []) refused.set(coin.asset, (refused.get(coin.asset) || 0n) + big(coin.value))
  return {
    assets: [...by.values()].map((r) => ({ asset: r.asset, atoms: r.atoms, fees: [...r.fees].map(([asset, atoms]) => ({ asset, atoms })) })),
    refused: [...refused].map(([asset, atoms]) => ({ asset, atoms })),
    delaySeconds: delay,
    count,
  }
}

// The coins on their way home (leaves.js homeUnderWay), by asset, with the hours left before the
// last of each arrives, at `nowMs`. -> [{ asset, atoms, hours }]
export function homeOnWay (list, nowMs) {
  const by = new Map()
  for (const h of list || []) {
    const r = by.get(h.asset) || { asset: h.asset, atoms: 0n, hours: 0 }
    r.atoms += big(h.value)
    if (h.delay && h.at) r.hours = Math.max(r.hours, homeHours((h.at + h.delay * 1000 - nowMs) / 1000))
    by.set(h.asset, r)
  }
  return [...by.values()]
}

// ---- every coin home, with the operator gone ----
// The coin states the library still holds for the wallet (leaves.js HELD), and of them those a
// holder can send home: all but one already on its way out (`exiting`). Whether each can go is the
// library's (`exit_quote` says it, or refuses); a channel leaf goes by its own steps (`channel_exit`).
const HOME_FROM = Object.freeze(['pending', 'live', 'offered', 'sending', 'given', 'forfeited'])
export function homeCoins (coins) { return (Array.isArray(coins) ? coins : []).filter((c) => c && HOME_FROM.includes(c.state)) }

// Whether the operator cannot be reached, as the library last said: a sync's `unreachable`
// (present only then), else an `info` (`server_info.unreachable`). -> { why, note } when it cannot
// be, null when it answered, undefined when this answer says nothing either way.
export function unreachableOf (answer, kind) {
  if (!answer || typeof answer !== 'object') return undefined
  if (kind === 'sync') return answer.unreachable ? { why: String(answer.unreachable.why || ''), note: answer.unreachable.note || null } : null
  const si = answer.server_info
  if (!si || typeof si !== 'object') return undefined
  return si.unreachable ? { why: String(si.unreachable), note: null } : null
}

// Whether the fees `now` ({ asset: atoms }) are, in every asset, no more than `shown`.
export function noMoreThan (now, shown) {
  return Object.entries(now || {}).every(([a, v]) => big(v) <= big((shown || {})[a] ?? 0))
}

// Each coin's way home, quoted by the library (`run(command, args)` answers its result): every coin
// homeCoins names, a channel leaf (`channelIds`) set apart. Asks nothing of the operator.
// -> { quotes: [{ coin, quote }], channels: [coin], refused: [{ coin, error }] }
export async function homeQuote (run, coins, channelIds = []) {
  const out = { quotes: [], channels: [], refused: [] }
  const ch = new Set(channelIds || [])
  for (const c of homeCoins(coins)) {
    const coin = { leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? '') }
    if (ch.has(c.leaf_id)) { out.channels.push(coin); continue }
    try { out.quotes.push({ coin, quote: await run('exit_quote', { leaf_id: c.leaf_id }) }) } catch (e) { out.refused.push({ coin, error: e }) }
  }
  return out
}

// What homeQuote quoted, sent home: each coin's exit broadcast only on the fees its quote showed
// (`shown`), a channel's by `channel_exit`. Coins of one tree share the first steps of their way
// out: once one coin's exit has put them on the chain, the next coin's are fewer and its fees
// lower than quoted, and the library refuses the fees shown; that coin is quoted again and goes
// only for no more than the person was shown for it, in every asset.
// -> { started: [{ coin, value }], refused: [{ coin, error }], kept: { leaf_id: { asset, value, at, delay } } }
export async function homeTake (run, q, { now = () => Date.now(), log = () => {} } = {}) {
  const out = { started: [], refused: [], kept: {} }
  const exitOn = (coin, quote) => {
    const args = { leaf_id: coin.leaf_id, shown: quote.unroll || {} }
    if (quote.fee_asset) args.fee_asset = quote.fee_asset
    return run('exit', args)
  }
  const go = async (coin, f, delay) => {
    try {
      const v = await f()
      out.started.push({ coin, value: v })
      out.kept[coin.leaf_id] = { asset: coin.asset, value: coin.value, at: now(), delay: delay || null }
      const txids = ((v && v.broadcast) || []).map((x) => x.txid)
      log(`[leaves] home: ${coin.leaf_id} ${(v && v.state) || ''} ${txids.join(' ')}`)
    } catch (e) { out.refused.push({ coin, error: e }); log(`[leaves] home: ${coin.leaf_id} refused: ${e && e.message}`) }
  }
  for (const { coin, quote } of (q && q.quotes) || []) {
    await go(coin, async () => {
      try { return await exitOn(coin, quote) } catch (e) {
        if (!/fees changed since they were shown/.test(String((e && e.message) || ''))) throw e
        const again = await run('exit_quote', { leaf_id: coin.leaf_id })
        if (!noMoreThan(again && again.unroll, quote.unroll)) throw e
        return await exitOn(coin, again)
      }
    }, quote.exit_delay_seconds)
  }
  for (const coin of (q && q.channels) || []) await go(coin, () => run('channel_exit', { leaf_id: coin.leaf_id }), null)
  return out
}

// The coins on their way home, as the library holds them (exiting, and not a coin a watchtower
// took out while the wallet was away, which default mode does not speak of), each with when it
// was sent and its delay where the wallet sent it (`kept`, homeTake's). Those a person sent, and
// while the operator cannot be reached (`unreachable`) every one; a coin the wallet takes home by
// itself on its date while the operator answers is not said (docs/DEFAULT_MODE.md).
// -> { list: [{ leaf_id, asset, value, at, delay }], kept: what of `kept` is still on its way }
export function homeUnderWay (coins, kept, unreachable) {
  const k = kept || {}
  const list = []
  const all = Array.isArray(coins) ? coins : []
  for (const c of all) {
    if (!c || c.state !== 'exiting' || c.kept_safe) continue
    if (!k[c.leaf_id] && !unreachable) continue
    const h = k[c.leaf_id] || {}
    list.push({ leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? ''), at: h.at || null, delay: h.delay || null })
  }
  const on = new Set(list.map((h) => h.leaf_id))
  const left = all.length ? Object.fromEntries(Object.entries(k).filter(([l]) => on.has(l) || !all.some((c) => c && c.leaf_id === l))) : k
  return { list, kept: left }
}

// The minutes a payment to an address from the tree takes at most, from the operator's interval
// between settlements (the library's `round_within_seconds`), or null when it publishes none.
export function arrivalMinutes (seconds) {
  const n = Number(seconds)
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.ceil(n / 60)) : null
}

// When Receive asks again for a receive code the operator did not give (#521), after `failures`
// in a row: at once twice, then 5, 10, 20 and 40 s, then every minute for as long as the page is
// open. It keeps saying it is getting the code through the first two, and only then shows the
// address meanwhile (`address`), so a payer is never left without a way to pay; the code comes
// back the moment the operator answers. -> { waitMs, address }
export function receiveCodeRetry (failures) {
  const n = failures > 0 ? failures : 0
  if (n <= 2) return { waitMs: n === 0 ? 0 : 2000, address: false }
  return { waitMs: Math.min(5000 * 2 ** (n - 3), 60_000), address: true }
}

// How a payment of `amount` atoms of an asset to an address is made: on the chain when the
// wallet's coins there cover it (as it always was), else out of the tree when the tree's
// spendable coins cover it, else not at all.
export function addressRoute (amount, onchain, treeSpendable) {
  const a = big(amount)
  if (a <= big(onchain)) return 'chain'
  if (a <= big(treeSpendable)) return 'tree'
  return null
}

// The coin states a balance counts as arriving: held, not yet spendable (a board not yet final,
// a transfer recorded and not yet completed; `given`, a coin given up in the next round for a new
// one, such as a coin received out of round that the wallet refreshes by itself; `returning`, a
// coin the operator took at its expiry while the wallet was away, which it owes back and repays
// as a new coin).
export const ARRIVING_STATES = Object.freeze(['pending', 'given', 'returning'])

// How often a wallet that could not join the page's operator tries again, while the page is open.
export const JOIN_RETRY_MS = 120_000

// After an on-chain send or trade of the page's own wallet, how long the wallet boards nothing:
// the page and the leaf wallet spend the same coins (one phrase, one set of keys), and a board
// racing a payment would spend a coin the payment needs.
export const BOARD_QUIET_MS = 60_000

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// The page's operator, as configured, or null when the page names none (or names it wrongly).
export function pinnedOperator (cfg) {
  if (!cfg || typeof cfg !== 'object') return null
  const { server, node_url: nodeUrl, operator } = cfg
  if (typeof server !== 'string' || !/^https?:\/\//.test(server)) return null
  if (typeof nodeUrl !== 'string' || !/^https?:\/\//.test(nodeUrl)) return null
  if (typeof operator !== 'string' || !/^[0-9a-f]{64}$/.test(operator)) return null
  return { server: server.replace(/\/+$/, ''), node_url: nodeUrl, operator }
}

// The watchtowers the page names beside those its operator names (`watchtowers` in its
// operator's configuration): those other operators run for this operator's users, so a coin
// does not rest on its own operator alone to name who watches for it. Only https URLs (or
// http on this machine), at most eight; the library deposits with one only when its info says
// it watches for the wallet's own operator, and passes over the rest.
export function defaultWatchtowers (cfg) {
  const list = (cfg && Array.isArray(cfg.watchtowers)) ? cfg.watchtowers : []
  return list.filter((u) => typeof u === 'string' && (/^https:\/\/[^\s]+$/.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[^\s]*)?$/.test(u)))
    .map((u) => u.replace(/\/+$/, '')).slice(0, 8)
}

// The operator's server must show the key the page pinned before the wallet joins it, and the
// wallet's own answer must name it after: a server that shows another key is refused.
export function checkPinned (operatorKey, pinned, what = 'the server') {
  if (!pinned) throw new Error('no operator is pinned')
  if (operatorKey !== pinned.operator) {
    throw new Error(`${what} shows operator key ${String(operatorKey || 'none')}, not the pinned ${pinned.operator}: not joined`)
  }
}

// A receive request of the leaf library: `<word>:<hex of its JSON>`, the JSON's kind 'request'
// (or, from an older wallet, an `arca_request` key). -> its JSON, or null for anything else.
export function parseReceiveCode (text) {
  const s = String(text || '').trim()
  const i = s.indexOf(':')
  if (i <= 0) return null
  const prefix = s.slice(0, i), hex = s.slice(i + 1)
  if (!/^[A-Za-z0-9-]+$/.test(prefix) || !hex.length || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  let v
  try {
    const bytes = new Uint8Array(hex.length / 2)
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.slice(2 * k, 2 * k + 2), 16)
    v = JSON.parse(new TextDecoder().decode(bytes))
  } catch { return null }
  if (!v || typeof v !== 'object') return null
  if (v.kind !== 'request' && v.arca_request === undefined) return null
  return v
}

// Whether a payment to `text` goes in the tree: it is a receive request (short, as a receive code
// carries it, or in the library's spelling) naming the operator and the chain this wallet's leaf
// wallet holds its coins with (`info`, the library's answer).
export function treeRoute (text, info) {
  const r = parseReceiveCode(expandRequest(text, info) || text)
  if (!r || !info) return null
  if (!info.operator || !info.genesis_hash) return null
  if (r.operator !== info.operator || r.genesis_hash !== info.genesis_hash) return null
  return r
}

// What of an asset is arriving: the leaf states counted as such in the library's balance.
export function arrivingAtoms (balance, asset) {
  const states = (balance && balance.arca && balance.arca[asset]) || {}
  let n = 0n
  for (const s of ARRIVING_STATES) n += big(states[s])
  return n
}

// What of an asset was moved out to keep it safe while the wallet was away (the library's balance
// `kept_safe`, part of what it counts as `exiting`), in atoms, until the wallet has put it back.
export function keptSafeAtoms (balance, asset) {
  const states = (balance && balance.arca && balance.arca[asset]) || {}
  return big(states.kept_safe)
}

// What of an asset is being redone: coins the library marks `redoing` (spendable once, then taken
// out of the chain with the Bitcoin block their round's block anchors to), in atoms. Part of what
// is arriving, and shown apart from it.
export function redoingAtoms (coins, asset) {
  let n = 0n
  for (const c of coins || []) if (c && c.asset === asset && c.redoing === true) n += big(c.value)
  return n
}

// The Bitcoin blocks the operator waits for after a block is certified before a coin in it is
// spendable (the library's `info` `anchor_depth`), or null when the library does not say.
export function anchorDepth (info) {
  const d = info && info.anchor_depth
  return d === null || d === undefined || !Number.isFinite(Number(d)) ? null : Number(d)
}

// The assets whose on-chain coins are boarded by themselves: each asset the operator serves (its
// `info`), held on the chain at the phrase's keys (the library's own reading) at least at the
// operator's smallest leaf. -> [{ asset, onchain: BigInt, min: BigInt }]
export function boardCandidates (balance, info) {
  const served = new Map(((info && info.server_info && Array.isArray(info.server_info.assets)) ? info.server_info.assets : [])
    .filter((a) => a && typeof a.asset === 'string').map((a) => [a.asset, big(a.min_leaf)]))
  const out = []
  for (const [asset, v] of Object.entries((balance && balance.sequentia_onchain) || {})) {
    if (!served.has(asset)) continue
    const frozen = big(((balance && balance.sequentia_onchain_frozen) || {})[asset])
    const onchain = big(v) - frozen
    const min = served.get(asset)
    if (onchain > 0n && onchain >= min) out.push({ asset, onchain, min })
  }
  return out
}

// The amount a board of `onchain` atoms carries when its fee is `fee` atoms of the same asset:
// what is left after the fee, or null when that is below the smallest leaf.
export function boardValue (onchain, fee, min) {
  const v = big(onchain) - big(fee)
  return v >= big(min) && v > 0n ? v : null
}

// The board itself: learn the fee, then board what is left after it, the fee the library quoted
// for exactly that board passed as `shown` so nothing is signed on a fee no quote named. `run` is
// the library's command runner. A board of the boarded asset's own fee needs more coins as the
// amount grows, so the quote is asked again (at most `tries` times) until the fee it names leaves
// room for itself. -> the library's answer, or null when nothing could be boarded.
export async function boardAll (run, c, tries = 3) {
  const fee0 = await run('board_quote', { asset: c.asset, amount: String(c.min) })
  let fee = big(fee0 && fee0.fee && fee0.fee.amount)
  if (fee0 && fee0.fee && fee0.fee.asset !== c.asset) return null
  for (let i = 0; i < tries; i++) {
    const v = boardValue(c.onchain, fee, c.min)
    if (v == null) return null
    let q
    try { q = await run('board_quote', { asset: c.asset, amount: String(v) }) } catch { fee = fee * 2n + 1n; continue }
    const f = big(q && q.fee && q.fee.amount)
    if (v + f <= c.onchain) {
      const r = await run('board', { asset: c.asset, amount: String(v), shown: q.fee })
      // What the board took off the chain (its amount and its fee), for onchainLessBoards.
      return r && typeof r === 'object' ? { ...r, spent: String(v + f) } : r
    }
    fee = f
  }
  return null
}

// What a board just made takes off the chain: `onchain` atoms as the page's own reading of the
// chain shows them, less what the board spent (`board`: { spent, below, at }, from boardSpent)
// while that reading does not show it spent yet. The board's leaf counts as arriving in the tree
// from the moment it is made, so without this the coins count twice until the reading catches
// up (a block, or the page's next scan). The board is taken as seen once the reading drops to
// what it left (`below`), or after half an hour. -> { atoms, seen }
export const BOARD_SEEN_MS = 30 * 60_000
export function onchainLessBoards (board, onchain, nowMs) {
  const o = big(onchain)
  if (!board) return { atoms: o, seen: true }
  if (o <= big(board.below) || nowMs - Number(board.at) > BOARD_SEEN_MS) return { atoms: o, seen: true }
  const v = o - big(board.spent)
  return { atoms: v > 0n ? v : 0n, seen: false }
}
// The record onchainLessBoards keeps for a board of `held` atoms on the chain (the library's
// reading when it boarded) that spent `spent`, made at `at`.
export function boardSpent (held, spent, at) {
  return { spent: String(big(spent)), below: String(big(held) - big(spent)), at }
}

// The assets a wallet lists to pay or send from: BTC always (the parent chain, first-class,
// shown at 0 in a fresh wallet), then each Sequentia asset only while the wallet holds some of it
// (on the chain, in the tree or on Lightning), in the order given. No asset is listed for being
// the network's own: a fresh wallet lists BTC alone. `balances`: { assetHex: atoms } (any
// numeric form); `others`: [[assetHex, atoms]] from the other places it is held.
export function heldAssetList (balances, others = []) {
  const out = ['BTC']
  const add = (h, v) => { if (h && h !== 'BTC' && big(v) > 0n && !out.includes(h)) out.push(h) }
  for (const [h, v] of Object.entries(balances || {})) add(h, v)
  for (const [h, v] of others || []) add(h, v)
  return out
}


// ---- what the wallet holds that cannot move before a date (a vesting allocation) ----
//
// A vesting distribution pays a key of the wallet a coin nobody can move before its vest date.
// The leaf library's `claims` lists it (state `vesting`, `vest` a median time, `vests` the date in
// words); from that date its `care` takes it up by itself and it is an ordinary coin. Until then
// the wallet shows it under the asset's figure, counts it in the figure and the headline, and
// never as what can be spent. `care` and `claim` list a vesting claim without its asset or value:
// only `claims` is read for this.

// How often the wallet reads its claims at most (and once after each care).
export const CLAIMS_EVERY_MS = 120_000

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// The UTC date of a unix time in words, as the library writes it: "3 November 2026".
export function dateWords (t) {
  const d = new Date(Number(t) * 1000)
  if (!Number.isFinite(d.getTime())) return ''
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

// A `claims` answer -> what vests, one entry for each asset and date (claims vesting on the same
// day are one line), earliest first: [{ asset, vest, vests, atoms }] (`vest` the earliest median
// time of the entry, `atoms` a decimal string, so the list crosses a message boundary as it is).
// A claim whose date has passed and that the wallet has not taken up yet (state `open`, with a
// vest time) stays in the figure as arriving, `arriving: true`, one entry per asset, until care
// takes it up a moment later: the figure never dips between the date and the take-up.
export function vestingLots (claims) {
  const by = new Map()
  for (const c of Array.isArray(claims) ? claims : []) {
    if (!c || c.held || typeof c.asset !== 'string') continue
    const vest = Number(c.vest)
    const atoms = big(c.value)
    if (c.vest == null || !Number.isFinite(vest) || vest <= 0 || atoms <= 0n) continue
    const arriving = c.state === 'open'
    if (c.state !== 'vesting' && !arriving) continue
    const vests = (typeof c.vests === 'string' && c.vests) || dateWords(vest)
    const k = c.asset + '|' + (arriving ? '' : vests)
    const e = by.get(k)
    if (e) { e.atoms += atoms; if (vest < e.vest) { e.vest = vest; if (arriving) e.vests = vests } } else by.set(k, { asset: c.asset, vest, vests, atoms, ...(arriving ? { arriving: true } : {}) })
  }
  return [...by.values()].sort((a, b) => a.vest - b.vest || (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0))
    .map((e) => ({ ...e, atoms: e.atoms.toString() }))
}

// What of an asset has vested and is arriving (taken up by the wallet a moment later), in atoms.
export function vestedArriving (lots, asset) {
  return vestingFor(lots, asset).filter((l) => l.arriving).reduce((n, l) => n + big(l.atoms), 0n)
}

// The entries of one asset still to vest (one line under the figure for each), earliest first.
export function vestingLines (lots, asset) {
  return vestingFor(lots, asset).filter((l) => !l.arriving)
}

// The entries of one asset, earliest first.
export function vestingFor (lots, asset) {
  return (Array.isArray(lots) ? lots : []).filter((l) => l && l.asset === asset)
}

// What of an asset vests later, in atoms.
export function vestingAtoms (lots, asset) {
  return vestingFor(lots, asset).reduce((n, l) => n + big(l.atoms), 0n)
}

// The assets anything vests in.
export function vestingAssets (lots) {
  return [...new Set((Array.isArray(lots) ? lots : []).filter((l) => l && big(l.atoms) > 0n).map((l) => l.asset))]
}

// Whether `asked` atoms of an asset need what has not vested: more than `spendable`, and no more
// than what vests on top of it. -> null, or { atoms: the part of what is asked that is not
// spendable now, vest, vests: the earliest date from which all of it can be used }, or, when what
// has vested and is arriving covers it, { atoms, arriving: true } (it can be used in a moment).
// Asked for more than even all of it covers, it is plainly not enough: null, for the action's own
// refusal.
export function vestingShort (lots, asset, asked, spendable) {
  const a = big(asked), s = big(spendable) > 0n ? big(spendable) : 0n
  if (a <= s) return null
  const need = a - s
  let got = vestedArriving(lots, asset)
  if (got > 0n && got >= need) return { atoms: need, arriving: true }
  for (const l of vestingLines(lots, asset)) {
    got += big(l.atoms)
    if (got >= need) return { atoms: need, vest: l.vest, vests: l.vests }
  }
  return null
}

// A refusal of the network's for a coin that has not vested (the operator's code `vesting`, its
// message naming the median time) in plain words, or null for any other.
export function vestingRefusal (e) {
  if (!e || e.code !== 'vesting') return null
  const m = /median time (\d+)/.exec(String(e.message || ''))
  const date = m ? dateWords(Number(m[1])) : ''
  return date ? DEFAULT_WORDS.vestingRefused(date) : DEFAULT_WORDS.vestingRefusedUndated
}

// Whether a reading of `claims` shows a claim whose vest date has passed that the wallet has not
// taken up yet: care is then run at once rather than at its pace, so it becomes a coin by itself.
export function vestedOpen (claims) {
  return (Array.isArray(claims) ? claims : []).some((c) => c && c.state === 'open' && !c.held && c.vest != null)
}
