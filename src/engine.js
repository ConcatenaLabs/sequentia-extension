// The dual-chain wallet engine, running in the background service worker.
//
// One BIP39 mnemonic drives BOTH chains (first principle: every Sequentia
// wallet is dual-chain): the Sequentia side via SWK's Wollet/Signer, the
// Bitcoin testnet4 side via SWK's wasm BtcWallet — deriving the IDENTICAL
// shared tb1 address. Sequentia is transparent by default: receive addresses
// are unblinded (tb1), confidential (tsqb1) is an explicit opt-in parameter.
//
// wasm-bindgen forbids re-entrant &mut use of one object, so every scan and
// every build->broadcast runs through the withWollet() promise queue — the
// same load-bearing discipline as the web wallet.

import './shim.js';
import { rememberWallet, tagOf } from './mode.js';
import init, {
  Mnemonic, Network, Signer, Wollet, Update, EsploraClient, Address, AssetId,
  Pset, Transaction, BtcWallet, stringToQr,
} from '../pkg/lwk_wasm.js';
import { hydrateShim } from './shim.js';
import * as A from './assets.js';
import { sessionMnemonic } from './vault.js';
import { pignusSecret, xOnlyPubkey, signSchnorr } from './btcsign.js';
import { ESPLORA, T4_API, DEFAULT_FEERATE, BTC_FEERATE } from './config.js';
import { parseAtoms, fmtAtoms, stGet, stSet } from './util.js';
import { describeTransparent, stripBip32 } from './psetbytes.js';

// ---- module state (rebuilt lazily after a service-worker restart) ----
let wasmReady = null;
let network = null, client = null, POLICY_HEX = '';
let signer = null, wollet = null, btcW = null, mnemonic = null;
let addrIndex = null;
let btcScanState = { balanceSats: 0n, externalNext: 0, changeNext: 0 };
let scannedOnce = false;
const GAP = 20;

// ---- wollet exclusivity queue ----
let _wolletQ = Promise.resolve();
export function withWollet(fn) {
  const run = _wolletQ.then(fn, fn);
  _wolletQ = run.then(() => {}, () => {});
  return run;
}

// ---- own-tx ring: re-apply recent own broadcasts after every scan Update ----
const _ownTxRing = [];
function noteOwnTx(finalized) {
  try {
    const hex = finalized && finalized.toString ? String(finalized.toString()) : null;
    if (!hex || !/^[0-9a-f]+$/i.test(hex)) return;
    _ownTxRing.push({ hex, at: Date.now() });
    while (_ownTxRing.length > 32) _ownTxRing.shift();
  } catch {}
}
function reapplyOwnTxs() {
  const cutoff = Date.now() - 60 * 60_000;
  for (let i = _ownTxRing.length - 1; i >= 0; i--) if (_ownTxRing[i].at < cutoff) _ownTxRing.splice(i, 1);
  for (const e of _ownTxRing) { try { wollet.applyTransaction(new Transaction(e.hex)); } catch {} }
}

