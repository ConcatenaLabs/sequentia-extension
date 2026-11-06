// BTC on the Bitcoin ark, in the offscreen document.
//
// Bark's wallet on Bitcoin, compiled to wasm (btc-ark/pkg, the web wallet's build of the
// operator repository's `bark-wasm/`), runs in its own dedicated worker (btc-ark/worker.js,
// copied from the web wallet). It keeps its store in IndexedDB, reaches the ark server over
// gRPC-web and reads testnet4 from Esplora; its daemon claims Lightning payments the server
// holds for the wallet and takes in what is sent to it in the ark. This module owns that
// worker for as long as the offscreen document lives (vendor/btc-ark.js `mountBtcArk`, the
// web wallet's module), so the service worker never waits on it.
//
// The wallet opens in both modes once the extension is unlocked, so BTC held there is always
// in BTC's one figure. In default mode it also boards the wallet's confirmed BTC at its tb1
// addresses by itself (one transaction from those addresses to the ark, signed here with the
// phrase's own keys after the ark server has cosigned the board), when the service worker asks
// (`board`, once the kit wallet sees BTC on the chain and no BTC payment of its own is fresh).
//
// Messages (scope 'ark'), answered { ok, value } or { ok: false, error: { message } }:
//   'start' { mnemonic }              -> opens the wallet of that phrase (or leaves it open)
//   'stop'                            -> closes it and forgets the phrase
//   'status'                          -> { open, figures, lastBoard, lastError }
//   'info'                            -> the server's limits, the wallet's `info` (max_vtxo_sat,
//                                        min_board_sat, required_board_confirmations…), or null
//   'run'   { command, args }         -> the wallet's answer (e.g. 'address')
//   'quote' { to, sats } / 'send' { to, sats } -> vendor/btc-ark.js quote/send, amounts as strings
//   'max'   { to }                    -> the most the ark can pay `to` now, its fee taken off (sats), or null
//   'payOutcome' { hash, untilMs? }        -> a held payment followed to 'complete', 'came-back' or 'pending'
//   'invoice' { sats, description }   -> { invoice, payment_hash, expires_at }
//   'received' { hash }               -> the receive's state, claimed when paid
//   'ln'    { method, args }          -> the trade composer's BTC (`lightning()`), BigInt as { $big }
//   'board' { lim, changeNext, cap }  -> boards the confirmed BTC at the first `lim` keys
//   'name'  { op: 'state' | 'register' | 'release', name? } -> { name, address } of the payment name
// The balance is sent to the service worker as `arkBalance` after every change.
//
// The payment name (vendor/lnaddr.js, the web wallet's module): `name@LNADDR_DOMAIN`, held by a key of
// the phrase. While the ark is open this document keeps the link with the service that answers a
// payer: a Lightning wallet's invoice comes from this ark, for the amount it chose; a Sequentia
// wallet is given one of the signed receive codes this link leaves with the service and tops up
// while the ark is open (vendor/name-stock.js), each made by the service worker at an address the
// stock picks (`default.nameCode`), from the indices the service worker last gave
// (`default.nameIndices`, read every ten seconds: a reading a little old only picks inside an
// older window, which a restore still reads).

import { mountBtcArk, arkConfig } from './vendor/btc-ark.js';
import { decodeBolt11 } from './vendor/bolt11.js';
import { HDKey, mnemonicToSeedSync, btc } from './vendor/btc.js';
import { BTC_ARK, T4_API, BTC_FEERATE } from './src/config.js';
import { toWire, fromWire } from './src/wire.js';
import { mountLnAddress, nameKey } from './vendor/lnaddr.js';
import { LSP, LNADDR_DOMAIN } from './src/config.js';

