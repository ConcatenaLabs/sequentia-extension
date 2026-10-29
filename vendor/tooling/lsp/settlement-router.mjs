// Settlement router — the rail-agnostic matching principle, made concrete.
//
// PRINCIPLE (Andreas, 2026-07-16): the DEX matches on {asset, price, size, side} ALONE.
// Rails (Lightning vs on-chain) are NOT a matching axis — they are a settlement preference
// each party states for the side it holds. This module takes a MATCH that already happened
// (rail-blind) and decides HOW to settle it, inserting an LSP bridge ONLY where the two
// sides' rail choices genuinely cross. When they coincide, the LSP is not in the value path
// at all (it only did matchmaking). See memory dex-rail-agnostic-matching.
//
// A BTC<->asset swap has exactly two legs, atomically bound by ONE preimage H:
//   • BTC leg:   payer = BUYER  (pays BTC),   receiver = SELLER (receives BTC)
//   • asset leg: payer = SELLER (pays asset), receiver = BUYER  (receives asset)
// Each leg's two endpoints each have a rail. Per leg:
//   • endpoints AGREE            -> settle natively on that rail (no bridge)
//   • endpoints DISAGREE (cross) -> the LSP terminates the LN end and originates the
//                                   on-chain end, passing H through: one submarine hop,
//                                   on THAT leg only.
// A receiver on 'ln' with no inbound liquidity needs a JIT channel first (provisionInbound).
//
// This file is a PURE function: no I/O, no config, no fund movement. It is the spine the
// live settlement path (runMixed / the cross-book couriers / pure-LN) will be refactored to
// obey, and it is exhaustively unit-tested in settlement-router.test.mjs.

/** @typedef {'ln'|'chain'|'leaf'} Rail */

// THE LEAF RAIL. A leaf is a coin in an operator's tree (developer mode's leaves). It settles in
// one of two ways, and never through the LSP or a preimage:
//   • IN THE TREE: both parties hold leaves on both legs. One reassignment both wallets sign
//     (offer, accept, complete) moves both assets at once: method 'in-tree'.
//   • IN A ROUND: one party holds leaves on both legs and the other is an ordinary on-chain
//     covenant order. The operator's round spends the order, pays its maker on the chain and
//     gives the taker a leaf: method 'round' (a take from leaves).
// Every other shape with a leaf has no construction, and is refused rather than planned: a leaf
// against Lightning needs the operator's gateway, which developer mode's composer does not run
// (user mode's BTC trade does, in one shape: planSingleStep's 'leaf-ln' below), and a party
// with a leaf on one leg and the chain on the other is no trade either side can sign. BTC is
// never a leaf: native bitcoin lives on its own chain, so a BTC leg stays on Lightning or an
// on-chain hash-lock, and a pair with BTC in it has no leaf rail at all.

/**
 * @param {object} match
 * @param {string} match.asset   asset id (or ticker) being traded against BTC
 * @param {string} [match.quote] the pair's quote asset when it is not BTC (a same-chain pair, its
 *   quote in BTC's structural place). Only a same-chain pair has a leaf rail.
 * @param {object} match.buyer   { btcRail:Rail, assetRail:Rail, assetInbound?:boolean }
 *   buyer PAYS BTC on btcRail, RECEIVES the asset on assetRail. assetInbound: does the
 *   buyer already hold LN inbound for the asset? (only consulted when assetRail==='ln')
 * @param {object} match.seller  { assetRail:Rail, btcRail:Rail, btcInbound?:boolean }
 *   seller PAYS the asset on assetRail, RECEIVES BTC on btcRail. btcInbound: only consulted
 *   when btcRail==='ln'.
 * @returns {object} a settlement plan (see below)
 */