// ---- IndexedDB scan-state cache (instant cold start) ----
const IDB_NAME = 'swk-wallet', IDB_STORE = 'scan';
function idbOpen() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore(IDB_STORE); } catch {} };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((res) => {
      const q = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function idbPut(key, val) {
  try {
    const db = await idbOpen();
    await new Promise((res) => {
      const q = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put(val, key);
      q.onsuccess = () => res();
      q.onerror = () => res();
    });
  } catch {}
}
function wolletKey() {
  try { return 'upd:' + wollet.descriptor().toString(); } catch { return 'upd:default'; }
}
// The cache is only useful as a FROM-EMPTY base (fullScan Updates are relative
// to the wollet state at scan time), so exactly one kind of update is persisted:
// one computed against an empty wollet, aged out weekly.
let _cacheRestored = false, _cachePersisted = false;
const CACHE_BASE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
async function restoreWolletState() {
  try {
    const at = Number(await idbGet(wolletKey() + ':at') || 0);
    if (at && Date.now() - at > CACHE_BASE_MAX_AGE_MS) {
      await idbPut(wolletKey(), null); await idbPut(wolletKey() + ':at', null);
      return false;
    }
    const b64 = await idbGet(wolletKey());
    if (!b64) return false;
    wollet.applyUpdate(Update.deserializeDecryptedBase64(b64, wollet.descriptor()));
    try { reapplyOwnTxs(); } catch {}
    _cacheRestored = true;
    return true;
  } catch { return false; }
}
async function refreshScanCacheBase() {
  if (_cacheRestored || _cachePersisted) return;
  try {
    const w2 = new Wollet(network, signer.wpkhSlip77Descriptor());
    const u2 = await withWollet(() => client.fullScan(w2));
    if (!u2) return;
    await idbPut(wolletKey(), u2.serializeEncryptedBase64(w2.descriptor()));
    await idbPut(wolletKey() + ':at', Date.now());
    _cachePersisted = true;
  } catch {}
}

// ---- boot ----
export async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      await hydrateShim();
      await A.restoreCaches();
      await init();
      network = Network.sequentiaTestnet();
      POLICY_HEX = network.policyAsset().toString();
      A.setPolicyHex(POLICY_HEX);
      client = new EsploraClient(network, ESPLORA, false, 1, false);
    })();
  }
  await wasmReady;
}

export function isOpen() { return !!wollet; }
export function getMnemonic() { return mnemonic; }
export function getPolicyHex() { return POLICY_HEX; }
export function getNetworkName() { return 'sequentia-testnet'; }

// Bring the wallet up from the session mnemonic (no-op if already up, rebuilds
// silently after a service-worker restart). Returns false while locked.
export async function ensureOpen() {
  await ensureWasm();
  if (wollet) return true;
  const phrase = await sessionMnemonic();
  if (!phrase) return false;
  await openFromPhrase(phrase);
  return true;
}

export async function openFromPhrase(phrase) {
  await ensureWasm();
  mnemonic = phrase.trim().replace(/\s+/g, ' ');
  const m = new Mnemonic(mnemonic);
  signer = new Signer(m, network);
  wollet = new Wollet(network, signer.wpkhSlip77Descriptor());
  // The wallet's tag keys what is kept for each wallet (its mode, its leaf operator).
  try { await rememberWallet(tagOf(wollet.descriptor().toString())); } catch {}
  btcW = new BtcWallet(T4_API);
  addrIndex = null;
  scannedOnce = false;
  _cacheRestored = false; _cachePersisted = false;
  await restoreWolletState();
  // Restore the receive index across service-worker restarts: a fresh worker
  // otherwise serves addresses from the (possibly stale) restored scan view
  // and can hand out an already-used address before the first sync.
  try {
    const s = await stGet('local', 'ext.addrIndex');
    if (s && s.desc === wollet.descriptor().toString() && Number.isInteger(s.index)) addrIndex = s.index;
  } catch {}
}

// Validate a mnemonic without opening anything (onboarding import).
export async function validateMnemonic(phrase) {
  await ensureWasm();
  new Mnemonic(phrase.trim().replace(/\s+/g, ' '));   // throws if invalid
  return true;
}
export async function randomMnemonic(words = 12) {
  await ensureWasm();
  return Mnemonic.fromRandom(words).toString();
}

export function closeWallet() {
  signer = null; wollet = null; btcW = null; mnemonic = null;
  addrIndex = null; scannedOnce = false;
  _ownTxRing.length = 0;
}

