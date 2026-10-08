// DEX taker engine: fills resting orders for the SeqDEX site.
//
// Two settlement families, both ported from the proven web-wallet paths:
//  - Same-chain interactive fill (swap.js liftOffer): the taker builds its
//    half with Wollet.seqdexSwapRequest, the maker co-signs over the SeqOB
//    relay courier (vendor/seqob.js), and the taker signs + self-broadcasts.
//  - Pure-Lightning swap (swap.js plnSwapBody path): the LSP drives the swap
//    on the user's OWN hosted nodes; both device signers co-sign; instant and
//    final when settled.
//
// SECURITY: the wallet NEVER trusts the site's numbers. The site names an
// offer (mount, pair, offer_id) and a take size; the wallet re-fetches the
// offer from the relay itself, recomputes the amounts with the daemon's exact
// proRata / slice math, and shows THOSE in the approval window.

import { AssetId, Pset } from '../pkg/lwk_wasm.js';
import * as wasmMod from '../pkg/lwk_wasm.js';
import * as seqob from '../vendor/seqob.js';
import { sessionMnemonic } from './vault.js';
import { settleFill as covSettleFill, planFillFromMatched } from '../vendor/covenant-order.js';
import { makeCovenantHooks, revHexStr } from '../vendor/covenant-fill-host.js';
import * as A from './assets.js';
import * as engine from './engine.js';
import { stripBip32 } from './psetbytes.js';
import * as ln from './ln.js';
import { BASE, ESPLORA, DEFAULT_FEERATE, EXCHANGE_RATE_SCALE } from './config.js';
import { fmtAtoms, stGet, stSet } from './util.js';
import { ensureOffscreen } from './offscreen-doc.js';

const MOUNTS = {
  ln: BASE + '/seqob-pln',
  chain: BASE + '/seqob',
  conf: BASE + '/seqob-conf',
};
const EST_SWAP_VSIZE = 1500n;   // explicit same-chain swap fee estimate (vbytes)

let progressSink = null;
export function setProgressSink(fn) { progressSink = fn; }
function say(t) { try { progressSink && progressSink(t); } catch {} }