export function planSettlement(match) {
  if (!match || !match.buyer || !match.seller) throw new Error('planSettlement: match needs buyer and seller');
  const { buyer, seller } = match;
  assertRail(buyer.btcRail, 'buyer.btcRail');
  assertRail(buyer.assetRail, 'buyer.assetRail');
  assertRail(seller.assetRail, 'seller.assetRail');
  assertRail(seller.btcRail, 'seller.btcRail');
  if ([buyer.btcRail, buyer.assetRail, seller.assetRail, seller.btcRail].includes('leaf')) return planLeafSettlement(match);

  // BTC leg: buyer pays, seller receives. Asset leg: seller pays, buyer receives.
  const btcLeg = planLeg('btc', buyer.btcRail, seller.btcRail, !!seller.btcInbound);
  const assetLeg = planLeg('asset', seller.assetRail, buyer.assetRail, !!buyer.assetInbound);

  const bridged = btcLeg.bridge || assetLeg.bridge;
  return {
    asset: match.asset ?? null,
    // WHICH ENDPOINT IS THE TAKER. A leg's lnSide names the PAYER/RECEIVER role that sits on Lightning,
    // which is not enough on its own: on the asset leg 'payer' means the MAKER when the taker buys and
    // the TAKER when the taker sells, and those are two completely different settlement problems. Carry
    // it so a capability predicate can tell them apart instead of admitting both or refusing both.
    takerSide: match.takerSide ?? null,
    btcLeg,
    assetLeg,
    // Whole-swap atomicity is always one shared preimage H. When the LSP bridges a leg it
    // must hold H until BOTH legs are locked (so neither party can be left half-settled);
    // when nothing is bridged, the two real parties bind H directly (on-chain couriers or
    // pure-LN) and the LSP only introduced them.
    atomic: { sharedPreimage: true, lspCoordinates: bridged },
    // The "happy coincidence": both legs settle on the rail each endpoint already wanted,
    // so no submarine hop and no bridge fee. This is the common, cheapest path and must be
    // preferred whenever the match allows it.
    happyCoincidence: !bridged,
    // Everything the caller must actually DO, in order, to make settlement happen.
    steps: buildSteps(btcLeg, assetLeg),
  };
}

/**
 * Decide a single leg. payerRail/receiverRail are the rails the two endpoints chose;
 * receiverInbound says whether an LN receiver already has inbound liquidity.
 */
export function planLeg(unit, payerRail, receiverRail, receiverInbound) {
  assertRail(payerRail, `${unit} payerRail`);
  assertRail(receiverRail, `${unit} receiverRail`);
  if (payerRail === 'leaf' || receiverRail === 'leaf') return planLeafLeg(unit, payerRail, receiverRail);
  const native = payerRail === receiverRail;
  // A receiver on Lightning must have inbound liquidity to receive at all. If not, a JIT
  // channel is opened toward it first (provisionInbound). This is independent of bridging:
  // it applies to a native ln-ln leg too.
  const jitInbound = receiverRail === 'ln' && !receiverInbound;

  if (native) {
    return {
      unit,
      rail: payerRail,
      method: payerRail === 'ln' ? 'ln-htlc' : 'onchain-htlc',
      bridge: false,
      lnSide: null,
      jitInbound,
    };
  }
  // Endpoints cross: exactly one is 'ln'. The LSP is the LN counterparty to the ln end and
  // the on-chain counterparty to the chain end, forwarding the SAME H. One submarine hop.
  return {
    unit,
    rail: 'mixed',
    method: 'submarine',
    bridge: true,
    lnSide: payerRail === 'ln' ? 'payer' : 'receiver',
    jitInbound,
  };
}

/**
 * Route a rail-blind MATCH to its settlement PATH, given the resting offer's signed capability signals.
 *
 * PRINCIPLE (rail-crossing-p2p-lsp-design.md): matching is rail-blind; settlement picks a mutually-supported
 * rail. A DIRECT peer-to-peer submarine is the FIRST-CLASS path whenever the counterparties line up (an
 * interactive online maker that can itself accept BTC-LN); the LSP leg-bridge is the FALLBACK ONLY on a
 * genuine mismatch (an on-chain-only / passive covenant maker). This applies symmetrically both directions.
 *
 * The rail crossing is on the BTC leg (the mismatch is always the BTC leg — the asset leg is Sequentia
 * on-chain). Its lnSide names who is on Lightning: 'payer' = the BUYER pays BTC over LN (a BUY), 'receiver'
 * = the SELLER receives BTC over LN (a SELL).
 *   • interactive maker that accepts BTC-LN  -> P2P submarine (no LSP in the value path): ln_direction 1 for
 *     the buy (reverse submarine, maker locks the asset + mints a bolt11 the taker pays), 0 for the sell
 *     (normal submarine, taker mints a bolt11 the maker pays).
 *   • else (on-chain-only / covenant)        -> the LSP payer/receiver leg-bridge terminates the LN end and
 *     originates the on-chain BTC HTLC, passing the shared H through.
 *
 * PURE. `offerSignals` is the taken offer's meta.caps (unified-book) — {btc_ln, interactive, asset_onchain,
 * maker_ln_node_pubkey} — or an object carrying them directly. planSettlement/planLeg are unchanged; this
 * only decides HOW, from the plan they produce.
 *
 * @param {object} match          a planSettlement match ({asset, buyer, seller})
 * @param {object} [offerSignals] the resting offer's caps (or {caps:{...}})
 * @returns {{ path:'native'|'p2p-submarine'|'lsp-bridge'|'leaf-swap'|'leaf-take'|null, ln_direction:0|1|null, lnSide:'payer'|'receiver'|null, reason?:string }}
 */