// ---- sync ----
let _syncing = null;
export async function sync() {
  if (!wollet) throw new Error('wallet is locked');
  if (_syncing) return _syncing;   // coalesce concurrent callers into one pass
  _syncing = (async () => {
    try {
      const upd = await withWollet(() => client.fullScan(wollet));
      if (upd) {
        await withWollet(async () => { wollet.applyUpdate(upd); reapplyOwnTxs(); });
      }
      try { btcScanState = await btcScanRaw(); } catch {}
      refreshScanCacheBase();   // off-path; no-op once a base exists
      scannedOnce = true;
      addrIndex = Math.max(addrIndex ?? 0, unifiedNextUnused());
      persistAddrIndex();
      await stSet('local', 'ext.balCache', serializeBalances());
      await stSet('local', 'ext.lastSyncAt', Date.now());
    } finally {
      _syncing = null;
    }
  })();
  return _syncing;
}

export async function syncIfStale(maxAgeMs = 120000) {
  const at = (await stGet('local', 'ext.lastSyncAt')) || 0;
  if (scannedOnce && Date.now() - at < maxAgeMs) return;
  await sync();
}

async function btcScanRaw() {
  const s = await btcW.scan(mnemonic);
  return {
    balanceSats: BigInt(s.balanceSats ?? s.balance_sats ?? 0),
    externalNext: Number(s.externalNext ?? s.external_next ?? 0),
    changeNext: Number(s.changeNext ?? s.change_next ?? 0),
  };
}

// ---- balances ----
function balObj() {
  try { return wollet.balance().toJSON(); } catch { return {}; }
}
function serializeBalances() {
  const seq = {};
  for (const [h, v] of Object.entries(balObj())) seq[h] = String(v);
  return { seq, btc: btcScanState.balanceSats.toString() };
}
// {seq:{hex:atomsStr}, btc:atomsStr, scanned:bool}. Falls back to the persisted
// snapshot before the first real scan, so the popup paints instantly.
export async function balances() {
  if (!wollet) throw new Error('wallet is locked');
  if (scannedOnce) return { ...serializeBalances(), scanned: true };
  const c = await stGet('local', 'ext.balCache');
  if (c) return { ...c, scanned: false };
  return { ...serializeBalances(), scanned: false };
}
export function availableFor(hex) {
  if (hex === 'BTC') return btcScanState.balanceSats;
  const b = balObj();
  return BigInt(b[hex] || 0n);
}

// ---- addresses (shared tb1 across both chains; confidential is opt-in) ----
function unifiedNextUnused() {
  let lwkNext = 0;
  try { lwkNext = wollet.address(undefined).index(); } catch {}
  return Math.max(lwkNext, btcScanState.externalNext);
}
// Fire-and-forget: remember the served index per descriptor so a worker
// restart never cycles the receive address backwards.
function persistAddrIndex() {
  try { stSet('local', 'ext.addrIndex', { desc: wollet.descriptor().toString(), index: addrIndex }).catch(() => {}); } catch {}
}
export function currentAddress(confidential = false) {
  if (!wollet) throw new Error('wallet is locked');
  const r = wollet.address(addrIndex == null ? undefined : addrIndex);
  addrIndex = r.index();
  persistAddrIndex();
  const a = r.address();
  const addr = confidential ? a : a.toUnconfidential();
  return { address: addr.toString(), index: addrIndex, confidential };
}
export function newAddress(confidential = false) {
  if (!wollet) throw new Error('wallet is locked');
  addrIndex = (addrIndex == null ? unifiedNextUnused() : addrIndex + 1);
  return currentAddress(confidential);
}
// QR data URI with the BARE address as payload (universally scannable on both
// chains — deliberately NOT Address.QRCodeUri(), whose payload is a wrong-network
// liquidnetwork: URI).
export function qrFor(payload) {
  return stringToQr(payload);
}

// The raw wasm Address object at the current receive index (for callers that
// need the object, e.g. the DEX swap builder). Confidential opt-in.
export function rawAddress(confidential = false) {
  if (!wollet) throw new Error('wallet is locked');
  const r = wollet.address(addrIndex == null ? undefined : addrIndex);
  addrIndex = r.index();
  persistAddrIndex();
  const a = r.address();
  return confidential ? a : a.toUnconfidential();
}

