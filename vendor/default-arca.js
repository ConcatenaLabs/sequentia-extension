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
  return `It arrives within ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

const KEEP_OPEN = 'Keep this page open meanwhile.'

// When coins moved out of the Ark are ready, in minutes. Default mode names no rail: the words say
// the money is made ready for its use, never where it moves from.
function readyWords (minutes) {
  if (!minutes) return 'Ready shortly.'
  return `Ready within ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

export const DEFAULT_WORDS = Object.freeze({
  arriving: (amount, ticker) => `${amount} ${ticker} arriving`,
  // Default mode, under an asset's figure: a payment received and still arriving, with how long.
  arrivingIn: (amount, ticker) => `${amount} ${ticker} arriving, in about a minute`,
  // The figure of an asset held only in a payment still arriving: never a bare 0.
  arrivingFigure: 'Arriving',
  // Activity's row for a payment that is not in the balance yet, and when it will be, in words.
  rowArriving: 'Arriving',
  rowComingBack: 'Coming back',
  arrivingSoon: 'about a minute',
  boardWhen: (n) => `usually within ${n} minutes`,
  comingBackWhen: 'within about two days',
  comingBackWithin: (hours) => `within about ${hours} hour${hours === 1 ? '' : 's'}`,
  takingLonger: 'taking longer than usual; the wallet keeps at it',
  // A payment that waits for the wallet's own money being moved (its refresh, in a round now),
  // `when` as causeWhen says it for a round ("about a minute", or "usually within N minutes").
  waitRound: (when) => `Your money is being moved: this goes ahead by itself (${when}).`,
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
  // While a wallet opened in this browser for the first time finds what it holds.
  finding: 'Syncing… finding everything this wallet holds.',
  // The same, once it has run a few minutes (a wallet with a long history), and once it has run
  // far longer than any history should take.
  findingSlow: 'Syncing… this wallet has a long history, so finding everything it holds takes a few minutes. Nothing has moved, and it opens by itself once it has.',
  findingLong: 'Syncing… finding everything this wallet holds is taking far longer than it should. Nothing has moved, and your coins are still yours. Reload the page to start again.',
  // A payment asked then.
  findingLongPay: 'Your wallet is taking far longer than it should to find everything it holds, so nothing has moved. Reload the page to start again; your coins are still yours.',
  findingTip: 'Your address, the same tb1 address on both chains. Your receive code shows here once the wallet has found everything it holds.',
  // The same, while the service that holds the wallet's coins for instant payments does not answer:
  // the wallet asks again by itself every half minute.
  findingStalled: 'Syncing… the service that holds your coins for instant payments is not answering, so this wallet has not found them yet. They are still yours, and show here once it answers.',
  // A payment asked then, that what the wallet holds elsewhere does not cover.
  findingStalledPay: 'The service that holds your coins for instant payments is not answering, so this wallet has not found them yet. Nothing has moved. They are still yours: they show in your balance once it answers, and can be sent from then.',
  // Receive's Confidential switch: the code is then the wallet's confidential address alone. A
  // payment that arrives in seconds is never confidential (the operator publishes every leaf of
  // a round, its asset and value), so the code carries none of those ways; BTC never is either.
  confidential: 'Confidential',
  receiveTipConf: 'Any Sequentia asset, any amount, paid to your confidential address.',
  // What a payment to a confidential address is moved out of the Ark for (movingOut).
  confidentialPurpose: 'sent confidentially',
  // The review of a payment to a confidential address, while the wallet pays it from coins in the
  // clear with its change in the clear: the payment's output is blinded, but its amount and asset
  // follow from the inputs, the change and the fee (sequentia-web-wallet#585).
  confidentialSeen: 'This payment\u2019s amount and asset can still be worked out by anyone reading the chain.',
  // The review of a payment to a confidential address made so that its amount is hidden
  // (confidential-pay.js): the asset too when a confidential coin of another asset hides it.
  confidentialHidden: 'Anyone reading the chain can see that a payment was made, but not its asset or amount.',
  confidentialAmountHidden: (ticker) => `Anyone reading the chain can see that this payment is ${ticker}, but not how much.`,
  confidentialTip: 'Asks the payer to hide the amount, and the asset where it can, from everyone but you and them.',
  confidentialNote: 'Everyone can still see that a payment was made. A payment that arrives in seconds is never confidential, so this one arrives after the next block, in about a minute. BTC is never confidential: to receive BTC, turn this off.',
  sendTitle: (amount, ticker) => `Send ${amount} ${ticker}?`,
  sendLine: 'It arrives in seconds.',
  // The fee line of a payment in the Ark: none, said so rather than left out.
  feeLabel: 'Fee',
  noFee: 'No fees',
  // A payment in the tree leaves a little of what it moves for the fees of the transactions it
  // keeps ready (the library's `send_quote`): the review shows it, never "No fees" when it is not.
  // Its value beside it, when the asset has a price, so "a little" is never left to guess.
  feeKept: (amount, ticker, value) => `${amount} ${ticker}` + (value ? ` (${value})` : ''),
  feeKeptSome: 'A small part of what you send, shown once it is sent',
  // A payment whose money is moved in first: its fees (the move's and the payment's) are known only
  // once the money is in, so the review shows the most they can be, which the payment then keeps to.
  feeAtMost: (amount, ticker, value) => `At most ${amount} ${ticker}` + (value ? ` (${value})` : ''),
  // What leaves the wallet: the amount and the fee on top of it.
  totalLabel: 'Total',
  // Part of what is sent is on the wallet's side of an Arca channel with the operator (instant
  // payments), which a transfer can't spend: it is closed into the next round, whose block the
  // payment waits for (about a minute on Sequentia, about 10 on Bitcoin). `instant` is the most
  // that goes without the wait, '' when none.
  aMinute: 'about a minute',
  tenMinutes: 'about 10 minutes',
  waitBlock: (time, instant, ticker) => `This payment takes ${time} because it is larger than what you can send instantly, so it waits for the next block.` +
    (instant ? ` You can send up to ${instant} ${ticker} instantly.` : '') + ' Keep this page open.',
  // Under the amount, while it is typed, before anything is reviewed.
  feeHint: (amount, ticker, value) => `Fee ${amount} ${ticker}` + (value ? ` (${value})` : ''),
  hintSeconds: (fee) => `${fee} · arrives in seconds`,
  hintWait: (fee, time, instant, ticker) => (fee ? `${fee} · takes ${time}.` : `Takes ${time}.`) + (instant ? ` Up to ${instant} ${ticker} goes instantly.` : ''),
  // Asked for more than can go once the fee is taken out: the review offers the most that can.
  feeOutOfAll: (ticker) => `The fee comes out of your ${ticker}, so this is the most you can send.`,
  sendInstead: (amount, ticker) => `Send ${amount} ${ticker}`,
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
  // A payment of an asset on the chain from the wallet's own coins there, once broadcast.
  sentBlock: (amount, ticker) => `Sent ${amount} ${ticker}. It arrives after the next block, in about a minute.`,
  stillArriving: (ticker) => `Part of this ${ticker} is still arriving: try again in a moment.`,
  // A payment the library refused for want of what it can spend now: the most it can send, which
  // leaves a little of the asset for the fees of the transactions the payment keeps ready.
  sendUpTo: (amount, ticker) => `You can send up to ${amount} ${ticker}: the fee comes out of your balance.`,
  sendNoneNow: (ticker) => `None of your ${ticker} can be sent this way right now: try again in a moment.`,
  // What is sent waits only for the next settlement (the wallet's own upkeep is moving it, or the
  // library names coins to settle first): the payment goes ahead by itself after it (D96).
  settling: 'Goes through in about a minute',
  // What is sent is held on the chain (all of it, or the part the rest does not cover), and is moved
  // in first: the payment goes ahead by itself once it is, `n` minutes at most as the network says
  // (the move's, and the settle after it of what else pays when part of that is on its way). A page
  // closed meanwhile makes it when the wallet is next open (pending-sends.js), so it is one wait.
  bringIn: (n) => (n <= 1 ? 'Goes through in about a minute' : `Goes through within about ${n} minutes`),
  // Moving it in did not start in that time (its coin is not in a block yet): nothing was sent.
  bringLate: 'This is taking longer than usual. Nothing was sent, and your money is still yours.',
  // The network would not take the money in for it (too little of it to move once its fee is paid,
  // or not taken at all): nothing was sent.
  bringRefused: 'Nothing was sent, and your money is still yours. It can go to an address: ask for one, or paste one.',
  // What is held is less than the fee of sending it (the fee is paid in what is sent): nothing can go.
  belowFee: (ticker) => `This ${ticker} is less than the fee to send it, so it cannot be sent yet. Once more arrives, it can.`,
  // Money held on the chain that cannot be moved in (too little of it, or an asset taken in only on
  // the chain), to a receive code that names no address: it goes only to an address.
  toAddressOnly: (ticker) => `This ${ticker} can be sent only to an address. Ask for an address to pay, or paste one.`,
  // Once the money was in, the payment's fees came to more than the review showed: nothing was
  // sent, and the review shows the payment again with its fee now.
  feeMoved: 'The fee changed while your money was moved in, so nothing was sent. Here it is with the fee now.',
  // The same, with the true wait: the library's (`settle_first`'s `final_in_seconds`) once it has
  // said, the operator's round, block and anchor depth before (settleMinutes); past it, that it
  // takes longer and still goes by itself.
  goesThrough: (minutes) => (minutes <= 1 ? 'Goes through in about a minute' : `Goes through within about ${minutes} minutes`),
  goesThroughLate: 'Taking longer than usual: this goes ahead by itself, or nothing is sent',
  // A payment the page made after it was closed and opened again (pending-sends.js): while it
  // waits, its Activity row; how it ended, said once on Balance; and the review of the same payment
  // asked again while it waits.
  rowSending: 'Sending',
  pendingNotSent: (amount, ticker) => `${amount} ${ticker} was not sent: nothing left your wallet.`,
  pendingMaybeSent: (amount, ticker) => `A payment of ${amount} ${ticker} may have gone before the page closed: check Activity before sending it again.`,
  sameOnItsWay: 'The same payment is already on its way: sending this pays it twice.',
  // A payment that waited for its money and still could not go: nothing was sent.
  settleGaveUp: 'This payment could not go through yet: nothing was sent, and your money stays in your wallet.',
  // A payment to an address whose coins are held but not spendable yet (the change of a payment
  // just made, a coin just received): when it can go, as long as a payment to an address takes.
  stillArrivingWithin: (ticker, minutes) => minutes
    ? `Part of this ${ticker} is still arriving: it can be sent within ${minutes} minute${minutes === 1 ? '' : 's'}.`
    : `Part of this ${ticker} is still arriving: try again in a moment.`,
  codeBtc: 'A receive code takes Sequentia assets. For BTC, use an address or an invoice.',
  codeMixed: 'A receive code is paid on its own: send it without other recipients.',
  addressShort: 'This amount can\u2019t be sent to an address right now. Send it to a receive code, or pay an invoice.',
  // A payment to an address out of the tree is made in the operator's next settlement, which the
  // paying wallet signs its part of as it is made: a page closed before then makes nothing (the
  // coins stay the wallet's), so the review asks for the page to stay open, the wallet reads
  // "Sending" until the payment is made, and only then "Sent" (offboardStage).
  arrivesWithin: (minutes) => `${arrivesWords(minutes)} ${KEEP_OPEN}`,
  fee: (amount, ticker) => `Fee ${amount} ${ticker}`,
  sendingLater: (amount, ticker) => `Sending ${amount} ${ticker}. Keep this page open until it is sent.`,
  sentLater: (amount, ticker, minutes) => `Sent ${amount} ${ticker}. ${arrivesWords(minutes)}`,
  // A payment to an address that ended without being made (the page was closed before it went, or
  // the settlement went on without it): its coins are the wallet's again. Said once, in the review
  // when it is open, else on a card above Balance's list the next time the wallet is open.
  notMade: (amount, ticker, to) => `Your payment of ${amount} ${ticker} to ${to} was not made: nothing left your wallet. Send it again.`,
  // Made, and taken back by the service before it reached the address (`reclaimed`).
  notArrived: (amount, ticker, to) => `Your payment of ${amount} ${ticker} to ${to} did not arrive. Report a problem, so it can be put right.`,
  newsOk: 'OK',
  // History's row for each of them.
  rowNotMade: 'Not sent',
  rowNotMadeSub: 'Nothing left your wallet.',
  rowNotArrived: 'Did not arrive',
  // The same amount of the same asset to the same address, asked while the first is still on its
  // way: the library goes on with the first (`already`) and sends nothing more.
  sentAlready: (amount, ticker, minutes) => `${amount} ${ticker} to this address is already on its way, so nothing more was sent. ${arrivesWords(minutes)} ${KEEP_OPEN} To pay the same again, send once it has arrived.`,
  faucetReceived: (what) => `Received ${what}.`,
  // The faucet has paid and the wallet has not taken the coin in yet (it was busy with an update).
  faucetOnItsWay: (what) => `The faucet sent ${what}. It shows in your balance as soon as your wallet has taken it in, usually within a few minutes.`,
  // A stake, a pool's delegation and a mix are made from coins the wallet holds on the chain: what
  // they need is moved out of the Ark first, by the wallet itself.
  movingOut: (what, purpose, minutes) => `Getting ${what} ready to be ${purpose}. ${readyWords(minutes)} Keep this page open.`,
  movingWaits: (what, purpose) => `${what} is not ready to be ${purpose} yet: the network makes it ready as soon as it can, and it stays yours meanwhile. It is ${purpose} then, while this page is open; or come back later and press the button again.`,
  cannotMoveNow: (what) => `${what} cannot be made ready right now: the network has too little of it free. Nothing has moved: try again later.`,
  notEnough: (amount, ticker) => `Not enough ${ticker}: ${amount} ${ticker} short.`,
  // The wallet did not open within the wait (and is not finding what it holds): nothing moved.
  stillOpening: 'Your wallet has not finished opening, so nothing has moved. If it does not open, reload the page.',
  waitOpening: 'Your wallet is still opening; this goes on by itself once it has.',
  notMoved: 'This could not be made ready just now. Nothing was spent: try again in a moment.',
  notReady: 'What was being made ready has not arrived yet. It stays yours: try again in a few minutes.',
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

// The minutes a payment to an address from the tree takes at most to reach the receiving
// wallet's figure, from the wait for the operator's next settlement (`seconds`: its interval
// between settlements, or the library's `round_within_seconds`), the chain's block interval
// (`blockSeconds`, the operator's `fills.block_seconds`, 60 when it says none) and the most the
// operator takes from the settlement to the payment's unlock in a block (`unlockSeconds`, its
// `offboards.unlock_within_seconds`, UNLOCK_WITHIN_S when it says none). The whole way, not the
// settlement alone: the settlement's block and its certificate (ADDRESS_PATH_BLOCKS), the unlock,
// and the wallets' own passes and reads of the chain (ADDRESS_PATH_SLACK_S), rounded up to five
// minutes. On the testnet (a settlement a minute, a block a minute, no unlock time published) that
// is fifteen minutes. A time stated is one the wallet keeps. -> minutes, or null when the operator
// publishes no interval.
// The minutes coins the wallet moves out of the tree to its own address take to be its to spend on
// the chain (for a stake, say): the operator's next settlement (`seconds`), the wallet handing
// over its part of it at once, the settlement's block, and the operator's unlock of the output in a
// block (`unlockSeconds`, as for arrivalMinutes), with MOVE_OUT_BLOCKS blocks and MOVE_OUT_SLACK_S
// seconds for the reads on either side. Nothing waits on another wallet: on the testnet (a
// settlement a minute, a block a minute, no unlock time published) it is fourteen.
// -> minutes, or null when the operator publishes no interval.
export const MOVE_OUT_BLOCKS = 2
export const MOVE_OUT_SLACK_S = 30
export function moveOutMinutes (seconds, blockSeconds, unlockSeconds = null) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const b = Number(blockSeconds) > 0 ? Number(blockSeconds) : 60
  return Math.max(1, Math.ceil((n + MOVE_OUT_BLOCKS * b + unlockOf(unlockSeconds) + MOVE_OUT_SLACK_S) / 60))
}

// How often the page syncs while some coin is arriving (ARRIVING_STATES: a coin given up in the
// next round, a transfer not yet completed). The operator holds a round for the wallet's part of
// it (its forfeits, handed over in a sync) before the round goes on the chain, and the library's
// own schedule syncs once a minute: a coin the wallet refreshes by itself after receiving it, or
// moves out of the Ark, then waits on this wallet for a minute or more, unspendable meanwhile.
// ARRIVING_SYNC_FOR_MS bounds one stretch of it, so a coin that stays arriving for long (one the
// operator owes back) does not keep the page syncing.
export const ARRIVING_SYNC_MS = 10_000
export const ARRIVING_SYNC_FOR_MS = 10 * 60_000

// Whether the page syncs now because something is arriving: `arriving` the atoms arriving over
// every asset, `since` when this stretch of arriving began (ms), `lastSyncMs` the last such sync.
export function arrivingSyncDue ({ arriving, nowMs, since, lastSyncMs = 0, busy = false } = {}) {
  if (busy || !(big(arriving) > 0n)) return false
  if (since != null && Number(nowMs) - Number(since) > ARRIVING_SYNC_FOR_MS) return false
  return Number(nowMs) - Number(lastSyncMs || 0) >= ARRIVING_SYNC_MS
}

export const ADDRESS_PATH_BLOCKS = 2
export const ADDRESS_PATH_SLACK_S = 120
export const UNLOCK_WITHIN_S = 600
const unlockOf = (u) => (Number(u) > 0 ? Number(u) : UNLOCK_WITHIN_S)
export function arrivalMinutes (seconds, blockSeconds, unlockSeconds = null) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return null
  const b = Number(blockSeconds) > 0 ? Number(blockSeconds) : 60
  const m = Math.ceil((n + ADDRESS_PATH_BLOCKS * b + unlockOf(unlockSeconds) + ADDRESS_PATH_SLACK_S) / 60)
  return Math.max(5, Math.ceil(m / 5) * 5)
}