export function chooseSettlementPath(match, offerSignals = {}) {
  const plan = planSettlement(match);
  const caps = (offerSignals && offerSignals.caps) || offerSignals || {};
  // A leaf plan settles by the wallet's leaf library alone: an in-tree swap with another wallet
  // that holds leaves, or a take from leaves of an on-chain order the round can spend. Neither
  // is 'native' in the LSP's sense, and neither ever falls back to the LSP: an order the round
  // cannot spend is no path at all.
  if (plan.leaf) {
    if (plan.leaf.shape === 'in-tree') return { path: 'leaf-swap', ln_direction: null, lnSide: null };
    if (caps.leaf_take) return { path: 'leaf-take', ln_direction: null, lnSide: null };
    return { path: null, ln_direction: null, lnSide: null,
      reason: 'this order cannot be taken from leaves: a round spends only a transparent covenant order' };
  }
  if (plan.happyCoincidence) return { path: 'native', ln_direction: null, lnSide: null };
  const btc = plan.btcLeg, asset = plan.assetLeg;
  if (btc && btc.bridge) {
    // The BTC leg crosses. Its lnSide fixes the taker side: payer=>buy (taker pays BTC-LN), receiver=>sell.
    const side = btc.lnSide === 'payer' ? 'buy' : 'sell';
    // A P2P SUBMARINE CAN ONLY BRIDGE ONE LEG — THE BTC ONE.
    //
    // It is two counterparties swapping directly: the maker takes BTC over Lightning and settles its
    // asset on-chain. That works precisely because the ASSET leg is native. When the asset leg crosses
    // too (the maker delivers its asset over Lightning while the taker wants it on-chain), there is no
    // party in a P2P swap who can produce an on-chain asset for the taker — the maker does not hold one
    // and the LSP is not in the value path at all.
    //
    // This checked only the BTC leg, so a doubly-crossed shape against an interactive maker was routed
    // to P2P anyway. Watched it happen: a GOLD buy dispatched to 'p2p-buy' and died with "This trade
    // could not be completed", because the path chosen could never have settled it whatever the
    // counterparties did. The LSP bridge is the only settlement for that shape (it sources the asset
    // from the LN maker as principal and fronts it on-chain), so route there and let the capability
    // predicate have the final word.
    if (caps.interactive && caps.btc_ln && !(asset && asset.bridge))
      return { path: 'p2p-submarine', ln_direction: side === 'buy' ? 1 : 0, lnSide: btc.lnSide };
    return { path: 'lsp-bridge', ln_direction: null, lnSide: btc.lnSide };
  }
  // Only the ASSET leg crosses (a JIT asset-LN receive) — no P2P submarine for that in this phase; the LSP
  // asset-leg bridge is the path (its lnSide names the LN endpoint on the asset leg).
  return { path: 'lsp-bridge', ln_direction: null, lnSide: (asset && asset.lnSide) || null };
}

function buildSteps(btcLeg, assetLeg) {
  const steps = [];
  // Provision inbound BEFORE anything locks, so an LN receiver can actually receive.
  for (const leg of [btcLeg, assetLeg]) {
    if (leg.jitInbound) steps.push({ op: 'provision-inbound', leg: leg.unit });
  }
  // Lock both legs (order is caller's concern; the router just states what must lock).
  for (const leg of [btcLeg, assetLeg]) {
    steps.push({ op: leg.bridge ? 'lock-submarine' : (leg.method === 'ln-htlc' ? 'lock-ln' : 'lock-onchain'), leg: leg.unit });
  }
  // Reveal H to claim; when any leg is bridged the LSP gates the reveal for atomicity.
  steps.push({ op: 'reveal-preimage', gatedByLsp: btcLeg.bridge || assetLeg.bridge });
  return steps;
}