const BTC_DUST = 294n;
const A = { ark: null, fp: null, phrase: null, lastBoard: null, lastError: null, name: null, nameKey: null, idx: null, idxTimer: null };
const sw = async (method, params = {}) => {
  const r = await chrome.runtime.sendMessage({ scope: 'ui', method, params });
  if (!r || !r.ok) throw new Error((r && r.error) || method + ' failed');
  return r.result;
};
async function readIndices() { try { A.idx = await sw('default.nameIndices'); } catch { /* the last reading stands */ } }
// What a payer may send to the name: from NAME_MIN_SAT up to the ark's largest coin, never above
// NAME_MAX_SAT (the web wallet's limits).
const NAME_MIN_SAT = 1000n, NAME_MAX_SAT = 1_000_000n;

async function fingerprint(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ark-host/' + String(text).trim()));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function emit(event, data) {
  chrome.runtime.sendMessage({ scope: 'ark-event', event, data }).catch(() => {});
}
// The figures, and what default mode says about BTC leaving the ark alone (vendor/btc-ark.js exitNoteOf).
const figuresWire = (f) => ({ total: String(f.total), spendable: String(f.spendable), arriving: String(f.arriving), claimable: String(f.claimable || 0),
  exitNote: (A.ark && A.ark.exitNote && A.ark.exitNote()) || null });
const fmtBtc8 = (sats) => { const n = BigInt(sats), w = n / 100000000n, f = (n % 100000000n).toString().padStart(8, '0').replace(/0+$/, ''); return w.toString() + (f ? '.' + f : ''); };

async function start({ mnemonic }) {
  if (!mnemonic) throw { message: 'the wallet is locked' };
  const config = arkConfig(BTC_ARK);
  if (!config) throw { message: 'no Bitcoin ark is configured' };
  const fp = await fingerprint(mnemonic);
  if (A.ark && A.fp === fp) { await A.ark.open(); return { open: A.ark.isOpen() }; }
  stop();
  A.fp = fp; A.phrase = mnemonic.trim().replace(/\s+/g, ' ');
  A.ark = mountBtcArk({
    makeWorker: () => new Worker(new URL('./btc-ark/worker.js', import.meta.url), { type: 'module' }),
    mnemonic: () => A.phrase, config,
    decode: (s) => decodeBolt11(s),
    onChange: (f) => emit('arkBalance', figuresWire(f)),
    log: (...a) => console.info(...a),
    fmt: fmtBtc8,
    store: { get: (k) => localStorage.getItem(k + '.' + fp), set: (k, v) => v == null ? localStorage.removeItem(k + '.' + fp) : localStorage.setItem(k + '.' + fp, v) },
  });
  await A.ark.open();
  emit('arkBalance', figuresWire(A.ark.figures()));
  startName(fp);
  return { open: true };
}