// What the wallet says once the library has answered a payment to an address out of the tree
// (`v`, its `offboard` answer), and whether it is a new payment to write down in History. The same
// amount of the same asset to the same address, asked while the first is still on its way, is that
// first payment (`already`): nothing more is sent, and it is never said to be. `minutes`: the
// review's arrival time, `blockSeconds` the chain's block interval. -> { text, sent }
// The text is "Sending" (`made: false`) until the library says the payment is made: "Sent" is never
// shown for a payment that is not (offboardStage).
export function offboardOutcome (v, amount, ticker, minutes, blockSeconds, unlockSeconds = null) {
  const mins = arrivalMinutes(v && v.round_within_seconds, blockSeconds, unlockSeconds) || minutes
  if (v && v.already) return { text: DEFAULT_WORDS.sentAlready(amount, ticker, minutes), sent: false, minutes: mins }
  return { text: DEFAULT_WORDS.sendingLater(amount, ticker), sent: true, minutes: mins }
}

// Where a payment to an address out of the tree stands, from its state in the library's `offboards`
// (arca bark/src/arca/offboard.rs): `waiting` for the operator's settlement and `in_round` until the
// paying wallet hands over its part are 'pending' (a wallet closed now makes nothing); `unlocking`
// and `paid` are 'made'; `not_made` (it ended without a settlement: its coins are the wallet's
// again) and `reclaimed` (made, and taken back by the operator before it reached the address) are
// ends the person is told of. Anything else the library may say is 'pending', never 'made'.
export function offboardStage (state) {
  if (state === 'unlocking' || state === 'paid') return 'made'
  if (state === 'not_made') return 'not_made'
  if (state === 'reclaimed') return 'reclaimed'
  return 'pending'
}

