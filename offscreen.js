const OFFSCREEN_BUILD = '0.5.22';
// Offscreen document: the home for LONG Lightning operations. A service
// worker gets killed by idle clocks and task caps no keepalive fully
// defeats; this is a real page with neither. The worker hands a job over,
// this page runs it to completion (however long the hosted nodes take),
// streams progress, and writes the result to storage — so even a worker
// death cannot lose the outcome. The mnemonic arrives over extension
// messaging (trusted contexts only) and never leaves this page.
import {
  initSeqln, provisionAndConnect, waitNodeReady, seqlnChannelInbound, seqlnSwap,
  seqlnNodeInvoice, seqlnInvoiceStatus, seqlnNodeSettle, seqlnNodePay,
  provisionedState, deviceTransportPubkey,
} from './vendor/seqln.js';
import {
  Crypter, signOffer, randHex, makerKeyFromSeed, setSeqobBase, seqobBase,
} from './vendor/seqob.js';
import { lnDeriveNode, lnDeriveAsset } from './vendor/seqln-keys.js';
import { LSP, BASE } from './src/config.js';
import './offscreen-leaves.js';

initSeqln({
  lspUrl: LSP.url,
  token: LSP.token,
  wsBase: LSP.wsBase,
  // A page may dynamic-import, so the default sdkPath works here.
  nodes: {
    asset: { wsUrl: LSP.wsAsset, hostPubkey: LSP.hostPubkeyAsset },
    btc: { wsUrl: LSP.wsBtc, hostPubkey: LSP.hostPubkeyBtc },
  },
});

function progress(job, text) {
  chrome.runtime.sendMessage({ scope: 'oln-progress', job, text }).catch(() => {});
}