// Track a self-broadcast tx from another module (the DEX fill path).
export function noteOwn(finalized) { noteOwnTx(finalized); }

// ---- fee application (any-asset fees, open fee market) ----
function applyFee(b, feeHex) {
  if (feeHex && feeHex !== POLICY_HEX) return b.feeRate(DEFAULT_FEERATE).feeAsset(new AssetId(feeHex), A.feeRateFor(feeHex));
  return b.feeRate(A.policyFeeRate());
}

// ---- prepared sends (two-phase: prepare -> review in UI -> confirm) ----
const prepared = new Map();
let prepSeq = 0;
function stash(entry) {
  const id = 'p' + (++prepSeq) + '.' + Date.now();
  prepared.set(id, { ...entry, at: Date.now() });
  // Drop stale entries (10 min) so an abandoned review can't linger forever.
  for (const [k, v] of prepared) if (Date.now() - v.at > 600000) prepared.delete(k);
  return id;
}

// Sequentia send. rows: [{addr, amtS, asset}]; feeAssetHex '' => tSEQ;
// feeRateS optional (the fee asset's OWN units/vByte).
export async function prepareSeqSend(rows, feeAssetHex, feeRateS) {
  if (!wollet) throw new Error('wallet is locked');
  let b = network.txBuilder();
  const review = [];
  for (const r of rows) {
    const a = new Address(r.addr);
    if (a.isMainnet()) throw new Error('That looks like a mainnet address; this is a Sequentia testnet wallet.');
    const sats = parseAtoms(r.amtS, A.sendPrecision(r.asset));
    if (sats <= 0n) throw new Error('amount must be greater than zero');
    const assetId = new AssetId(r.asset);
    if (a.isBlinded()) b = r.asset === POLICY_HEX ? b.addLbtcRecipient(a, sats) : b.addRecipient(a, sats, assetId);
    else b = b.addExplicitRecipient(a, sats, assetId);
    review.push({ addr: r.addr, atoms: sats.toString(), hex: r.asset });
  }
  const feeHex = (feeAssetHex && feeAssetHex !== POLICY_HEX) ? feeAssetHex : POLICY_HEX;
  const feeR = Number(A.feeRateFor(feeHex));
  const feePrec = A.assetMeta(feeHex).precision || 0;
  b = b.feeRate(feeRateS ? (parseFloat(feeRateS) * Math.pow(10, feePrec) * feeR / 1e5)
                         : (feeHex === POLICY_HEX ? A.policyFeeRate() : DEFAULT_FEERATE));
  if (feeAssetHex && feeAssetHex !== POLICY_HEX) b = b.feeAsset(new AssetId(feeAssetHex), A.feeRateFor(feeAssetHex));
  const pset = await withWollet(async () => b.finish(wollet));
  // Best-effort fee estimate for the review — never the source of truth.
  let feeEst = null;
  try { const f = wollet.psetDetails(pset).balance().fee(); if (f != null) feeEst = String(f); } catch {}
  const id = stash({ kind: 'seq', pset, feeHex });
  return { id, review: { network: 'Sequentia (testnet); not parent-chain BTC', rows: review, feeAssetHex: feeHex, feeEst } };
}

// Bitcoin testnet4 send (sats; feeRate sat/vB). BtcWallet builds + signs.
export async function prepareBtcSend(dest, amtS, feeRateS) {
  if (!btcW) throw new Error('wallet is locked');
  const sats = parseAtoms(amtS, 8);
  if (sats <= 0n) throw new Error('amount must be greater than zero');
  const fr = feeRateS ? parseFloat(feeRateS) : BTC_FEERATE;
  const p = await btcW.prepare(mnemonic, dest, sats, fr);
  const id = stash({ kind: 'btc', hex: p.hex, txid: p.txid });
  return {
    id,
    review: {
      network: 'Bitcoin testnet4 (parent chain)',
      rows: [{ addr: dest, atoms: sats.toString(), hex: 'BTC' }],
      feeAssetHex: 'BTC',
      feeEst: String(p.feeSats ?? p.fee_sats ?? ''),
      vsize: Number(p.vsize || 0),
    },
  };
}

