// The user-mode composer's engine: one market trade, in one native step.
//
// The person names what they pay, what they get and how much they pay. The engine reads the
// single-step book (tooling/lsp/single-step-book.mjs), asks the wallet's leaf library to price
// each candidate it can fill, picks one (the most received, then the fewest parties), and makes
// the ticket: amount in, amount out, one cost line. On confirm it settles that one candidate the
// way the settlement router names (tooling/lsp/settlement-router.mjs planSingleStep), and follows
// it to "Settled", or to "Returned" when nothing traded. It never falls back to another source.
//
// Every amount on a ticket is the leaf library's answer (swap_read, take_quote, settle_quote);
// this file compares the library's numbers and adds the ones it shows, and decides nothing the
// library decides. It has no DOM and no node: import, so the page (user-composer.js) and the
// drill (tooling/user-mode-drill.mjs) run the same code.
//
// deps:
//   leaves.command(name, args) -> the library's answer (a promise or a value)
//   fetchJson(url, init?)      -> the parsed JSON of a GET or POST, throwing on an HTTP error
//   makers()                   -> the base URLs of the live leaf makers to ask
//   relayBook(pay, receive)    -> the relay's offers that sell `receive` for `pay` (each with
//                                 `_verified`, its relay JSON `_relayJson`, and its order
//                                 status `_status`, the book's statuses[i] of offers[i])
//   relayFills(pay, receive)   -> the relay's fill records of the pair (an order resting in the
//                                 tree is settled once its fill's record is final), or absent
//   outputValue(txid, vout)    -> the atoms an order's output holds on the chain now, or null
//                                 (the relay keeps an offer's signed amount after a part fill)
//   admitted()                 -> { pairs, genesis }: user-mode/pairs.json and this chain's genesis
//   btc                        -> the wallet's Bitcoin Lightning, for BTC trades (user-trade-btc.js),
//                                 or null: then nothing is traded for or with BTC
//   onchain                    -> the wallet's own on-chain coins, for covenant orders taken on the
//                                 chain ('onchain-fill'), or null: { balance(asset) -> atoms it can
//                                 spend now, fee(payAsset) -> { asset, atoms } of one fill's network
//                                 fee, take(matched, { fee, onTxid }) -> { txid } (builds, signs and
//                                 broadcasts the FILL at the fee shown; onTxid(txid) before the
//                                 broadcast),
//                                 status(txid) -> 'final' | 'confirmed' | 'pending' | 'unknown' }
//   anchorDepth()              -> the Bitcoin blocks the operator waits for after a block is certified
//                                 before a coin in it can be traded (the library's `info`
//                                 `anchor_depth`), or null; optional: at 0 a coin not ready yet is
//                                 on its way and ready in a minute or two
//   restoring()                -> whether a restore is still under way, its history included;
//                                 optional: while it is, a quote that would wait on money on its way
//                                 (or name a time for it) answers 'restoring' instead
//   vesting(asset)             -> what of an asset vests later ([{ asset, vest, vests, atoms }], the
//                                 wallet's last `claims` reading, default-arca.js vestingLots); optional:
//                                 with it, a pay amount that needs what has not vested is 'vesting'
//   held(asset)                -> what the wallet shows it holds of an asset, wherever it is; optional:
//                                 with it, a pay asset held but not payable now is 'not-ready', not
//                                 'no-funds'
//   chain(asset)               -> the wallet's money of an asset held on the chain, for a trade that
//                                 needs it: { atoms (all of it on the chain), movable (what the wallet
//                                 can move in to trade from), margin (kept back for the move's fee),
//                                 minutes (how long moving it in takes), stays ('dust' or 'unserved'
//                                 when none of it can be moved in, else null) }; optional: with it and
//                                 bringIn, money on the chain that no fill on the chain takes is
//                                 moved in first and then traded, the ticket saying how long
//   bringIn(asset, want, opts) -> moves what the wallet holds of an asset on the chain in, by itself
//                                 (default mode boards it now, as a person asked), once at least
//                                 `want` atoms of it are there to move; `opts`: { until (ms), stop()
//                                 (true once the trade no longer waits for it) }; resolves with
//                                 { boarded }, { already }, { refused } or null (nothing by
//                                 `until`); asked once per trade, and again only after a reload;
//                                 optional
//   movedFees(asset, since)    -> the fees, in atoms of the asset, of the moves in of it made since
//                                 `since` (ms): a trade paid with money moved in counts them in what
//                                 it pays; optional (none counted)
//   prepare(asset)             -> asks the wallet to make an asset held but not payable ready (default
//                                 mode boards it); optional
//   release(asset, leaves)     -> asks the wallet to free `leaves`, live coins of `asset` kept by an open
//                                 offline-refresh plan, in its next round (plan_release); optional:
//                                 with it, a pay asset held only in such coins is 'freeing'
//   changed(record)            -> told when a trade moves on in a way that changes what the wallet
//                                 holds; optional (the page reads its balance again)
//   store                      -> getItem/setItem (the trade records, persisted before signing)
//   now()                      -> milliseconds
//   sleep(ms), log(...)        -> optional

import { makerEntries, covenantRoundEntries, restingEntries, onchainFillEntries, sizeEntry, chooseCandidate, admittedSources, SLOW_SOURCES, SLOW_PREMIUM_BPS } from './tooling/lsp/single-step-book.mjs'
import { planFillFromMatched } from './covenant-order.js'
import { planSingleStep } from './tooling/lsp/settlement-router.mjs'
import { btcTrades } from './user-trade-btc.js'
import { DEFAULT_WORDS, vestingShort, nextFinalBy, settleMinutesOf, SETTLE_LATE_MS } from './default-arca.js'
import { restrictedQuote, restrictedConfirm, restrictedAdvance } from './restricted-engine.js'
import { composedQuote, composedAdvance, openComposedIds, claimOnce } from './restricted-composed.js'

const big = (v) => { try { return BigInt(v ?? 0) } catch { return 0n } }

// How long the wallet waits for a maker to complete a swap it accepted before it cancels it and
// takes its coins back (the maker completes in seconds; the cancel and a late completion exclude
// each other at the operator's signer).
export const MAKER_COMPLETE_MS = 120_000
// How long a trade whose maker's offer is gone keeps asking for a price within what was accepted
// (the wallet busy, no firm offer yet) before it is returned with words.
export const REPRICE_MOST_MS = 60_000
// A waiting trade whose coins the wallet called through, priced again and refused once more for
// coins that wait for a round: the next price is asked of the other side only after the wait that
// refusal gave, and at least this long after, never at every follow.
export const REPRICE_AGAIN_MS = 30_000
// How many offers of one trade may be gone (each priced again at once) before it is returned.
export const GONE_MOST = 3
// Whether refusal `e` says a coin the wallet held (`held`, the leaf ids it held before the step)
// is spent already: the operator's `double_spend`, naming the coin.
export function spentElsewhere (e, held) {
  const m = String((e && e.message) || '')
  if (!/double_spend/.test(m)) return false
  const named = (m.match(/\b[0-9a-f]{64}\b/i) || [])[0]
  return !!named && (held || []).includes(named.toLowerCase())
}
// A step whose outcome is unknown (the operator did not answer, so the library may still complete
// it at its next sync) is looked for this long before the trade is called returned.
export const UNCERTAIN_MS = 10 * 60 * 1000
// The longest a restricted trade's move to the chain is followed after its page closed: the page's
// own wait for a move (index.html MOVE_WAIT_MS, 45 minutes) and five minutes more.
export const RESTRICTED_MOVE_MOST_MS = 50 * 60 * 1000
// A maker's firm offer is accepted only while at least this long is left before it lapses.
export const FIRM_MARGIN_MS = 20_000
// The most the operator's fee may be of a price, in millionths, for a trade in user mode.
export const MAX_FEE_PPM = 10_000

// Words a default screen must never show (design 1.4). Lower case; matched as whole words.
export const USER_MODE_FORBIDDEN_WORDS = Object.freeze(['rail', 'rails', 'round', 'rounds', 'leaf', 'leaves', 'operator', 'covenant',
  'covenants', 'expiry', 'atom', 'atoms', 'forfeit', 'forfeits', 'channel', 'channels', 'relay', 'maker', 'makers', 'hash', 'preimage',
  'htlc', 'submarine', 'lsp', 'tree', 'anchor', 'unroll', 'exit', 'checkpoint', 'reassignment', 'on-chain', 'lightning', 'bridge', 'gateway',
  'node', 'nodes', 'claim', 'claims', 'distribution', 'distributions', 'lapse', 'lapses', 'lapsed', 'locktime', 'locktimes',
  'parent chain', 'input', 'inputs', 'vb'])

export function forbiddenIn (text) {
  const t = String(text || '').toLowerCase()
  return USER_MODE_FORBIDDEN_WORDS.filter((w) => new RegExp(`(^|[^a-z-])${w.replace(/[-]/g, '\\-')}([^a-z-]|$)`).test(t))
}

// Every string the user composer shows, in one place, so the word list can be checked against
// all of them (user-trade.test.mjs).
export const USER_WORDS = Object.freeze({
  pay: 'You pay',
  get: 'You receive',
  // The control between the two sides: it exchanges them, each amount staying with its asset.
  flip: 'Swap You pay and You receive',
  flipMark: '⇅',
  amount: 'Amount',
  max: 'Max',
  balance: (x) => `balance ${x}`,
  // Under You pay, beside the balance: a payment on its way, which a trade settles first and pays.
  arriving: (x) => `${x} arriving, in about a minute`,
  // What the book can fill now, when less than asked: said beside the amounts as they are typed.
  bookUpTo: (x) => `The book can fill up to ${x} now.`,
  // The same, when a maker takes more only after its coins are next settled, a few minutes on.
  bookUpToSoon: (x) => `The book can fill up to ${x} now, and more in a few minutes.`,
  // Nothing to fill now for that reason alone.
  notOfferedSoon: (get, pay) => `${get} for ${pay} can be traded again in a few minutes.`,
  // Nobody offers the pair this moment, though it was offered a moment ago: the price is asked
  // again by itself.
  offeredAgain: (get, pay) => `Getting a price for ${get} for ${pay}: it takes a moment. Nothing has moved.`,
  // Nobody offers the pair now, and a purchase of the wallet's own paid with BTC is still to pay:
  // the BTC desk holds what it gives for that purchase until it is paid, so this one waits for it.
  // The Trade tab prices it again by itself.
  btcAhead: 'You have a purchase paid with BTC under way: this one can be priced once that one is paid. Nothing has moved.',
  review: 'Review',
  confirm: 'Trade',
  cancel: 'Cancel',
  amountIn: 'You pay',
  amountOut: 'You receive',
  fees: 'Fees',
  included: 'included above',
  noFees: 'No fees',
  // A ticket whose fees are known only once its money is moved in: the most they can be.
  feesAtMost: 'Fees at most',
  upTo: (x) => `Up to ${x} can be traded now.`,
  // After Max, what this trade cannot take of the asset paid (one trade takes so many coins, or no
  // offer pays exactly the rest): it stays, the person's to trade or send after.
  stays: (x) => `${x} stays in your wallet, to trade or send after this one.`,
  notOffered: (get, pay) => `Not offered right now: nobody offers ${get} for ${pay} in one step.`,
  notListed: (get, pay) => `${get} for ${pay} is not offered.`,
  // Nothing to choose under You receive: no pair admitted for what is paid, or none read yet.
  nothingOffered: (pay) => `Not offered right now: nobody offers anything for ${pay}.`,
  enter: 'Enter how much you pay.',
  tooSmall: 'That amount is too small to trade.',
  noFirmOffer: 'Nobody could confirm a price for this just now. Nothing has moved: try again in a moment.',
  // The wallet's own refusal: what it holds of the asset, less the fees the trade keeps back, does
  // not cover the amount (nothing more is on its way). `most`: what can be traded now, as Max fills it.
  ownShort: (most) => `You can trade up to ${most} now: the fees of this trade come out of what you hold. Nothing has moved.`,
  // The wallet's own library was busy finishing something it started for longer than a quote waits.
  walletBusy: 'Your wallet is still finishing something it started, so it could not get a price in time. Nothing has moved: try again in a moment.',
  noFunds: (pay) => `You have no ${pay} to trade.`,
  // More than can be traded now, the rest vesting later (the wallet's one sentence for it).
  notVested: DEFAULT_WORDS.notVested,
  // Held, and shown in the balance, but not where a trade can pay it from yet (just arrived, or
  // still being moved in by the wallet): never "you have none". `soon`: the operator calls a coin
  // ready once its block is certified (anchor depth 0), so it is ready in a minute or two.
  notReady: (pay, soon) => soon ? `Your ${pay} is on its way: it is ready to trade in a minute or two. Nothing has moved.`
    : `Your ${pay} is not ready to trade yet: it is once the next Bitcoin blocks settle it. Nothing has moved.`,
  // More than the wallet holds of what is paid, nothing of it waiting: the whole of it, named.
  moreThanHeld: (have) => `That is more than your ${have}.`,
  // A restore still checking the wallet's earlier history: what the wallet would say is on its way
  // may be history, so nothing waits on it and no time is promised.
  restoring: 'Your wallet is still being restored: this trade can be priced once that is done. Nothing has moved.',
  // A coin that was ready, taken back out of the chain with its Bitcoin block: still the wallet's,
  // and in its balance, while the network takes it in again.
  redoing: (pay) => `Your ${pay} is being redone after a Bitcoin reorganisation: it is still yours, and ready to trade again once that settles. Nothing has moved.`,
  // Held by an order the person placed, which they can cancel; never said of the wallet's own moves,
  // which a trade waits for by itself.
  busy: (pay) => `Your ${pay} is held by an order you placed, and can be traded once it is filled or cancelled. Nothing has moved.`,
  // Kept by the wallet's plan to refresh it while the wallet is closed, which only a round can end:
  // the wallet gives it up in its next round for a coin it can trade.
  // The best offers are orders resting in the tree that only coins expiring later can fill: the
  // wallet refreshes its older coins in the next round, and prices the trade again once they are in.
  readying: (pay, soon) => soon ? `Getting your ${pay} ready for this trade: it is ready in a minute or two. Nothing has moved.`
    : `Getting your ${pay} ready for this trade: it is ready once the next Bitcoin blocks settle it. Nothing has moved.`,
  freeing: (pay, soon) => soon ? `Your ${pay} is being made ready to trade: it is ready in a minute or two. Nothing has moved.`
    : `Your ${pay} is being made ready to trade: it is ready once the next Bitcoin blocks settle it. Nothing has moved.`,
  // The amount not typed, while it follows the book's price now: an estimate, said as one.
  about: 'about',
  // Review, while the sources are asked for terms they hold to: the amount shown is the estimate.
  pricing: 'Getting the exact price…',
  // Still at it past the makers' window: the wallet is checking the price it was given.
  pricingLong: 'Still getting the exact price: this can take up to half a minute…',
  // The steps of a trade with BTC, in the order they happen, for the progress shown while it runs
  // (tradeSteps). `a` names the asset traded for BTC.
  stepsTitle: 'Your trade, step by step',
  pricingTitle: 'Getting your price',
  closeProgress: 'Close',
  closeHint: 'Closing this stops nothing: the trade goes on, and Your trades follows it.',
  stepReadyBtc: 'Getting ready to receive your BTC',
  stepFirm: 'Asking for a firm price (this can take up to a minute)',
  stepCheck: 'Checking the price and the fees',
  stepPriced: 'Price ready: check it and confirm',
  stepSendAsset: (a) => `Sending your ${a}`,
  stepWaitBtc: 'Waiting for your BTC',
  stepReadyAsset: (a) => `Getting ready to receive your ${a}`,
  stepWaitOther: (a) => `Waiting for the other side to send your ${a}`,
  stepFinal: (a) => `Waiting for your ${a} to be confirmed on the network`,
  stepSendBtc: 'Sending your BTC',
  stepTakeAsset: (a) => `Receiving your ${a}`,
  stepFinish: 'Finishing the trade',
  stepDone: 'Done',
  stepBack: (a) => `Nothing was traded: your ${a} is back`,
  // BTC held at the wallet's address, which a trade cannot pay from until the wallet has moved it
  // where trades pay BTC from (the Bitcoin ark): a move confirmed by `blocks` Bitcoin blocks (no
  // time: Bitcoin's blocks keep none).
  btcMoving: (blocks) => `Your BTC is being moved so it can be traded. It is ready after ${btcBlocks(blocks)}. Nothing has moved yet.`,
  btcMore: (blocks) => `More of your BTC is being moved so it can be traded, ready after ${btcBlocks(blocks)}.`,
  priceMoved: 'The price moved. Here is the new one.',
  // What is paid waits for the network to settle it first, and the wallet has not said how long:
  // the trade goes ahead by itself after, and no time is promised until the wallet says one.
  settling: 'Goes through by itself once what you pay is ready',
  // A ticket accepted before what it pays is settled: the book's price now, and the least it goes
  // for once settled, its fees taken; less than that and it comes back.
  atLeast: (x) => `You receive at least ${x} after fees, or the trade comes back and nothing is traded.`,
  goesThrough: (minutes) => (minutes <= 1 ? 'Goes through in about a minute' : `Goes through within about ${minutes} minutes`),
  goesThroughLate: 'Taking longer than usual: this goes ahead by itself, or is returned with nothing traded',
  settleLate: 'This is taking longer than usual. Nothing has moved, and your money stays in your wallet.',
  // What is paid is held on the chain, and no order there takes it: the wallet moves it in first
  // (and settles first what else pays with it) and the trade then goes ahead by itself, at this
  // price or better. `n`: the minutes all of that takes, one wait (the ticket's).
  bringIn: (n) => (n <= 1 ? 'Goes through in about a minute' : `Goes through within about ${n} minutes`),
  // A trade confirmed while what it pays was settled first, whose price then moved past what was
  // accepted: nothing traded, said as an expired price is.
  returnedMoved: 'Returned: nothing traded. The price moved while it waited.',
  // A trade that waited for its coins (or its money moved in) past the most it was to wait.
  returnedLate: 'Returned: nothing traded. It took too long to get ready.',
  // A trade that waited for its coins, whose coins were no longer the wallet's to pay with once
  // through (spent by another payment, or another device of the wallet).
  returnedGone: 'Returned: nothing traded. Your wallet no longer holds what it was to pay.',
  // A trade paid with money moved in first, whose move the network would not take (too little of
  // it to move once its fee is paid, or not taken at all): nothing traded.
  returnedRefused: 'Returned: nothing traded, and your money stays in your wallet. You can send it to an address.',
  // Paid with money that arrived on the chain and cannot be moved to trade: too little of it to move
  // once its fee is paid (`dust`), or an asset traded only on the chain, where nobody offers it now.
  // It can be sent all the same.
  chainDust: (pay) => `This ${pay} arrived in too small an amount to trade yet. You can send it, and once more arrives you can trade it.`,
  chainStays: (pay) => `Nobody offers to trade this ${pay} now. You can send it.`,
  // What it pays is held on the chain and frozen by its issuer for this wallet (a supervised asset):
  // it stays where it is until the issuer lifts the freeze. `amount`: the frozen amount and its
  // ticker; `most`: what the rest of the holding trades now, less the fees kept back, when it trades any.
  chainFrozen: (amount, most) => `${amount} is frozen by its issuer and stays where it is until the issuer lifts the freeze.` +
    (most ? ` You can trade up to ${most} now.` : '') + ' Nothing has moved.',
  sent: 'Sent',
  // A trade whose taking back waits for an answer that has not come: the wallet asks again by itself.
  sentAwaiting: 'Sent, waiting for an answer: nothing more is needed from you',
  settled: 'Settled',
  // Buying with BTC, until what is bought is held for the wallet (its round, then that round's block
  // certified): the wallet pays its BTC only then, and only an open page pays it. Closed before
  // that, nothing is traded and nothing is paid. `m`: the minutes left of the wait the library states.
  waitingOther: (m) => `Keep this page open: your BTC is paid once what you buy is held for you, within about ${m} minute${m === 1 ? '' : 's'}. Nothing has left your wallet yet. If the page closes first, nothing is traded.`,
  // The same, past the wait the library stated by SETTLE_LATE_MS.
  waitingOtherLate: 'Keep this page open: this is taking longer than usual. Your BTC is paid once what you buy is held for you, and nothing has left your wallet yet. If the page closes first, nothing is traded.',
  // Buying with BTC, the BTC being paid: seconds.
  btcPaying: 'Paying your BTC. Keep this page open a moment more.',
  // Buying with BTC, the BTC paid and its proof handed on, what was bought being collected: it comes
  // to the wallet on any device, open or not (the operator holds what claims it).
  btcCollecting: 'Paid. What you bought is arriving, and it comes to your wallet even if this page closes.',
  // A purchase of BTC whose payment is made: the BTC comes once the other side pays it out.
  btcOnItsWay: 'Paid. Your BTC is on its way.',
  // What the trade brings is the wallet's; only its settling with the network is left. One word on
  // every surface, with no time: how long settling takes is the network's, not the trade's.
  received: 'Received, settling',
  receivedSlow: 'Received, and yours to use. Settling with the network is taking longer than usual.',
  minutes: (word, n) => `${word} (${n} min)`,
  returned: 'Returned: nothing traded.',
  returnedFees: (fees) => `Returned: nothing traded. Fees of ${fees} were paid.`,
  returnedLapsed: 'Returned: nothing traded. The other side\'s offer ran out while the trade waited.',
  // A trade that settled and was then undone: it never completed on the network, so what the
  // wallet paid comes back by itself (within its exit delay, about two days), and what it was to
  // bring is not the wallet's.
  undone: 'Undone: this trade did not complete. What you paid is coming back to you, within about two days.',
  undoneWithin: (hours) => `Undone: this trade did not complete. What you paid is coming back to you, within about ${hours} hour${hours === 1 ? '' : 's'}.`,
  undoneBack: 'Undone: this trade did not complete. What you paid came back to you.',
  // A trade confirmed and being sent: the screen is free at once, the trade goes on in Open.
  sending: 'Sending…',
  failed: 'This trade could not be made. Nothing moved.',
  // A trade whose other side cannot yet give what default mode asks of every trade (that what it
  // gives comes home if the trade dies): nothing moved, and the other sides offer it again shortly.
  notYet: 'This trade isn\'t available right now. Nothing moved; try again in a few minutes.',
  recent: 'Your trades',
  openTrades: 'Open',
  pastTrades: 'Past',
  // The card over the page once a trade is sent, which follows it until it ends; and the notice the
  // page gives, wherever the person is, when a trade ends with the card closed.
  cardSent: 'Trade sent',
  cardSettled: 'Trade complete',
  cardReturned: 'Trade returned',
  cardState: 'Status',
  markDone: '✓',
  markBack: '↩',
  done: 'Done',
  viewHistory: 'View in history',
  // A transaction a trade made on a chain, opened in that chain's explorer.
  txOn: (chain) => `Transaction on ${chain}`,
  ended: (what, word) => `${what}: ${word}`,
})