function assertRail(r, where) {
  if (r !== 'ln' && r !== 'chain' && r !== 'leaf') throw new Error(`${where} must be 'ln', 'chain' or 'leaf' (got ${JSON.stringify(r)})`);
}

const isBtc = (a) => a == null || String(a).toUpperCase() === 'BTC';

// One leg with a leaf on at least one end (see THE LEAF RAIL above).
function planLeafLeg(unit, payerRail, receiverRail) {
  if (payerRail === 'ln' || receiverRail === 'ln')
    throw new Error(`${unit} leg: a leaf settles with Lightning only through the operator's gateway, which this composer does not run`);
  if (payerRail === 'leaf' && receiverRail === 'leaf')
    return { unit, rail: 'leaf', method: 'in-tree', bridge: false, lnSide: null, jitInbound: false };
  return { unit, rail: 'round', method: 'round', bridge: false, lnSide: null, jitInbound: false,
    leafSide: payerRail === 'leaf' ? 'payer' : 'receiver' };
}

// A whole match with a leaf in it. Only two shapes exist: both parties on leaves (one in-tree
// swap), or one party on leaves on both legs against an on-chain order (a take in a round).
function planLeafSettlement(match) {
  const { buyer, seller } = match;
  if (isBtc(match.quote))
    throw new Error('BTC is never a leaf: a pair with BTC settles its BTC leg over Lightning or on the chain, so it has no leaf rail');
  const leafParty = (p, a, b) => {
    if (p[a] === 'leaf' && p[b] === 'leaf') return true;
    if (p[a] === 'leaf' || p[b] === 'leaf') throw new Error('a party pays and receives from leaves on both legs, or on neither');
    return false;
  };
  const buyerLeaf = leafParty(buyer, 'btcRail', 'assetRail');
  const sellerLeaf = leafParty(seller, 'assetRail', 'btcRail');
  if (!buyerLeaf && !sellerLeaf) throw new Error('planLeafSettlement: no leaf in the match');
  const other = buyerLeaf ? seller : buyer;
  if (!(buyerLeaf && sellerLeaf) && (other.btcRail !== 'chain' || other.assetRail !== 'chain'))
    throw new Error('a party on leaves trades either with another party on leaves (in the tree) or with an on-chain order (in a round)');
  const btcLeg = planLeafLeg('btc', buyer.btcRail, seller.btcRail);
  const assetLeg = planLeafLeg('asset', seller.assetRail, buyer.assetRail);
  const shape = buyerLeaf && sellerLeaf ? 'in-tree' : 'round';
  return {
    asset: match.asset ?? null,
    takerSide: match.takerSide ?? null,
    btcLeg,
    assetLeg,
    // One reassignment (in the tree) or one round transaction binds both legs: no preimage, and
    // the LSP is never in the value path.
    atomic: { sharedPreimage: false, oneTransaction: true, lspCoordinates: false },
    happyCoincidence: true,
    leaf: { shape, leafParty: shape === 'in-tree' ? 'both' : (buyerLeaf ? 'buyer' : 'seller') },
    steps: shape === 'in-tree'
      ? [{ op: 'swap-offer' }, { op: 'swap-accept' }, { op: 'swap-complete' }]
      : [{ op: 'take-quote' }, { op: 'take' }, { op: 'forfeits-to-round' }],
  };
}

// The leaf library's commands that settle a leaf plan, in order, or null for a plan without a
// leaf. A leaf plan never has an LSP binary (planExecutionName answers null for it).
export function leafExecution(plan) {
  if (!plan || !plan.leaf) return null;
  return plan.leaf.shape === 'in-tree'
    ? ['swap_offer', 'swap_read', 'swap_accept', 'swap_complete']
    : ['take_quote', 'take'];
}