// Confirm a prepared send: sign (Sequentia) / broadcast, track own spends.
export async function confirmSend(id) {
  const e = prepared.get(id);
  if (!e) throw new Error('this review expired; rebuild the transaction');
  prepared.delete(id);
  if (e.kind === 'seq') {
    const txid = await withWollet(async () => {
      const signed = signer.sign(e.pset);
      const finalized = wollet.finalize(signed);
      const t = await client.broadcast(finalized);
      try { wollet.applyTransaction(finalized); } catch {}
      noteOwnTx(finalized);
      return t;
    });
    sync().catch(() => {});
    return { txid: txid.toString(), chain: 'sequentia' };
  }
  if (e.kind === 'btc') {
    const txid = await btcW.broadcast(e.hex);
    sync().catch(() => {});
    return { txid: String(txid), chain: 'bitcoin' };
  }
  throw new Error('unknown prepared entry');
}
export function dropPrepared(id) { prepared.delete(id); }

// Send used by Lightning channel funding (no review modal — the LN flow shows
// its own progress). chain 'btc' | 'seq'.
export async function sendToAddress({ chain, asset, amount, address }) {
  if (chain === 'btc') {
    const p = await btcW.prepare(mnemonic, address, BigInt(amount), BTC_FEERATE);
    const txid = await btcW.broadcast(p.hex);
    return { txid: String(txid) };
  }
  const a = new Address(address);
  const assetId = new AssetId(asset);
  let b = network.txBuilder();
  b = a.isBlinded() ? b.addRecipient(a, BigInt(amount), assetId) : b.addExplicitRecipient(a, BigInt(amount), assetId);
  // Fee strictly IN the asset being moved (a wallet holding only this asset
  // must never need a different one; movability is gated on it being priced).
  b = applyFee(b, asset);
  return withWollet(async () => {
    const pset = b.finish(wollet);
    const signed = signer.sign(pset);
    const finalized = wollet.finalize(signed);
    const txid = await client.broadcast(finalized);
    try { wollet.applyTransaction(finalized); } catch {}
    noteOwnTx(finalized);
    return { txid: txid.toString() };
  });
}

// ---- histories ----
// Sequentia: classify from non-zero deltas (lwk reports "unknown" when the
// policy asset nets to zero, e.g. an asset send paying its fee in that asset).
export function seqHistory(limit = 60) {
  if (!wollet) throw new Error('wallet is locked');
  let txs;
  try { txs = wollet.transactions(); } catch { return []; }
  txs.sort((a, b) => (b.height() ?? 9e9) - (a.height() ?? 9e9));
  const out = [];
  for (const t of txs.slice(0, limit)) {
    const deltas = {};
    const raw = t.balance().toJSON();
    for (const [h, v] of Object.entries(raw)) deltas[h] = String(v);
    const nz = Object.entries(deltas).filter(([, v]) => BigInt(v) !== 0n);
    let type = t.txType();
    if (type === 'unknown' && nz.length) {
      type = nz.every(([, v]) => BigInt(v) < 0n) ? 'outgoing' : nz.every(([, v]) => BigInt(v) > 0n) ? 'incoming' : 'unknown';
    }
    out.push({ txid: t.txid().toString(), height: t.height() ?? null, timestamp: t.timestamp() ?? null, type, deltas });
  }
  return out;
}