// ---- the relay is the source of truth for offer terms ----
export async function fetchOffer(mount, base, quote, offerId) {
  const q = mount === 'conf' ? '?confidential=1' : '';
  const url = `${MOUNTS[mount]}/v1/market/${encodeURIComponent(base)}/${encodeURIComponent(quote)}/orderbook${q}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('order book unreachable (HTTP ' + r.status + ')');
  const j = await r.json();
  const o = (j.offers || []).find((x) => x.offer_id === offerId);
  if (!o) throw new Error('that offer is no longer on the book; refresh and pick another');
  // The relay protojson-encodes bytes fields as base64; normalize exactly like
  // the courier's own fetchBook does (covenant terms et al become hex).
  seqob.normRelayOffer(o);
  const now = Math.floor(Date.now() / 1000);
  if (Number(o.expires_at_unix || 0) > 0 && Number(o.expires_at_unix) <= now) throw new Error('that offer has expired');
  return o;
}

const big = (v) => BigInt(v ?? 0);
const ceilDiv = (a, b) => (a + b - 1n) / b;

// ---- same-chain fill ------------------------------------------------------

// The daemon's exact proRata: recv = floor(offer*take/base), pay = ceil(want*take/base).
export function sameChainQuote(o, takeBase) {
  const baseAmt = big(o.base_amount), offerAmt = big(o.offer_amount), wantAmt = big(o.want_amount);
  if (baseAmt <= 0n) throw new Error('malformed offer');
  let take = big(takeBase);
  if (take < 1n) take = 1n;
  if (take > baseAmt) take = baseAmt;
  const recv = (offerAmt * take) / baseAmt;   // taker RECEIVES the maker's offer_asset
  const pay = ceilDiv(wantAmt * take, baseAmt); // taker PAYS the maker's want_asset
  if (recv <= 0n || pay <= 0n) throw new Error('that take size prices to zero; increase it');
  return { take, payAsset: o.want_asset, payAtoms: pay, recvAsset: o.offer_asset, recvAtoms: recv, capped: take >= baseAmt };
}

// Open-fee-market fee for the swap tx: the native policy fee converted into
// the chosen fee asset at its published rate. Prefer paying the fee in the
// asset being paid, else the asset received, else tSEQ; only priced assets.
function pickFee(payAsset, recvAsset) {
  const candidates = [payAsset, recvAsset, A.policyHex()];
  for (const a of candidates) {
    try {
      const rate = A.feeRateFor(a);
      const nativeFeeSats = (BigInt(DEFAULT_FEERATE) * EST_SWAP_VSIZE) / 1000n;
      const amount = ceilDiv(nativeFeeSats * BigInt(EXCHANGE_RATE_SCALE), rate);
      return { feeAsset: a, feeAmount: amount, feeRate: rate };
    } catch {}
  }
  throw new Error('no fee-priced asset available for the swap fee');
}

// Prepare a same-chain fill: verify against the relay, compute the exact
// amounts, and return { display, exec } for the approval flow.
export async function prepareOnchainFill({ mount = 'chain', base, quote, offerId, takeBase, confidential = false }) {
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
  await engine.syncIfStale();   // the balance check below must see the live UTXO set
  const o = await fetchOffer(mount, base, quote, offerId);
  if (o.cross_chain) throw new Error('cross-chain offers are not fillable from the site yet');
  if (o.covenant || o.Covenant) {
    if (confidential) throw new Error('covenant orders are transparent by design; this one cannot be on the confidential book');
    return prepareCovenantFill(o, takeBase);
  }
  if (!o.same_chain || !o.same_chain.maker_recv_address) throw new Error('this offer has no same-chain settlement terms');
  if (confidential && !o.confidential) throw new Error('this is not a confidential-book offer');
  const q = sameChainQuote(o, takeBase);
  const fee = pickFee(q.payAsset, q.recvAsset);
  const pm = A.assetMeta(q.payAsset), rm = A.assetMeta(q.recvAsset), fm = A.assetMeta(fee.feeAsset);

  const have = engine.availableFor(q.payAsset);
  if (have < q.payAtoms + (fee.feeAsset === q.payAsset ? fee.feeAmount : 0n)) {
    throw new Error('not enough ' + pm.ticker + ' to fill this: it costs ' + fmtAtoms(q.payAtoms, pm.precision) + ' plus the network fee');
  }

  const display = {
    text: 'Fill a resting order on the SeqDEX ' + (confidential ? 'confidential' : 'on-chain') + ' book.',
    deltas: [
      { ticker: pm.ticker, atoms: '-' + q.payAtoms.toString(), precision: pm.precision || 0 },
      { ticker: rm.ticker, atoms: q.recvAtoms.toString(), precision: rm.precision || 0 },
    ],
    detail: (q.capped ? 'Fills the whole offer. ' : 'Partial fill at the offer’s exact ratio. ')
      + 'Network fee ≈ ' + fmtAtoms(fee.feeAmount, fm.precision || 0) + ' ' + fm.ticker
      + (confidential ? ' · settles as a blinded transaction' : '')
      + ' · atomic: one transaction moves both sides or nothing moves.',
  };

  const exec = async () => {
    seqob.setSeqobBase(MOUNTS[mount]);
    const wollet = engine.getWollet(), signer = engine.getSigner(), client = engine.getClient();
    // The receive address is ALWAYS the confidential form: seqdexSwapRequest
    // requires a blinding pubkey (the maker's stateless blinder blinds the
    // taker's receive output to it; change goes there too). This settlement
    // variant has no transparent-receive mode.
    const receiveAddr = engine.rawAddress(true);
    const buildRequest = async () => engine.withWollet(async () => {
      const sreq = wollet.seqdexSwapRequest(
        new AssetId(q.payAsset), q.payAtoms,
        new AssetId(q.recvAsset), q.recvAtoms,
        receiveAddr,
        new AssetId(fee.feeAsset), fee.feeAmount, fee.feeRate,
      );
      return sreq.toJson();
    });
    const finalizeAccept = async (acc) => engine.withWollet(async () => {
      const pset = new Pset(acc.transaction);
      pset.addDetails(wollet);
      const signed = signer.sign(pset);
      const strippedB64 = stripBip32(signed.toString());
      const finalized = wollet.finalize(new Pset(strippedB64));
      const txid = await client.broadcast(finalized);
      try { wollet.applyTransaction(finalized); } catch {}
      engine.noteOwn(finalized);
      return { transaction: strippedB64, txid: txid.toString() };
    });
    const res = await seqob.lift(o, q.take, fee.feeAsset, { buildRequest, finalizeAccept, onStatus: say });
    engine.sync().catch(() => {});
    return {
      txid: (res && res.txid) || null,
      paid: { asset: q.payAsset, atoms: q.payAtoms.toString() },
      received: { asset: q.recvAsset, atoms: q.recvAtoms.toString() },
    };
  };

  return { display, exec };
}

// ---- covenant fill ----------------------------------------------------------
// A funded, self-enforcing resting order: the maker locked asset A in one
// taproot UTXO and can be offline; ANYONE who pays the baked-in price may
// spend it, enforced by the tapscript interpreter. No maker round-trip: the
// taker assembles the FILL (covenant input 0, no signature; own explicit
// funding inputs for the credit + fee), verified byte-for-byte against the
// on-chain scriptPubKey by covenant-order.js before anything is signed.
async function prepareCovenantFill(o, takeBase) {
  const q = sameChainQuote(o, takeBase);   // recvAsset = the covenant's asset A
  // Fee must not be the covenant's sold asset A; prefer the credit asset B.
  const fee = (() => {
    for (const a of [q.payAsset, A.policyHex()]) {
      if (a === q.recvAsset) continue;
      try {
        const rate = A.feeRateFor(a);
        const nativeFeeSats = (BigInt(DEFAULT_FEERATE) * EST_SWAP_VSIZE) / 1000n;
        return { asset: a, atoms: ceilDiv(nativeFeeSats * BigInt(EXCHANGE_RATE_SCALE), rate) };
      } catch {}
    }
    throw new Error('no fee-priced asset available for the fill fee');
  })();

  const synth = {
    resting_is_covenant: true,
    covenant: o.covenant || o.Covenant,
    covenant_locked: String(BigInt(o.offer_amount)),
    fill_base_amount: q.recvAtoms.toString(),
    offer_id: o.offer_id,
    pair: o.pair,
  };

  // Covenant fills are all-explicit transactions: receive and change go to the
  // TRANSPARENT address (a blinded output could never balance the introspected
  // explicit amounts).
  const transparentAddr = engine.rawAddress(false).toString();
  const ctx = {
    wasm: wasmMod,
    wollet: engine.getWollet(),
    network: engine.getNetwork(),
    mnemonic: engine.getMnemonic(),
    esploraFetch: (path, init) => fetch(ESPLORA + path, init),
    receiveAddress: () => transparentAddr,
    fee: { asset: fee.asset, atoms: fee.atoms.toString() },
    noteOwnTx: engine.noteOwn,
    onStatus: say,
    // The live maker fleet re-quotes, so its covenants keep a key-path cancel
    // (non-NUMS internal key). For the TAKER that is availability risk, not
    // fund risk: the fill is one atomic transaction, and a maker cancel merely
    // voids the order. Opt in, and disclose it on the approval sheet.
    opts: { makerCancellableOK: true },
  };
  const hooks = makeCovenantHooks(ctx);

  // Verify against the funded UTXO and derive the consensus-exact amounts for
  // the approval sheet (the recipe, not our display math, is what settles).
  const ct = synth.covenant;
  const spkHex = await hooks.fetchUtxoSpk(ct.covenant_txid || ct.covenantTxid, ct.covenant_vout ?? ct.covenantVout ?? 0);
  const recipe = planFillFromMatched(synth, spkHex, { makerCancellableOK: true });
  const payAsset = revHexStr(recipe.creditAsset);
  const recvAsset = revHexStr(recipe.covenantAsset);
  const pm = A.assetMeta(payAsset), rm = A.assetMeta(recvAsset), fm = A.assetMeta(fee.asset);

  // A covenant fill spends EXPLICIT coins only (the leaf introspects explicit
  // amounts). If the credit+fee need is short on explicit coins but covered by
  // blinded ones, plan an automatic explicitizing self-transfer first — chained
  // in the mempool ahead of the fill — instead of telling the user to do it.
  const needByAsset = new Map();
  needByAsset.set(payAsset, BigInt(recipe.creditValue));
  needByAsset.set(fee.asset, (needByAsset.get(fee.asset) || 0n) + fee.atoms);
  const explicitize = [];
  {
    const utxos = engine.getWollet().utxos();
    for (const [asset, target] of needByAsset) {
      let explicit = 0n, blinded = 0n;
      for (const u of utxos) {
        try {
          const sec = u.unblinded();
          if (sec.asset().toString() !== asset) continue;
          const isExp = sec.isExplicit ? sec.isExplicit() : true;
          if (isExp) explicit += BigInt(sec.value()); else blinded += BigInt(sec.value());
        } catch {}
      }
      if (explicit < target) {
        if (explicit + blinded < target + (asset === fee.asset ? fee.atoms : 0n)) {
          throw new Error('not enough ' + A.assetMeta(asset).ticker + ' to fill this order');
        }
        explicitize.push({ asset, amount: target });
      }
    }
  }

  const display = {
    text: 'Fill a funded covenant order on the SeqDEX on-chain book. The order is enforced by the chain itself; the maker can be offline.',
    deltas: [
      { ticker: pm.ticker, atoms: '-' + String(recipe.creditValue), precision: pm.precision || 0 },
      { ticker: rm.ticker, atoms: q.recvAtoms.toString(), precision: rm.precision || 0 },
    ],
    detail: (recipe.partial ? 'Partial fill; the remainder re-locks in a fresh covenant for the next taker. ' : 'Fills the whole order. ')
      + 'Network fee ≈ ' + fmtAtoms(fee.atoms, fm.precision || 0) + ' ' + fm.ticker
      + ' · consensus-exact: the chain rejects any underpay or redirect.'
      + ' The maker can cancel this order until your fill confirms; a cancel voids the fill and nothing of yours moves.'
      + (explicitize.length ? ' Includes an automatic self-transfer first: part of your balance is in blinded outputs, and a covenant fill spends explicit coins only.' : ''),
  };

  const exec = async () => {
    for (const e of explicitize) {
      say('Making your blinded ' + A.assetMeta(e.asset).ticker + ' spendable for the fill…');
      await engine.sendToAddress({ chain: 'seq', asset: e.asset, amount: e.amount.toString(), address: transparentAddr });
    }
    const res = await engine.withWollet(() => covSettleFill(synth, hooks));
    engine.sync().catch(() => {});
    return {
      txid: res.txid || null,
      paid: { asset: payAsset, atoms: String(recipe.creditValue) },
      received: { asset: recvAsset, atoms: q.recvAtoms.toString() },
    };
  };
  return { display, exec };
}

// ---- pure-Lightning swap ---------------------------------------------------

// Partial-fill slice pricing, the exact mirror of the Go taker (xdriver_pureln
// RunTakerPureLN): quote msat derived from the signed offer's ratio; floor
// when the taker GIVES the quote side (buy), ceil when it RECEIVES it (sell).
export function plnSliceQuote(side, takeAtoms, offerAssetAtoms, offerQuoteAtoms) {
  const take = big(takeAtoms), oa = big(offerAssetAtoms), oq = big(offerQuoteAtoms);
  if (take <= 0n || oa <= 0n || oq <= 0n) return null;
  if (take >= oa) return { whole: true, takeAtoms: oa, quoteAtoms: oq, dust: oq <= 0n };
  const num = oq * take * 1000n;
  const msat = side === 'sell' ? (num + oa - 1n) / oa : num / oa;
  const quoteAtoms = msat / 1000n;
  return { whole: false, takeAtoms: take, quoteAtoms, dust: quoteAtoms <= 0n };
}

export async function prepareLnSwap({ base, quote, offerId, takeAtoms }) {
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
  const o = await fetchOffer('ln', base, quote, offerId);
  const ld = o.lightning ? Number(o.lightning.ln_direction ?? -1) : -1;
  if (ld !== 2 && ld !== 3) throw new Error('this offer does not settle purely over Lightning');

  // Taking the other side of the maker's direction.
  const makerBuys = o.trade_dir === 'TRADE_DIR_BUY';
  const side = makerBuys ? 'sell' : 'buy';           // taker sells base into a bid, buys base from an ask
  const offerAssetAtoms = big(o.base_amount);
  const offerQuoteAtoms = big(makerBuys ? o.offer_amount : o.want_amount);
  const q = plnSliceQuote(side, takeAtoms ?? offerAssetAtoms, offerAssetAtoms, offerQuoteAtoms);
  if (!q) throw new Error('malformed offer amounts');
  if (q.dust) throw new Error('that take size prices to zero on the other leg; increase it');

  const bm = A.assetMeta(base);
  const qm = quote === 'BTC' ? { ticker: 'BTC', precision: 8 } : A.assetMeta(quote);
  const payTicker = side === 'buy' ? qm.ticker : bm.ticker;
  const payAtoms = side === 'buy' ? q.quoteAtoms : q.takeAtoms;
  const payPrec = side === 'buy' ? qm.precision : bm.precision;
  const recvTicker = side === 'buy' ? bm.ticker : qm.ticker;
  const recvAtoms = side === 'buy' ? q.takeAtoms : q.quoteAtoms;
  const recvPrec = side === 'buy' ? bm.precision : qm.precision;

  const display = {
    text: 'Swap over Lightning on the LNDEX. Instant and final when it settles; nothing moves on-chain.',
    deltas: [
      { ticker: payTicker, atoms: '-' + payAtoms.toString(), precision: payPrec || 0 },
      { ticker: recvTicker, atoms: recvAtoms.toString(), precision: recvPrec || 0 },
    ],
    detail: (q.whole ? 'Fills the whole resting offer. ' : 'Partial fill at the offer’s exact ratio. ')
      + 'Both legs travel through your own Lightning channels; if it stalls, nothing moves and your funds are returned automatically.',
  };

  // The swap runs in the OFFSCREEN document: a service worker dies to idle
  // clocks and task caps mid-swap (seen live, repeatedly); the offscreen page
  // has neither. The approved exec dispatches a job and returns its id; the
  // site polls dexJobResult, so even a worker death cannot lose the outcome.
  const exec = async () => {
    const phrase = await sessionMnemonic();
    if (!phrase) throw new Error('the wallet is locked');
    await ensureOffscreen();
    // Durably record which assets this wallet trades over Lightning: the
    // balance/status paths use this to query LN-only nodes (an LN balance with
    // no on-chain trace was otherwise invisible in every display).
    try {
      const prev = (await stGet('local', 'ext.lnAssets')) || [];
      const add = [base, quote].filter((a) => /^[0-9a-f]{64}$/i.test(String(a || '')));
      const next = [...new Set([...prev, ...add.map((a) => a.toLowerCase())])];
      if (next.length !== prev.length) await stSet('local', 'ext.lnAssets', next);
    } catch {}
    const job = 'oln' + Date.now() + Math.random().toString(36).slice(2, 8);
    // The dispatcher writes the started record itself: it must exist even if
    // the offscreen page dies before its first write.
    await chrome.storage.local.set({ ['ext.olnjob.' + job]: { done: false, started: true, at: Date.now() } });
    const counterKind = quote === 'BTC' ? 'BTC' : quote;
    await chrome.runtime.sendMessage({
      scope: 'oln', op: 'swap', job,
      params: {
        phrase, base, counterKind, side,
        baseTicker: bm.ticker, counterTicker: qm.ticker,
        recvAtoms: recvAtoms.toString(),
        amountUnits: Number(q.takeAtoms) / Math.pow(10, bm.precision || 0),
        offerId: o.offer_id, makerPubkey: o.maker_pubkey,
        takeAtomsNum: q.whole ? null : Number(q.takeAtoms),
        takeAtoms: q.takeAtoms.toString(), quoteAtoms: q.quoteAtoms.toString(),
      },
    });
    return { jobId: job, pending: true };
  };

  return { display, exec };
}


// Market order on the pure-Lightning book: ONE approval, then the offscreen
// engine walks the opposing resting orders best-first (the wallet plans the
// slices here from the relay book — the site names only side + amount). A
// slice that fails is skipped, never retried blind; the walk stops 5% past
// the best price so a thin book cannot fill at cliff prices.
export async function prepareLnMarketOrder({ base, quote, side, baseAtoms }) {
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
  if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
  const want = big(baseAtoms);
  if (want <= 0n) throw new Error('amount must be positive');
  const q = quote || 'BTC';
  const url = `${MOUNTS.ln}/v1/market/${encodeURIComponent(base)}/${encodeURIComponent(q)}/orderbook`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('order book unreachable (HTTP ' + r.status + ')');
  const book = await r.json();
  const now = Math.floor(Date.now() / 1000);
  const opposing = (book.offers || []).filter((o) => {
    const ld = o.lightning ? Number(o.lightning.ln_direction ?? -1) : -1;
    if (ld !== 2 && ld !== 3) return false;
    if (Number(o.expires_at_unix || 0) > 0 && Number(o.expires_at_unix) <= now) return false;
    return side === 'buy' ? o.trade_dir === 'TRADE_DIR_SELL' : o.trade_dir === 'TRADE_DIR_BUY';
  });
  for (const o of opposing) seqob.normRelayOffer(o);
  const priceOf = (o) => {
    const makerBuys = o.trade_dir === 'TRADE_DIR_BUY';
    const qa = big(makerBuys ? o.offer_amount : o.want_amount);
    const ba = big(o.base_amount);
    return ba > 0n ? Number(qa) / Number(ba) : Infinity;
  };
  opposing.sort((a, b) => (side === 'buy' ? priceOf(a) - priceOf(b) : priceOf(b) - priceOf(a)));
  if (!opposing.length) throw new Error('no opposing resting orders on the pure-Lightning book');
  const best = priceOf(opposing[0]);
  const slices = [];
  let remaining = want, totalQuote = 0n;
  for (const o of opposing) {
    if (remaining <= 0n) break;
    const p = priceOf(o);
    if (side === 'buy' ? p > best * 1.05 : p < best * 0.95) break;
    const sq = plnSliceQuote(side, remaining < big(o.base_amount) ? remaining : big(o.base_amount),
      o.base_amount, o.trade_dir === 'TRADE_DIR_BUY' ? o.offer_amount : o.want_amount);
    if (!sq || sq.dust) continue;
    slices.push({
      offerId: o.offer_id, makerPubkey: o.maker_pubkey,
      takeAtoms: sq.takeAtoms.toString(), quoteAtoms: sq.quoteAtoms.toString(),
      takeAtomsNum: sq.whole ? null : Number(sq.takeAtoms),
    });
    remaining -= sq.takeAtoms; totalQuote += sq.quoteAtoms;
  }
  if (!slices.length) throw new Error('nothing fillable within the slippage bound');
  const filled = want - remaining;
  const bm = A.assetMeta(base);
  const qm = q === 'BTC' ? { ticker: 'BTC', precision: 8 } : A.assetMeta(q);
  const display = {
    text: 'Market ' + side + ' on the LNDEX: walks the book across ' + slices.length + ' resting order' + (slices.length > 1 ? 's' : '') + '.',
    deltas: side === 'buy'
      ? [{ ticker: qm.ticker, atoms: '-' + totalQuote.toString(), precision: qm.precision || 0 },
         { ticker: bm.ticker, atoms: filled.toString(), precision: bm.precision || 0 }]
      : [{ ticker: bm.ticker, atoms: '-' + filled.toString(), precision: bm.precision || 0 },
         { ticker: qm.ticker, atoms: totalQuote.toString(), precision: qm.precision || 0 }],
    detail: (remaining > 0n ? 'The book covers ' + fmtAtoms(filled, bm.precision || 0) + ' ' + bm.ticker + ' of the requested amount within 5% of the best price; the rest is not placed. ' : '')
      + 'Each slice settles atomically over Lightning; a failed slice is skipped.',
  };
  const exec = async () => {
    const phrase = await sessionMnemonic();
    if (!phrase) throw new Error('the wallet is locked');
    await ensureOffscreen();
    try {
      const prev = (await stGet('local', 'ext.lnAssets')) || [];
      const add = [base, q].filter((a) => /^[0-9a-f]{64}$/i.test(String(a || '')));
      const next = [...new Set([...prev, ...add.map((a) => a.toLowerCase())])];
      if (next.length !== prev.length) await stSet('local', 'ext.lnAssets', next);
    } catch {}
    const job = 'oln' + Date.now() + Math.random().toString(36).slice(2, 8);
    await chrome.storage.local.set({ ['ext.olnjob.' + job]: { done: false, started: true, at: Date.now() } });
    await chrome.runtime.sendMessage({
      scope: 'oln', op: 'market', job,
      params: {
        phrase, side, base, counterKind: q === 'BTC' ? 'BTC' : q,
        baseTicker: bm.ticker, counterTicker: qm.ticker,
        basePrecision: bm.precision || 0, slices,
      },
    });
    return { jobId: job, pending: true, slices: slices.length };
  };
  return { display, exec };
}


// Limit order: fill whatever the book already crosses at (or better than) the
// limit price, then REST the remainder as a live maker offer served by the
// wallet's persistent engine. One approval covers both halves.
export async function prepareLnLimitOrder({ base, quote, side, baseAtoms, limitQuoteAtoms }) {
  if (!(await engine.ensureOpen())) throw new Error('the wallet is locked');
  if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
  const want = big(baseAtoms), limitQuote = big(limitQuoteAtoms);
  if (want <= 0n || limitQuote <= 0n) throw new Error('amount and limit price are required');
  const q = quote || 'BTC';
  const url = `${MOUNTS.ln}/v1/market/${encodeURIComponent(base)}/${encodeURIComponent(q)}/orderbook`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('order book unreachable (HTTP ' + r.status + ')');
  const book = await r.json();
  const now = Math.floor(Date.now() / 1000);
  const opposing = (book.offers || []).filter((o) => {
    const ld = o.lightning ? Number(o.lightning.ln_direction ?? -1) : -1;
    if (ld !== 2 && ld !== 3) return false;
    if (Number(o.expires_at_unix || 0) > 0 && Number(o.expires_at_unix) <= now) return false;
    return side === 'buy' ? o.trade_dir === 'TRADE_DIR_SELL' : o.trade_dir === 'TRADE_DIR_BUY';
  });
  for (const o of opposing) seqob.normRelayOffer(o);
  // Unit price comparison in exact integers: offerQuote*limitBase <=> limitQuote*offerBase.
  const crosses = (o) => {
    const oq = big(o.trade_dir === 'TRADE_DIR_BUY' ? o.offer_amount : o.want_amount);
    const ob = big(o.base_amount);
    if (ob <= 0n) return false;
    return side === 'buy' ? oq * want <= limitQuote * ob : oq * want >= limitQuote * ob;
  };
  const priceOf = (o) => {
    const oq = big(o.trade_dir === 'TRADE_DIR_BUY' ? o.offer_amount : o.want_amount);
    const ob = big(o.base_amount);
    return ob > 0n ? Number(oq) / Number(ob) : Infinity;
  };
  const crossing = opposing.filter(crosses)
    .sort((a, b) => (side === 'buy' ? priceOf(a) - priceOf(b) : priceOf(b) - priceOf(a)));
  const slices = [];
  let remaining = want, quoteFilled = 0n;
  for (const o of crossing) {
    if (remaining <= 0n) break;
    const sq = plnSliceQuote(side, remaining < big(o.base_amount) ? remaining : big(o.base_amount),
      o.base_amount, o.trade_dir === 'TRADE_DIR_BUY' ? o.offer_amount : o.want_amount);
    if (!sq || sq.dust) continue;
    slices.push({ offerId: o.offer_id, makerPubkey: o.maker_pubkey,
      takeAtoms: sq.takeAtoms.toString(), quoteAtoms: sq.quoteAtoms.toString(),
      takeAtomsNum: sq.whole ? null : Number(sq.takeAtoms) });
    remaining -= sq.takeAtoms; quoteFilled += sq.quoteAtoms;
  }
  const restBase = remaining;
  const restQuote = restBase > 0n ? (limitQuote * restBase + want - 1n) / want : 0n;
  const bm = A.assetMeta(base);
  const qm = q === 'BTC' ? { ticker: 'BTC', precision: 8 } : A.assetMeta(q);
  const display = {
    text: 'Limit ' + side + ' on the LNDEX' + (slices.length
      ? ': fills ' + fmtAtoms(want - restBase, bm.precision || 0) + ' ' + bm.ticker + ' now (the book crosses your price), rests the remainder.'
      : ': rests on the book at your price until matched.'),
    deltas: side === 'buy'
      ? [{ ticker: qm.ticker, atoms: '-' + limitQuote.toString(), precision: qm.precision || 0 },
         { ticker: bm.ticker, atoms: want.toString(), precision: bm.precision || 0 }]
      : [{ ticker: bm.ticker, atoms: '-' + want.toString(), precision: bm.precision || 0 },
         { ticker: qm.ticker, atoms: limitQuote.toString(), precision: qm.precision || 0 }],
    detail: 'Worst case at your limit price; a resting remainder is served live by this wallet and matched the moment a crossing order appears. Closing the browser withdraws it (the book expires it within the hour).',
  };
  const exec = async () => {
    const phrase = await sessionMnemonic();
    if (!phrase) throw new Error('the wallet is locked');
    await ensureOffscreen();
    try {
      const prev = (await stGet('local', 'ext.lnAssets')) || [];
      const add = [base, q].filter((a) => /^[0-9a-f]{64}$/i.test(String(a || '')));
      const next = [...new Set([...prev, ...add.map((a) => a.toLowerCase())])];
      if (next.length !== prev.length) await stSet('local', 'ext.lnAssets', next);
    } catch {}
    const job = 'oln' + Date.now() + Math.random().toString(36).slice(2, 8);
    await chrome.storage.local.set({ ['ext.olnjob.' + job]: { done: false, started: true, at: Date.now() } });
    await chrome.runtime.sendMessage({
      scope: 'oln', op: 'limit', job,
      params: {
        phrase, side, base, counterKind: q === 'BTC' ? 'BTC' : q,
        baseTicker: bm.ticker, counterTicker: qm.ticker, basePrecision: bm.precision || 0,
        slices, restBase: restBase.toString(), restQuote: restQuote.toString(),
      },
    });
    return { jobId: job, pending: true, fillsNow: slices.length, rests: restBase > 0n };
  };
  return { display, exec };
}

export async function jobResult(jobId) {
  if (jobId) {
    const key = 'ext.olnjob.' + String(jobId);
    const o = await chrome.storage.local.get(key);
    return o[key] || { done: false };
  }
  // No id: the newest job (a page that lost its jobId to a worker restart
  // can still recover the outcome).
  const all = await chrome.storage.local.get(null);
  let best = null, bestKey = null;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('ext.olnjob.')) continue;
    if (!best || (v.at || 0) > (best.at || 0)) { best = v; bestKey = k; }
  }
  return best ? { ...best, jobId: bestKey.slice('ext.olnjob.'.length) } : { done: false, none: true };
}

// ---- PSET bip32-derivation stripping (verbatim from the proven web-wallet
// path: the maker's co-signed PSET carries our bip32 derivations; the node
// rejects finalized PSETs that still carry them) ----