function btcBlocks (n) { return Number(n) === 1 ? 'a Bitcoin block' : `${Number(n) || 2} Bitcoin blocks` }

// Whether what an open trade brings is held already, and only its settling is left: a purchase
// with BTC once the BTC is paid and the asset claimed, a sale for BTC once the BTC came, a swap once
// the maker completed it, a take once its round released the coin.
// What a trade has paid already in the asset paid, with nothing yet traded for it: the margins a
// cancel's respend left (`cancelFees`) and those of the wallet's payment to itself that made the
// coin a trade gives (`shapeFees`, the library's `pays.shapes`). Neither comes back; a trade priced
// again counts them once, in what it pays and in its fees, and one returned names them.
export function paidAlready (r) {
  return big(r && r.cancelFees) + big(r && r.shapeFees)
}

export function heldAlready (r) {
  if (!r) return false
  if (r.source === 'btc-gateway') return r.dir === 'sell' ? !!r.btcPaid : !!(r.preimage && r.receiveState === 'received')
  if (r.source === 'leaf-maker') return r.swapState === 'done'
  if (r.source === 'covenant-round') return r.takeState === 'released'
  return false
}

// What the list of trades says of one: Sent, then Settled; a trade waiting on the other side or on
// its settling says so, with the minutes it has waited once it has waited one. The same words in the
// Trade tab's Open trades, in History and on every other surface: none of them promises a time.
// The steps of a trade with BTC (source 'btc-gateway'), in the order they happen: before it is
// confirmed (`quote`, the step the price is at: 'invoice', 'firm', 'check' or 'priced'), or the
// trade's record `r` after. `name(asset)` names an asset. -> [{ key, text, state }], each state
// 'done', 'now' or 'todo'; null for a trade of another kind. A trade that came back ends at one
// step that says so.
export function tradeSteps ({ r = null, quote = null, payAsset, receiveAsset, name = (a) => a }) {
  const W = USER_WORDS
  const sell = (r ? r.dir : (receiveAsset === 'BTC' ? 'sell' : 'buy')) === 'sell'
  const asset = name(sell ? (r ? r.ticket.payAsset : payAsset) : (r ? r.ticket.receiveAsset : receiveAsset))
  const keys = sell
    ? [['invoice', W.stepReadyBtc], ['firm', W.stepFirm], ['check', W.stepCheck], ['priced', W.stepPriced],
        ['send', W.stepSendAsset(asset)], ['wait-btc', W.stepWaitBtc], ['finish', W.stepFinish], ['done', W.stepDone]]
    : [['firm', W.stepFirm], ['check', W.stepCheck], ['priced', W.stepPriced], ['ready', W.stepReadyAsset(asset)],
        ['wait-other', W.stepWaitOther(asset)], ['final', W.stepFinal(asset)], ['send-btc', W.stepSendBtc],
        ['take', W.stepTakeAsset(asset)], ['finish', W.stepFinish], ['done', W.stepDone]]
  let at
  if (!r) at = quote || keys[0][0]
  else if (r.state === 'returned' || r.state === 'failed') {
    return [{ key: 'back', text: W.stepBack(name(r.ticket.payAsset)), state: 'done' }]
  } else if (r.state === 'settled') at = 'done'
  else if (sell) at = r.state === 'confirming' ? 'send' : r.btcPaid ? 'finish' : 'wait-btc'
  else if (r.state === 'confirming') at = 'ready'
  else if (r.state === 'waiting') at = r.receiveState && r.receiveState !== 'waiting' ? 'final' : 'wait-other'
  else at = !r.preimage ? 'send-btc' : r.receiveState !== 'received' ? 'take' : 'finish'
  const i = keys.findIndex(([k]) => k === at)
  return keys.map(([key, text], j) => ({ key, text, state: j < i || at === 'done' ? 'done' : j === i ? 'now' : 'todo' }))
}

// When a trade waiting to go is due, as one time (ms): the later of the end of its move in (a trade
// paid with money moved in first: its ticket's minutes from when it was confirmed) and what the
// library last said its coins are final by (`finalBy`). null when neither is known.
export function settlingBy (r) {
  const moved = r.bringIn && r.bringMinutes ? (r.settleSince || r.at || 0) + Number(r.bringMinutes) * 60_000 : null
  if (moved == null) return r.finalBy ?? null
  return r.finalBy != null && r.finalBy > moved ? r.finalBy : moved
}

export function tradeStateWord (r, now = Date.now()) {
  const W = USER_WORDS
  if (r.state === 'settled') return W.settled
  if (r.state === 'undone') {
    if (r.undoneBack) return W.undoneBack
    // The time true for it: until its coin can be claimed home, and a little for the claim.
    const left = r.claimFrom ? r.claimFrom * 1000 + 600_000 - now : null
    return left != null && left > 0 && left < 2 * 86_400_000 ? W.undoneWithin(Math.max(1, Math.ceil(left / 3_600_000))) : W.undone
  }
  if (r.state === 'returned' && (r.feesPaid || []).length) return null
  if (r.state === 'returned' && r.whyKind === 'lapsed') return W.returnedLapsed
  if (r.state === 'returned' && r.whyKind === 'moved') return W.returnedMoved
  if (r.state === 'returned' && r.whyKind === 'refused') return W.returnedRefused
  if (r.state === 'returned' && r.whyKind === 'late') return W.returnedLate
  if (r.state === 'returned' && r.whyKind === 'gone') return W.returnedGone
  // Confirmed, and what it pays being settled first (or moved in first): it goes ahead by itself once
  // through, within one wait (settlingBy: the later of the move's minutes and what the library last
  // said), and past that by two minutes, that it takes longer.
  if (r.state === 'settling') {
    const by = settlingBy(r)
    if (by == null) return W.settling
    return now > by + 120_000 ? W.goesThroughLate : W.goesThrough(Math.max(1, Math.ceil((by - now) / 60_000)))
  }
  if (r.state === 'returned' || r.state === 'failed') return W.returned
  if (r.state === 'confirming') return W.sending
  const since = (t) => Math.floor((now - (t || r.at || now)) / 60000)
  // Buying with BTC: nothing has left the wallet until its asset is held for it, within the wait the
  // library states (waitBy, from lightning_receive_ready); before its first answer, the library's
  // figure for the operator's next round (waitFirstBy, or the defaults' when the operator was not read).
  if (r.state === 'waiting') {
    const by = (r.waitBy && r.waitBy.finalBy) ?? r.waitFirstBy ?? ((r.waitingSince ?? r.at ?? now) + settleMinutesOf(null) * 60_000)
    return now > by + SETTLE_LATE_MS ? W.waitingOtherLate : W.waitingOther(Math.max(1, Math.ceil((by - now) / 60_000)))
  }
  const m = since(r.sentAt)
  // Received, its settling still waiting with the network after ten minutes (the network had no
  // room for it yet): said so, the coins being the wallet's all along.
  const held = heldAlready(r)
  const word = held ? (m >= SLOW_SETTLE_MIN && (r.settleState || []).some((x) => x && x !== 'released') ? W.receivedSlow : W.received)
    : r.source === 'btc-gateway' && r.dir === 'sell' ? W.btcOnItsWay
      : r.source === 'btc-gateway' && r.dir === 'buy' ? (r.preimage && r.posted ? W.btcCollecting : W.btcPaying)
        : r.awaiting ? W.sentAwaiting : W.sent
  return m >= 1 ? W.minutes(word, m) : word
}

// The fees a ticket counts, as one line: each fee in the asset it is paid in, summed per asset.
// `fmt(asset, atoms)` names an amount. Fees in the asset paid come first.
export function costLine (fees, fmt, payAsset) {
  const per = new Map()
  for (const f of fees || []) { if (!f || big(f.atoms) <= 0n) continue; per.set(f.asset, (per.get(f.asset) || 0n) + big(f.atoms)) }
  if (!per.size) return USER_WORDS.noFees
  const order = [...per.keys()].sort((a, b) => (a === payAsset ? -1 : b === payAsset ? 1 : 0))
  const parts = order.map((a) => fmt(a, per.get(a)))
  // A fee known only as a bound (`most`): said as the most it can be.
  const head = (fees || []).some((f) => f && f.most && big(f.atoms) > 0n) ? USER_WORDS.feesAtMost : USER_WORDS.fees
  return `${head} ${parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0]}, ${USER_WORDS.included}`
}

// The pickers' order: BTC first whatever is held, then what the wallet holds, then the rest,
// each group by name.
export function pickerOrder (assets, held, name) {
  const nm = (a) => String((name && name(a)) || a)
  const rest = (assets || []).filter((a) => a !== 'BTC')
  const h = rest.filter((a) => big(held && held(a)) > 0n).sort((a, b) => nm(a).localeCompare(nm(b)))
  const o = rest.filter((a) => !(big(held && held(a)) > 0n)).sort((a, b) => nm(a).localeCompare(nm(b)))
  return ['BTC', ...new Set([...h, ...o])]
}