// Bitcoin testnet4: esplora address txs over the scanned window, deduped,
// classified by net delta to the wallet.
export async function btcHistory(limit = 60) {
  if (!btcW) throw new Error('wallet is locked');
  const { externalNext, changeNext } = btcScanState;
  const lim = Math.max(externalNext + GAP, changeNext + GAP, GAP);
  const walletAddrs = new Set();
  for (const internal of [false, true]) for (let i = 0; i < lim; i++) walletAddrs.add(btcW.address(mnemonic, internal, i));
  const query = new Set();
  for (let i = 0; i < externalNext; i++) query.add(btcW.address(mnemonic, false, i));
  for (let i = 0; i < changeNext; i++) query.add(btcW.address(mnemonic, true, i));
  if (!query.size) return [];
  const seen = new Map();
  await Promise.all([...query].map(async (a) => {
    try {
      const txs = await fetch(`${T4_API}/address/${a}/txs`).then((r) => (r.ok ? r.json() : []));
      for (const t of (txs || [])) if (t && t.txid) seen.set(t.txid, t);
    } catch {}
  }));
  const txs = [...seen.values()];
  txs.sort((a, b) => (((b.status && b.status.block_height) ?? 9e9) - ((a.status && a.status.block_height) ?? 9e9)));
  const out = [];
  for (const t of txs.slice(0, limit)) {
    let inSum = 0n, outSum = 0n;
    for (const vin of (t.vin || [])) { const po = vin.prevout; if (po && walletAddrs.has(po.scriptpubkey_address)) inSum += BigInt(po.value || 0); }
    for (const vo of (t.vout || [])) { if (walletAddrs.has(vo.scriptpubkey_address)) outSum += BigInt(vo.value || 0); }
    const delta = outSum - inSum;
    out.push({
      txid: t.txid,
      height: (t.status && t.status.block_height) ?? null,
      timestamp: (t.status && t.status.block_time) ?? null,
      type: delta >= 0n ? 'incoming' : 'outgoing',
      deltas: { BTC: delta.toString() },
    });
  }
  return out;
}

// Unspent outputs, serialized for the website provider (the DEX composes
// swap PSETs from these and sends them back through signPset).
export function utxosSerialized() {
  if (!wollet) throw new Error('wallet is locked');
  const out = [];
  let utxos = [];
  try { utxos = wollet.utxos(); } catch { return out; }
  for (const u of utxos) {
    try {
      const op = u.outpoint();
      const sec = u.unblinded();
      out.push({
        txid: op.txid().toString(),
        vout: op.vout(),
        asset: sec.asset().toString(),
        value: String(sec.value()),
        scriptPubkey: u.scriptPubkey().toString(),
        address: (() => { try { return u.address().toString(); } catch { return null; } })(),
        height: u.height() ?? null,
      });
    } catch {}
  }
  return out;
}