// The payments to an address out of the tree this wallet asked for, read against the library's
// `offboards` (`offboards`: its answer). `asked`: the wallet's records, each `{ offboard, stage? }`
// with the stage it last knew. -> { stages: Map(id -> stage now), news: [the library's entry, with
// `stage`, for each record that has just reached 'not_made' or 'reclaimed'] }. A record the library
// does not list keeps its stage. A record already at an end is never news again.
export function offboardEnds (asked, offboards) {
  const byId = new Map((Array.isArray(offboards) ? offboards : []).filter((o) => o && o.offboard).map((o) => [String(o.offboard), o]))
  const stages = new Map(); const news = []
  for (const r of Array.isArray(asked) ? asked : []) {
    if (!r || !r.offboard) continue
    const was = r.stage || 'pending'
    const o = byId.get(String(r.offboard))
    if (!o || was === 'not_made' || was === 'reclaimed') { stages.set(String(r.offboard), was); continue }
    let now = offboardStage(o.state)
    // Made is never unsaid by a reading that has not caught up.
    if (was === 'made' && now === 'pending') now = 'made'
    stages.set(String(r.offboard), now)
    if (now !== was && (now === 'not_made' || now === 'reclaimed')) news.push({ ...o, stage: now })
  }
  return { stages, news }
}