// Offscreen documents may use no chrome API beyond runtime messaging —
// chrome.storage does not exist here (a first-line use of it silently killed
// whole runs). Durable writes are relayed to the service worker, and each
// relay message also wakes the worker.
function store(key, val) {
  return chrome.runtime.sendMessage({ scope: 'oln-store', key, val });
}
async function storeSure(key, val) {
  for (let i = 0; i < 10; i++) {
    try { await store(key, val); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
}

// nodeKey -> ms of the last SUCCESSFUL swap step on it. While a node is hot
// (and its signer never dropped — the offscreen document now OUTLIVES jobs, so
// wss signer links persist), the bring-up ritual (provision HTTP, readiness
// poll, inbound ensure, hintability probe) is skipped wholesale: those exist
// for cold/revived nodes, and re-running them cost ~15s of every warm swap.
const HOT = {};
const HOT_TTL = 5 * 60_000;

async function connectOwn(kind, phrase, label) {
  const expect = kind === 'BTC'
    ? 'btc:' + String(await deviceTransportPubkey(lnDeriveNode(phrase, 'btc').transportPrivkey)).toLowerCase()
    : String(kind).toLowerCase();
  const st = provisionedState()[expect];
  if (st && st.connected && st.nodeId) return { connected: true, key: expect, nodeId: st.nodeId, warm: true };
  const prov = kind === 'BTC'
    ? await provisionAndConnect({
        chain: 'btc', label: 'BTC', policy: 'enforce',
        deriveIdentity: () => { const d = lnDeriveNode(phrase, 'btc'); return { transportPrivkey: d.transportPrivkey, signingSeed: d.signingSeed }; },
      })
    : await provisionAndConnect({
        chain: 'seq', assetId: kind, label, policy: 'enforce',
        deriveIdentity: (id) => lnDeriveAsset(phrase, id),
      });
  if (!(prov && prov.connected)) throw new Error('could not bring your device signer online for your ' + label + ' Lightning node');
  return prov;
}

async function waitPatient(job, nodeKey, label, totalMs = 8 * 60_000) {
  const deadline = Date.now() + totalMs;
  for (;;) {
    try {
      await waitNodeReady({ nodeKey, onProgress: () => progress(job, 'Preparing your ' + label + ' node (booting and syncing)…') });
      return;
    } catch (e) {
      if (Date.now() > deadline) throw e;
      progress(job, 'Your ' + label + ' node is still syncing; holding on…');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// The 902 boot race: a just-revived node answers RPC well before its channels
// finish re-establishing with their peers, and creating an invoice with route
// hints then fails ("None of those hints were suitable local channels" — seen
// live killing a swap before any HTLC existed; the channel became hintable 91s
// after boot). Creating a throwaway hold-invoice IS the exact readiness test,
// so keep probing until hints resolve, then let the real swap proceed.
async function waitHintable(job, nodeKey, asset, label, totalMs = 150_000) {
  const deadline = Date.now() + totalMs;
  const rnd = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(rnd);
    const hash = [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      await seqlnNodeInvoice({ node_key: nodeKey, asset, amount: 1, payment_hash: hash, expiry: 60 });
      return;
    } catch (e) {
      // Only the hint race is worth waiting out; any other failure belongs to
      // the swap itself, which will surface it honestly.
      if (!/hints|suitable|902/i.test(String((e && e.message) ?? e))) return;
      if (Date.now() > deadline) return;
      progress(job, 'Your ' + label + ' channel is coming online; holding until it can receive…');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function runSwap(job, p, marks) {
  const mark = (st) => marks.push([st, Date.now()]);
  mark('start');
  const provBase = await connectOwn(p.base, p.phrase, p.baseTicker);
  mark(provBase.warm ? 'base-warm' : 'base-connected');
  const provCounter = await connectOwn(p.counterKind, p.phrase, p.counterTicker);
  mark(provCounter.warm ? 'counter-warm' : 'counter-connected');
  const hotBase = provBase.warm && (Date.now() - (HOT[provBase.key] || 0) < HOT_TTL);
  const hotCounter = provCounter.warm && (Date.now() - (HOT[provCounter.key] || 0) < HOT_TTL);
  if (!hotBase) {
    progress(job, 'Bringing your ' + p.baseTicker + ' Lightning node online…');
    await waitPatient(job, provBase.key, p.baseTicker);
    mark('base-ready');
  }
  if (!hotCounter) {
    progress(job, 'Bringing your ' + p.counterTicker + ' Lightning node online…');
    await waitPatient(job, provCounter.key, p.counterTicker);
    mark('counter-ready');
  }
  const recvProv = p.side === 'buy' ? provBase : provCounter;
  const recvAsset = p.side === 'buy' ? p.base : (p.counterKind === 'BTC' ? undefined : p.counterKind);
  const recvLabel = p.side === 'buy' ? p.baseTicker : p.counterTicker;
  const hotRecv = (p.side === 'buy' ? hotBase : hotCounter);
  if (!hotRecv) {
    progress(job, 'Ensuring inbound capacity on your receiving leg…');
    try {
      if (p.side === 'buy') await seqlnChannelInbound({ node_key: provBase.key, asset: p.base, amount: Number(p.recvAtoms) });
      else await seqlnChannelInbound({ node_key: provCounter.key, asset: p.counterKind === 'BTC' ? undefined : p.counterKind, amount: Number(p.recvAtoms) });
    } catch {}
    mark('inbound-ensured');
    await waitHintable(job, recvProv.key, recvAsset, recvLabel);
    mark('hintable');
  }
  progress(job, 'Settling over Lightning…');
  const r = await seqlnSwap({
    side: p.side, asset: p.base, amount: p.amountUnits,
    quote_asset: p.counterKind === 'BTC' ? undefined : p.counterKind,
    node_key: provBase.key, counter_node_key: provCounter.key,
    offer_id: p.offerId, maker_pubkey: p.makerPubkey,
    take_atoms: p.takeAtomsNum ?? undefined,
  });
  mark('settled');
  HOT[provBase.key] = HOT[provCounter.key] = Date.now();
  return {
    settled: true,
    direction: r.direction || (p.side === 'sell' ? 'sold' : 'bought'),
    baseAtoms: String(r.base_amount ?? p.takeAtoms),
    quoteAtoms: String(r.quote_amount ?? p.quoteAtoms),
    preimage: r.preimage || null,
    paymentHash: r.hash_h || null,
  };
}


// ---------------------------------------------------------------------------
// RESTING MAKER: the wallet serves a pure-LN limit order's resting remainder,
// speaking the Go maker's five-message protocol (xcourier_pureln.go). The
// relay binds this WS when the offer is posted over it and delivers
// lift_requested here; every session is E2E-encrypted (ECDH + AES-GCM)
// between the offer's maker key and the taker's session key. Presence is
// honest: the offer lives while this document lives, and expiry reaps it.
async function makerSeedHex(phrase, tag) {
  const data = new TextEncoder().encode('seqdex-lndex-maker:' + tag + ':' + phrase);
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64e(bytes) { let x = ''; for (let i = 0; i < bytes.length; i++) x += String.fromCharCode(bytes[i]); return btoa(x); }
function b64d(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
const teEnc = new TextEncoder(), tdDec = new TextDecoder();
// ceil/floor variants of the daemon's proportional quote (BigInt, no overflow).
const propCeil = (whole, take, base) => (take >= base ? whole : (whole * take + base - 1n) / base);
const propFloor = (whole, take, base) => (take >= base ? whole : (whole * take) / base);

async function runRest(job, p) {
  const key = 'ext.olnjob.' + job;
  // The maker identity includes the BUILD stamp: the relay routes lift
  // sessions by maker pubkey, and a ghost engine (stale cache, orphaned
  // document) sharing a deterministic key could capture lifts meant for the
  // live one — seen live answering with obsolete protocol semantics. A ghost
  // now holds a different, obsolete pubkey whose offers simply expire.
  const mk = makerKeyFromSeed(await makerSeedHex(p.phrase, OFFSCREEN_BUILD + ':' + p.base + '/' + p.counterKind));
  // The maker pubkey must ride INSIDE the signed lightning terms; extract it
  // by signing a throwaway object (signOffer derives + sets it from the priv).
  const _d = { offer_id: 'x', pair: { base_asset: 'x', quote_asset: 'x' } };
  signOffer(_d, mk);
  const makerPub = _d.maker_pubkey;
  const hexB64 = (h) => { const b = []; for (let i = 0; i < h.length; i += 2) b.push(parseInt(h.slice(i, i + 2), 16)); return b64e(Uint8Array.from(b)); };
  const provBase = await connectOwn(p.base, p.phrase, p.baseTicker);
  const provCounter = await connectOwn(p.counterKind, p.phrase, p.counterTicker);
  await waitPatient(job, provBase.key, p.baseTicker);
  await waitPatient(job, provCounter.key, p.counterTicker);
  const sell = p.side === 'sell';           // maker sells base (rests an ask)
  const pre = p.prefill || {};
  const state = {
    remaining: BigInt(p.baseAtoms), quoteRemaining: BigInt(p.quoteAtoms),
    filled: BigInt(pre.baseAtoms || '0'), quoteFilled: BigInt(pre.quoteAtoms || '0'),
    offerId: null, fills: (pre.slices || []).filter((x) => x.ok).map((x) => ({ crossing: true, ...x })),
  };
  // The maker socket must never fall silent: an idle websocket gets closed by
  // the front proxy within a minute and the relay then EVICTS the resting
  // offer as unliftable (seen live on the first wallet-served offer). A cheap
  // subscribe frame every 20s keeps it open; a drop reconnects and re-posts.
  let ws = null, closed = false;
  const send = (o) => { try { ws && ws.send(JSON.stringify(o)); } catch {} };
  const keep = setInterval(() => {
    send({ market_subscribe: { base_asset: p.base, quote_asset: p.counterKind === 'BTC' ? 'BTC' : p.counterKind } });
  }, 20_000);
  const connect = () => {
    ws = new WebSocket((BASE + '/seqob-pln').replace(/^http/, 'ws') + '/v1/ws');
    ws.onopen = () => { if (state.remaining > 0n) post(); };
    ws.onmessage = onWsMessage;
    ws.onclose = () => {
      if (closed) return;
      progress(job, 'Relay link dropped; re-resting your order…');
      setTimeout(() => { if (!closed) connect(); }, 3000);
    };
  };
  const post = () => {
    const o = {
      offer_id: randHex(16), schema_version: 1,
      pair: { base_asset: p.base, quote_asset: p.counterKind === 'BTC' ? 'BTC' : p.counterKind, confidential: false },
      trade_dir: sell ? 'TRADE_DIR_SELL' : 'TRADE_DIR_BUY',
      base_amount: state.remaining.toString(),
      offer_amount: (sell ? state.remaining : state.quoteRemaining).toString(),
      offer_asset: sell ? p.base : (p.counterKind === 'BTC' ? 'BTC' : p.counterKind),
      want_amount: (sell ? state.quoteRemaining : state.remaining).toString(),
      want_asset: sell ? (p.counterKind === 'BTC' ? 'BTC' : p.counterKind) : p.base,
      allow_partial: true, min_fill: '0',
      created_at_unix: String(Math.floor(Date.now() / 1000)),
      expires_at_unix: String(Math.floor(Date.now() / 1000) + 3600),
      fee_asset_hint: '', min_anchor_depth: 0,
      maker_ln_node_pubkey: provBase.nodeId || '',
      ln_connect_hints: [], time_in_force: 'TIME_IN_FORCE_UNSPECIFIED', confidential: false,
      lightning: { ln_direction: sell ? 3 : 2, maker_claim_pub: makerPub, maker_refund_pub: makerPub,
        onchain_cltv: 240, maker_issues_hold_invoice: false, max_0conf_amount: '0' },
    };
    signOffer(o, mk);
    state.offerId = o.offer_id;
    // Wire form: proto bytes fields travel as BASE64 (the signed object keeps
    // the wallet's hex convention; only the submitted copy converts).
    send({ offer_submit: { ...o, lightning: { ...o.lightning,
      maker_claim_pub: hexB64(makerPub), maker_refund_pub: hexB64(makerPub) } } });
    progress(job, 'Resting ' + (sell ? 'ask' : 'bid') + ': ' + state.remaining + ' atoms on the book.');
    store(key, { done: false, resting: true, offerId: state.offerId,
      remaining: state.remaining.toString(), filledAtoms: state.filled.toString(),
      quoteAtoms: state.quoteFilled.toString(), fills: state.fills, at: Date.now() });
  };

  const sessions = new Map();               // session_id -> raw swap_msg sink
  async function serve(lr) {
    const sid = lr.session_id || lr.sessionId;
    const takerPubB64 = lr.taker_session_pubkey || lr.takerSessionPubkey;
    const takerPub = /^[0-9a-fA-F]{66}$/.test(String(takerPubB64)) ? String(takerPubB64) : b64d(takerPubB64);
    // The taker's PARTIAL slice arrives INSIDE the encrypted terms request (in
    // courier msat = atoms x 1000); lift_requested.take_amount is the relay's
    // whole-offer figure in ATOMS. Reading the slice from the wrong envelope
    // sent nonsense terms on every build until now.
    let take = state.remaining;
    const q_of = (t) => (sell ? propFloor(state.quoteRemaining, t, state.remaining)
                              : propCeil(state.quoteRemaining, t, state.remaining));
    const cr = await Crypter.fromECDH(mk, takerPub);
    const inbox = []; let wake = null;
    sessions.set(sid, (sm) => { inbox.push(sm); if (wake) { const w = wake; wake = null; w(); } });
    const recv = async (type, ms) => {
      const t0 = Date.now();
      for (;;) {
        while (inbox.length) {
          const sm = inbox.shift();
          let m; try { m = JSON.parse(tdDec.decode(await cr.open(b64d(sm.ciphertext)))); } catch { continue; }
          if (m.type === type) return m;
          if (m.type === 'xc_fail') throw new Error('taker: ' + (m.reason || 'failed'));
        }
        if (Date.now() - t0 > ms) throw new Error('timeout waiting ' + type);
        await new Promise((r) => { wake = r; setTimeout(r, 1500); });
      }
    };
    const say = async (m) => send({ swap_msg: { session_id: sid, ciphertext: b64e(await cr.seal(teEnc.encode(JSON.stringify(m)))) } });
    try {
      const req = await recv('pln_terms_request', 90_000);
      let reqMsat = 0n; try { reqMsat = BigInt(String(req.seq_amount || 0)); } catch {}
      const reqAtoms = reqMsat / 1000n;
      if (reqAtoms > 0n && reqAtoms < state.remaining) take = reqAtoms;
      const q = q_of(take);
      const inNodeId = sell ? provCounter.nodeId : provBase.nodeId;   // the leg the taker pays
      await say({ type: 'pln_terms', maker_ln_node_id: inNodeId, btc_amount: Number(q * 1000n), seq_amount: Number(take * 1000n) });
      const inv = await recv('pln_asset_invoice', 90_000);
      const H = String(inv.hash_h || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(H)) throw new Error('bad hash from taker');
      const inKey = sell ? provCounter.key : provBase.key;
      const inAsset = sell ? (p.counterKind === 'BTC' ? undefined : p.counterKind) : p.base;
      // Cross-chain timelock arithmetic (mirrors seqdex pkg/xchain/cltv.go): the chain that must be
      // slow is taken slow, the one that must be fast is taken fast. The incoming hold's lifetime is
      // whatever the taker pays it with, so the maker names the hold timelock it needs to pay the
      // taker's invoice safely, then caps the outgoing route below the hold as actually paid.
      const TIMING = { btc: { fast: 150, slow: 900 }, seq: { fast: 60, slow: 90 } };
      const inIsBtc = sell && p.counterKind === 'BTC';
      const outIsBtc = !sell && p.counterKind === 'BTC';
      const inT = inIsBtc ? TIMING.btc : TIMING.seq, outT = outIsBtc ? TIMING.btc : TIMING.seq;
      const routeAllowance = outIsBtc ? 24 : 120;
      const SETTLE_MARGIN = 20 * 60, HOLD_WAIT = 150;
      const holdCltv = Math.ceil(((18 + routeAllowance) * outT.slow + HOLD_WAIT + SETTLE_MARGIN) / inT.fast);
      await seqlnNodeInvoice({ node_key: inKey, asset: inAsset, amount: Number(sell ? q : take), payment_hash: H, expiry: 900 });
      await say({ type: 'pln_hold_ready', hash_h: H, hold_cltv: holdCltv });
      const hDead = Date.now() + 150_000;
      let held = null;
      for (;;) {
        const st = await seqlnInvoiceStatus({ node_key: inKey, payment_hash: H }).catch(() => ({}));
        if (st.held || st.state === 'accepted') { held = st; break; }
        if (Date.now() > hDead) throw new Error('taker never paid the hold');
        await new Promise((r) => setTimeout(r, 700));
      }
      // Cap the outgoing payment's timelock below the held HTLC's real expiry. Without the
      // expiry (an older node) the swap is refused rather than paid blind.
      const remaining = Number(held.htlc_expiry) - Number(held.btc_tip);
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('hold reported no expiry; refusing to pay blind');
      const maxCltv = Math.floor((remaining * inT.fast - SETTLE_MARGIN) / outT.slow);
      if (!(maxCltv > 0)) throw new Error('the taker paid the hold with too short a timelock (' + remaining + ' blocks left)');
      const outKey = sell ? provBase.key : provCounter.key;
      const paid = await seqlnNodePay({ node_key: outKey, bolt11: inv.bolt11, wantHash: H, maxCltv });
      const P = String((paid && (paid.preimage || paid.payment_preimage)) || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(P)) throw new Error('pay returned no preimage');
      await seqlnNodeSettle({ node_key: inKey, payment_hash: H, preimage: P });
      await say({ type: 'pln_settled' });
      state.remaining -= take; state.quoteRemaining -= q;
      state.filled += take; state.quoteFilled += q;
      state.fills.push({ takeAtoms: take.toString(), quoteAtoms: q.toString(), at: Date.now() });
      progress(job, 'Resting order filled: ' + take + ' atoms; ' + state.remaining + ' remain.');
      if (state.remaining > 0n) post();
      else {
        await storeSure(key, { done: true, ok: true, result: { rested: true, settled: true,
          baseAtoms: state.filled.toString(), quoteAtoms: state.quoteFilled.toString(), fills: state.fills }, at: Date.now() });
        closed = true; clearInterval(keep); clearInterval(pinger);
        chrome.runtime.sendMessage({ scope: 'oln-done', job }).catch(() => {});
        try { ws.close(); } catch {}
      }
    } catch (e) {
      progress(job, 'A lift on your resting order failed (' + String((e && e.message) || e).slice(0, 60) + '); the order rests on.');
      try { await say({ type: 'xc_fail', reason: String((e && e.message) || e).slice(0, 80) }); } catch {}
    } finally { sessions.delete(sid); }
  }

  const onWsMessage = (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : tdDec.decode(new Uint8Array(ev.data))); } catch { return; }
    if (m.error) progress(job, 'Relay: ' + String(m.error.message || m.error).slice(0, 70));
    const lr = m.lift_requested || m.liftRequested;
    if (lr && String(lr.offer_id || lr.offerId) === String(state.offerId)) { serve(lr); return; }
    const sm = m.swap_msg || m.swapMsg;
    if (sm) { const h = sessions.get(sm.session_id || sm.sessionId); if (h) h(sm); }
  };
  const pinger = setInterval(() => { chrome.runtime.sendMessage({ scope: 'oln-ping', job }).catch(() => {}); }, 15000);
  connect();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.scope !== 'oln') return;
  // Liveness + build handshake: the dispatcher reuses this document (keeping
  // signer wss links warm across swaps) only when it answers with the current
  // version; a stale or dead doc gets recreated instead.
  // The build stamp is a LITERAL baked into this file: getManifest() reads the
  // live manifest and let a STALE document masquerade as current code (seen
  // live: a pre-update document served a lift with outdated semantics).
  if (msg.op === 'hello') { sendResponse({ version: OFFSCREEN_BUILD }); return false; }
  // Market walk: sequential slices through the same runSwap engine; one job
  // record aggregates the outcome (a page that lost its jobId still recovers).
  if (msg.op === 'market') {
    sendResponse({ accepted: true });
    (async () => {
      const key = 'ext.olnjob.' + msg.job;
      await storeSure(key, { done: false, started: true, offscreen: true, market: true, at: Date.now() });
      const pinger = setInterval(() => {
        chrome.runtime.sendMessage({ scope: 'oln-ping', job: msg.job }).catch(() => {});
      }, 15000);
      const p = msg.params;
      const done = [];
      let filled = 0n, quoteTotal = 0n;
      try {
        for (let i = 0; i < p.slices.length; i++) {
          const s = p.slices[i];
          progress(msg.job, 'Market order: slice ' + (i + 1) + ' of ' + p.slices.length + '…');
          const marks = [];
          try {
            const r = await runSwap(msg.job, {
              phrase: p.phrase, base: p.base, counterKind: p.counterKind, side: p.side,
              baseTicker: p.baseTicker, counterTicker: p.counterTicker,
              recvAtoms: p.side === 'buy' ? s.takeAtoms : s.quoteAtoms,
              amountUnits: Number(s.takeAtoms) / Math.pow(10, p.basePrecision || 0),
              offerId: s.offerId, makerPubkey: s.makerPubkey,
              takeAtomsNum: s.takeAtomsNum, takeAtoms: s.takeAtoms, quoteAtoms: s.quoteAtoms,
            }, marks);
            filled += BigInt(r.baseAtoms || s.takeAtoms);
            quoteTotal += BigInt(r.quoteAtoms || s.quoteAtoms);
            done.push({ ok: true, offerId: s.offerId, baseAtoms: String(r.baseAtoms || s.takeAtoms), quoteAtoms: String(r.quoteAtoms || s.quoteAtoms) });
          } catch (e) {
            done.push({ ok: false, offerId: s.offerId, error: String((e && e.message) ?? e) });
          }
        }
        await storeSure(key, {
          done: true, ok: done.some((d) => d.ok),
          result: { settled: done.some((d) => d.ok), market: true, baseAtoms: filled.toString(), quoteAtoms: quoteTotal.toString(), slices: done },
          at: Date.now(),
        });
        progress(msg.job, 'Market order finished.');
      } finally { clearInterval(pinger); }
      chrome.runtime.sendMessage({ scope: 'oln-done', job: msg.job }).catch(() => {});
    })();
    return false;
  }
  // Limit order: walk the crossing slices first (same loop as a market order),
  // then hand the remainder to the resting-maker engine under the SAME job.
  if (msg.op === 'limit') {
    sendResponse({ accepted: true });
    (async () => {
      const key = 'ext.olnjob.' + msg.job;
      await storeSure(key, { done: false, started: true, offscreen: true, limit: true, at: Date.now() });
      const p = msg.params;
      const done = [];
      let filled = 0n, quoteTotal = 0n;
      for (let i = 0; i < (p.slices || []).length; i++) {
        const s = p.slices[i];
        progress(msg.job, 'Limit order: crossing fill ' + (i + 1) + ' of ' + p.slices.length + '…');
        try {
          const r = await runSwap(msg.job, {
            phrase: p.phrase, base: p.base, counterKind: p.counterKind, side: p.side,
            baseTicker: p.baseTicker, counterTicker: p.counterTicker,
            recvAtoms: p.side === 'buy' ? s.takeAtoms : s.quoteAtoms,
            amountUnits: Number(s.takeAtoms) / Math.pow(10, p.basePrecision || 0),
            offerId: s.offerId, makerPubkey: s.makerPubkey,
            takeAtomsNum: s.takeAtomsNum, takeAtoms: s.takeAtoms, quoteAtoms: s.quoteAtoms,
          }, []);
          filled += BigInt(r.baseAtoms || s.takeAtoms);
          quoteTotal += BigInt(r.quoteAtoms || s.quoteAtoms);
          done.push({ ok: true, offerId: s.offerId });
        } catch (e) { done.push({ ok: false, offerId: s.offerId, error: String((e && e.message) ?? e) }); }
      }
      const restBase = BigInt(p.restBase || '0');
      if (restBase <= 0n) {
        await storeSure(key, { done: true, ok: done.some((d) => d.ok) || !p.slices.length,
          result: { settled: filled > 0n, baseAtoms: filled.toString(), quoteAtoms: quoteTotal.toString(), slices: done }, at: Date.now() });
        chrome.runtime.sendMessage({ scope: 'oln-done', job: msg.job }).catch(() => {});
        return;
      }
      try {
        await runRest(msg.job, { ...p, baseAtoms: p.restBase, quoteAtoms: p.restQuote,
          prefill: { baseAtoms: filled.toString(), quoteAtoms: quoteTotal.toString(), slices: done } });
      } catch (e) {
        await storeSure(key, { done: true, ok: filled > 0n,
          error: 'resting failed: ' + String((e && e.message) ?? e),
          result: { settled: filled > 0n, baseAtoms: filled.toString(), quoteAtoms: quoteTotal.toString(), slices: done }, at: Date.now() });
        chrome.runtime.sendMessage({ scope: 'oln-done', job: msg.job }).catch(() => {});
      }
    })();
    return false;
  }
  if (msg.op !== 'swap') return;
  sendResponse({ accepted: true });
  (async () => {
    const key = 'ext.olnjob.' + msg.job;
    // Overwrite the dispatcher's started record with proof this page ran.
    await storeSure(key, { done: false, started: true, offscreen: true, at: Date.now() });
    // Liveness pings: each one wakes the service worker, and a live worker
    // retains this offscreen page (its death took the page — and the job —
    // with it in earlier runs). Also stamps a heartbeat for post-mortems.
    const pinger = setInterval(() => {
      chrome.runtime.sendMessage({ scope: 'oln-ping', job: msg.job }).catch(() => {});
      store('ext.olnhb.' + msg.job, Date.now()).catch(() => {});
    }, 15000);
    const marks = [];
    try {
      const result = await runSwap(msg.job, msg.params, marks);
      await storeSure(key, { done: true, ok: true, result, marks, at: Date.now() });
      progress(msg.job, 'Swap settled.');
    } catch (e) {
      await storeSure(key, { done: true, ok: false, error: String((e && e.message) ?? e), marks, at: Date.now() });
    } finally {
      clearInterval(pinger);
    }
    chrome.runtime.sendMessage({ scope: 'oln-done', job: msg.job }).catch(() => {});
  })();
  return false;
});
