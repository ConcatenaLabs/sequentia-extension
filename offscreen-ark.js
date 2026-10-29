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
//   'run'   { command, args }         -> the wallet's answer (e.g. 'address')
//   'quote' { to, sats } / 'send' { to, sats } -> vendor/btc-ark.js quote/send, amounts as strings
//   'invoice' { sats, description }   -> { invoice, payment_hash, expires_at }
//   'received' { hash }               -> the receive's state, claimed when paid
//   'ln'    { method, args }          -> the trade composer's BTC (`lightning()`), BigInt as { $big }
//   'board' { lim, changeNext }       -> boards the confirmed BTC at the first `lim` keys
// The balance is sent to the service worker as `arkBalance` after every change.

import { mountBtcArk, arkConfig } from './vendor/btc-ark.js';
import { decodeBolt11 } from './vendor/bolt11.js';
import { HDKey, mnemonicToSeedSync, btc } from './vendor/btc.js';
import { BTC_ARK, T4_API, BTC_FEERATE } from './src/config.js';
import { toWire, fromWire } from './src/wire.js';

const BTC_DUST = 294n;
const A = { ark: null, fp: null, phrase: null, lastBoard: null, lastError: null };

async function fingerprint(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ark-host/' + String(text).trim()));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function emit(event, data) {
  chrome.runtime.sendMessage({ scope: 'ark-event', event, data }).catch(() => {});
}
const figuresWire = (f) => ({ total: String(f.total), spendable: String(f.spendable), arriving: String(f.arriving) });

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
  });
  await A.ark.open();
  emit('arkBalance', figuresWire(A.ark.figures()));
  return { open: true };
}

function stop() {
  if (A.ark) { try { A.ark.close(); } catch {} }
  A.ark = null; A.fp = null; A.phrase = null;
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
async function board({ lim = 20, changeNext = 0 } = {}) {
  if (!A.ark || !A.ark.isOpen()) return null;
  const sel = await utxos(Math.max(1, Math.min(200, Number(lim) || 20)));
  const r = await A.ark.board({ utxos: async () => sel, buildUnsigned: drain(sel, Number(changeNext) || 0), broadcast });
  A.lastBoard = { at: Date.now(), value: r ? { txid: r.txid, amount: r.amount } : null };
  return A.lastBoard.value;
}

function need() { if (!A.ark || !A.ark.isOpen()) throw { message: 'the Bitcoin ark wallet is not open' }; return A.ark; }

async function handle(op, args) {
  switch (op) {
    case 'start': return await start(args);
    case 'stop': stop(); return true;
    case 'status': return { open: !!(A.ark && A.ark.isOpen()), figures: A.ark ? figuresWire(A.ark.figures()) : null, lastBoard: A.lastBoard, lastError: A.lastError };
    case 'run': return await need().run(String(args.command), args.args || {});
    case 'quote': return toWire(await need().quote(String(args.to), BigInt(args.sats || 0)));
    case 'send': return toWire(await need().send(String(args.to), BigInt(args.sats || 0)));
    case 'invoice': await need(); return await A.ark.invoice(String(args.sats), args.description || 'Receive');
    case 'received': return await need().received(String(args.hash));
    case 'ln': {
      const l = need().lightning();
      const m = String(args.method);
      if (!l || typeof l[m] !== 'function') throw { message: 'no such method ' + m };
      return toWire(await l[m](fromWire(args.args)));
    }
    case 'board': return await board(args);
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