// How a payment's address is named in what the wallet says of it: its start and its end.
export function shortAddress (address) {
  const a = String(address || '')
  return a.length > 22 ? a.slice(0, 14) + '\u2026' + a.slice(-4) : a
}

// The one sentence for a payment to an address that reached an end other than made.
export function offboardNewsText (n, amount, ticker) {
  const to = shortAddress(n && n.address)
  return n && n.stage === 'reclaimed' ? DEFAULT_WORDS.notArrived(amount, ticker, to) : DEFAULT_WORDS.notMade(amount, ticker, to)
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
// wallet's coins there cover it with its network fee (`feeMargin`, what the fee may take of the
// same asset, which default mode pays it in), else out of the tree when the tree's spendable
// coins cover it, else on the chain when its coins there cover the amount alone (the fee may
// still fit), else not at all. Coins on the chain a few atoms short of amount and fee never
// refuse a payment the tree could make.
// `treeArriving`: what the tree holds of the asset that is not spendable yet (the change of a
// payment just made, a coin just received); when the tree would cover the amount with it, the
// payment is 'arriving': refused as still arriving, never as not enough.
// `movable`: of the chain's coins, what the wallet can move into the tree (`moveMargin` kept back for
// the move's and the payment's fees): an amount that needs both the chain's coins and the tree's is
// 'bring-in', the chain's moved in first and the whole then paid out of the tree, one payment.
export function addressRoute (amount, onchain, treeSpendable, feeMargin = 0n, treeArriving = 0n, movable = 0n, moveMargin = feeMargin) {
  const a = big(amount)
  if (a + big(feeMargin) <= big(onchain)) return 'chain'
  if (a <= big(treeSpendable)) return 'tree'
  if (a <= big(onchain)) return 'chain'
  if (big(treeArriving) > 0n && a <= big(treeSpendable) + big(treeArriving)) return 'arriving'
  if (big(movable) > 0n && a + big(moveMargin) <= big(treeSpendable) + big(treeArriving) + big(movable)) return 'bring-in'
  return null
}

// How default mode pays an asset to a receive code of its own operator, by the rule that one balance
// is spendable whichever way completes soonest:
//   'tree'     in the tree: what it holds there and can send now (`tree`), with what is on its way
//              there (`onItsWay`, settled first, about a minute), covers the amount and `margin`;
//   'chain'    otherwise at the code's address (`address`: the code names one), from the wallet's
//              coins on the chain (`chain`), when they cover it with the network fee's `margin`:
//              after the next block, about a minute;
//   'bring-in' otherwise, when the tree and what can be moved in from the chain (`movable`, less
//              `moveMargin` for the move's and the payment's fees) cover it together: moved in first,
//              then paid in the tree, one payment;
//   'tree'     when nothing covers it: the tree's refusal says what can go.
export function codeRoute ({ amount, tree = 0n, onItsWay = 0n, chain = 0n, movable = 0n, margin = 0n, moveMargin = margin, address = false }) {
  const a = big(amount)
  const inTree = big(tree) + big(onItsWay)
  if (a + big(margin) <= inTree) return 'tree'
  if (address && a + big(margin) <= big(chain)) return 'chain'
  if (big(movable) > 0n && a + big(moveMargin) <= inTree + big(movable)) return 'bring-in'
  return 'tree'
}

// The most a payment of an asset to a receive code of its own operator can be, by the routes
// codeRoute takes (the same arguments, but no amount): from the chain alone at the code's address
// less the network fee's `margin`; the tree's and the chain's together, the chain's moved in first,
// less `moveMargin`; or what the tree holds and has on its way. Max fills it in, and a payment of
// more is refused naming it, so the two never disagree.
export function codeMost ({ tree = 0n, onItsWay = 0n, chain = 0n, movable = 0n, margin = 0n, moveMargin = margin, address = false }) {
  const inTree = big(tree) + big(onItsWay)
  const fromChain = address ? big(chain) - big(margin) : 0n
  const together = big(movable) > 0n ? inTree + big(movable) - big(moveMargin) : 0n
  return [fromChain, together, inTree].reduce((a, b) => (b > a ? b : a), 0n)
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

// The most a payment of `paid` atoms the library refused for want of funds could send instead, in
// atoms: what its live coins hold less the margins the payment leaves for its transactions' fees
// ("the wallet holds H of asset A in live coins, and paying P takes N with the margins …": H less
// N - P), or that much less than `paid` when the change would fall below the operator's smallest
// leaf. 0n when nothing can be sent; null for any other refusal.
// The fee a refused payment would have kept back, from the library's own words ("paying P takes
// N with the margins …": N - P), in atoms; null when the words do not say it.
export function feeFromRefusal (paid, message) {
  const s = String(message || '').match(/paying (\d+) takes (\d+)/)
  if (!s || BigInt(s[1]) !== BigInt(paid)) return null
  const fee = BigInt(s[2]) - BigInt(s[1])
  return fee >= 0n ? fee : null
}

// The most a payment refused `in_channel` can send once the channels it names are moved back:
// what the live coins hold, plus the wallet's side of its channels, less the payment's fee
// ("holds H … paying P takes N …; T more is the wallet's side": H + T - (N - P)), at most `paid`.
// The round that moves them back may cost a little more; the payment then says the most it can.
// null when the words do not say it.
export function sendableAfterFreeing (paid, message) {
  const m = String(message || '')
  const s = m.match(/holds (\d+) of asset \S+ in live coins, and paying (\d+) takes (\d+)/)
  const t = m.match(/; (\d+) more is the wallet's side of its channels/)
  if (!s || !t) return null
  const most = BigInt(s[1]) + BigInt(t[1]) - (BigInt(s[3]) - BigInt(s[2]))
  const p = BigInt(paid)
  return most > 0n ? (most < p ? most : p) : 0n
}

export function sendableNow (paid, message) {
  const m = String(message || '')
  const p = BigInt(paid)
  const s = m.match(/holds (\d+) of asset \S+ in live coins, and paying (\d+) takes (\d+)/)
  if (s) {
    const held = BigInt(s[1]), margins = BigInt(s[3]) - BigInt(s[2])
    const most = held - (margins > 0n ? margins : 0n)
    return most > 0n ? (most < p ? most : p) : 0n
  }
  const d = m.match(/change would be below the operator's smallest leaf in asset \S+ \((\d+) atoms\)/)
  if (d) { const most = p - BigInt(d[1]); return most > 0n ? most : 0n }
  return null
}

// Max for a payment in the tree: the most of `held` atoms a payment can send once the fee the
// library keeps back for it comes out of what is held. `quote(atoms)` is the library's
// `send_quote` for that amount ({ fee } on top of it), or throws with its refusal. A quote of all
// that is held answers with its fee rather than refusing, so the fee is taken off and the smaller
// amount quoted again, until the amount and its fee fit; a refusal that says the most it can send
// (sendableNow) is taken as it is. -> atoms, 0n when nothing can be sent.
export async function treeSendMax (held, quote, tries = 4) {
  const all = big(held)
  let a = all
  for (let i = 0; i < tries && a > 0n; i++) {
    let q
    try { q = await quote(a) } catch (e) {
      const most = sendableNow(a, String((e && e.message) || e))
      if (most == null || most >= a) throw e
      a = most
      continue
    }
    const fee = big(q && q.fee)
    if (a + fee <= all) return a
    a = all - fee
  }
  return a > 0n ? a : 0n
}

// Whether an amount typed for a payment in the tree fits once its fee is counted: `atoms` the
// amount, `fee` the library's quote of it (on top of the amount), `spendable` what the wallet can
// pay with now (held less arriving). -> { fits: true } or { fits: false, most } with the most that
// fits (0n when nothing does). A quote answers with its fee rather than refusing an amount the fee
// does not fit beside, so the hint under the amount says the most as the amount is typed, not only
// once Review & send is pressed.
export function amountFits (atoms, fee, spendable) {
  const a = big(atoms), f = big(fee), s = big(spendable)
  if (a + f <= s) return { fits: true }
  const most = s - f
  return { fits: false, most: most > 0n ? most : 0n }
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
      // Its fee and the amount boarded too, so a payment that asked for the move counts its fee.
      return r && typeof r === 'object' ? { ...r, spent: String(v + f), fee: String(f), amount: String(v) } : r
    }
    fee = f
  }
  return null
}

// What a board just made takes off the chain: `onchain` atoms as the page's own reading of the
// chain shows them, less what the board spent (`board`: { spent, below, at, txid }, from
// boardSpent) while that reading does not hold the board yet. The board's leaf counts as arriving
// in the tree from the moment it is made, so without this the coins count twice until the
// reading catches up (a block, or the page's next scan).
//
// `holds(txid)` says whether the page's reading holds a transaction (true, false, or undefined
// when it cannot tell). With it the board is taken as seen exactly when the reading holds the
// board's transaction, and until then only what the reading still holds of the coins the board
// spent comes off: the library read `held` (= below + spent) when it boarded, so a reading short
// of that has not seen part of them (a coin that just arrived) and takes off that much less. A
// coin that reaches the address after the board is never taken off for it: the reading drops by
// the board and rises by the new coin at once, and comparing it with what the board left
// (`below`) would read the new coin as the board's, so it would vanish until the next board or
// half an hour. Without `holds` (or a record kept before boards named their transaction) the
// board is taken as seen once the reading drops to what it left. Never longer than half an
// hour. -> { atoms, seen }
export const BOARD_SEEN_MS = 30 * 60_000
export function onchainLessBoards (board, onchain, nowMs, holds) {
  const o = big(onchain)
  if (!board) return { atoms: o, seen: true }
  if (nowMs - Number(board.at) > BOARD_SEEN_MS) return { atoms: o, seen: true }
  const spent = big(board.spent)
  let known
  if (board.txid && typeof holds === 'function') { try { known = holds(board.txid) } catch {} }
  if (known === true) return { atoms: o, seen: true }
  if (known === false) {
    const held = big(board.below) + spent
    const missing = held > o ? held - o : 0n
    const off = spent > missing ? spent - missing : 0n
    return { atoms: o - off, seen: false }
  }
  if (o <= big(board.below)) return { atoms: o, seen: true }
  const v = o - spent
  return { atoms: v > 0n ? v : 0n, seen: false }
}
// The record onchainLessBoards keeps for a board of `held` atoms on the chain (the library's
// reading when it boarded) that spent `spent`, made at `at`, its transaction `txid`.
export function boardSpent (held, spent, at, txid) {
  const rec = { spent: String(big(spent)), below: String(big(held) - big(spent)), at }
  if (typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid)) rec.txid = txid
  return rec
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

// Activity's rows for what is not in the figure yet, each with when it will be in words, true for
// its cause (docs/DEFAULT_MODE.md, History):
// - `round`: a payment past what counts at once, a channel being closed, a coin a reorganisation
//   took back: the operator's next round, about a minute (a median of 64 s; three minutes is the
//   time past which it is said to take longer);
// - `board`: a deposit to the wallet's address, on the chain until the wallet has it in the tree:
//   its block, then its board's block certified with its anchor buried (`boardMinutes`);
// - `return`: a coin coming home on the chain, within about two days.
// Past its time a line says it is taking longer than usual, and the wallet keeps at it.
// `arriving`: leaves.js arrivingPayments, and the page's deposits on the chain ({ deposit: true });
// `shown`: the leaf ids a received row already shows (that row says it instead); `firstSeen`: when
// each line was first seen (ms, by id), `nowMs`, `boardMin` from boardMinutes.
// -> [{ asset, atoms: BigInt, leaf, kind: 'arriving'|'coming_back', cause, when, late }]
export function arrivingRows (arriving, shown = [], { firstSeen = {}, nowMs = Date.now(), boardMin = 5, roundMin = 1 } = {}) {
  const seen = new Set(shown || [])
  const out = []
  for (const a of arriving || []) {
    if (!a || !a.asset || (a.leaf_id && seen.has(a.leaf_id))) continue
    const cause = arrivingCause(a)
    const since = a.leaf_id && firstSeen[a.leaf_id] != null ? Number(firstSeen[a.leaf_id]) : null
    // A coin coming home whose claim time the library knows: the hours until then, and a little for
    // the claim; past it, taking longer.
    const left = cause === 'return' && Number(a.claimFrom) > 0 ? Number(a.claimFrom) * 1000 + 600_000 - nowMs : null
    const late = left != null ? left < 0 : since != null && nowMs - since > statedSeconds(cause, boardMin, roundMin) * 1000
    const when = late ? DEFAULT_WORDS.takingLonger
      : left != null && left < 2 * 86_400_000 ? DEFAULT_WORDS.comingBackWithin(Math.max(1, Math.ceil(left / 3_600_000)))
        : causeWhen(cause, boardMin, roundMin)
    out.push({ asset: a.asset, atoms: big(a.atoms), leaf: a.leaf_id || null, kind: cause === 'return' || a.channel === true ? 'coming_back' : 'arriving',
      cause, late, when })
  }
  return out
}
// The cause of an arriving line (arrivingRows).
export function arrivingCause (a) {
  if (a && a.state === 'exiting') return 'return'
  if (a && (a.deposit === true || a.kind === 'board')) return 'board'
  return 'round'
}
// The minutes a deposit takes to be usable: a Sequentia block, and its board's block certified with
// its anchor buried under `anchorDepth` Bitcoin blocks (about ten minutes each), rounded up to five.
export function boardMinutes (anchorDepth) {
  const d = Number(anchorDepth)
  const m = (Number.isFinite(d) && d > 0 ? d * 10 : 0) + 5
  return Math.ceil(m / 5) * 5
}
// The minutes a round's coin takes to be the wallet's: the round, and its block certified with its
// anchor buried under `anchorDepth` Bitcoin blocks (the same finality rule as a board's). 1 at depth
// 0 ("about a minute"); otherwise a minute and ten for each Bitcoin block, rounded up to five.
export function roundMinutes (anchorDepth) {
  const d = Number(anchorDepth)
  if (!(Number.isFinite(d) && d > 0)) return 1
  return Math.ceil((1 + d * 10) / 5) * 5
}
// The minutes a payment that settles first usually waits before it goes, as the library's
// `settle_first` counts it (`usual_in_seconds`) for a coin not yet in a round: the operator's next
// round; a round interval more for the other participations' forfeits when the operator holds its
// rounds for them (`held`: its batches have no sweep); a block for the round and one more for its
// certificate; a Bitcoin block (about ten minutes) for each block of anchor depth the operator
// counts finality at; and the operator's release: three of its passes over the rounds when it
// publishes how long one takes (`passSeconds`, its `fills.round_pass_seconds`, one more pass then
// to build the round), else a round interval and a block. 6 on the testnet (rounds and blocks a
// minute apart, rounds held, depth 0, no pass time published).
export function settleMinutes (roundSeconds, blockSeconds, anchorDepth, held = false, passSeconds = null) {
  const r = Number(roundSeconds) > 0 ? Number(roundSeconds) : 60
  const b = Number(blockSeconds) > 0 ? Number(blockSeconds) : 60
  const d = Number.isFinite(Number(anchorDepth)) && Number(anchorDepth) > 0 ? Number(anchorDepth) : 0
  const p = Number(passSeconds) > 0 ? Number(passSeconds) : null
  const release = p != null ? 3 * p : r + b
  return Math.max(1, Math.ceil((r + (p ?? 0) + (held ? r : 0) + 2 * b + d * 600 + release) / 60))
}
// settleMinutes for an operator as the library's `info` answers it (null: the defaults).
export function settleMinutesOf (info) {
  const si = (info && info.server_info) || {}, f = si.fills || {}
  return settleMinutes(f.round_interval_seconds, f.block_seconds, anchorDepth(info), !!(si.batches && si.batches.no_sweep), f.round_pass_seconds)
}
// The time a payment settling first is told it goes by, from each answer of the library's
// `settle_first`, or its `settle_first` refusal (`usual_in_seconds`, what it usually takes, else
// `final_in_seconds`, the most; and `waiting_for`): the first answer sets it, and it stays while
// the step waited for stands or moves on (a step slower than usual makes it late, not later), and is
// set again only when the step goes back (a new round, an anchor rollback). `prev` is the last
// { finalBy, step } (ms, the step's name), or null. -> the new one.
const WAIT_STEPS = ['round', 'forfeits', 'block', 'certificate', 'anchor', 'release']
export function nextFinalBy (prev, answer, nowMs = Date.now()) {
  const secs = answer && (answer.usual_in_seconds ?? answer.final_in_seconds)
  if (!answer || answer.ready || secs == null) return prev
  const at = nowMs + Number(secs) * 1000, step = answer.waiting_for ?? null
  if (!prev || prev.finalBy == null) return { finalBy: at, step }
  const back = step != null && prev.step != null && WAIT_STEPS.indexOf(step) < WAIT_STEPS.indexOf(prev.step)
  return back ? { finalBy: at, step } : { finalBy: prev.finalBy, step: step ?? prev.step }
}
// The words of a payment settling first, at `nowMs`: within the minutes left to `finalBy` (ms, when
// the library said it would be through), or `minutes` before it has said; past `finalBy` by
// SETTLE_LATE_MS, that it takes longer and goes by itself.
export const SETTLE_LATE_MS = 120_000
export function settleWords (finalBy, minutes, nowMs = Date.now(), words = DEFAULT_WORDS) {
  if (finalBy == null) return words.goesThrough(minutes || 1)
  if (nowMs > finalBy + SETTLE_LATE_MS) return words.goesThroughLate
  return words.goesThrough(Math.max(1, Math.ceil((finalBy - nowMs) / 60_000)))
}

// The seconds after which a line of `cause` is taking longer than it said.
export function statedSeconds (cause, boardMin = 5, roundMin = 1) {
  return cause === 'return' ? 2 * 86_400 : cause === 'board' ? boardMin * 60 : roundMin <= 1 ? 180 : roundMin * 60
}
// When, in words, for a line of `cause`.
export function causeWhen (cause, boardMin = 5, roundMin = 1) {
  if (cause === 'return') return DEFAULT_WORDS.comingBackWhen
  if (cause === 'board') return DEFAULT_WORDS.boardWhen(boardMin)
  return roundMin <= 1 ? DEFAULT_WORDS.arrivingSoon : DEFAULT_WORDS.boardWhen(roundMin)
}