// ---- signing surfaces for the website provider ----
// Sign a PSET a website built (a DEX order, a covenant fill) and return it
// WITHOUT finalizing or broadcasting — the site composes the rest.
//
// A site knows the outputs it is spending but not which of them are ours: it
// has no xpub and no derivation paths. The signer, meanwhile, signs an input
// only when that input carries THIS wallet's key origin. So the origins are
// filled in here, from the wallet's own descriptor, before signing, and taken
// back out afterwards — they say which keys this wallet derives, which is
// nobody else's business, and neither the signature nor finalizing needs them.
export async function signPset(psetB64) {
  if (!signer) throw new Error('wallet is locked');
  return withWollet(async () => {
    const pset = new Pset(psetB64);
    pset.addDetails(wollet);
    let signed;
    try {
      signed = signer.sign(pset);
    } catch (e) {
      if (/No signature added/i.test(String(e && e.message))) {
        throw new Error('this wallet holds none of the inputs in that transaction');
      }
      throw e;
    }
    return stripBip32(signed.toString());
  });
}
// What a PSET does to THIS wallet, for the approval window.
//
// The wallet's own decoder handles a blinded transaction. A fully transparent
// one it refuses ("Input #N is not blinded"), and those are exactly the
// transactions a covenant settles, so they are read from the bytes instead —
// with the wallet's key origins filled in first, so that what is ours can be
// told from what is not.
export function describePset(psetB64) {
  try {
    const pset = new Pset(psetB64);
    const det = wollet.psetDetails(pset);
    const bal = det.balance();
    const net = bal.balances().toJSON();
    const deltas = {};
    for (const [h, v] of Object.entries(net)) deltas[h] = String(v);
    let fee = null;
    try { const f = bal.fee(); if (f != null) fee = String(f); } catch {}
    return { deltas, fee };
  } catch {
    try {
      const pset = new Pset(psetB64);
      pset.addDetails(wollet);
      const t = describeTransparent(pset.toString());
      const deltas = {};
      for (const [h, v] of Object.entries(t.deltas)) if (v !== 0n) deltas[h] = String(v);
      return { deltas, fee: t.fee == null ? null : String(t.fee), transparent: true };
    } catch {
      return null;
    }
  }
}
export function signMessage(message) {
  if (!signer) throw new Error('wallet is locked');
  return signer.signMessage(message);
}
export async function pignusBtcPubkey() {
  const phrase = await sessionMnemonic();
  if (!phrase) throw new Error('the wallet is locked');
  return xOnlyPubkey(_bsHex(pignusSecret(phrase)));
}
// A parent-chain address this wallet actually owns, for a site that has to
// name one in a script -- a cross-chain loan names where the collateral comes
// back to, and it is baked in before anything is funded. Handing back a raw key
// instead would produce an output the wallet cannot see or spend.
export function btcReceiveAddress(index = null) {
  if (!btcW) throw new Error('the wallet is locked');
  const i = index == null ? btcScanState.externalNext : Number(index);
  const address = btcW.address(mnemonic, false, i);
  return { address, index: i };
}
export async function pignusBtcSignTaproot(sighashHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(String(sighashHex || '')))
    throw new Error('the sighash must be 32 bytes of hex');
  const phrase = await sessionMnemonic();
  if (!phrase) throw new Error('the wallet is locked');
  return signSchnorr(_bsHex(pignusSecret(phrase)), String(sighashHex).toLowerCase());
}
export async function pignusPrepareBtcFunding(address, amountSats) {
  if (!btcW) throw new Error('the wallet is locked');
  const p = await btcW.prepare(mnemonic, address, BigInt(amountSats), BTC_FEERATE);
  return { txid: String(p.txid), vout: p.vout ?? 0, hex: p.hex };
}
function _bsHex(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
// The wallet's Sequentia staking identity: the key at m/2/0 that a stake is
// bonded to, and the only key that can ever unbond it. `signMessage` above
// signs with the MASTER key, which is a different key and proves nothing about
// a stake -- so anything asking "do you own this stake" needs this one.
export function stakerPublicKey() {
  if (!signer) throw new Error('wallet is locked');
  if (typeof signer.stakerPublicKey !== 'function') {
    throw new Error('this wallet build has no Sequentia staking key');
  }
  return signer.stakerPublicKey();
}
export function signStakerMessage(message) {
  if (!signer) throw new Error('wallet is locked');
  if (typeof signer.signMessageWithStakerKey !== 'function') {
    throw new Error('this wallet build cannot sign with the staking key; update the extension');
  }
  return signer.signMessageWithStakerKey(message);
}
export async function broadcastRaw({ chain, hex, psetB64 }) {
  if (chain === 'bitcoin') return { txid: String(await btcW.broadcast(hex)) };
  if (psetB64) {
    return withWollet(async () => {
      const finalized = wollet.finalize(new Pset(psetB64));
      const txid = await client.broadcast(finalized);
      try { wollet.applyTransaction(finalized); } catch {}
      noteOwnTx(finalized);
      return { txid: txid.toString() };
    });
  }
  return withWollet(async () => {
    const tx = new Transaction(hex);
    const txid = await client.broadcastTx(tx);
    return { txid: txid.toString() };
  });
}

// ---- misc accessors for other modules ----
export function getSigner() { return signer; }
export function getWollet() { return wollet; }
export function getNetwork() { return network; }
export function getClient() { return client; }
export function fmt(atoms, hex) { return fmtAtoms(atoms, A.assetMeta(hex).precision || 0); }