// --- Current-execution mapping (Stage 1b) ---------------------------------------
// The live LSP is the counterparty and MIRRORS the user's chosen rails, so every leg is native
// today (no bridge). settlementPlanForSide expresses that as a match; planExecutionName maps the
// resulting no-bridge plan to the deployed seqob-cli binary. Kept here (not in the server) so it
// is unit-testable without loading the http server. A bridge plan (a genuine rail crossing, which
// arrives with rail-blind matching in Stage 2) has no current binary and maps to null.
export function settlementPlanForSide(side, payRail, recvRail) {
  const match = side === 'buy'
    ? { asset: 'x', buyer:  { btcRail: payRail,  assetRail: recvRail },
                    seller: { assetRail: recvRail, btcRail: payRail } }
    : { asset: 'x', buyer:  { btcRail: recvRail, assetRail: payRail },
                    seller: { assetRail: payRail, btcRail: recvRail } };
  return planSettlement(match);
}
// The MIXED-rail (submarine) dispatch only: which xsub* binary settles a take
// whose two legs sit on DIFFERENT rails. Its callers build submarine argv from
// the name, so a same-rail shape must stay null here rather than be answered with
// a binary of a different shape.
//
// PURE-LN (both legs Lightning) is therefore deliberately absent, and adding
// 'ln:ln' -> 'xpln' here would mis-dispatch. Routing an ln/ln take is the
// caller's job, through the same bridgedTakePlan/renderMixedTake path the other
// rails use — and it is gated on a real protocol gap first: xpln has no
// take-amount flag, so it lifts the best resting offer IN FULL and cannot do the
// partial fills every other rail now does.
export function planExecutionName(side, plan) {
  // A leaf plan is the wallet's own leaf library's (leafExecution), never a seqob-cli binary: an
  // LSP handed one must refuse it, so it maps to null like a shape the binaries cannot run.
  if (plan.leaf) return null;
  if (plan.btcLeg.bridge || plan.assetLeg.bridge) return null;   // rail crossing -> Stage-2 bridge
  return {
    'buy:ln:chain':   'xsubbuy',      // pay BTC over LN, claim asset on-chain
    'buy:chain:ln':   'xsubas',       // pay BTC on-chain HTLC, receive asset over LN (HODL)
    'sell:ln:chain':  'xsublift',     // fund asset HTLC on-chain, receive BTC over LN
    'sell:chain:ln':  'xsubas-sell',  // pay asset over LN, receive BTC on-chain
  }[`${side}:${plan.btcLeg.rail}:${plan.assetLeg.rail}`] || null;
}

// --- The single step (user mode) -----------------------------------------------------------
// User mode offers only what settles in one native step and never falls back mid-trade
// (single-step-book.mjs). Each source of its book settles one way, which the router names here
// from the same leaf plans as developer mode's, so the two modes cannot disagree on what a shape
// is: an in-tree swap ('leaf-swap', both parties on leaves) or a take from leaves in a round
// ('leaf-take', against an on-chain order), or a trade of BTC for an asset in one hash-lock
// ('leaf-ln': the asset leg in the operator's tree under the hash, between two wallets of its,
// and the BTC leg over Bitcoin Lightning under the same hash). Any other source is refused,
// never planned.
export const SINGLE_STEP_SOURCES = Object.freeze({
  'leaf-maker': { path: 'leaf-swap', taker: { leaf: true }, maker: 'leaf' },
  'covenant-round': { path: 'leaf-take', taker: { leaf: true }, maker: 'chain' },
  'btc-gateway': { path: 'leaf-ln', taker: { leaf: true, btc: 'ln' }, maker: 'leaf' },
  'leaf-resting': { path: 'leaf-fill-resting', taker: { leaf: true }, maker: 'resting-leaf' },
  // A transparent covenant order taken on the chain from the wallet's own on-chain coins: one
  // transaction, no operator, no leaves.
  'onchain-fill': { path: 'native', taker: { chain: true }, maker: 'chain' },
});