// What the library can pay now, per asset, out of round: its live coins, less the coin of every
// open offline-refresh plan, which the library never spends outside a round. With `waiting`, also
// every coin given up in a refresh still waiting for a round (`refresh_waiting`): a trade takes
// that refresh back first and pays with the coin, and its quote prices it so.
// What a payment the library refused for want of funds is short by, in atoms of the asset paid: what
// it takes with its margins less what the wallet holds, or the operator's smallest leaf when the
// change would fall below it (paying that much less leaves change of at least that). 0n otherwise.
export function shortBy (message) {
  const m = String(message || '')
  const s = m.match(/holds (\d+) of asset \S+ in live coins, and paying \d+ takes (\d+)/)
  if (s) return BigInt(s[2]) > BigInt(s[1]) ? BigInt(s[2]) - BigInt(s[1]) : 0n
  const d = m.match(/change would be below the operator's smallest leaf in asset \S+ \((\d+) atoms\)/)
  return d ? BigInt(d[1]) : 0n
}

// The most the wallet can pay now of what a payment of `paying` atoms was refused for, by the
// library's own refusal of it: short of what it takes with its margins ("the wallet holds H … in live
// coins, and paying P takes T with the margins": P less what it is short), or leaving change below the
// operator's smallest leaf ("… smallest leaf in asset … (M atoms): pay a little less, or that much
// more": P less M). -> atoms (0n when nothing can go), or null for any other refusal.
export function ownShortMost (message, paying) {
  const short = shortBy(message)
  if (!(short > 0n)) return null
  const m = String(message || '').match(/paying (\d+) takes/)
  const p = m ? BigInt(m[1]) : big(paying)
  if (!(p > 0n)) return null
  return p > short ? p - short : 0n
}

// The same from the refusal itself: the library's own figure (`most`, which it gives with both
// refusals) when it carries one; else, from a library that does not carry it yet, read from its words.
export function refusalMost (e, paying) {
  if (e && e.most != null && /^\d+$/.test(String(e.most))) return BigInt(e.most)
  return ownShortMost(e && e.message, paying)
}
// The exact amount that pays with nothing left over, by the library's refusal (its `all`): above
// `most`, and the amounts between the two leave change too small to keep, so it is offered only as
// "all of it" (the Max button), never as "up to". -> atoms, or null when it does not say.
export function refusalAll (e) {
  return e && e.all != null && /^\d+$/.test(String(e.all)) ? BigInt(e.all) : null
}
// What the margins of the coins a payment takes come to, by the library's refusal of it for want of
// them ("paying P takes T with the margins": T less P). -> atoms, or null when it does not say.
export function refusalMargins (e) {
  const m = String(e && e.message).match(/paying (\d+) takes (\d+)/)
  return m && BigInt(m[2]) >= BigInt(m[1]) ? BigInt(m[2]) - BigInt(m[1]) : null
}
// The give asked of a maker for its want to be `want` at the entry's rate: the most whose want
// (ceil(give × rate_num / rate_den), as the maker prices it) is not above `want`. -> atoms.
export function giveFor (entry, want) {
  return (big(want) * entry.rateDen) / entry.rateNum
}
// What the wallet holds in live coins, by the library's refusal of a payment short of its margins:
// its own figure (`live`), else from its words. -> atoms, or null when it does not say.
export function refusalLive (e) {
  if (e && e.live != null && /^\d+$/.test(String(e.live))) return BigInt(e.live)
  const h = String(e && e.message).match(/holds (\d+) of asset \S+ in live coins/)
  return h ? BigInt(h[1]) : null
}

// The indicative entries worth asking for firm terms, best first: a source whose coin waits on
// Bitcoin blocks is chosen over one handed over in seconds only when it gives SLOW_PREMIUM_BPS
// more (chooseCandidate), so one that does not give that much more than the best such indicative
// entry is never asked; its firm terms (a take quoted by the operator) cost the person time.
export function worthFirming (ind) {
  const fast = ind.filter((x) => !SLOW_SOURCES.has(x.e.source))
  const bestFast = fast.length ? fast[0].receive : 0n
  return ind.filter((x) => !SLOW_SOURCES.has(x.e.source) || x.receive * 10000n > bestFast * (10000n + SLOW_PREMIUM_BPS))
}

export function plannedCoins (plans) {
  return new Set(((plans && plans.plans) || []).filter((p) => !/^(done|cancelled|stopped|finished)$/.test(String(p.state || ''))).map((p) => p.coin))
}
export function spendableFrom (coins, plans, { waiting = false } = {}) {
  const planned = plannedCoins(plans)
  const out = new Map()
  for (const c of coins || []) {
    // A resting order's coin is the order the person placed: a fill or a cancel spends it, no trade.
    if (!c || planned.has(c.leaf_id) || c.order === true) continue
    // Held out as spent elsewhere (another device of the wallet gave it to a round): the wallet's,
    // and not spendable now, until the library's hold ends (its coin_places says the same).
    if (c.spent_elsewhere_until != null) continue
    if (c.state !== 'live' && !(waiting && c.state === 'given' && c.refresh_waiting)) continue
    out.set(c.asset, (out.get(c.asset) || 0n) + big(c.value))
  }
  return out
}

const TRADES_KEY = 'swk.usertrade'
// The trade records kept: every unfinished trade's, always, since it is what lets a reload resume
// or return the trade; and the newest ended ones, up to KEEP_ENDED of them and KEEP_BYTES in all,
// the oldest out first. History draws its trade rows from these records, so a trade that ended
// before the newest KEEP_ENDED is no longer a row there: the coins it brought are in the balance,
// and its fill stays in the relay's trade log.
export const KEEP_ENDED = 200
export const KEEP_BYTES = 1_000_000
const ENDED_STATES = ['settled', 'returned', 'failed', 'undone']
// A composed purchase whose bitcoin step cannot be paid now says why, as any bitcoin purchase does.
const FIRST_STEP_SAYS = ['no-funds', 'btc-moving', 'wallet-busy', 'too-small', 'part-ready', 'not-ready']
// The library's states of a swap that settled and is dead: its coin coming home (`returning`), and
// home (`returned`). The page reads them; it infers nothing.
export const UNDOING_STATES = Object.freeze(['returning'])
export const UNDONE_STATES = Object.freeze(['returned'])
// A trade record as the library's swap state `swapState` makes it, or null when it changes nothing:
// undone (what was paid coming back) when the swap is dead, and undone and back once it is home.
// `ret`: the library's `return` (its `claim_from`, the median time from which the coin can be
// claimed home), kept for the row's time.
export function undoneOf (rec, swapState, ret = null) {
  if (!rec || !rec.swap) return null
  const back = UNDONE_STATES.includes(swapState)
  if (!back && !UNDOING_STATES.includes(swapState)) return null
  const claimFrom = ret && Number(ret.claim_from) > 0 ? Number(ret.claim_from) : (rec.claimFrom || null)
  if (rec.state === 'undone' && !!rec.undoneBack === back && rec.claimFrom === claimFrom) return null
  return { ...rec, state: 'undone', undoneAt: rec.undoneAt || Date.now(), undoneBack: back, claimFrom }
}
export const STORAGE_FULL = 'The trade was not made: this browser has no room left to keep its record. Nothing was signed.'
// `list` (oldest first) with its oldest ended records dropped until at most `keep` ended ones are
// left and the whole is at most `bytes` long as JSON. An unfinished record is never dropped, nor any
// record of a composed trade still open (its steps, ended or not: restricted-composed.js).
// An ended record keeps no list of what the wallet held before it (`before`, `beforeParts`): only an
// unfinished trade looks for what it brought among them. An unfinished one keeps the whole list,
// spent coins included, since the library can make a spent or lost coin live again (a plan's step
// that did not happen, a round final again). Each list is the wallet's whole coin history, so with
// them every ended record ran to about 110 KB on a wallet of weeks and the store's bound kept only
// the last eight trades (#776); a store written so is made lean at its next write.
export function boundedRecords (list0, keep, bytes) {
  const kept = openComposedIds(list0)
  const ended = (r) => ENDED_STATES.includes(r && r.state) && !kept.has(r.id)
  const list = list0.map((r) => (ended(r) && (r.before || r.beforeParts) ? lean(r) : r))
  const size = list.map((r) => JSON.stringify(r).length + 1)
  let endedLeft = list.filter(ended).length
  let total = size.reduce((a, b) => a + b, 1)
  const drop = new Set()
  for (let i = 0; i < list.length && (endedLeft > keep || total > bytes); i++) {
    if (!ended(list[i])) continue
    drop.add(i); endedLeft--; total -= size[i]
  }
  return drop.size ? list.filter((_, i) => !drop.has(i)) : list
}
function lean (r) { const { before, beforeParts, ...rest } = r; return rest }
// How long a quote waits before it asks once more for firm terms that none gave.
const FIRM_RETRY_MS = 3000
// How long the sources are given to answer for firm terms, from the moment they are asked: every
// source worth asking is asked at once, and one whose answer has not come by then is left out of
// the ticket (a late answer is let go of), so a slow maker never holds the person's price up. It
// counts from the asking, never from Review: what the wallet itself does first (reading what it
// can pay, behind whatever its library is busy with) is not taken out of a maker's time.
export const QUOTE_FIRM_MS = 8000
// How many sources are asked for firm terms at once. Each one's check runs on the wallet's library,
// one command at a time, so every source more holds the first answer back (on a phone eight took
// 2 to 5 s each, and none came within the window); and a maker holds its coins for each offer.
export const FIRM_AT_ONCE = 4
// How long, past QUOTE_FIRM_MS, the wallet's own reading of firm terms a source gave in time (the
// library's check of an offer, of a fee) may take when no other firm terms are in hand yet: the
// wallet's library answers one command at a time, and a sync it was running when the offer came
// in holds that check up. With firm terms in hand the quote ends at QUOTE_FIRM_MS; with none, it
// waits this much longer rather than refuse a price a maker gave in time.
export const QUOTE_READ_MS = 30_000
// What the wallet can pay, as last read, stands for a quote this long: a quote never waits behind
// the wallet's library to learn it (each quote reads it again behind the price). A trade confirmed
// since reads it afresh.
export const HOLDINGS_FRESH_MS = 60_000
// The longest a quote takes, whatever the wallet's library is doing, before the person is told the
// wallet is busy (the BTC desk alone gets its own window on top).
export const QUOTE_MOST_MS = 45_000
// When the BTC desk is the only source a trade can take (buying or selling BTC), its firm terms
// (an offer and a Lightning invoice) are waited for this long, not QUOTE_FIRM_MS: there is no
// other answer to take instead, and a late one was a refusal for nothing. Seen live: the desk's
// firm terms took 17 to 41 seconds, and a wait of 20 refused half the trades.
export const BTC_ONLY_FIRM_MS = 60000
// How long a refresh asked to get coins ready for a resting order is waited on before it is asked
// again: its round, and the round's block being certified.
export const READYING_MS = 10 * 60_000
// A pair offered within this long that nobody offers now: a maker reading its coins again after a
// trade quotes nothing for up to about 90 s (#698), so the wallet asks again rather than saying the
// pair is not offered, every OFFERED_AGAIN_EVERY_MS.
export const OFFERED_AGAIN_MS = 3 * 60_000
export const OFFERED_AGAIN_EVERY_MS = 5000
// The longest a trade that settles first waits for its coins, when the library has not said how
// long they take, before it comes back with nothing traded.
export const SETTLE_MOST_MS = 10 * 60_000
// The library says how long a settle still takes at most (`settle_first`'s `final_in_seconds`): a
// settle waits twice that and this margin when that is longer than SETTLE_MOST_MS.
export const SETTLE_MARGIN_MS = 120_000
// A trade whose coins must settle first is shown at the book's price now, before any source can
// hold firm terms for it (a firm price needs coins the wallet can spend): it goes by itself once
// they are through only for at least the amount its ticket names, which is the book's price less
// the fees last seen for the asset paid, less this slack in parts per ten thousand of it.
export const SETTLE_SLACK_BP = 100n
export function settleBound (finalInSeconds) {
  const s = Number(finalInSeconds)
  return Number.isFinite(s) && s > 0 ? Math.max(SETTLE_MOST_MS, 2 * s * 1000 + SETTLE_MARGIN_MS) : SETTLE_MOST_MS
}
// The book's entries read while the amount was typed stand for the quote this long.
const ENTRIES_FRESH_MS = 8000
// The states of a coin held by something under way (a live one here is planned for a refresh).
const BUSY_STATES = ['given', 'offered', 'sending', 'forfeited', 'receiving', 'paying', 'live']
// How far, as a factor either way, an entry's price may be from the price feed's and stand.
const FEED_REACH = 2
// The least time between two syncs the engine asks for.
const SYNC_EVERY_MS = 10000
// Minutes after which a received trade still settling is said to be slow.
const SLOW_SETTLE_MIN = 10

// The library's commands the engine runs that only read, which it runs one after another for a
// quote or a pass over its trades: each asks the library to answer from a look at the chain made
// a moment ago (shared_view) rather than its own, which a wallet on a slow link pays a round trip
// for. Every command that takes a coin, signs or broadcasts looks first, whatever it is asked.
export const SHARED_VIEW_READS = new Set(['info', 'coins', 'plans', 'participations', 'swaps', 'balance', 'swap_read', 'take_quote',
  'settle_quote', 'quote', 'order_fill_resting_quote', 'order_cancel_resting_quote'])

export function createEngine (deps) {
  // The node scans one wallet at a time; a command that meets another's scan is asked again
  // (the library's own words; nothing else is retried).
  const run = async (cmd, args) => {
    const a = SHARED_VIEW_READS.has(cmd) ? { ...(args || {}), shared_view: true } : (args || {})
    for (let i = 0; ; i++) {
      const t0 = now()
      try { const v = await deps.leaves.command(cmd, a); if (now() - t0 > 2000) log(`[user trade] ${cmd} took ${now() - t0} ms`); return v } catch (e) {
        if (now() - t0 > 2000) log(`[user trade] ${cmd} took ${now() - t0} ms, refused`)
        if (i < 8 && /Scan already in progress/.test(String(e && e.message))) { await sleep(500 + 500 * i); continue }
        throw e
      }
    }
  }
  const now = () => (deps.now ? deps.now() : Date.now())
  const firmMs = deps.quoteFirmMs || QUOTE_FIRM_MS
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = deps.log || (() => {})
  const key = () => TRADES_KEY + '.' + (deps.tag ? deps.tag() : 'default')

  // Orders the operator refused to take as not final yet (its chain does not yet hold their
  // transaction as final, whatever the wallet's node says): not offered again for a while.
  const NOT_FINAL_MS = 15 * 60 * 1000
  const nfKey = () => key() + '.notfinal'
  function notFinal () { try { const m = JSON.parse(deps.store.getItem(nfKey()) || '{}'); for (const k of Object.keys(m)) if (m[k] <= now()) delete m[k]; return m } catch { return {} } }
  function markNotFinal (id) { const m = notFinal(); m[id] = now() + NOT_FINAL_MS; try { deps.store.setItem(nfKey(), JSON.stringify(m)) } catch {} }

  function records () { try { return JSON.parse(deps.store.getItem(key()) || '[]') } catch { return [] } }
  // Writes the records, bounded (`boundedRecords`). A store that refuses the write (a full
  // localStorage) is tried again with fewer ended trades kept, then with none; one that refuses
  // even that refuses the trade: `confirm` writes the record before anything is signed, so a trade
  // whose record cannot be kept is never signed.
  function save (list) {
    const keep = deps.keepEnded ?? KEEP_ENDED, bytes = deps.keepBytes ?? KEEP_BYTES
    let refused
    for (const [k, b] of [[keep, bytes], [Math.floor(keep / 4), Math.floor(bytes / 4)], [0, 0]]) {
      try { deps.store.setItem(key(), JSON.stringify(boundedRecords(list, k, b))); return } catch (e) { refused = e }
    }
    log('[user trade] the trade records could not be written:', refused && refused.message)
    const e = new Error(STORAGE_FULL); e.code = 'storage-full'; throw e
  }
  // A record's first write in an ended state stamps when it ended (`endedAt`), whichever way it
  // ended: the Trade tab keeps an ended trade while the page that saw it end is open, and one with
  // no time of its end left the list at once.
  function put (rec) { if (ENDED_STATES.includes(rec && rec.state) && !rec.endedAt) rec.endedAt = now(); const l = records(); const i = l.findIndex((r) => r.id === rec.id); if (i >= 0) l[i] = rec; else l.push(rec); save(l); return rec }
  const btcT = btcTrades({ run, deps, put, log, now, settleStep: (rec) => settleStep(rec), maxFeePpm: MAX_FEE_PPM, firmMarginMs: FIRM_MARGIN_MS })

  // A wallet that holds no leaves (it joined no operator) can pay nothing from them.
  async function spendable () {
    let coins
    // The coins the wallet holds as its store has them (`held`, `brief`: no read of the chain), and
    // in full only when one is given up in a refresh, whose waiting the full read names: a full
    // read of every coin asks the node for each, and queued behind other work it held quotes for
    // minutes.
    try {
      coins = await run('coins', { held: true, brief: true })
      if ((coins || []).some((c) => c && c.state === 'given')) coins = await run('coins', { held: true })
    } catch (e) { log('[user trade] no leaves:', e && e.message); return new Map() }
    const plans = await run('plans').catch(() => ({ plans: [] }))
    const sp = spendableFrom(coins, plans, { waiting: true })
    holdings = { sp, at: now() }
    return sp
  }
  // What the wallet can pay, as last read (HOLDINGS_FRESH_MS), and a reading under way.
  let holdings = null
  let holdingsRead = null
  function readHoldingsSoon () {
    if (!holdingsRead) holdingsRead = spendable().catch(() => null).finally(() => { holdingsRead = null })
    return holdingsRead
  }
  // What the wallet can pay for a quote: the last reading while it is fresh (read again behind
  // the quote, never ahead of it), else a reading now. A reading too high is caught by the source's
  // own check (the library refuses what the coins cannot pay, and the firm terms are asked again
  // for less); the person never waits on the library's queue to learn it.
  async function spendableForQuote () {
    if (holdings && now() - holdings.at < HOLDINGS_FRESH_MS) {
      const sp = holdings.sp
      readHoldingsSoon()
      return sp
    }
    return (await readHoldingsSoon()) || spendable()
  }

  // The candidates' entries for a directed pair, from every admitted source.
  async function entries (payAsset, receiveAsset, sources) {
    const out = []
    // A maker quotes in-tree swaps, and, with a Bitcoin Lightning node, BTC in one hash-lock.
    if (sources.includes('leaf-maker') || (sources.includes('btc-gateway') && deps.btc)) {
      // Every maker at once: one that does not answer costs its own wait, not the others'.
      const got = await Promise.all((deps.makers ? deps.makers() : []).map(async (m) => {
        try {
          const q = await deps.fetchJson(m + '/v1/quotes')
          const es = makerEntries(m, q.quotes, { payAsset, receiveAsset }).filter((e) => sources.includes(e.source))
          // Every pair the maker offers now, not only the one asked: a pair asked next that it
          // offered a moment ago and offers not now is asked again (OFFERED_AGAIN_MS), not refused.
          for (const x of q.quotes || []) if (x && x.want_asset && x.give_asset && big(x.max_give || 0) > 0n) offeredAt.set(x.want_asset + '>' + x.give_asset, now())
          // A pair the maker takes more of only after its next round, its quotes cut to nothing.
          if ((q.after_next_round || []).some((x) => x && x.give_asset === receiveAsset && x.want_asset === payAsset)) es.soon = true
          return es

        } catch (e) { log('[user trade] maker', m, 'did not answer:', e && e.message); return [] }
      }))
      for (const g of got) { out.push(...g); if (g.soon) out.soon = true }
    }
    const onchain = sources.includes('onchain-fill') && deps.onchain
    const wantBook = (sources.includes('covenant-round') || sources.includes('leaf-resting') || onchain) && deps.relayBook
    const book = wantBook ? await Promise.resolve(deps.relayBook(payAsset, receiveAsset)).catch((e) => { log('[user trade] the book did not answer:', e && e.message); return [] }) : []
    if (sources.includes('leaf-resting') && book.length) {
      // Only orders resting in the tree of the operator the wallet joined.
      const operator = await operatorInfo().then((i) => i && i.operator)
      out.push(...restingEntries(book, { payAsset, receiveAsset, operator }))
    }
    if (onchain && book.length) out.push(...onchainFillEntries(book, { payAsset, receiveAsset }))
    if (sources.includes('covenant-round') && deps.relayBook) {
      try {
        const nf = notFinal()
        for (const e of covenantRoundEntries(book, { payAsset, receiveAsset })) {
          if (nf[e.id]) { log('[user trade] not offered: the operator holds order', e.id, 'not final yet'); continue }
          // What the order can be filled for now: the relay's status of it (statuses[i] of
          // offers[i]; the signed offer_amount overstates it after a part fill), else the chain.
          const active = e.raw && e.raw._status && e.raw._status.active_amount
          if (active != null) {
            e.maxReceive = big(active)
            if (e.maxReceive <= 0n) continue
          } else if (deps.outputValue) {
            const [txid, vout] = e.id.split(':')
            const v = await Promise.resolve(deps.outputValue(txid, Number(vout))).catch(() => null)
            if (v == null) continue
            e.maxReceive = big(v)
          }
          out.push(e)
        }
      } catch (e) { log('[user trade] the book did not answer:', e && e.message) }
    }
    const near = out.filter((e) => nearFeed(e, payAsset, receiveAsset))
    if (out.soon) near.soon = true
    // A pair offered a moment ago that nobody offers now is offered again shortly (#698).
    const key = payAsset + '>' + receiveAsset
    if (near.length) offeredAt.set(key, now())
    else if (offeredAt.has(key) && now() - offeredAt.get(key) < OFFERED_AGAIN_MS) near.again = true
    return near
  }

  // Whether an entry's price is within reach of the price feed's: an entry giving more than twice,
  // or less than half, of what the feed says the pay asset is worth in the receive asset is
  // mispriced at its source (a maker that read a bad price, an order posted inverted), and is
  // never shown or taken. Without a feed price for either asset, every entry stands.
  function nearFeed (e, payAsset, receiveAsset) {
    const fair = deps.fairRate ? deps.fairRate(payAsset, receiveAsset) : null
    if (!(fair > 0)) return true
    // Atoms received per atom paid, at the entry's price.
    const at = Number(e.rateDen) / Number(e.rateNum)
    const ok = at <= fair * FEED_REACH && at >= fair / FEED_REACH
    if (!ok) log('[user trade] an entry far off the price feed is left out:', e.source, e.id, 'gives', at, 'per atom against the feed\'s', fair)
    return ok
  }

  // What the operator's rounds can pay of `asset` now (its server's `fundable`), read at most every
  // five seconds; null when the server does not say. A take of a covenant order is paid to its maker
  // in the asset the person pays, from the operator's own coins in its round: a take larger than
  // that would wait for the operator, and a take cannot be called back.
  // One sync serves every trade moving on at the same time, and none runs again within
  // SYNC_EVERY_MS of the last: the library runs one command at a time, and a trade that waits
  // (a take waiting for its round) synced at every pass, so a slow node kept every quote waiting
  // behind syncs.
  let syncAsk = null
  function syncShared () {
    if (syncAsk && (syncAsk.pending || now() - syncAsk.at < SYNC_EVERY_MS)) return syncAsk.p
    const a = { at: now(), pending: true }
    a.p = run('sync').then(() => {}, (e) => log('[user trade] sync:', e && e.message)).finally(() => { a.pending = false; a.at = now() })
    syncAsk = a
    return a.p
  }

  // One `info` serves every caller for five seconds, those asking at the same time included: the
  // library runs one command at a time, and a quote asks from several candidates at once.
  let infoAsk = null
  function operatorInfo () {
    if (!infoAsk || now() - infoAsk.at > 5000) infoAsk = { at: now(), p: run('info').catch(() => null) }
    return infoAsk.p
  }
  async function operatorRoom (asset) {
    const info = await operatorInfo()
    const a = ((info && info.server_info && info.server_info.assets) || []).find((x) => x && x.asset === asset)
    return a && a.fundable != null ? big(a.fundable) : null
  }

  // The step of the price being made, for the person's progress (tradeSteps), set by quote.
  let quoteStep = null
  // Firm terms of one entry for `pay` atoms, priced by the library. -> a candidate or null.
  // What the last check of a maker's offer added to its price (the margins, and settling the change),
  // by the asset paid: the next offer of that asset is asked for that much less, so the check does
  // not send it back for a smaller one.
  const marginsSeen = new Map()
  // The offer each maker made in place of one whose completion the operator refused, by maker:
  // the next price asked of that maker for the same pair takes it rather than asking again.
  const madeAgain = new Map()
  // The quote under way's hook for a refusal of the wallet's own (its coins short now).
  let refusalSeen = null
  async function firm (entry, payAsset, receiveAsset, pay, have, until = Date.now() + firmMs, hard = until) {
    planSingleStep(entry.source, { payAsset, receiveAsset, caps: entry.source === 'covenant-round' ? { leaf_take: true } : undefined })
    // Sized on what the wallet can pay, never on more: a site asks the price of all the wallet can
    // pay with a large probe amount, and a maker asked for its whole level refuses what it does
    // not hold.
    const size = sizeEntry(entry, pay < have ? pay : have)
    if (!size) return null
    if (entry.source === 'btc-gateway') return btcT.firm(entry, payAsset, receiveAsset, pay, have, size, quoteStep, (e, at) => { if (refusalSeen) refusalSeen(e, at) })
    if (entry.source === 'leaf-resting') return firmResting(entry, payAsset, receiveAsset, pay, have, size, hard)
    if (entry.source === 'onchain-fill') return firmOnchain(entry, payAsset, receiveAsset, pay, have)
    if (entry.source === 'covenant-round') {
      // No more than the operator can pay its maker in this round now.
      const room = await operatorRoom(payAsset)
      let sized = size
      if (room != null && room < size.pay) {
        sized = room > 0n ? sizeEntry(entry, room) : null
        if (!sized) { log('[user trade] the operator cannot pay this take in a round now:', entry.id, String(room)); return null }
      }
      // The take's price and the operator's fee come from the library: size down until what it
      // gives fits what the person pays and what the wallet can pay now.
      let r = sized.receive
      const limit = pay < have ? pay : have
      for (let i = 0; i < 4; i++) {
        let q
        try { q = await run('take_quote', { order: entry.raw._relayJson || entry.raw, amount: String(r), max_fee_ppm: MAX_FEE_PPM }) } catch (e) {
          log('[user trade] take_quote:', e.message)
          noteLiveShort(e)
          // Short by the margins, or change below the smallest leaf: ask for less, by what is missing.
          const over = shortBy(e.message)
          if (over <= 0n || i >= 3) return null
          const s3 = sizeEntry(entry, (r * entry.rateNum) / entry.rateDen - over - 1n)
          if (!s3 || s3.receive >= r) return null
          r = s3.receive
          continue
        }
        // What leaves the wallet in all: the price, the operator's fee, and the margins of a
        // payment to itself when it holds no coin of exactly that much.
        let gives = big(q.spends ?? q.gives)
        // A payment to itself leaves change resting on a reassignment: it is settled in the next
        // round as part of the trade, so no coin of the wallet piles up reassignments, and that
        // fee is on the ticket too.
        let sc = null
        const ch = q.pays_itself && big(q.pays_itself.change)
        if (ch > 0n) {
          try { sc = await run('settle_quote', { asset: payAsset, value: String(ch), expiry: q.pays_itself.expiry }) } catch (e) { log('[user trade] settle_quote:', e.message); return null }
          gives += big(sc.fee)
        }
        if (gives <= limit) {
          return { source: entry.source, id: entry.id, entry, receive: big(q.filled), give: gives,
            fees: [{ asset: payAsset, atoms: big(q.fee) + (big(q.spends ?? q.gives) - big(q.gives)) + (sc ? big(sc.fee) : 0n) }], quote: q,
            settle: sc ? { change: sc } : null }
        }
        // Over by the fee: size the fill down by what the excess buys, and fit the lot rules again.
        const s2 = sizeEntry(entry, (r * entry.rateNum) / entry.rateDen - (gives - limit) - 1n)
        if (!s2 || s2.receive >= r) return null
        r = s2.receive
      }
      return null
    }
    if (entry.source === 'leaf-maker') {
      // A maker's firm offer stays counted as in hand while the wallet's library reads it: a quote
      // that ends with nothing in hand while one is still being read says the wallet was busy,
      // never that nobody gave a price (a maker answered in 2 s while the library was held for
      // five minutes by another source's command).
      const reads = makerReads, mark = {}
      try { return await firmMaker(entry, payAsset, receiveAsset, pay, have, size, until, hard, () => reads.add(mark)) } finally { reads.delete(mark) }
    }
    return null
  }

  // Firm terms of a maker's offer: asked of the maker, then read with the library. `answered` is
  // called once the maker has given an offer and its reading begins.
  async function firmMaker (entry, payAsset, receiveAsset, pay, have, size, until, hard, answered) {
    // Ask the maker for a firm offer of what the size gives, then read it with the library: what
    // the wallet gets, gives and pays, and the dates of the coin it gets.
    const lim = pay < have ? pay : have
    const guess = marginsSeen.get(payAsset) || 0n
    const fitted = guess > 0n && lim > guess ? sizeEntry(entry, lim - guess) : null
    let give = fitted ? fitted.receive : size.receive
    // The offer a maker made in place of one whose completion the operator refused (`made`): taken
    // as the maker's firm offer here, at its own size, rather than asking again.
    const made = madeAgain.get(entry.maker)
    if (made && made.give_asset === receiveAsset && made.want_asset === payAsset) { madeAgain.delete(entry.maker); give = big(made.give) }
    // Asked for at least all the coins it takes, margins in, the trade empties them: the swap pays
    // exactly what they keep past their margins (`aim`, the library's `all`), never sized down to
    // leave change. Learnt from the library's refusal (its `all`) or from terms it read (what they
    // give plus their change). When no give of the maker's answers that exactly (`aimed` tries),
    // the trade goes as it would have, and what stays is the ticket's to name.
    // `back`: the give asked again when no give pays exactly (the terms read before aiming, or, after
    // a refusal, one that pays the library's `most`, below which every amount pays).
    let aim = null, aimed = 0, back = null, tries = 4
    const aimAt = (all, margins) => {
      if (all == null || margins == null || all <= 0n || all + margins > lim || aimed > 0) return null
      const g = giveFor(entry, all)
      return g >= entry.minReceive && g <= entry.maxReceive && g > 0n ? all : null
    }
    const startAim = (all, fallback) => { back = fallback; aim = all; aimed = 1; tries += 3; give = giveFor(entry, all) }
    const dropAim = () => { aim = null; give = back }
    for (let i = 0; i < tries; i++) {
      let o
      // A maker that does not answer a firm offer by the quote's deadline is left out of it; an
      // offer asked again for less, after the wallet's check, is given the makers' time again,
      // never past `hard`. Acceptances and releases, which must complete, are never cut short.
      const askBy = i === 0 ? until : Math.min(Date.now() + firmMs, hard)
      try {
        o = i === 0 && made && made.give_asset === receiveAsset && made.want_asset === payAsset ? made
          : await deps.fetchJson(entry.maker + '/v1/firm', { method: 'POST', body: JSON.stringify({ give_asset: receiveAsset, want_asset: payAsset, give: String(give) }), signal: AbortSignal.timeout(Math.max(1000, askBy - Date.now())) })
      } catch (e) {
        log('[user trade] maker firm:', e.message)
        // The maker holds less than its quote now (its last trade spent some): ask for half.
        if (/does not hold that much|after its next round/.test(String(e.message))) {
          give = give / 2n
          if (give < entry.minReceive) return null
          continue
        }
        return null
      }
      answered()
      // Aiming at the exact amount: a maker's want off it by its rounding (or its ladder) is asked
      // again with the give moved by the difference, twice at most; then the trade goes as it would.
      if (aim != null && o.want != null && big(o.want) !== aim) {
        await releaseNow(entry.maker, o.swap)
        const d = aim - big(o.want)
        if (aimed >= 3) { log('[user trade] no give of this maker pays exactly', String(aim)); dropAim() } else {
          aimed++
          give = d > 0n ? give + ((d * entry.rateDen) / entry.rateNum || 1n) : give - ((-d * entry.rateDen + entry.rateNum - 1n) / entry.rateNum || 1n)
          if (give < entry.minReceive || give <= 0n || give > entry.maxReceive) dropAim()
        }
        if (give < entry.minReceive || give <= 0n) return null
        continue
      }
      let t
      try { t = await run('swap_read', { offer: o.offer }) } catch (e) {
        log('[user trade] swap_read:', e.message)
        noteLiveShort(e)
        // The amount asked takes all the coins it can and more: the swap pays what they keep (`all`).
        const all = aimAt(refusalAll(e), refusalMargins(e) ?? ownMargins)
        if (all != null) {
          await releaseNow(entry.maker, o.swap)
          const most = refusalMost(e)
          startAim(all, most != null && most > 0n ? giveFor(entry, most) : give - 1n)
          continue
        }
        if (aim != null) { await releaseNow(entry.maker, o.swap); dropAim(); if (give < entry.minReceive || give <= 0n) return null; continue }
        // Paying that much would take all the wallet holds, with the margins its transactions leave
        // for their fees, or leave change below the operator's smallest leaf: ask again for less, by
        // what is missing (a site's probe sizes on all the wallet can pay).
        const over = shortBy(e.message)
        if (over > 0n && i < tries - 1) {
          await releaseNow(entry.maker, o.swap)
          give = give - (over * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
          if (give < entry.minReceive) return null
          continue
        }
        release(entry.maker, o.swap); return null
      }
      // What the wallet gets: what the offer gives, less what the wallet adds to the swap's margin
      // when it pays from more coins than the maker's margin covers (the library's `tops_up`, #693),
      // shown on the ticket and in its fees.
      const topUp = big(t.tops_up && t.tops_up.asset === receiveAsset ? t.tops_up.margin : 0)
      if (t.gets.asset !== receiveAsset || t.gives.asset !== payAsset || big(t.gets.value) + topUp !== give || big(t.gets.value) <= 0n) { release(entry.maker, o.swap); return null }
      const gets = big(t.gets.value)
      const spend = big(t.gives.value) + big(t.pays.margins)
      marginsSeen.set(payAsset, big(t.pays.margins))
      const limit = pay < have ? pay : have
      // Terms that leave change while what was asked covers the coins they take whole: the swap
      // pays them all instead (what it gives plus its change), with nothing left behind.
      const kept = big(t.change && t.change.value)
      const whole = kept > 0n ? aimAt(big(t.gives.value) + kept, big(t.pays.margins)) : null
      if (whole != null) {
        await releaseNow(entry.maker, o.swap)
        startAim(whole, give)
        continue
      }
      if (spend > limit) {
        await releaseNow(entry.maker, o.swap)
        const over = spend - limit
        give = give - (over * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
        if (give < entry.minReceive) return null
        continue
      }
      // The coins the swap makes (what the wallet gets, and its change) are settled in a round
      // only when they would sit one reassignment short of the operator's limit: otherwise they
      // are the wallet's to use the moment the maker completes, and nothing waits for a round.
      // What settling costs, when it is needed, comes from the library.
      const most = await depthLimit()
      const settles = t.hops == null || most == null || Number(t.hops) >= most - 1
      let s = { asset: receiveAsset, value: String(gets), fee: '0', after: String(gets) }, sc = null
      const change = big(t.change && t.change.value)
      if (settles) {
        try {
          s = await run('settle_quote', { asset: receiveAsset, value: String(gets), expiry: t.dates && t.dates.expiry })
          if (change > 0n) sc = await run('settle_quote', { asset: payAsset, value: String(change), expiry: t.dates && t.dates.expiry })
        } catch (e) { log('[user trade] settle_quote:', e.message); release(entry.maker, o.swap); return null }
      }
      const total = spend + (sc ? big(sc.fee) : 0n)
      marginsSeen.set(payAsset, total - big(t.gives.value))
      if (total > limit) {
        // Settling the change costs too: what the trade takes in all must fit what is paid.
        await releaseNow(entry.maker, o.swap)
        give = give - ((total - limit) * entry.rateDen + entry.rateNum - 1n) / entry.rateNum - 1n
        if (give < entry.minReceive) return null
        continue
      }
      const fees = [{ asset: payAsset, atoms: big(t.pays.margins) }]
      if (topUp > 0n) fees.push({ asset: receiveAsset, atoms: topUp })
      if (settles) fees.push({ asset: receiveAsset, atoms: big(s.fee) })
      if (sc) fees.push({ asset: payAsset, atoms: big(sc.fee) })
      return { source: entry.source, id: entry.id, entry, receive: big(s.after), give: total, offer: o, terms: t,
        settle: settles ? { received: s, change: sc } : null, fees }
    }
    return null
  }

  // Firm terms of a fill of an order resting in the tree, priced by the library
  // (`order_fill_resting_quote`, from the operator's own view of the order): what leaves the wallet
  // is the coins it gives less the change, and the coins the fill brings (what it gets, and the
  // change) are settled in the next round, at the fee a coin of their expiry pays.
  // Each asking again is one library command more that every other waits behind: none is asked
  // past the quote's deadline (`hard`), nor again on a refusal the same as the last, which a
  // smaller fill did not change (four such asks held a wallet for ten minutes).
  async function firmResting (entry, payAsset, receiveAsset, pay, have, size, hard = Infinity) {
    const limit = pay < have ? pay : have
    let r = size.receive
    let lastRefusal = null
    for (let i = 0; i < 4; i++) {
      if (i > 0 && now() > hard) { log('[user trade] the resting fill is not asked again: the quote\'s time is up'); return null }
      let q
      try { q = await run('order_fill_resting_quote', { order: entry.id, amount: String(r) }) } catch (e) {
        // A fill spends only the wallet's coins no older than the order's: when those hold less
        // than the fill takes, the library says how much they hold, and the fill is sized to it.
        const m = /the outputs take (\d+) of asset \S+, more than the (\d+) the inputs hold/.exec(String(e && e.message))
        const same = m && lastRefusal === m[0]
        if (m) lastRefusal = m[0]
        if (m && BigInt(m[1]) > 0n && !same) {
          const r2 = (r * BigInt(m[2])) / BigInt(m[1]) - 1n
          const s2 = r2 > 0n ? sizeEntry(entry, (r2 * entry.rateNum) / entry.rateDen) : null
          if (s2 && s2.receive < r) { r = s2.receive; continue }
        }
        // Only coins expiring no earlier than the order's coin fill it, and the wallet's that do
        // hold too little: noted, so a quote that finds no other offer gets those coins ready.
        const old = /that expire no earlier than the order's coin \(median time (\d+)\) keep (\d+) past their checkpoints/.exec(String(e && e.message))
        if (old) tooOldFrom = Math.max(tooOldFrom || 0, Number(old[1]))
        log('[user trade] order_fill_resting_quote:', e.message); noteLiveShort(e); return null
      }
      if (!q.gets || q.gets.asset !== receiveAsset || big(q.gets.amount) !== r || !q.fee || q.fee.asset !== payAsset) { log('[user trade] the resting fill is not the one asked'); return null }
      const coins = (await run('coins')) || []
      const given = coins.filter((c) => (q.gives || []).includes(c.leaf_id))
      if (given.length !== (q.gives || []).length) return null
      const spends = given.reduce((n, c) => n + big(c.value), 0n) - big(q.change)
      const expiry = Math.min(...given.map((c) => Number(c.expiry)).filter((x) => x > 0), Number((q.served && q.served.expiry) || Infinity))
      let s, sc = null
      try {
        s = await run('settle_quote', { asset: receiveAsset, value: String(r), expiry })
        if (big(q.change) > 0n) sc = await run('settle_quote', { asset: payAsset, value: String(q.change), expiry })
      } catch (e) { log('[user trade] settle_quote:', e.message); return null }
      const total = spends + (sc ? big(sc.fee) : 0n)
      if (total <= limit) {
        return { source: entry.source, id: entry.id, entry, receive: big(s.after), give: total, quote: q,
          settle: { received: s, change: sc },
          fees: [{ asset: payAsset, atoms: spends - big(q.paid) + (sc ? big(sc.fee) : 0n) }, { asset: receiveAsset, atoms: big(s.fee) }] }
      }
      const s2 = sizeEntry(entry, (r * entry.rateNum) / entry.rateDen - (total - limit) - 1n)
      if (!s2 || s2.receive >= r) return null
      r = s2.receive
    }
    return null
  }

  // Firm terms of a covenant order taken on the chain: the FILL's own amounts (covenant-order.js
  // plans them exactly, as the taker's transaction must pay them) and one fill's network fee, in
  // the asset the wallet pays fees in. What leaves the wallet is the price, plus the fee when it is
  // paid in the same asset.
  async function firmOnchain (entry, payAsset, receiveAsset, pay, have) {
    let fee
    try { fee = await deps.onchain.fee(payAsset) } catch (e) { log('[user trade] on-chain fee:', e.message); return null }
    if (!fee || !fee.asset || big(fee.atoms) <= 0n) return null
    const sameFee = fee.asset === payAsset
    let limit = (pay < have ? pay : have) - (sameFee ? big(fee.atoms) : 0n)
    for (let i = 0; i < 4 && limit > 0n; i++) {
      const size = sizeEntry(entry, limit)
      if (!size) return null
      const c = entry.raw.covenant || entry.raw.Covenant
      const matched = { offer_id: entry.raw.offer_id, resting_is_covenant: true, covenant: c, covenant_locked: String(entry.maxReceive), fill_base_amount: String(size.receive) }
      let recipe
      try { recipe = planFillFromMatched(matched, null, {}) } catch (e) { log('[user trade] the order cannot be filled:', e.message); return null }
      // A covenant names its assets in the chain's internal byte order, the wallet in display order.
      const internal = (h) => String(h).match(/../g).reverse().join('')
      if (recipe.covenantAsset !== internal(receiveAsset) || recipe.creditAsset !== internal(payAsset)) { log('[user trade] the order does not sell what it is listed as selling'); return null }
      const price = big(recipe.creditValue)
      const give = price + (sameFee ? big(fee.atoms) : 0n)
      if (give <= (pay < have ? pay : have)) {
        return { source: entry.source, id: entry.id, entry, receive: size.receive, give, matched, price,
          fees: [{ asset: fee.asset, atoms: big(fee.atoms) }], fee }
      }
      limit -= give - (pay < have ? pay : have)
    }
    return null
  }

  function release (maker, swap) {
    if (!maker || !swap) return
    Promise.resolve(deps.fetchJson(maker + '/v1/release', { method: 'POST', body: JSON.stringify({ swap }) })).catch(() => {})
  }
  // A firm offer let go of before the maker is asked again for a smaller one: the maker holds its
  // coins for an offer until it is released, and refuses a second offer they would have paid.
  async function releaseNow (maker, swap) {
    if (!maker || !swap) return
    try { await deps.fetchJson(maker + '/v1/release', { method: 'POST', body: JSON.stringify({ swap }) }) } catch {}
  }

  // A firm answer within `ms`, or null: a source that answers later is let go of (drop), so the
  // offer it holds frees the maker's coins.
  // The firm terms of `ps` (each a candidate or null) once all are in, or at `soft` (ms, wall
  // clock) when one is in hand, or at `hard` whatever is in: the sources' own deadline is `soft`
  // (a maker asked is cut off then), and what the wallet reads of an answer that came in time may
  // run to `hard` while nothing else is in hand. One that comes later is let go of.
  function firmsBy (ps, soft, hard) {
    return new Promise((resolve) => {
      const got = []
      let left = ps.length, done = false, softTimer = null, hardTimer = null
      const finish = () => {
        if (done) return
        done = true; clearTimeout(softTimer); clearTimeout(hardTimer)
        resolve(got.slice())
      }
      if (!left) return finish()
      ps.forEach((p) => Promise.resolve(p).then((c) => c, (e) => { log('[user trade] firm:', e && e.message); return null }).then((c) => {
        left--
        if (done) { if (c) { log('[user trade] a source answered after the quote, let go:', c.source); drop(c) } return }
        if (c) got.push(c)
        if (!left || (c && Date.now() >= soft)) finish()
      }))
      softTimer = setTimeout(() => { if (got.length) finish() }, Math.max(0, soft - Date.now()))
      hardTimer = setTimeout(finish, Math.max(0, hard - Date.now()))
    })
  }

  // Lets go of a priced choice that is not taken: the maker's held offer, and the wallet's own
  // Bitcoin invoice for it.
  function drop (c) {
    if (!c) return
    if (c.source === 'composed') { drop(c.first); return }
    if (c.offer) release(c.entry.maker, c.offer.swap)
    if (c.btc) {
      btcT.release(c.entry.maker, c.btc.offer && c.btc.offer.swap)
      if (c.btc.invoice && deps.btc) Promise.resolve(deps.btc.cancelInvoice(c.btc.invoice.payment_hash)).catch(() => {})
    }
  }

  // The ticket for paying `amount` atoms of `payAsset` for `receiveAsset`.
  // -> { ok: true, ticket: { payAsset, receiveAsset, amountIn, amountOut, fees, upTo? }, choice }
  //  | { ok: false, why: 'not-listed'|'not-offered'|'no-funds'|'not-ready'|'redoing'|'busy'|'freeing'|'readying'|'too-small'|'no-firm-offer',
  //      soon? } (soon: what is not ready yet is ready in a minute or two)
  //  | { ok: false, why: 'part-ready', ready } (atoms payable now, too few for any offer)
  // What can be received for `payAsset` in one step now: each admitted pair's asset that some
  // source in the book offers, whatever the wallet holds. BTC counts only with the wallet's
  // Bitcoin Lightning (the gateway pays it there).
  async function offered (payAsset) {
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const chain = ad.pairs && ad.pairs.chains && ad.pairs.chains[ad.genesis]
    const pairs = ((chain && chain.pairs) || []).filter((p) => p.pay === payAsset && p.receive !== payAsset && (p.sources || []).length)
    const found = await Promise.all(pairs.map((p) => entries(payAsset, p.receive, p.sources)
      .then((es) => es.some((e) => e.source !== 'btc-gateway' || deps.btc) ? p.receive : null).catch(() => null)))
    return [...new Set(found.filter(Boolean))]
  }

  // Indicative terms in either direction, for the two amounts while a person types: the book's
  // best single-step source for paying `pay`, or the least paid to receive `receive`. No maker is
  // asked for firm terms (a firm offer holds the maker's coins); Review does that, fees and all.
  // The book's entries are read once every few seconds per pair.
  // -> { ok: true, pay, receive, short: { pay, receive, soon? } | null (the most one source fills
  //       now; `soon` when a maker takes more after its next round) }
  //  | { ok: false, why: 'not-listed'|'not-offered'|'soon'|'too-small' }
  const estimates = new Map()
  // When each directed pair (pay>receive) last had an entry: see OFFERED_AGAIN_MS.
  const offeredAt = new Map()
  async function estimate ({ payAsset, receiveAsset, pay, receive }) {
    // While the amount is typed, what the wallet can pay is read behind it, so Review finds it.
    if (payAsset !== 'BTC' && (!holdings || now() - holdings.at > 10_000)) readHoldingsSoon()
    // A pair with a restricted asset: its price for what is paid, else nothing said while typing
    // (Review says what the trade needs: an approval, another asset to pay with).
    if (deps.restricted && (await deps.restricted.available()) && [payAsset, receiveAsset].some((a) => a !== 'BTC' && deps.restricted.isRestricted(a))) {
      if (!pay) return { ok: false, why: 'restricted' }
      const rq = await restrictedQuote(deps.restricted, { payAsset, receiveAsset, amount: pay }).catch(() => null)
      return rq && rq.ok ? { ok: true, pay: rq.ticket.amountIn, receive: rq.ticket.amountOut, short: null } : { ok: false, why: 'restricted' }
    }
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const sources = admittedSources(ad.pairs, ad.genesis, payAsset, receiveAsset)
    if (!sources.length) return { ok: false, why: 'not-listed' }
    const key = payAsset + '>' + receiveAsset
    let c = estimates.get(key)
    if (!c || now() - c.at > 8000) {
      c = { at: now(), es: await entries(payAsset, receiveAsset, sources).catch(() => []) }
      estimates.set(key, c)
    }
    const es = c.es.filter((e) => (e.source !== 'btc-gateway' || deps.btc) && big(e.maxReceive) > 0n)
    // A maker that takes more only after its next round (its instant budget is spent for now).
    const soon = !!c.es.soon || es.some((e) => e.soon)
    if (!es.length) return behindBtc({ ok: false, why: soon ? 'soon' : 'not-offered', ...(c.es.again ? { again: true } : {}) }, payAsset)
    const cdiv = (a, b) => (a + b - 1n) / b
    let most = null
    for (const e of es) { const r = big(e.maxReceive); if (!most || r > most.receive) most = { receive: r, pay: cdiv(r * e.rateNum, e.rateDen) } }
    const out = (p, r, short) => ({ ok: true, pay: String(p), receive: String(r), short: short ? { pay: String(most.pay), receive: String(most.receive), ...(soon ? { soon: true } : {}) } : null })
    if (pay != null) {
      const A = big(pay)
      if (A <= 0n) return { ok: false, why: 'too-small' }
      let best = null
      for (const e of es) { const s = sizeEntry(e, A); if (s && (!best || s.receive > best.receive)) best = { ...s, e } }
      if (!best) return { ok: false, why: 'too-small' }
      // Short only when the source cannot take the whole amount (its size or its lot rules): what
      // the price's rounding leaves of the amount, less than one atom of what is received, is not.
      return out(A, best.receive, best.receive < (A * best.e.rateDen) / best.e.rateNum)
    }
    const R = big(receive)
    if (R <= 0n) return { ok: false, why: 'too-small' }
    let best = null
    for (const e of es) {
      if (R > big(e.maxReceive) || R < big(e.minReceive || 0)) continue
      const p = cdiv(R * e.rateNum, e.rateDen)
      if (!best || p < best) best = p
    }
    if (best != null) return out(best, R, false)
    return R > most.receive ? out(most.pay, most.receive, true) : { ok: false, why: 'too-small' }
  }

  // What a person is waiting on comes first: while a quote or a confirmation runs, no trade is moved
  // on (advance), so the library's one-at-a-time queue holds no follow-up of another trade (a sync of
  // many seconds on a slow link) ahead of it. The trades move on at the next pass after it.
  let asked = 0
  // The wallet's own upkeep waits too, for the whole of it, not only while a command runs: a sync
  // started between the steps of a quote (while a maker answers) held the next step for its whole
  // length (deps.leaves.hold, leaves.js asking).
  // The least expiry (median time) a resting order's coin asked of the wallet's coins in this
  // quote, when one refused them for expiring sooner; null otherwise.
  let tooOldFrom = null
  // Whether a source's check in this quote found the wallet's coins of the asset paid not live
  // now (held in a refresh, received and not yet settled): the trade waits on them, and is said to.
  let liveShort = false
  // What a source's check in this quote found waiting only for a round (the library's `settle_first`:
  // coins at the operator's depth limit, too deep to give part of, arriving, or of a format the other
  // side does not read), with the coins it named: the trade settles them first, and goes.
  let settleSeen = null
  // The wallet's own shortfall a source's check met (`ownShortMost`): what it could pay at most.
  // `ownAll`: what the trade pays in all, the margins in, when it pays the library's `all` (the
  // exact amount that empties the coins it takes): the person's figure is all-in everywhere.
  let ownMost = null, ownLive = null, ownAll = null, ownMargins = null
  const noteLiveShort = (e, at = {}) => {
    const most = refusalMost(e, at.paying)
    if (most != null && (ownMost == null || most > ownMost)) ownMost = most
    const m = refusalMargins(e)
    if (m != null) ownMargins = m
    const all = refusalAll(e)
    if (all != null && ownMargins != null && (ownAll == null || all + ownMargins > ownAll)) ownAll = all + ownMargins
    // What the refusal says the wallet holds in live coins (absent for the change's refusal).
    const live = refusalLive(e)
    if (live != null) ownLive = live
    if (/ in live coins/.test(String(e && e.message))) liveShort = true
    if (e && e.kind === 'settle_first') {
      settleSeen = { coins: [...new Set([...(settleSeen ? settleSeen.coins : []), ...(e.coins || [])])],
        // How long the library says those coins wait (its refusal's own reading), the longest seen.
        wait: e.final_in_seconds != null && (!settleSeen || !settleSeen.wait || Number(e.final_in_seconds) > Number(settleSeen.wait.final_in_seconds))
          ? { final_in_seconds: e.final_in_seconds, usual_in_seconds: e.usual_in_seconds, waiting_for: e.waiting_for } : settleSeen && settleSeen.wait }
    }
  }
  // The BTC desk's check of the wallet's own payment reports here too (#666).
  refusalSeen = noteLiveShort
  // The makers' firm offers of this quote that came in and are still being read by the wallet's
  // library (one mark each): a new set every quote, so a reading a past quote let go of never counts.
  let makerReads = new Set()
  // When the wallet last asked a refresh of an asset's coins for a resting order (ms), so a quote
  // asked again while that round runs says so rather than asking again.
  const readyingSince = new Map()
  // Refreshes the wallet's live coins of `asset` that expire before median time `from`, in the
  // operator's next round (planned ones through their release): its new coins expire later than
  // any order resting now. Whether coins are being made ready.
  async function readyCoins (asset, from) {
    const since = readyingSince.get(asset)
    if (since && now() - since < READYING_MS) return true
    const coins = ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === asset && c.state === 'live')
    const planned = plannedCoins(await run('plans').catch(() => ({ plans: [] })))
    const old = coins.filter((c) => Number(c.expiry || 0) < from)
    if (!old.length) return false
    const kept = old.filter((c) => planned.has(c.leaf_id)).map((c) => c.leaf_id)
    const free = old.filter((c) => !planned.has(c.leaf_id)).map((c) => c.leaf_id)
    try {
      if (kept.length && deps.release) await Promise.resolve(deps.release(asset, kept))
      if (free.length) {
        const q = await run('quote', { leaves: free })
        await run('participate', { leaves: free, shown: q && q.coins })
      }
    } catch (e) { log('[user trade] getting coins ready:', e && e.message); return false }
    readyingSince.set(asset, now())
    log('[user trade] coins of', String(asset).slice(0, 8), 'refreshed for a resting order:', free.length + kept.length)
    return true
  }

  // Asks the wallet to free the live coins of `asset` an open offline-refresh plan keeps, in its
  // next round (deps.release): the library pays such a coin out of round only once a round has
  // freed it. Whether it asked. `mine`: the wallet's coins of the asset, when already read.
  async function freePlanned (asset, mine) {
    if (!deps.release) return false
    const coins = mine || ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === asset)
    const planned = plannedCoins(await run('plans').catch(() => ({ plans: [] })))
    const kept = coins.filter((c) => c.state === 'live' && planned.has(c.leaf_id)).map((c) => c.leaf_id)
    if (!kept.length) return false
    try { await Promise.resolve(deps.release(asset, kept)) } catch (e) { log('[user trade] release:', e && e.message) }
    return true
  }

  // Whether a restore is still checking the wallet's history (deps.restoring): what the wallet says is
  // on its way may be history then (arca #879), so no answer that waits on it, or names a time for
  // it, is given.
  function restoring () { try { return !!(deps.restoring && deps.restoring()) } catch { return false } }
  // The answers that promise money on its way, or a time for it.
  const PROMISES = ['settle-first', 'not-ready', 'readying', 'freeing']

  // Whether the operator calls a coin ready once its block is certified (anchor depth 0).
  function soon () {
    try { const d = deps.anchorDepth ? deps.anchorDepth() : null; return d !== null && d !== undefined && Number(d) === 0 } catch { return false }
  }

  // The answer of a quote whose pay asset waits only for a round: `coins`, the library's names of
  // what to put through it, or none (then every coin of the asset that waits for one).
  function settleFirst (payAsset, coins, held) {
    return { ok: false, why: 'settle-first', payAsset, coins: coins || [], held: String(held ?? 0n), ...(settleSeen && settleSeen.wait ? { wait: settleSeen.wait } : {}) }
  }

  // What the library's `settle_first` is asked for a trade's coins: the ones it named, else every
  // coin of the asset paid that waits for a round. The one place the engine words that ask.
  const settleArgs = (payAsset, coins) => (coins && coins.length ? { coins } : { asset: payAsset })

  // A purchase of the wallet's own paid with BTC that has not paid its BTC yet (#774): the BTC desk
  // holds what it gives for that one until it is paid, which can leave it nothing to offer meanwhile.
  function btcBuyOpen () {
    return records().find((r) => r.source === 'btc-gateway' && r.ticket && r.ticket.payAsset === 'BTC' &&
      !ENDED_STATES.includes(r.state) && !r.preimage) || null
  }
  // A price paid with BTC that nobody offers now, while such a purchase is under way: said as that,
  // never "it takes a moment" for as long as it lasts.
  function behindBtc (q, payAsset) {
    if (!q || q.ok || payAsset !== 'BTC' || !['not-offered', 'no-firm-offer', 'soon'].includes(q.why) || !btcBuyOpen()) return q
    return { ok: false, why: 'btc-ahead' }
  }

  const personWaits = (f) => async (...a) => {
    asked++
    try { return await (deps.leaves && deps.leaves.hold ? deps.leaves.hold(() => f(...a)) : f(...a)) } finally { asked-- }
  }

  // A quote ends within QUOTE_MOST_MS whatever the wallet's library is doing (longer for the BTC
  // desk alone, which is given its own window): past it the person is told the wallet is busy, in
  // plain words, and a price that comes later is let go of. Without it a library held by one long
  // command kept a quote for six minutes, and every request behind it waited too.
  async function quote (args) {
    const cap = { until: Date.now() + (deps.quoteMostMs ?? QUOTE_MOST_MS) }
    let late = false, timer = null
    const inner = quoteOnce({ ...args, cap }).then((q) => (q && !q.ok && PROMISES.includes(q.why) && restoring() ? { ok: false, why: 'restoring' }
      : q && !q.ok && q.why === 'settle-first' && !late ? waitAndGo(q, args) : behindBtc(q, args.payAsset))).then((q) => {
      if (late && q && q.ok) { log('[user trade] a price came after the quote ended, let go:', q.ticket && q.ticket.source); drop(q.choice) }
      return q
    })
    const bound = new Promise((resolve) => {
      const tick = () => {
        const left = cap.until - Date.now()
        if (left <= 0) { late = true; resolve({ ok: false, why: 'wallet-busy' }) } else timer = setTimeout(tick, Math.min(left, 1000))
      }
      tick()
    })
    try { return await Promise.race([inner, bound]) } finally { clearTimeout(timer) }
  }

  // A quote whose coins wait only for a round (`settle-first`) is answered with a ticket the person
  // can accept now, on every surface alike (the Trade tab, a site's order): the book's price for
  // the amount, the least it goes for (SETTLE_SLACK_BP under it, after the fees last seen and the
  // refresh's fee), and the wait the library's refusal gave for those coins. A price request moves
  // and commits nothing: no coin is given to a round until the person accepts (`confirm`, which
  // writes a trade that waits for the coins, has them settled, is priced again once they are
  // through, and goes by itself at that price or better, or comes back with the new price:
  // advanceSettling, repriceWithin). Where the operator charges for a refresh, its fee (the
  // library's read-only `quote` of those coins) is in the ticket accepted.
  // -> as quote: { ok: true, ticket: { …, about, indicative, finalBy }, choice: { source: 'settling' } },
  //    or the book's own answer when it offers nothing for the pair.
  async function waitAndGo (q, { payAsset, receiveAsset, amount }) {
    const A = big(amount)
    const wait = q.wait || null
    // What settling those coins costs, read only: the coins the library named, else every live coin
    // of the asset (what `settle_first` of the asset may give up). Nothing is asked of a coin
    // already in a round.
    let refresh = 0n
    try {
      const named = q.coins && q.coins.length ? q.coins
        : ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === payAsset && c.state === 'live').map((c) => c.leaf_id)
      const live = new Set(((await run('coins').catch(() => [])) || []).filter((c) => c && c.state === 'live').map((c) => c.leaf_id))
      const leaves = named.filter((l) => live.has(l))
      if (leaves.length) {
        const r = await run('quote', { leaves })
        for (const c of (r && r.coins) || []) refresh += big(c.fee)
      }
    } catch (e) { log('[user trade] the refresh\'s fee:', e && e.message) }
    // The price now: a restricted pair's from its own book, counting what waits for the round as
    // there (`arriving`), else the book's estimate for what is paid less the fees last seen.
    let about = null
    const restricted = deps.restricted && (await Promise.resolve(deps.restricted.available()).catch(() => false)) &&
      [payAsset, receiveAsset].some((a) => a !== 'BTC' && deps.restricted.isRestricted(a))
    if (restricted) {
      const on = deps.restricted.onItsWay ? big(await Promise.resolve(deps.restricted.onItsWay(payAsset)).catch(() => 0n)) : 0n
      const rq = await restrictedQuote(deps.restricted, { payAsset, receiveAsset, amount: A - refresh, arriving: on > A ? on : A }).catch(() => null)
      if (rq && rq.ok) about = big(rq.ticket.amountOut)
    } else {
      const fees = (marginsSeen.get(payAsset) || 0n) + refresh
      const e = await estimate({ payAsset, receiveAsset, pay: String(fees > 0n && fees < A ? A - fees : A) }).catch(() => null)
      // Nobody offers the pair now: said so, as for any trade.
      if (e && !e.ok && ['not-listed', 'too-small', 'not-offered', 'soon'].includes(e.why)) {
        return { ok: false, why: e.why === 'soon' ? 'not-offered' : e.why, ...(e.again ? { again: true } : {}) }
      }
      if (e && e.ok) about = big(e.receive)
    }
    // No price to show before the round: said so, in the words of coins being made ready, and asked
    // again by the caller; nothing moved.
    if (about == null) return { ok: false, why: 'readying', held: q.held, soon: soon() }
    const least = about - (about * SETTLE_SLACK_BP + 9999n) / 10000n
    if (least <= 0n) return { ok: false, why: 'too-small' }
    const fb = nextFinalBy(null, wait, now())
    const ticket = { payAsset, receiveAsset, amountIn: String(A), amountOut: String(least), about: String(about),
      fees: refresh > 0n ? [{ asset: payAsset, atoms: String(refresh) }] : [], source: 'settling', asked: String(A), indicative: true, finalBy: fb ? fb.finalBy : null }
    const choice = { source: 'settling', payAsset, coins: q.coins || [], finalBy: fb ? fb.finalBy : null, finalStep: fb ? fb.step : null,
      settleMost: wait ? settleBound(wait.final_in_seconds) : null }
    return { ok: true, ticket, choice }
  }

  // Money held on the chain is traded whichever way completes soonest: an order on the chain that
  // takes the whole amount, when a book offers one, at once; otherwise it is moved in first and then
  // traded, the ticket saying how long (bringInTicket). Everything else is priced as before (quoteHeld).
  async function quoteOnce (args) {
    const plan = await bringPlan(args)
    if (!plan) return quoteHeld(args)
    if (plan.stays) {
      // Never settled first and then "taking longer": the money cannot come in. An order on the chain
      // that takes it, or anything else the sources price, goes; otherwise the plain reason.
      const q = await quoteHeld(args)
      if (q.ok) return q
      return ['settle-first', 'no-funds', 'not-ready', 'part-ready', 'readying'].includes(q.why)
        ? { ok: false, why: 'chain-stays', stays: plan.stays, ...(plan.stays === 'frozen' ? { frozen: String(plan.frozen), most: String(plan.most) } : {}) } : q
    }
    if (plan.chainFill) {
      const q = await quoteHeld({ ...args, only: 'onchain-fill' })
      if (q.ok && !q.ticket.upTo) return q
      if (q.ok) drop(q.choice)
    }
    return bringInTicket(args, plan)
  }

  // Whether paying `amount` needs money the wallet holds on the chain, and it can be moved in: what
  // the balance shows less what is on the chain falls short of the amount, and with what can be moved
  // in (less the move's fee) covers it. -> { tree, chain, movable, margin, minutes, chainFill } or null.
  async function bringPlan ({ payAsset, amount }) {
    if (payAsset === 'BTC' || !deps.chain || !deps.bringIn || !deps.held) return null
    const A = big(amount)
    if (A <= 0n) return null
    const c = await Promise.resolve(deps.chain(payAsset)).catch(() => null)
    if (!c || !(big(c.atoms) > 0n)) return null
    const shown = big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n))
    const chain = big(c.atoms)
    // What its issuer froze of it for this wallet (a supervised asset): in the figure, and it moves
    // nowhere, neither in nor to an order on the chain.
    const frozen = big(c.frozen) < chain ? big(c.frozen) : chain
    const tree = shown > chain ? shown - chain : 0n
    if (tree >= A) return null
    if (A + big(c.margin) > tree + big(c.movable)) {
      // The balance covers it only with frozen coins: said so, at once, never settled first.
      // `most`: what the rest trades now, the tree's and what can be moved in, less the fees kept back.
      if (frozen > 0n && A <= tree + chain) {
        const rest = tree + big(c.movable) - big(c.margin)
        return { stays: 'frozen', frozen, most: rest > 0n ? rest : 0n, chainFill: chain - frozen >= A }
      }
      // The balance covers it only with money on the chain that cannot be moved in (`c.stays`: 'dust',
      // too little of it once the move's fee is paid; 'unserved', an asset the network does not take
      // in): said so, unless an order on the chain takes it (quoteOnce).
      if (c.stays && A <= tree + chain) return { stays: c.stays, chainFill: chain - frozen >= A }
      return null
    }
    return { tree, chain, movable: big(c.movable), margin: big(c.margin), minutes: Number(c.minutes) || 5, chainFill: chain - frozen >= A }
  }

  // The ticket of a trade paid with money moved in first: the amount, all of it paid, for what the
  // best price the sources show now gives for it less `plan.margin` (the fees of the move and of the
  // trade, which the firm terms take out of what is paid), held to as a bound (no less received, no
  // more paid, the move's fee counted in what is paid), and how long it takes. The fee line is that
  // margin, as the most the fees can be: they are known only once the money is in. Nothing is
  // asked of a maker yet: a firm price is asked once the money is in (advanceSettling), and the
  // trade goes only within that bound.
  async function bringInTicket ({ payAsset, receiveAsset, amount }, plan) {
    const A = big(amount)
    const net = A - big(plan.margin)
    if (net <= 0n) return { ok: false, why: 'too-small' }
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const sources = admittedSources(ad.pairs, ad.genesis, payAsset, receiveAsset).filter((s) => s !== 'onchain-fill')
    if (!sources.length) return { ok: false, why: 'not-listed' }
    const all = await entries(payAsset, receiveAsset, sources)
    const ind = all.map((e) => { const s = sizeEntry(e, net); return s ? { e, s } : null }).filter(Boolean)
      .sort((a, b) => (b.s.receive > a.s.receive ? 1 : b.s.receive < a.s.receive ? -1 : 0))
    if (!ind.length) return { ok: false, why: all.length ? 'too-small' : 'not-offered' }
    const best = ind[0]
    const ticket = { payAsset, receiveAsset, amountIn: String(A), amountOut: String(best.s.receive),
      fees: [{ asset: payAsset, atoms: String(plan.margin), most: true }],
      source: best.e.source, asked: String(A), bringIn: plan.minutes }
    const want = A + big(plan.margin) - plan.tree
    return { ok: true, ticket, choice: { source: 'bring-in', payAsset, entry: best.e, minutes: plan.minutes, want: want > 0n ? want : 0n } }
  }

  async function quoteHeld ({ payAsset, receiveAsset, amount, onStep = null, cap = null, only = null }) {
    quoteStep = onStep
    tooOldFrom = null
    liveShort = false
    ownMost = null; ownLive = null; ownAll = null; ownMargins = null
    settleSeen = null
    makerReads = new Set()
    const reads = makerReads
    const A = big(amount)
    if (A <= 0n) return { ok: false, why: 'too-small' }
    // A pair with a restricted asset trades on the chain under its policy server
    // (restricted-engine.js), or, without what that needs, as before.
    const rq = await restrictedQuote(deps.restricted, { payAsset, receiveAsset, amount: A })
    // Bitcoin for a restricted asset: one trade through the asset that bitcoin buys and that buys
    // it (restricted-composed.js), one ticket and one confirmation. Bitcoin the wallet cannot pay
    // now is said as for any purchase; otherwise, the card names the asset to go through.
    if (rq && rq.why === 'btc-route' && payAsset === 'BTC' && rq.card && rq.card.side === 'get' && (rq.card.choices || []).length) {
      const cq = await composedQuote(deps.restricted, { receiveAsset, vias: rq.card.choices, drop, run, nowSec: () => Math.floor(now() / 1000),
        quoteFirst: (via) => quoteOnce({ payAsset: 'BTC', receiveAsset: via, amount: A, onStep, cap }) })
      if (cq.ok) return cq
      if (cq.first && FIRST_STEP_SAYS.includes(cq.first.why)) return cq.first
      // Not approved for what the ticket would bring: the approval card, before anything moves.
      if (cq.card) return { ok: false, why: 'approval', card: cq.card }
    }
    if (rq) return rq
    // More than the wallet holds to spend, the rest vesting later: refused with the date from
    // which all of it can be used (default-arca.js vestingShort), whatever the pair. Nothing is
    // asked of a maker.
    if (payAsset !== 'BTC' && deps.vesting) {
      const lots = await Promise.resolve(deps.vesting(payAsset)).catch(() => [])
      if (lots && lots.length) {
        const can = deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : ((await spendable()).get(payAsset) || 0n)
        const v = vestingShort(lots, payAsset, A, can)
        // Vested, and being taken up by the wallet: ready in a moment.
        if (v && v.arriving) return { ok: false, why: 'not-ready', held: String(can + v.atoms), soon: true }
        if (v) return { ok: false, why: 'vesting', atoms: String(v.atoms), vests: v.vests }
      }
    }
    const ad = deps.admitted ? await deps.admitted() : { pairs: null, genesis: null }
    const sources = admittedSources(ad.pairs, ad.genesis, payAsset, receiveAsset).filter((s) => !only || s === only)
    if (!sources.length) return { ok: false, why: 'not-listed' }
    // More than the balance shows: said so at once ("That is more than your …"), never settled
    // first and waited for, since no settlement covers it.
    if (payAsset !== 'BTC' && deps.held) {
      const shown = big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n))
      if (shown > 0n && A > shown) return { ok: false, why: 'part-ready', ready: String(shown), soon: soon() }
    }
    // BTC is paid over the wallet's Bitcoin Lightning, never from a leaf. An order taken on the
    // chain is paid from the wallet's on-chain coins, the rest from its leaves.
    const haveLeaf = payAsset === 'BTC'
      ? (deps.btc ? big(await Promise.resolve(deps.btc.balance()).catch(() => 0n)) : 0n)
      : (await spendableForQuote()).get(payAsset) || 0n
    // BTC the wallet holds at its address, which a trade cannot pay from until it is moved where
    // trades pay BTC from: moved for the trade by itself (deps.btcMove), and said so; never "no BTC".
    let moving = false
    if (payAsset === 'BTC' && haveLeaf < A && deps.btcMove && deps.btcAtAddress) {
      const atAddress = big(await Promise.resolve(deps.btcAtAddress()).catch(() => 0n))
      if (atAddress > 0n) {
        try { deps.btcMove(A - haveLeaf); moving = true } catch (e) { log('[user trade] btc move:', e && e.message) }
        if (haveLeaf <= 0n) return { ok: false, why: 'btc-moving', moving: true }
      }
    }
    const haveChain = payAsset !== 'BTC' && deps.onchain && sources.includes('onchain-fill')
      ? big(await Promise.resolve(deps.onchain.balance(payAsset)).catch(() => 0n)) : 0n
    // A coin not ready yet is ready in a minute or two when the operator calls it ready once its
    // block is certified.
    const soonNow = soon()
    if (haveLeaf <= 0n && haveChain <= 0n) {
      // What the wallet shows it holds, though no source can pay from it now: the wallet is asked to
      // make it ready (default mode boards coins on the chain into the tree by itself).
      const held = payAsset !== 'BTC' && deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : 0n
      if (held > 0n) {
        try { deps.prepare && deps.prepare(payAsset) } catch {}
        // Not yet the wallet's to spend (a board waiting for its blocks), or held by something under
        // way: an order placed from it, a move the wallet is making, a refresh planned for it.
        const mine = ((await run('coins').catch(() => [])) || []).filter((c) => c && c.asset === payAsset)
        // Live coins kept by an open offline-refresh plan are freed through the wallet's next round
        // (deps.release, the page's plan_release), as a payment from them is.
        if (await freePlanned(payAsset, mine)) return settleFirst(payAsset, [], held)
        // Held by an order the person placed (a resting order's coin, an offer of theirs still open):
        // true words, since the person can act on it (cancel the order). Everything else that holds
        // it is the wallet's own doing (a refresh its upkeep runs, a payment under way, a coin not
        // final yet): the trade waits for that and goes, never a refusal (D96).
        const ordered = mine.some((c) => c.order === true || c.state === 'offered')
        // Coins a Bitcoin reorganisation took back out of the chain, being redone: never a loss.
        if (!ordered && mine.some((c) => c.redoing === true)) return { ok: false, why: 'redoing', held: String(held) }
        return ordered ? { ok: false, why: 'busy', held: String(held), soon: soonNow } : settleFirst(payAsset, [], held)
      }
      return { ok: false, why: 'no-funds' }
    }
    const haveOf = (e) => (e.source === 'onchain-fill' ? haveChain : haveLeaf)
    // The entries read for the estimate a moment ago stand: the firm terms are what the ticket shows.
    const fresh = estimates.get(payAsset + '>' + receiveAsset)
    const all = fresh && now() - fresh.at <= ENTRIES_FRESH_MS ? fresh.es : await entries(payAsset, receiveAsset, sources)
    const es = all.filter((e) => haveOf(e) > 0n)
    // Indicative first, so only the best few are asked for firm terms (a maker holds its coins
    // for a firm offer).
    const ind = es.map((e) => { const h = haveOf(e); const s = sizeEntry(e, A < h ? A : h); return s ? { e, receive: s.receive } : null }).filter(Boolean)
      .sort((a, b) => (b.receive > a.receive ? 1 : b.receive < a.receive ? -1 : 0))
      // A maker quoting several levels of one pair is asked once, at the level that gives the
      // most for this size: each firm offer holds its coins.
      .filter((x, i, l) => !x.e.maker || l.findIndex((y) => y.e.maker === x.e.maker && y.e.source === x.e.source) === i)
    // The amount would trade, but what the wallet can pay now is less than any offer takes: the
    // rest of what it holds is not ready yet (coins waiting on their blocks). Said so, never
    // "too small".
    if (!ind.length && es.some((e) => haveOf(e) < A && sizeEntry(e, A))) {
      if (payAsset === 'BTC' && moving) return { ok: false, why: 'btc-moving', moving: true }
      // The rest may be held in coins an offline-refresh plan keeps: those are freed through the
      // wallet's next round, whatever the free coins hold, never left waiting for nothing.
      if (payAsset !== 'BTC' && await freePlanned(payAsset)) return settleFirst(payAsset, [], haveLeaf)
      // Part of what the balance shows waits for a round: settled first, then traded (D96). The
      // wallet never names a tradable part of a balance. When nothing waits (the amount is more than
      // the wallet holds), the answer below says that.
      const shown = payAsset !== 'BTC' && deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : null
      if (payAsset !== 'BTC' && (shown == null || shown > haveLeaf)) return settleFirst(payAsset, [], haveLeaf)
      const ready = es.reduce((m, e) => (haveOf(e) > m ? haveOf(e) : m), 0n)
      return { ok: false, why: 'part-ready', ready: String(ready), soon: soonNow }
    }
    // Firm terms of the best FIRM_AT_ONCE, all asked at once, within QUOTE_FIRM_MS: an entry that cannot
    // be firmed (a resting order the wallet's coins are too old for, a maker that ran short) or
    // that has not answered by then is left out, and a late answer is let go of. When none gives
    // firm terms and there is time left, they are asked once more a moment later.
    const cands = []
    // The next best FIRM_AT_ONCE are asked in the second round when the first gave none; with no
    // more to ask, the first ones again a moment later.
    const ranked = worthFirming(ind).slice(0, 2 * FIRM_AT_ONCE)
    // Wall-clock time: the person's wait (deps.now may be a test's stand-in clock).
    const btcOnly = ranked.length > 0 && ranked.every(({ e }) => e.source === 'btc-gateway')
    const window = btcOnly ? Math.max(firmMs, deps.btcOnlyFirmMs || BTC_ONLY_FIRM_MS) : firmMs
    const until = Date.now() + window
    const readMs = deps.quoteReadMs ?? QUOTE_READ_MS
    // The BTC desk alone is given its own window, and the quote's bound grows to hold it.
    if (cap && btcOnly) cap.until = Math.max(cap.until, until + readMs + 5000)
    for (let round = 0; round < 2 && !cands.length; round++) {
      const next = ranked.slice(round * FIRM_AT_ONCE, (round + 1) * FIRM_AT_ONCE)
      const worth = next.length ? next : ranked.slice(0, FIRM_AT_ONCE)
      if (round) { if (until - Date.now() < Math.min(FIRM_RETRY_MS + 2000, window / 2)) break; if (!next.length) await sleep(FIRM_RETRY_MS) }
      const got = await firmsBy(worth.map(({ e }) => firm(e, payAsset, receiveAsset, A, haveOf(e), until, until + readMs)), until, until + readMs)
      for (const c of got) if (c) cands.push(c)
    }
    const best = chooseCandidate(cands)
    for (const c of cands) if (c !== best) drop(c)
    // Offered, but nobody gave firm terms: that is not the amount's fault.
    // No firm offer, and the resting orders refused the wallet's coins only for expiring before
    // the order's coin: those coins are refreshed in the next round (a new coin expires later
    // than any order resting now), and the trade is priced again once they are in.
    // A source's check found what the trade needs waiting only for a round: settled first, then
    // priced again and traded.
    if (!best && settleSeen && payAsset !== 'BTC') return settleFirst(payAsset, settleSeen.coins, haveLeaf)
    if (!best && tooOldFrom != null && payAsset !== 'BTC' && await readyCoins(payAsset, tooOldFrom)) {
      return { ok: false, why: 'readying', held: String(haveLeaf), soon: soonNow }
    }
    // Nobody gave firm terms because what the wallet holds of the asset is not live now (given up in
    // a refresh, received and not yet settled): it is being made ready, never "nobody could confirm".
    // Nobody gave firm terms because the wallet itself cannot pay this much with the fees, and the
    // balance shows nothing more of it on its way: what can be traded now, never "nobody could
    // confirm" nor "try again" (#666).
    // (Coins it holds that are not live now, held in a refresh or just received, are being made ready
    // instead: the refusal's live figure is short of what it holds.)
    if (!best && ownMost != null && payAsset !== 'BTC' && (ownLive == null || ownLive >= haveLeaf)) {
      const shown = deps.held ? big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n)) : 0n
      // With what emptying the coins pays in all (`all`, the margins in), when it is more: what Max
      // asks for then.
      if (shown <= haveLeaf) {
        return Object.assign({ ok: false, why: 'own-short', most: String(ownMost) }, ownAll != null && ownAll > ownMost ? { all: String(ownAll) } : {})
      }
    }
    if (!best && liveShort && payAsset !== 'BTC') return settleFirst(payAsset, [], haveLeaf)
    // A maker gave firm terms in time and the wallet's library was still reading them when the
    // quote's time ran out (held by a long command of its own): the wallet was busy, nobody refused.
    if (!best && reads.size > 0) return { ok: false, why: 'wallet-busy' }
    if (!best) return { ok: false, why: !es.length ? 'not-offered' : ind.length ? 'no-firm-offer' : 'too-small', ...(!es.length && all.again ? { again: true } : {}) }
    const ticket = { payAsset, receiveAsset, amountIn: String(best.give), amountOut: String(best.receive),
      fees: best.fees.map((f) => ({ asset: f.asset, atoms: String(f.atoms) })), source: best.source, asked: String(A) }
    const have = haveOf(best.entry)
    // Less can be paid now than asked, while the wallet shows more of it (the rest waiting for a
    // round): settled first, then the whole amount is priced (D96), never "up to" a part of it.
    if (have < A && payAsset !== 'BTC' && best.entry.source !== 'onchain-fill' && deps.held) {
      const shown = big(await Promise.resolve(deps.held(payAsset)).catch(() => 0n))
      if (shown > have) { drop(best); return settleFirst(payAsset, [], have) }
    }
    if (have < A && best.give <= have) ticket.upTo = String(have)
    return { ok: true, ticket, choice: best, moving }
  }

  // Confirms a ticket's choice: writes the trade's record, then takes the one step. Answers the
  // record; `advance` follows it.
  // `prior`: a trade confirmed before, whose step waited for its coins to be settled first (state
  // 'settling'): the same record goes on with the new price, so it is never made twice. `extra`:
  // fields the record carries from the start (a composed trade's step: `partOf`, and `id` for the
  // one record its trade on the chain keeps whatever its tries).
  async function confirm (choice, ticket, prior = null, extra = {}) {
    // What the wallet can pay changes with this trade: the next quote reads it afresh.
    holdings = null
    const id = prior ? prior.id : extra.id || `${now()}-${Math.random().toString(16).slice(2, 10)}`
    // Paid with money moved in first: nothing is signed now. The trade waits, the ticket accepted as
    // its bound, while the wallet moves the money in; then it is priced again and goes ahead by
    // itself (advanceSettling), or is returned with words.
    if (choice.source === 'bring-in') {
      if (prior) return prior
      const rec = put({ id, at: now(), source: ticket.source, state: 'settling', ticket, accepted: ticket, settleSince: now(),
        bringIn: choice.payAsset, bringWant: String(choice.want || 0n), bringMinutes: choice.minutes, settleMost: bringMost(choice.minutes), ...extra })
      bringIn(rec)
      return rec
    }
    // A trade priced again after its offer was gone, or after a refusal that came once the wallet
    // had paid itself the coin it gives: what it paid already (paidAlready: a cancel's respend
    // margins, the shaping payment's), in the asset paid. The record's ticket counts them, in what
    // is paid and in its fees, so the fee line is what the trade cost.
    const cf = prior ? paidAlready(prior) : 0n
    if (cf > 0n) {
      ticket = { ...ticket, amountIn: String(big(ticket.amountIn) + cf), fees: [...(ticket.fees || []), { asset: ticket.payAsset, atoms: String(cf) }] }
    }
    // A trade paid with money moved in first: the move's fee (`moveFee`, repriceWithin) is part of
    // what it cost, in what is paid and in its fees, so the record says what the wallet paid.
    const mf = prior ? big(prior.moveFee) : 0n
    if (mf > 0n) {
      ticket = { ...ticket, amountIn: String(big(ticket.amountIn) + mf), fees: [...(ticket.fees || []), { asset: ticket.payAsset, atoms: String(mf) }] }
    }
    // A ticket accepted while what it pays waits for a round: the trade is written waiting for those
    // coins, bound to the least the ticket names, and goes by itself once they are through
    // (advanceSettling). Nothing is signed to anyone until then.
    if (choice.source === 'settling') {
      const rec = put({ id, at: now(), source: 'settling', state: 'settling', ticket, accepted: ticket, settledFirst: true,
        settleCoins: choice.coins || [], settleSince: now(), finalBy: choice.finalBy ?? null, finalStep: choice.finalStep ?? null,
        ...(choice.settleMost ? { settleMost: choice.settleMost } : {}), ...extra })
      settleAsk(rec).catch(() => {})
      return rec
    }
    const rec = put({ id, at: prior ? prior.at : now(), source: choice.source, state: 'confirming', ticket,
      ...(prior ? { accepted: prior.accepted || prior.ticket, settledFirst: prior.state === 'settling' || !!prior.settledFirst, settleSince: prior.settleSince,
        ...(prior.gave ? { gave: prior.gave } : {}), ...(prior.cancelFees ? { cancelFees: prior.cancelFees } : {}),
        ...(prior.bringIn ? { bringIn: prior.bringIn, bringMinutes: prior.bringMinutes, settleMost: prior.settleMost, ...(prior.moveFee ? { moveFee: prior.moveFee } : {}) } : {}),
        ...(prior.shapeFees ? { shapeFees: prior.shapeFees, shaped: prior.shaped } : {}) } : {}),
      ...extra })
    try {
      if (choice.source === 'composed') {
        // The composed record first, then its first step's own record, marked as its.
        rec.via = choice.via; rec.viaAtoms = choice.viaAtoms; rec.firstFees = choice.firstTicket.fees || []
        rec.moveFee = choice.moveFee; rec.moved = choice.moved; rec.secondFee = choice.secondFee; rec.secondFeeAsset = choice.secondFeeAsset
        put(rec)
        const one = await confirm(choice.first, choice.firstTicket, null, { partOf: rec.id })
        rec.first = one.id
        if (one.state !== 'confirming') { rec.state = one.state === 'waiting' ? 'waiting' : 'sent'; rec.sentAt = now(); if (rec.state === 'waiting') { rec.waitingSince = now(); rec.waitFirstBy = one.waitFirstBy; rec.waitBy = one.waitBy } }
        return put(rec)
      }
      if (choice.source === 'covenant-round') {
        rec.order = choice.entry.id
        rec.orderJson = choice.entry.raw._relayJson || choice.entry.raw
        // The participations the wallet has now, so a take the page closed on is found again.
        rec.beforeParts = ((await run('participations')) || []).map((p) => p.participation)
        put(rec)
        // What a payment to itself costs is spent even when the take is voided later (its margins
        // come back at that coin's next refresh): a return then says so.
        rec.selfPayCost = String(big(choice.quote.spends ?? choice.quote.gives) - big(choice.quote.gives))
        rec.settleTargets = choice.settle && choice.settle.change ? [{ asset: choice.settle.change.asset, value: choice.settle.change.value, fee: choice.settle.change.fee }] : []
        rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
        put(rec)
        let r
        try { r = await run('take', { order: rec.orderJson, amount: choice.quote.filled, max_fee_ppm: MAX_FEE_PPM, shown: choice.quote }) } catch (e) {
          if (/order_not_final/.test(String(e && e.message))) markNotFinal(rec.order)
          throw e
        }
        rec.take = r.take; rec.state = 'sent'; rec.sentAt = now()
        return put(rec)
      }
      if (choice.source === 'leaf-maker') {
        if (choice.offer.expires_at && Number(choice.offer.expires_at) * 1000 - now() < FIRM_MARGIN_MS) {
          rec.state = 'failed'; rec.error = 'the firm offer lapsed before it was confirmed'; put(rec)
          release(choice.entry.maker, choice.offer.swap)
          const e = new Error('the price is no longer held'); e.code = 'lapsed'; throw e
        }
        rec.maker = choice.entry.maker; rec.swap = choice.offer.swap; rec.give = choice.terms.gets.value
        rec.receiveAsset = choice.terms.gets.asset
        rec.settleTargets = !choice.settle ? [] : [{ asset: choice.settle.received.asset, value: choice.settle.received.value, fee: choice.settle.received.fee },
          ...(choice.settle.change ? [{ asset: choice.settle.change.asset, value: choice.settle.change.value, fee: choice.settle.change.fee }] : [])]
        // The coins the wallet holds now, so the coin the swap brings is the one it did not hold.
        rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
        put(rec)
        const a = await run('swap_accept', { offer: choice.offer.offer, shown: choice.terms })
        // The coin it gives was made first by a payment of the wallet to itself (`pays.shapes`):
        // paid now, whatever becomes of the trade, so a price asked again does not charge it twice.
        const shaped = big(a.pays && a.pays.shapes)
        if (shaped > 0n) rec.shapeFees = String(big(rec.shapeFees) + shaped)
        rec.accept = a.accept; rec.state = 'sent'; rec.sentAt = now()
        put(rec)
        try {
          const a = await deps.fetchJson(rec.maker + '/v1/accept', { method: 'POST', body: JSON.stringify({ swap: rec.swap, accept: rec.accept }) })
          if (a && a.state === 'done') { rec.makerDone = true; rec.makerDoneAt = now() }
        } catch (e) {
          log('[user trade] the maker did not take the acceptance yet:', e.message)
          // The operator refused the maker's completion: the offer is gone, and the next advance
          // re-prices at once (advanceGone).
          if (e.body && e.body.gone) rec.gone = e.body
        }
        return put(rec)
      }
      if (choice.source === 'btc-gateway') return await btcT.confirm(choice, rec)
      if (choice.source === 'restricted') return await restrictedConfirm(deps.restricted, choice, rec, put)
      if (choice.source === 'onchain-fill') {
        rec.order = choice.entry.id
        rec.fee = { asset: choice.fee.asset, atoms: String(choice.fee.atoms) }
        put(rec)
        const r = await deps.onchain.take(choice.matched, { fee: choice.fee, onTxid: (txid) => { rec.txid = txid; put(rec) } })
        rec.txid = r.txid; rec.state = 'sent'; rec.sentAt = now()
        return put(rec)
      }
      if (choice.source === 'leaf-resting') {
        rec.order = choice.entry.id
        rec.receiveAsset = choice.quote.gets.asset
        rec.settleTargets = [{ asset: choice.settle.received.asset, value: choice.settle.received.value, fee: choice.settle.received.fee },
          ...(choice.settle.change ? [{ asset: choice.settle.change.asset, value: choice.settle.change.value, fee: choice.settle.change.fee }] : [])]
        rec.before = ((await run('coins')) || []).map((c) => c.leaf_id)
        put(rec)
        const args = { order: rec.order, amount: choice.quote.filled }
        let r
        try { r = await run('order_fill_resting', { ...args, shown: choice.quote }) } catch (e) {
          if (!(e && (e.code === 'order_moved' || /order_moved/.test(String(e.message))))) throw e
          // Another taker filled first and the order rests at a new coin: filled there only for the
          // same amount at the same price and no higher fee, as shown.
          const again = await run('order_fill_resting_quote', args)
          const same = again.filled === choice.quote.filled && again.paid === choice.quote.paid && again.fee && again.fee.asset === choice.quote.fee.asset &&
            big(again.fee.amount) <= big(choice.quote.fee.amount) && big(again.change) === big(choice.quote.change)
          if (!same) { const x = new Error('the price is no longer held'); x.code = 'lapsed'; throw x }
          rec.movedFrom = choice.quote.coin
          r = await run('order_fill_resting', { ...args, shown: again })
        }
        rec.transfer = r.answer && r.answer.transfer_id
        rec.state = 'sent'; rec.sentAt = now()
        return put(rec)
      }
      throw new Error('no such source')
    } catch (e) {
      // A refusal (the library's or the operator's) leaves nothing moved. Any other error leaves
      // the outcome unknown: the library may still complete the step at its next sync, so the trade
      // stays open and is looked for (advance), and is called returned only if it never shows.
      const refused = e && (e.code === 'lapsed' || e.kind === 'refused' || e.kind === 'server_refused' || /^refused\b/i.test(String(e.message)))
      // What it pays waits only for a round (the library's `settle_first`): nothing moved. The
      // trade is kept, with the price the person accepted as its bound, while those coins go
      // through the next round; then it is priced again and goes ahead by itself (advance), or is
      // returned with words if the price moved past that bound. The firm offer is let go of now.
      // The same when the operator refused the step for coins too many payments from a round (its
      // `depth_limit`, which a fill of a resting order meets only at the fill, #746): a round cures it.
      const deep = refused && (e.code === 'depth_limit' || /\(\d{3} depth_limit\)/.test(String(e.message)))
      if (rec.state === 'confirming' && e && (e.kind === 'settle_first' || deep)) {
        drop(choice)
        rec.state = 'settling'
        rec.settleCoins = (e.kind === 'settle_first' && e.coins) || []
        rec.settleSince = rec.settleSince || now()
        rec.accepted = rec.accepted || ticket
        rec.error = null
        settleAsk(rec).catch(() => {})
        return put(rec)
      }
      // Refused after the wallet paid itself the coin of exactly what the trade gives (the library's
      // `shaped`): that payment moved, and its margins (`fee`, in the ticket shown) are paid; nothing
      // else moved. The coin is kept for this trade, so it is priced again at once into the same
      // record under what was accepted, from that coin, and the margins are counted once, never
      // charged again (paidAlready). Twice over, it is returned with words naming them.
      if (rec.state === 'confirming' && e && e.kind === 'shaped' && choice.source === 'leaf-maker') {
        drop(choice)
        rec.shapeFees = String(big(rec.shapeFees) + big(e.fee))
        rec.shaped = (rec.shaped || 0) + 1
        log('[user trade] refused after its coin was made; pricing again from it:', rec.id)
        if (rec.shaped >= 2) {
          rec.state = 'returned'; rec.whyKind = null; rec.error = e.message
          rec.feesPaid = [{ asset: ticket.payAsset, atoms: String(paidAlready(rec)) }]
          return put(rec)
        }
        rec.state = 'repricing'; rec.repriceSince = now(); rec.accepted = rec.accepted || ticket; rec.error = null
        return put(rec)
      }
      // A step refused, before anything was signed to the other side, because a coin of the
      // wallet's it paid from is spent elsewhere (a second device gave it to a round): a fill of an
      // order resting in the tree, a take of a covenant order, or an acceptance of a maker's offer
      // whose coin the wallet first shapes by paying itself. The library has caught up and holds
      // what replaced it, so the trade is priced again into the same record under what was
      // accepted, as a maker's gone offer is (advanceGone, #710). A person does not know which kind
      // of offer was the best price, so all behave the same.
      if (rec.state === 'confirming' && refused && spentElsewhere(e, rec.before) && ['leaf-resting', 'covenant-round', 'leaf-maker'].includes(choice.source)) {
        drop(choice)
        rec.gave = [...(rec.gave || []), { ...(rec.order ? { order: rec.order } : { swap: rec.swap }), why: String(e.message || '').slice(0, 300), whose: 'taker' }]
        log('[user trade] a coin it paid from was spent elsewhere; pricing again:', rec.id)
        if (rec.gave.length >= GONE_MOST) {
          rec.state = 'returned'; rec.whyKind = null; rec.error = 'the offers were gone ' + rec.gave.length + ' times'
          if (paidAlready(rec) > 0n) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: String(paidAlready(rec)) }]
          return put(rec)
        }
        rec.state = 'repricing'; rec.repriceSince = now(); rec.accepted = rec.accepted || ticket; rec.error = null
        return put(rec)
      }
      if (rec.state === 'confirming') {
        if (refused) { rec.state = 'failed'; rec.error = e.message; put(rec); throw e }
        rec.uncertain = true; rec.uncertainAt = now(); rec.error = e.message
        log('[user trade] the step did not answer; the trade is followed:', e.message)
        return put(rec)
      }
      throw e
    }
  }

  // Moves one trade on as far as it goes now. -> its record. When that changes what the wallet holds
  // (the trade's state, or what it brings held already), deps.changed is told, so the page reads its
  // balance again: an asset just received is one the person can pay with at once.
  // One advance of a record at a time: a second one asked meanwhile (two follows overlapping: the
  // page opening, a change of mode, the follow after a confirmation) answers the record as stored,
  // and the one running reads it afresh, so a trade is never accepted twice.
  const advancing = new Set()
  async function advance (rec) {
    if (asked > 0) return rec
    if (!rec) return advanceOnce(rec)
    if (advancing.has(rec.id)) return records().find((r) => r.id === rec.id) || rec
    advancing.add(rec.id)
    try {
      rec = records().find((r) => r.id === rec.id) || rec
      const was = rec.state + '|' + heldAlready(rec)
      const r = await advanceOnce(rec)
      if (r && deps.changed && r.state + '|' + heldAlready(r) !== was) { try { deps.changed(r) } catch {} }
      return r
    } finally { advancing.delete(rec.id) }
  }

  // The longest a trade paid with money moved in waits: the minutes its ticket says, no more (the
  // move takes most of them; the trade itself goes within seconds of the money being in).
  function bringMost (minutes) { return (Number(minutes) || 5) * 60_000 }
  // Asks the wallet to move a waiting trade's money in: once per trade (`bringing`; asked again only
  // when the page opened again), until the trade's own time is up, and no longer than the trade waits
  // for it. A move the network refuses returns the trade at once, with words.
  const bringing = new Map()
  function bringIn (rec) {
    if (bringing.has(rec.id) || !deps.bringIn) return
    const stop = () => { const cur = records().find((r) => r.id === rec.id); return !cur || cur.state !== 'settling' }
    const until = (rec.settleSince || rec.at || now()) + (rec.settleMost || bringMost(rec.bringMinutes))
    let p
    try { p = Promise.resolve(deps.bringIn(rec.bringIn, big(rec.bringWant), { until, stop, since: rec.settleSince || rec.at })) } catch (e) { p = Promise.reject(e) }
    bringing.set(rec.id, p)
    p.then((v) => {
      if (!v || !v.refused) return
      // Refused by the network (too little to move once its fee is paid, or not taken): nothing traded.
      const cur = records().find((r) => r.id === rec.id)
      if (!cur || cur.state !== 'settling') return
      cur.state = 'returned'; cur.whyKind = 'refused'; cur.error = 'moving in refused: ' + v.refused
      put(cur)
    }).catch((e) => log('[user trade] moving in:', e && e.message)).finally(() => bringing.delete(rec.id))
  }

  // A trade whose maker answered that its offer is gone: the operator refused the completion, so
  // the acceptance cannot complete there. Its coins are taken back at once (the library's cancel:
  // a coin of the wallet's given up elsewhere, by a second device, is found then, and the
  // acceptance cancelled with nothing respent), then the trade is priced again for what was
  // accepted and goes ahead in the same record only at that price or better (repriceWithin); the
  // offer the maker made in its place is taken first when it is there. A cancel that cannot be
  // made yet is asked again at the next advance; one that finds the swap done goes on as done.
  async function advanceGone (rec) {
    const gone = rec.gone
    put(rec)
    // Held for the swap, or waiting for the answer to an earlier cancel's respend.
    const held = ((await run('coins')) || []).filter((c) => c.state === 'offered' || c.state === 'sending')
    let c = null
    try { c = await run('swap_cancel', { swap: rec.swap }) } catch (e) { log('[user trade] swap_cancel:', e && e.message); return put(rec) }
    if (c && c.done) { rec.gone = null; rec.awaiting = false; return put(rec) }
    if (!c || !c.cancelled) {
      // Not known yet whether the coins came back: asked again at the next advance.
      rec.awaiting = !!(c && c.unknown)
      log('[user trade] the acceptance stands for now:', c && (c.note || c.error)); return put(rec)
    }
    rec.awaiting = false
    if (c.respent && c.respent.length) {
      const was = held.filter((x) => c.respent.includes(x.leaf_id)).reduce((n, x) => n + big(x.value), 0n)
      const now2 = ((await run('coins')) || []).filter((x) => x.state === 'live' && !(rec.before || []).includes(x.leaf_id) && x.asset === rec.ticket.payAsset)
      const got = now2.reduce((n, x) => n + big(x.value), 0n)
      if (was > got) rec.cancelFees = String(big(rec.cancelFees) + was - got)
    }
    log('[user trade] the maker\'s offer is gone (' + (gone.whose ? `the ${gone.whose}'s coin` : String(gone.code || '')) + '); pricing again:', rec.id)
    rec.gave = [...(rec.gave || []), { swap: rec.swap, why: String(gone.error || '').slice(0, 300), whose: gone.whose || null }]
    // Offers gone GONE_MOST times over: the trade comes back with words rather than ask again.
    if (rec.gave.length >= GONE_MOST) {
      if (gone.offer && gone.offer.swap && rec.maker) release(rec.maker, gone.offer.swap)
      rec.gone = null; rec.state = 'returned'; rec.whyKind = null; rec.error = 'the makers\' offers were gone ' + rec.gave.length + ' times'
      if (paidAlready(rec) > 0n) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: String(paidAlready(rec)) }]
      return put(rec)
    }
    if (gone.offer && gone.offer.swap && rec.maker) madeAgain.set(rec.maker, { ...gone.offer, give_asset: rec.ticket.receiveAsset, want_asset: rec.ticket.payAsset })
    rec.gone = null
    rec.state = 'repricing'; rec.repriceSince = now(); rec.accepted = rec.accepted || rec.ticket
    put(rec)
    return repriceWithin(rec, REPRICE_MOST_MS, rec.repriceSince)
  }

  // Puts a settling trade's coins through the next round (the library gives up nothing twice).
  async function settleAsk (rec) {
    const t = rec.ticket
    return run('settle_first', settleArgs(t.payAsset, rec.settleCoins))
  }

  // A confirmed trade whose coins are settled first: once through, priced again for the amount
  // accepted, and confirmed into the same record only when the new price is the one the person
  // accepted or better (no less received, no more paid); returned with words when it moved, or
  // when it waited past its bound (rec.settleMost, else SETTLE_MOST_MS). Nothing asks twice: one
  // advance of a record at a time (`advancing`), and its stored state read again before the
  // confirmation.
  async function advanceSettling (rec) {
    const late = () => { rec.state = 'returned'; rec.whyKind = 'late'; rec.error = 'settling first took too long'; return put(rec) }
    const most = rec.settleMost || SETTLE_MOST_MS
    // Money being moved in for it: asked once (bringIn), so a page closed meanwhile goes on with it
    // when it is open again.
    if (rec.bringIn) bringIn(rec)
    let v = null
    try { v = await settleAsk(rec) } catch (e) {
      log('[user trade] settle_first:', e && e.message)
      if (/no command|unknown command/i.test(String(e && e.message))) { rec.state = 'failed'; rec.error = e.message; return put(rec) }
    }
    // The record as stored now: never written back over a state another follow moved it to.
    const stored = records().find((r) => r.id === rec.id)
    if (!stored || stored.state !== 'settling') return stored || rec
    // How long it may wait: what the library first said it takes, twice, with a margin (settleBound),
    // kept on the record so a page opened later holds it to the same bound. A trade paid with money
    // moved in first already waits its ticket's minutes (bringMost): the library's word, counted from
    // when it first spoke, extends that bound, never shortens it, so the move and the settle are one
    // wait, the later of the two.
    if (v && !v.ready && v.final_in_seconds != null) {
      if (rec.settleMost == null) rec.settleMost = settleBound(v.final_in_seconds)
      else if (rec.bringIn && !rec.settleHeard) {
        const since = rec.settleSince || rec.at || now()
        rec.settleMost = Math.max(rec.settleMost, now() - since + settleBound(v.final_in_seconds))
      }
      rec.settleHeard = true
      const n = nextFinalBy(rec.finalBy != null ? { finalBy: rec.finalBy, step: rec.finalStep ?? null } : null, v, now())
      rec.finalBy = n.finalBy; rec.finalStep = n.step
      put(rec)
    }
    const upTo = rec.settleMost || most
    if (!v || !v.ready) { if (now() - (rec.settleSince || rec.at) > upTo) return late(); syncShared(); return rec }
    // Through, by the wallet's word, but the last price asked was refused for coins that wait for a
    // round: the other side is asked again only once that refusal's wait is through.
    if (rec.repriceAfter && now() < rec.repriceAfter) { if (now() - (rec.settleSince || rec.at) > upTo) return late(); syncShared(); return rec }
    await syncShared()
    return repriceWithin(rec, upTo, rec.settleSince || rec.at)
  }

  // Prices a confirmed trade again for the amount accepted (`rec.accepted`), and confirms it into
  // the same record only at the price accepted or better (no less received, no more paid); returns
  // it with words when the price moved, or once `most` ms have passed since `since` with no price.
  // Nothing asks twice: one advance of a record at a time (`advancing`), and its stored state read
  // again before the confirmation. Coins that must be settled first make it a settling trade.
  async function repriceWithin (rec, mostMs, since) {
    const t = rec.ticket, accepted = rec.accepted || t
    const state = rec.state
    // Priced again for at most one received atom's price above what the ticket pays (and never above
    // the amount the person typed), so the maker's rounding gives the same ticket at the same price,
    // and a ticket the maker's depth capped goes at its own size, never at the whole amount typed.
    const aIn = big(accepted.amountIn), aOut = big(accepted.amountOut)
    const step = aOut > 0n ? (aIn + aOut - 1n) / aOut : 0n
    let upTo = accepted.asked && big(accepted.asked) < aIn + step ? (big(accepted.asked) > aIn ? big(accepted.asked) : aIn) : aIn + step
    // Paid with money moved in first: the move's fee was paid out of what the ticket pays, so the
    // trade itself pays at most the rest (the ticket is all-in), and the record counts it (confirm).
    if (rec.bringIn && deps.movedFees) {
      let mf = 0n
      try { mf = big(await Promise.resolve(deps.movedFees(rec.bringIn, rec.settleSince || rec.at))) } catch {}
      if (mf > 0n) {
        rec.moveFee = String(mf)
        const cap = aIn - mf
        if (upTo > cap) upTo = cap > 0n ? cap : 0n
      }
    }
    // At the price accepted or better: no less received, no more paid than `upTo`, and what is
    // received for what is paid at least the ticket's.
    const within = (x) => x && x.ok && big(x.ticket.amountOut) >= aOut && big(x.ticket.amountIn) <= upTo &&
      big(x.ticket.amountOut) * aIn >= aOut * big(x.ticket.amountIn)
    // The money is still on the chain (not in a block yet, or its move not made yet): it waits, up to
    // `mostMs` since `since`.
    const stillOut = (x) => x && x.ok && x.choice && x.choice.source === 'bring-in'
    const lateOut = () => { rec.state = 'returned'; rec.whyKind = 'late'; rec.error = 'settling first took too long'; return put(rec) }
    let q = await quoteOnce({ payAsset: t.payAsset, receiveAsset: t.receiveAsset, amount: String(upTo) })
    if (stillOut(q)) return now() - since <= mostMs ? rec : lateOut()
    // The maker's offer made in place of a gone one, if this price did not take it: let go of.
    const left = rec.maker && madeAgain.get(rec.maker)
    if (left) { madeAgain.delete(rec.maker); release(rec.maker, left.swap) }
    // A cancel's respend left margins: a trade returned now names them.
    const back = () => { if (paidAlready(rec) > 0n) rec.feesPaid = [{ asset: t.payAsset, atoms: String(paidAlready(rec)) }]; return put(rec) }
    // A ticket the maker's depth capped, whose next atom costs more than the ticket's price: priced
    // once more at exactly what the ticket paid.
    if (q.ok && !within(q) && upTo > aIn) {
      drop(q.choice)
      q = await quoteOnce({ payAsset: t.payAsset, receiveAsset: t.receiveAsset, amount: String(aIn) })
      if (stillOut(q)) return now() - since <= mostMs ? rec : lateOut()
    }
    // The record as stored now: never written back over a state another follow moved it to.
    const stored = records().find((r) => r.id === rec.id)
    if (!stored || stored.state !== state) { if (q.ok) drop(q.choice); return stored || rec }
    if (!q.ok) {
      if (q.why === 'settle-first' && (state !== 'settling' || now() - since <= mostMs)) {
        rec.settleCoins = q.coins || []
        if (state !== 'settling') { rec.state = 'settling'; rec.settleSince = now(); settleAsk(rec).catch(() => {}) }
        // The refusal's own wait is the trade's time (the row counts down to it, and says when it
        // passes), and the other side is asked again only once that wait is through.
        if (q.wait) {
          const n = nextFinalBy(rec.finalBy != null ? { finalBy: rec.finalBy, step: rec.finalStep ?? null } : null, q.wait, now())
          if (n) { rec.finalBy = n.finalBy; rec.finalStep = n.step }
        }
        const secs = q.wait ? Number(q.wait.usual_in_seconds ?? q.wait.final_in_seconds) : NaN
        rec.repriceAfter = now() + Math.max(REPRICE_AGAIN_MS, Number.isFinite(secs) ? secs * 1000 : 0)
        return put(rec)
      }
      // Nobody offers it this moment: a maker quotes nothing while it reads its coins again after a
      // trade, so within the time given it is asked again at the next advance.
      if (now() - since <= mostMs && ['wallet-busy', 'no-firm-offer', 'not-offered'].includes(q.why)) return put(rec)
      // What it was to pay is no longer the wallet's: said so, not as a price that moved.
      rec.state = 'returned'; rec.whyKind = ['no-funds', 'own-short'].includes(q.why) ? 'gone' : 'moved'; rec.error = 'no price within the bound: ' + q.why
      return back()
    }
    if (!within(q)) {
      drop(q.choice)
      rec.state = 'returned'; rec.whyKind = 'moved'; rec.newTicket = q.ticket; rec.error = 'the price moved past the bound accepted'
      return back()
    }
    // The record as stored now: another follow may have moved it on meanwhile.
    const cur = records().find((r) => r.id === rec.id)
    if (!cur || cur.state !== state) { drop(q.choice); return cur || rec }
    if (rec.moveFee) cur.moveFee = rec.moveFee
    log(state === 'settling' ? '[user trade] settled first; going ahead at the price accepted:' : '[user trade] priced again; going ahead at the price accepted:', rec.id)
    try { return await confirm(q.choice, q.ticket, cur) } catch (e) {
      log('[user trade] going ahead again:', e && e.message)
      return records().find((r) => r.id === rec.id) || rec
    }
  }

  async function advanceOnce (rec) {
    if (!rec || ['settled', 'returned', 'failed', 'undone'].includes(rec.state)) return rec
    // A trade waiting to be priced again moves on under a claim no other page of this wallet holds
    // at the same time (as a composed trade does), from its record as stored then: two tabs never
    // settle, price or accept it twice, and one never writes back a copy the other moved past.
    if (rec.state === 'settling' || rec.state === 'repricing') {
      const done = await claimOnce(rec.id, async () => {
        const cur = records().find((r) => r.id === rec.id) || rec
        if (cur.state === 'settling') return advanceSettling(cur)
        if (cur.state === 'repricing') return repriceWithin(cur, REPRICE_MOST_MS, cur.repriceSince || cur.at)
        return cur
      }, deps.locks)
      return done || records().find((r) => r.id === rec.id) || rec
    }
    // A composed trade moves on under a claim no other page of this wallet holds at the same time,
    // from its record as stored then: two pages never move or take for one trade.
    if (rec.source === 'composed') {
      const done = await claimOnce(rec.id, async () => {
        const now_ = records().find((r) => r.id === rec.id) || rec
        if (['settled', 'returned', 'failed', 'undone'].includes(now_.state)) return now_
        return composedAdvance(deps.restricted, now_, { records, put, now, run, stepCoin, confirm: (c, t, x) => confirm(c, t, null, x) })
      }, deps.locks)
      return done || records().find((r) => r.id === rec.id) || rec
    }
    if (rec.state === 'confirming') {
      // The page closed between the record and the step, or the step did not answer. A take or an
      // acceptance the library made is in its own store; read it there. A step that did not answer
      // is looked for until UNCERTAIN_MS has passed.
      const notFound = (why) => { if (rec.uncertain && now() - (rec.uncertainAt || 0) < UNCERTAIN_MS) return; rec.state = 'failed'; rec.error = why }
      if (rec.source === 'leaf-maker' && rec.swap) {
        const s = ((await run('swaps')) || []).find((x) => x.swap === rec.swap)
        if (s && s.role === 'taker') { rec.state = 'sent'; rec.sentAt = now() } else notFound('not accepted')
      } else if (rec.source === 'covenant-round') {
        // A take is a participation; one the wallet did not have before, and no other trade
        // names, is this trade's.
        const known = new Set([...(rec.beforeParts || []), ...records().map((r) => r.take).filter(Boolean)])
        const p = ((await run('participations')) || []).find((x) => !known.has(x.participation) && (x.new_leaves || []).some((n) => n.asset === rec.ticket.receiveAsset))
        if (p) { rec.take = p.participation; rec.state = 'sent'; rec.sentAt = now() } else notFound('not taken')
      } else if (rec.source === 'leaf-resting') {
        // A fill the page closed on is sent again by the library's next sync; the coin it brings
        // is then the wallet's.
        await syncShared()
        const got = ((await run('coins')) || []).find((c) => !(rec.before || []).includes(c.leaf_id) && c.asset === rec.receiveAsset && c.state === 'live')
        if (got) { rec.state = 'sent'; rec.sentAt = now() } else notFound('not filled')
      } else if (rec.source === 'restricted') {
        // A trade whose broadcast did not answer: it was made once the chain knows it. One whose page
        // closed while what it pays from was moving to the chain is followed while that move runs
        // (#697), up to RESTRICTED_MOVE_MOST_MS: it is never ended as not made meanwhile.
        const st = rec.txid ? await Promise.resolve(deps.restricted.status(rec.txid)).catch(() => 'unknown') : 'unknown'
        const moving = !rec.txid && rec.movingSince && now() - rec.movingSince < RESTRICTED_MOVE_MOST_MS && deps.restricted.moving &&
          await Promise.resolve(deps.restricted.moving()).catch(() => true)
        if (st !== 'unknown') { rec.state = 'sent'; rec.sentAt = now() } else if (moving) return rec
        else { delete rec.movingSince; notFound('not made') }
      } else if (rec.source === 'onchain-fill') {
        // A FILL whose broadcast did not answer: it is the wallet's once the node knows it.
        const st = rec.txid ? await Promise.resolve(deps.onchain.status(rec.txid)).catch(() => 'unknown') : 'unknown'
        if (st !== 'unknown') { rec.state = 'sent'; rec.sentAt = now() } else notFound('not broadcast')
      } else if (rec.source === 'btc-gateway' && rec.hash) {
        // Selling: a payment under the hash is the wallet's lock. Buying: a receive under it.
        const mine = rec.dir === 'sell' ? ((await run('lightning_payments')) || {})[rec.hash] : ((await run('lightning_receives')) || {})[rec.hash]
        if (mine) { rec.state = rec.dir === 'sell' ? 'sent' : 'waiting'; rec.sentAt = now() } else notFound('not made')
      } else notFound('not made')
      put(rec)
      if (rec.state !== 'sent' && rec.state !== 'waiting') return rec
    }
    if (rec.source === 'covenant-round') return advanceTake(rec)
    if (rec.source === 'leaf-maker') return advanceSwap(rec)
    if (rec.source === 'btc-gateway') return btcT.advance(rec)
    if (rec.source === 'leaf-resting') return advanceResting(rec)
    if (rec.source === 'onchain-fill') return advanceOnchain(rec)
    if (rec.source === 'restricted') return restrictedAdvance(deps.restricted, rec, put, { now, uncertainMs: UNCERTAIN_MS })
    return rec
  }

  // A covenant order taken on the chain: Settled once its FILL is final. A FILL the chain never
  // takes (another taker spent the order first, and the node dropped it) moved nothing: Returned
  // once it has not been seen for UNCERTAIN_MS.
  async function advanceOnchain (rec) {
    const st = await Promise.resolve(deps.onchain.status(rec.txid)).catch(() => 'unknown')
    rec.chainState = st
    if (st === 'final') { rec.state = 'settled'; rec.settledAt = now() }
    else if (st === 'unknown') {
      if (rec.missingSince == null) rec.missingSince = now()
      if (now() - rec.missingSince >= UNCERTAIN_MS) { rec.state = 'returned'; rec.error = 'the fill never reached the chain' }
    } else rec.missingSince = null
    return put(rec)
  }

  // A fill of a resting order: Settled once the relay records the fill final and the coins it
  // brought are settled in a round that is final.
  async function advanceResting (rec) {
    await syncShared()
    if (deps.relayFills && rec.transfer && !rec.fillFinal) {
      const fills = await Promise.resolve(deps.relayFills(rec.ticket.payAsset, rec.ticket.receiveAsset)).catch(() => [])
      const f = (fills || []).find((x) => x && x.txid === rec.transfer)
      rec.fillState = f ? f.state : null
      if (f && f.state === 'final') rec.fillFinal = true
    }
    // A fill whose answer never came carries no transfer id to find at the relay: its coins' round
    // alone says it is final.
    if ((await settleStep(rec)) === 'settled' && (rec.fillFinal || !deps.relayFills || !rec.transfer)) { rec.state = 'settled'; rec.settledAt = now() }
    return put(rec)
  }

  // The participation of the wallet's own that took coin `c`: named on a coin given up to it
  // (`refresh_waiting`, or the library's note "participation <id>"), on one whose forfeit it signed
  // for that round (the note "participation <id>: its forfeit … is signed"), and on one it spent
  // once released (`spent_by`). -> id | null
  function roundOf (c) {
    if (!c) return null
    const named = (v) => ((/^participation ([0-9a-f]{64})(?::|$)/.exec(String(v || '')) || [])[1]) || null
    if (c.state === 'given') return c.refresh_waiting || named(c.note)
    if (c.state === 'forfeited') return named(c.note)
    if (c.state === 'spent') return named(c.spent_by)
    return null
  }
  // A coin the wallet paid on, offered in a trade, sent, put into an order, a distribution or an
  // offboard of its own, or took home, after the trade brought it: spending it onward proves it
  // arrived, so nothing of the trade waits on it.
  const ONWARD = new Set(['spent', 'given', 'offered', 'sending', 'exiting', 'exited'])
  const movedOn = (c) => ONWARD.has(c.state)

  // The operator's limit on reassignments since a round (`info.depth_limit`); null when unknown.
  async function depthLimit () {
    const info = await operatorInfo()
    const v = info && info.server_info && info.server_info.depth_limit
    return v != null ? Number(v) : null
  }

  async function participation (pid) {
    return ((await run('participations')) || []).find((p) => p.participation === pid) || null
  }

  // The coin a bitcoin purchase brought, as the wallet holds it now (restricted-composed.js): the
  // coin its claim made, or the one the round that settled it made in its place. -> { coin } (live),
  // { waiting } (in a round), { merged } (a round made one coin of it and others), { gone }.
  async function stepCoin (rec) {
    const first = ((rec && rec.settleTargets) || [])[0]
    if (!first || !first.leaf_id) return { gone: true }
    const coins = (await run('coins')) || []
    let id = first.leaf_id
    for (let hop = 0; hop < 4; hop++) {
      const c = coins.find((x) => x && x.leaf_id === id)
      if (!c) return { gone: true }
      if (c.state === 'live') return { coin: c }
      const pid = roundOf(c)
      if (!pid) return movedOn(c) || c.state === 'spent' ? { gone: true } : { waiting: true }
      const p = await participation(pid)
      if (!p || p.state !== 'released') return { waiting: true }
      // A round that gave up this coin alone made one coin of it; with others, a coin that is no
      // longer the purchase's alone.
      if ((p.gives || []).length > 1) return { merged: true }
      const made = (p.new_leaves || []).filter((n) => n && (!n.asset || n.asset === c.asset))
      if (made.length !== 1 || !made[0].leaf_id) return { waiting: true }
      id = made[0].leaf_id
    }
    return { waiting: true }
  }

  // The coins a trade brings, or leaves as change on a reassignment, settled in the operator's
  // next round at no more than the fees its ticket showed: { settle: { coins, participations } }
  // on the record once asked; 'settled' once every round is final. A coin the library has already
  // given up to a round of its own (its refresh of received coins takes a coin as soon as it lands)
  // is settled by that round, followed under its own id; one paid on out of round leaves nothing of
  // the trade to settle. -> 'waiting'|'settled'
  async function settleStep (rec) {
    const targets = rec.settleTargets || []
    if (!targets.length) return 'settled'
    if (!rec.settle) {
      const all = ((await run('coins')) || []).filter((c) => c && !(rec.before || []).includes(c.leaf_id))
      const coins = []
      const taken = []
      const used = new Set()
      const targetOf = new Map()
      for (const t of targets) {
        // A target that names its coin is that coin; otherwise the coin of its asset and value.
        const c = t.leaf_id ? all.find((x) => x.leaf_id === t.leaf_id)
          : all.find((x) => !used.has(x) && x.asset === t.asset && String(x.value) === String(t.value) && (x.state === 'live' || roundOf(x)))
        if (c) used.add(c)
        const pid = roundOf(c)
        if (pid) { taken.push({ coin: c.leaf_id, participation: pid }); continue }
        if (c && c.state === 'live') { coins.push(c); targetOf.set(c.leaf_id, t); continue }
        if (c && t.leaf_id && movedOn(c)) continue
        // A coin looked for by its value that the wallet has already moved on (the change of a sale
        // spent by the next trade, or offered in it) leaves nothing of the trade to settle either.
        if (!c && !t.leaf_id) {
          const gone = all.find((x) => !used.has(x) && x.asset === t.asset && String(x.value) === String(t.value) && movedOn(x))
          if (gone) { used.add(gone); continue }
        }
        const why = t.leaf_id ? `coin ${t.leaf_id} is not live yet` : `no live coin of ${t.value} of ${t.asset} yet`
        if (rec.settleWhy !== why) { rec.settleWhy = why; put(rec); log('[user trade] settle waits:', why) }
        return 'waiting'
      }
      // Only a coin one reassignment short of the operator's limit needs a round now: the rest stay
      // spendable at once (a round can take minutes, and holds the coin meanwhile), and the wallet's
      // own upkeep refreshes them before their dates. A library that does not count hops settles
      // every coin, as before.
      const limit = coins.length ? await depthLimit() : null
      const deep = coins.filter((c) => c.hops == null || limit == null || Number(c.hops) >= limit - 1)
      if (!deep.length && !taken.length) return 'settled'
      const parts = []
      if (deep.length) {
        let q
        try { q = await run('quote', { leaves: deep.map((c) => c.leaf_id), max_fee_ppm: MAX_FEE_PPM }) } catch (e) { log('[user trade] settle quote:', e.message); return 'waiting' }
        for (const qc of q.coins || []) {
          const t = targetOf.get(qc.leaf_id)
          if (!t || big(qc.fee) > big(t.fee)) { log('[user trade] a settle fee rose above the ticket:', qc.leaf_id, String(qc.fee)); return 'waiting' }
        }
        let r
        try { r = await run('participate', { leaves: deep.map((c) => c.leaf_id), max_fee_ppm: MAX_FEE_PPM, shown: q.coins }) } catch (e) { log('[user trade] participate:', e.message); return 'waiting' }
        const ok = ((r && r.participations) || []).filter((p) => p && !p.error && p.participation)
        if (!ok.length) { log('[user trade] participate:', JSON.stringify(r)); return 'waiting' }
        parts.push(...ok.map((p) => p.participation))
      }
      rec.settle = { coins: [...deep.map((c) => c.leaf_id), ...taken.map((t) => t.coin)], participations: [...new Set([...parts, ...taken.map((t) => t.participation)])] }
      put(rec)
      return 'waiting'
    }
    const ps = await Promise.all(rec.settle.participations.map((id) => participation(id)))
    rec.settleState = ps.map((p) => p && p.state)
    // Settled once every round is final (released), whatever became of its new coins afterwards:
    // the next trade often pays them on at once, gives them to a round of its own (one that may
    // never run, the coin then kept under its forfeit), or the wallet has not taken them yet.
    if (ps.every((p) => p && p.state === 'released')) return 'settled'
    // Said once each time it changes: what the settle waits on.
    const why = rec.settle.participations.map((id, i) => `${id.slice(0, 12)} ${ps[i] ? ps[i].state + ' [' + (ps[i].new_leaves || []).map((n) => n.state).join(',') + ']' : 'not in the library'}`).join('; ')
    if (rec.settleWhy !== why) { rec.settleWhy = why; put(rec); log('[user trade] settle waits on its round:', why) }
    // One that will not run, or one the library no longer lists, is asked again at the next pass:
    // its coin is then found as it is now (live again, given up elsewhere, or moved on).
    if (ps.some((p) => !p || ['void', 'expired', 'refused', 'lost'].includes(p.state))) rec.settle = null
    return 'waiting'
  }

  async function advanceTake (rec) {
    await syncShared()
    const p = await participation(rec.take)
    if (!p) return rec
    rec.takeState = p.state
    if (p.state === 'released' && (p.new_leaves || []).every((n) => n.state === 'live')) {
      if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
    } else if (['void', 'expired', 'refused', 'lost'].includes(p.state)) {
      // The take never ran; the library gives its coin back on its own.
      const back = (p.gives || []).every((g) => g.state === 'live')
      if (back) { rec.state = 'returned'; rec.returnedAt = now(); if (big(rec.selfPayCost) > 0n) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: rec.selfPayCost }] }
    }
    return put(rec)
  }

  async function advanceSwap (rec) {
    await syncShared()
    const s = ((await run('swaps')) || []).find((x) => x.swap === rec.swap)
    rec.swapState = s && s.state
    if (s && s.state === 'cancelled') { rec.state = 'returned'; rec.returnedAt = now(); return put(rec) }
    if (s && s.state === 'accepted') {
      // The maker has not completed it: hand the acceptance over again (it may have missed it),
      // and after the wait take the coins back. An answer that the offer is gone (the operator
      // refused the maker's completion) cannot change: the trade is priced again at once.
      if (rec.gone) return advanceGone(rec)
      // A maker that says the swap is done completed it: what it pays the wallet is read from the
      // mailbox now, and the coins signed into it are never taken back (a cancel then would say
      // "Returned" of a trade that went through), however long the maker was away.
      if (!rec.makerDone) {
        try {
          const a = await deps.fetchJson(rec.maker + '/v1/accept', { method: 'POST', body: JSON.stringify({ swap: rec.swap, accept: rec.accept }) })
          if (a && a.state === 'done') { rec.makerDone = true; rec.makerDoneAt = rec.makerDoneAt || now() }
        } catch (e) { if (e.body && e.body.gone) { rec.gone = e.body; return advanceGone(rec) } }
      }
      // A done answer is waited on for MAKER_COMPLETE_MS more, then the coins are taken back as
      // before: a maker that says done and never completes holds no price of the person's for
      // good, and a cancel after a real completion reads done (the library's swap_cancel).
      if (rec.makerDone && now() - (rec.makerDoneAt || 0) <= MAKER_COMPLETE_MS) {
        try { await run('mailbox') } catch (e) { log('[user trade] mailbox:', e && e.message) }
        const s2 = ((await run('swaps')) || []).find((x) => x.swap === rec.swap)
        rec.swapState = s2 && s2.state
        if (!s2 || s2.state !== 'done') return put(rec)
        if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
        return put(rec)
      }
      if (now() - (rec.sentAt || 0) > MAKER_COMPLETE_MS) {
        try {
          const held = ((await run('coins')) || []).filter((c) => c.state === 'offered' || c.state === 'sending')
          const c = await run('swap_cancel', { swap: rec.swap })
          rec.awaiting = !!(c && !c.cancelled && !c.done && c.unknown)
          if (c && c.cancelled) {
            rec.state = 'returned'; rec.returnedAt = now()
            // A cancel moves the coins signed into the acceptance to a fresh coin of the wallet's
            // own, a transfer that leaves margins: the return names them.
            if (c.respent && c.respent.length) {
              const was = held.filter((x) => c.respent.includes(x.leaf_id)).reduce((n, x) => n + big(x.value), 0n)
              const now2 = ((await run('coins')) || []).filter((x) => x.state === 'live' && !(rec.before || []).includes(x.leaf_id) && x.asset === rec.ticket.payAsset)
              const got = now2.reduce((n, x) => n + big(x.value), 0n)
              if (was > got) rec.feesPaid = [{ asset: rec.ticket.payAsset, atoms: String(was - got) }]
            }
          }
        } catch (e) { log('[user trade] swap_cancel:', e.message) }
      }
      return put(rec)
    }
    if (!s || s.state !== 'done') return put(rec)
    // Done: the coins it brings are operator-confirmed until the next round settles them.
    if ((await settleStep(rec)) === 'settled') { rec.state = 'settled'; rec.settledAt = now() }
    return put(rec)
  }

  // Every open trade, moved on; every settled swap, and every undone one not home yet, looked at in
  // the library's swaps: a swap dead after it settled is undone the moment the library says so
  // (undoneOf), however long after, and says so again once what was paid is home.
  async function resume () {
    const out = []
    const all = records()
    const watch = all.filter((r) => r.swap && (r.state === 'settled' || (r.state === 'undone' && !r.undoneBack)))
    if (watch.length) {
      let swaps = []
      try { swaps = (await run('swaps')) || [] } catch (e) { log('[user trade] swaps:', e.message) }
      const by = new Map(swaps.map((x) => [x.swap, x]))
      for (const r of watch) { const x = by.get(r.swap); const u = x && undoneOf(r, x.state, x.return); if (u) out.push(put(u)) }
    }
    for (const r of all) {
      if (ENDED_STATES.includes(r.state)) continue
      try { out.push(await advance(r)) } catch (e) { log('[user trade] resume', r.id, e.message) }
    }
    return out
  }

  return { quote: personWaits(quote), estimate, offered, confirm: personWaits(confirm), advance, resume, records, spendable, release, drop, soon }
}