function startName(fp) {
  if (A.name) return;
  A.name = mountLnAddress({
    base: LSP.url, domain: LNADDR_DOMAIN,
    key: () => { if (!A.phrase) return null; if (!A.nameKey) A.nameKey = nameKey(A.phrase); return A.nameKey; },
    invoice: async (msat) => {
      const inv = await A.ark.invoice(String(BigInt(msat) / 1000n), 'Payment to ' + A.name.address());
      followNameInvoice(inv);
      return inv.invoice;
    },
    code: async () => { throw new Error('the stock makes codes'); },
    // No code until the indices are known: the stock never guesses where the window is.
    stockCode: async (index) => { if (!A.idx) return null; const c = await sw('default.nameCode', { index }); return typeof c === 'string' && c ? c : null; },
    nextUnused: () => (A.idx && Number.isInteger(A.idx.nextUnused) ? A.idx.nextUnused : 0),
    shownIndex: () => (A.idx && Number.isInteger(A.idx.shown) ? A.idx.shown : null),
    limits: () => {
      if (!A.ark || !A.ark.isOpen()) return null;
      let max = NAME_MAX_SAT;
      const i = A.ark.info(); if (i && i.max_vtxo_sat != null && BigInt(i.max_vtxo_sat) < max) max = BigInt(i.max_vtxo_sat);
      return max >= NAME_MIN_SAT ? { min_sat: NAME_MIN_SAT, max_sat: max } : null;
    },
    store: { get: (k) => localStorage.getItem('lnaddr.' + k + '.' + fp), set: (k, v) => v == null ? localStorage.removeItem('lnaddr.' + k + '.' + fp) : localStorage.setItem('lnaddr.' + k + '.' + fp, v) },
    onChange: () => emit('nameChanged', { name: A.name && A.name.name() }),
    log: (...a) => console.info(...a),
  });
  clearInterval(A.idxTimer);
  A.idxTimer = setInterval(readIndices, 10_000);
  readIndices().then(() => A.name && A.name.recover()).then(() => { if (A.name) A.name.start(); });
}
// A payment to the name is claimed as soon as the server holds it, as Receive's own invoice is.
function followNameInvoice(inv) {
  (async () => {
    while (A.ark && Date.now() / 1000 < Number(inv.expires_at)) {
      await new Promise((ok) => setTimeout(ok, 3000));
      let r = null; try { r = await A.ark.received(inv.payment_hash); } catch {}
      if (r && r.state === 'paid') { emit('arkBalance', figuresWire(A.ark.figures())); return; }
    }
  })();
}
async function name({ op, name: wanted }) {
  if (!A.name) throw { message: 'the Bitcoin ark wallet is not open' };
  if (op === 'register') await A.name.register(String(wanted || ''));
  else if (op === 'release') await A.name.release();
  else if (op !== 'state') throw { message: 'no name operation ' + op };
  return { name: A.name.name(), address: A.name.address() };
}

function stop() {
  if (A.ark) { try { A.ark.close(); } catch {} }
  if (A.name) { try { A.name.stop(); } catch {} }
  clearInterval(A.idxTimer); A.idxTimer = null; A.idx = null;
  A.ark = null; A.fp = null; A.phrase = null; A.name = null; A.nameKey = null;
}

// ---- the board's funding, built and signed here with the phrase's own keys ----
function keys() {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(A.phrase));
  return (internal, i) => root.derive(`m/84'/1'/0'/${internal ? 1 : 0}/${i}`);
}
async function utxos(lim) {
  const node = keys();
  const jobs = [];
  for (const internal of [false, true]) for (let i = 0; i < lim; i++) jobs.push([internal, i]);
  const lists = await Promise.all(jobs.map(async ([internal, i]) => {
    const n = node(internal, i);
    const p = btc.p2wpkh(n.publicKey, btc.TEST_NETWORK);
    const us = await fetch(`${T4_API}/address/${p.address}/utxo`).then((r) => r.json()).catch(() => []);
    return us.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), script: p.script, priv: n.privateKey, confirmed: !!(u.status && u.status.confirmed) }));
  }));
  return lists.flat();
}
function drain(sel, changeNext) {
  const node = keys();
  return async (address, sats) => {
    const conf = sel.filter((u) => u.confirmed);
    if (!conf.length) throw new Error('no confirmed BTC to move');
    const inSum = conf.reduce((n, u) => n + u.value, 0n);
    const fee = BigInt(Math.ceil((10.75 + 68 * conf.length + 31 * 2 + 12) * BTC_FEERATE));
    const tx = new btc.Transaction();
    for (const u of conf) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: u.script, amount: u.value } });
    tx.addOutputAddress(address, BigInt(sats), btc.TEST_NETWORK);
    const change = inSum - BigInt(sats) - fee;
    if (change > BTC_DUST) tx.addOutputAddress(btc.p2wpkh(node(true, changeNext).publicKey, btc.TEST_NETWORK).address, change, btc.TEST_NETWORK);
    else if (inSum <= BigInt(sats)) throw new Error('not enough BTC for the move and its fee');
    const psbt = tx.toPSBT(0);
    const privs = [], seen = new Set();
    for (const u of conf) { const k = [...u.priv].join(','); if (!seen.has(k)) { seen.add(k); privs.push(u.priv); } }
    return {
      psbtHex: Array.from(psbt, (b) => b.toString(16).padStart(2, '0')).join(''), txid: tx.id,
      finish: () => { for (const k of privs) tx.sign(k); tx.finalize(); return { hex: tx.hex }; },
    };
  };
}
async function broadcast(hex) {
  const r = await fetch(`${T4_API}/tx`, { method: 'POST', body: hex });
  const t = (await r.text()).trim();
  if (!r.ok || !/^[0-9a-fA-F]{64}$/.test(t)) throw new Error(t || ('HTTP ' + r.status));
  return t;
}
// `cap`: the most the board carries, in sats (the band's room, src/ark-band.js), or none.
async function board({ lim = 20, changeNext = 0, cap = null } = {}) {
  if (!A.ark || !A.ark.isOpen()) return null;
  // While BTC leaves the ark alone, or needs the address's BTC to pay its way out, nothing goes in.
  if (A.ark.exitHolds && A.ark.exitHolds()) return null;
  const sel = await utxos(Math.max(1, Math.min(200, Number(lim) || 20)));
  const r = await A.ark.board({ utxos: async () => sel, buildUnsigned: drain(sel, Number(changeNext) || 0), broadcast, cap: cap == null ? null : BigInt(cap) });
  A.lastBoard = { at: Date.now(), value: r ? { txid: r.txid, amount: r.amount } : null };
  return A.lastBoard.value;
}