// The one hash-lock of a BTC trade: BTC over Lightning on both ends (native), the asset from a
// leaf to a leaf under the same hash (the operator settles it between its own two wallets, no
// Lightning channel in the asset in its path). The hash is the BTC receiver's, and the asset's
// giver locks first.
function planLeafLightning ({ payAsset, receiveAsset }) {
  if ((payAsset === 'BTC') === (receiveAsset === 'BTC')) throw new Error('a BTC trade names BTC and one asset besides it')
  const asset = payAsset === 'BTC' ? receiveAsset : payAsset
  return {
    asset, takerSide: payAsset === 'BTC' ? 'buy' : 'sell',
    btcLeg: { unit: 'btc', rail: 'ln', method: 'ln-htlc', bridge: false, lnSide: null, jitInbound: false },
    assetLeg: { unit: 'asset', rail: 'leaf', method: 'tree-htlc', bridge: false, lnSide: null, jitInbound: false },
    atomic: { sharedPreimage: true, lspCoordinates: false },
    happyCoincidence: true,
    leaf: { shape: 'hash-lock', hashBy: 'btc-receiver' },
    steps: payAsset === 'BTC'
      ? [{ op: 'receive-under-hash' }, { op: 'maker-locks-asset' }, { op: 'pay-btc-when-held' }, { op: 'claim-with-preimage' }]
      : [{ op: 'btc-invoice' }, { op: 'pay-asset-under-hash' }, { op: 'maker-pays-btc-when-held' }, { op: 'settle-with-preimage' }],
  };
}

// The settlement of a single-step source for a trade of `payAsset` for `receiveAsset`:
// { path, plan, commands } from the router's own plans, or a refusal for anything that is not
// one step. `caps` is the entry's unified-book capabilities, when it has them.
export function planSingleStep(source, { payAsset, receiveAsset, caps } = {}) {
  const s = SINGLE_STEP_SOURCES[source];
  if (!s) throw new Error(`${JSON.stringify(source)} is not a single-step source`);
  if (!payAsset || !receiveAsset || payAsset === receiveAsset) throw new Error('a trade names two assets');
  if (s.path === 'leaf-fill-resting') {
    if (isBtc(payAsset) || isBtc(receiveAsset)) throw new Error(`${source} trades no BTC: BTC is never a leaf`);
    // One transfer in the operator's tree, which the operator co-signs: the order's coin and the
    // taker's coins in, what the taker gets, the order's credit and its remainder out. The maker
    // may be away; the operator is the one party left to act.
    const plan = {
      asset: receiveAsset, quote: payAsset, takerSide: 'buy',
      btcLeg: { unit: 'btc', rail: 'leaf', method: 'in-tree', bridge: false, lnSide: null, jitInbound: false },
      assetLeg: { unit: 'asset', rail: 'leaf', method: 'in-tree', bridge: false, lnSide: null, jitInbound: false },
      atomic: { sharedPreimage: false, oneTransaction: true, lspCoordinates: false },
      happyCoincidence: true,
      leaf: { shape: 'resting', leafParty: 'both' },
      steps: [{ op: 'order-fill-resting-quote' }, { op: 'order-fill-resting' }],
    };
    return { path: s.path, plan, commands: ['order_fill_resting_quote', 'order_fill_resting'] };
  }
  if (s.path === 'leaf-ln') {
    const plan = planLeafLightning({ payAsset, receiveAsset });
    return { path: s.path, plan, commands: payAsset === 'BTC'
      ? ['lightning_receive_quote', 'lightning_receive', 'lightning_receive_ready', 'lightning_receive_preimage', 'sync']
      : ['lightning_pay_quote', 'lightning_pay', 'lightning_post_preimage', 'sync'] };
  }
  if (isBtc(payAsset) || isBtc(receiveAsset)) throw new Error(`${source} trades no BTC: BTC is never a leaf`);
  if (source === 'onchain-fill') {
    // Both sides on the chain: the taker's coins and the order's covenant in one FILL transaction.
    const chain = { btcRail: 'chain', assetRail: 'chain' };
    const plan = planSettlement({ asset: receiveAsset, quote: payAsset, buyer: chain, seller: chain, takerSide: 'buy' });
    return { path: s.path, plan, commands: ['covenant_fill'] };
  }
  const leaves = { btcRail: 'leaf', assetRail: 'leaf' };
  const other = s.maker === 'leaf' ? leaves : { btcRail: 'chain', assetRail: 'chain' };
  // The wallet buys `receiveAsset` with `payAsset`: the receive asset in the base's place.
  const match = { asset: receiveAsset, quote: payAsset, buyer: leaves, seller: other, takerSide: 'buy' };
  const plan = planSettlement(match);
  const path = chooseSettlementPath(match, caps ? { caps } : (s.path === 'leaf-take' ? { caps: { leaf_take: true } } : {})).path;
  if (path !== s.path) throw new Error(`${source} does not settle in one step here (${path || 'no path'})`);
  return { path, plan, commands: leafExecution(plan) };
}