function need() { if (!A.ark || !A.ark.isOpen()) throw { message: 'the Bitcoin ark wallet is not open' }; return A.ark; }

async function handle(op, args) {
  switch (op) {
    case 'start': return await start(args);
    case 'stop': stop(); return true;
    case 'status': return { open: !!(A.ark && A.ark.isOpen()), figures: A.ark ? figuresWire(A.ark.figures()) : null, lastBoard: A.lastBoard, lastError: A.lastError };
    // The server's limits as the wallet last read them (vendor/btc-ark.js info()), or null before.
    case 'info': return A.ark && A.ark.isOpen() ? A.ark.info() : null;
    case 'run': return await need().run(String(args.command), args.args || {});
    case 'quote': return toWire(await need().quote(String(args.to), BigInt(args.sats || 0)));
    case 'max': { const m = await need().max(String(args.to)); return m == null ? null : String(m); }
    case 'send': return toWire(await need().send(String(args.to), BigInt(args.sats || 0)));
    // A payment the payee holds, followed to its end (vendor/btc-ark.js payOutcome).
    case 'payOutcome': return toWire(await need().payOutcome(String(args.hash), { untilMs: Math.min(120000, Number(args.untilMs) || 60000) }));
    case 'invoice': await need(); return await A.ark.invoice(String(args.sats), args.description || 'Receive');
    case 'received': return await need().received(String(args.hash));
    case 'ln': {
      const l = need().lightning();
      const m = String(args.method);
      if (!l || typeof l[m] !== 'function') throw { message: 'no such method ' + m };
      return toWire(await l[m](fromWire(args.args)));
    }
    case 'board': return await board(args);
    case 'name': return await name(args);
    // Developer mode's exit by hand: each coin priced, then the coins worth it taken out.
    case 'exitEstimate': return await need().exitEstimate();
    case 'exitStart': { const r = await need().exitStart(Array.isArray(args.vtxos) ? args.vtxos.map(String) : null); emit('arkBalance', figuresWire(A.ark.figures())); return r; }
    case 'exitStatus': return await need().exitStatus();
    default: throw { message: 'no operation ' + op };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.scope !== 'ark' || sender.id !== chrome.runtime.id) return;
  handle(msg.op, msg.args || {})
    .then((value) => sendResponse({ ok: true, value }))
    .catch((e) => {
      const message = (e && e.message) ? e.message : String(e);
      A.lastError = { at: Date.now(), message };
      sendResponse({ ok: false, error: { message } });
    });
  return true;
});
