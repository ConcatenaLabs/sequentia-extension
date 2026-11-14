// Asset metadata, registry, prices, and any-asset fee rates.
//
// Ported from the web wallet (index.html) with localStorage caches replaced by
// chrome.storage.local and every DOM refresh removed. Precedence for names:
// user labels > registry > built-in defaults > generic hex prefix.
//
// FIRST PRINCIPLES encoded here (do not "fix"):
//  - No privileged asset: tSEQ enters the fee-rate map from the feed's
//    reference value exactly like every other asset; if the feed omits it,
//    tSEQ is unusable for fees. Never fabricate a rate (no 1:1 fallback).
//  - Fee-rate units are the fee asset's OWN units per vByte, never "sat/vB".

import { REGISTRY_URL, PRICES_URL, FEERATES_URL, DEFAULT_ASSETS, DEFAULT_FEERATE, EXCHANGE_RATE_SCALE } from './config.js';
import { stGet, stSet } from './util.js';

let POLICY_HEX = '';
export function setPolicyHex(hex) { POLICY_HEX = hex; }
export function policyHex() { return POLICY_HEX; }

// The OpenAMP module registers its live asset map so assetMeta can resolve
// 'oamp:<id>' rows without a circular import.
let oampAssetsGetter = () => ({});
export function registerOampAssets(fn) { oampAssetsGetter = fn; }

let REGISTRY_ASSETS = {};
let LABELS = {};
let PRICES = {};
let pricesTs = null;
let feeRates = {};

const PRICES_STALE_MS = 10 * 60 * 1000;

// Restore all caches from storage so the first popup paint resolves tickers,
// prices, and fee pickers without waiting on the network.
export async function restoreCaches() {
  REGISTRY_ASSETS = (await stGet('local', 'ext.registryCache')) || {};
  LABELS = (await stGet('local', 'ext.assetLabels')) || {};
  PRICES = (await stGet('local', 'ext.pricesCache')) || {};
  pricesTs = (await stGet('local', 'ext.pricesTs')) || null;
  feeRates = (await stGet('local', 'ext.feeRatesCache')) || {};
}

export async function loadRegistry() {
  try {
    const r = await fetch(REGISTRY_URL, { cache: 'no-store' });
    if (!r.ok) return;
    const idx = await r.json();
    const m = {};
    const clean = (s, n) => (typeof s === 'string') ? s.replace(/[<>]/g, '').slice(0, n) : s;
    for (const [id, v] of Object.entries(idx)) {
      if (Array.isArray(v)) m[id] = { ticker: clean(v[1], 16), name: clean(v[2], 48), precision: v[3], domain: v[0], verified: !!v[4] };
    }
    REGISTRY_ASSETS = m;
    await stSet('local', 'ext.registryCache', m);
  } catch {}
}

export async function saveLabel(hex, info) {
  LABELS[hex] = info;
  await stSet('local', 'ext.assetLabels', LABELS);
}

export function assetMeta(hex) {
  if (!hex) return { ticker: '—', name: 'Asset', precision: 0 };
  if (hex === 'BTC') return { ticker: 'BTC', name: 'Bitcoin testnet4', precision: 8 };
  if (hex.startsWith('oamp:')) {
    const m = oampAssetsGetter()[hex.slice(5)];
    return m ? { ticker: m.ticker || '?', name: m.name || 'Restricted asset', precision: m.precision || 0 }
             : { ticker: '?', name: 'Restricted asset', precision: 0 };
  }
  if (hex === POLICY_HEX) return { ticker: 'tSEQ', name: 'Sequence', precision: 8 };
  return LABELS[hex] || REGISTRY_ASSETS[hex] || DEFAULT_ASSETS[hex] || { ticker: hex.slice(0, 8) + '…', name: 'Asset', precision: 0 };
}

// Trust signals: verified (registry-vouched), registered (known at all), or
// unknown (potential impostor — anyone can mint any ticker).
export function assetRegistered(hex) {
  return !!(hex === POLICY_HEX || hex === 'BTC' || (hex && hex.startsWith('oamp:')) || REGISTRY_ASSETS[hex]);
}
export function assetVerified(hex) {
  if (hex === POLICY_HEX || hex === 'BTC') return true;
  const r = REGISTRY_ASSETS[hex];
  return !!(r && r.verified);
}
export function assetDomain(hex) {
  const r = REGISTRY_ASSETS[hex];
  return (r && r.domain) || '';
}

// True when we have NO authoritative precision (generic fallback row). Sending
// such an asset would mis-parse the amount, so sends are blocked on this.
export function precisionKnown(hex) {
  if (hex === 'BTC' || hex === POLICY_HEX) return true;
  if (hex.startsWith('oamp:')) return !!oampAssetsGetter()[hex.slice(5)];
  return !!(LABELS[hex] || REGISTRY_ASSETS[hex] || DEFAULT_ASSETS[hex]);
}
export function sendPrecision(hex) {
  if (!precisionKnown(hex)) throw new Error('unknown precision for asset ' + hex.slice(0, 12) + '…; label it before sending');
  return assetMeta(hex).precision;
}

// ---- prices / reference currency ----
export async function loadPrices() {
  try {
    const d = await fetch(PRICES_URL, { cache: 'no-store' }).then((r) => r.json());
    const m = {};
    for (const [t, v] of Object.entries(d)) {
      const p = (v && typeof v === 'object') ? v.price : v;
      if (p > 0) m[t.toUpperCase()] = p;
    }
    if (Object.keys(m).length) {
      PRICES = m;
      pricesTs = Date.now();
      await stSet('local', 'ext.pricesCache', m);
      await stSet('local', 'ext.pricesTs', pricesTs);
    }
  } catch {}
}

export function pricesStale() {
  return Object.keys(PRICES).length > 0 && (pricesTs == null || (Date.now() - pricesTs) > PRICES_STALE_MS);
}

function priceTicker(hex) {
  if (hex === 'BTC') return 'BTC';
  if (hex === POLICY_HEX) return 'SEQ';
  return assetMeta(hex).ticker;
}
const _BTC_KEYS = ['BTC', 'TBTC', 'WBTC'];
function _btcUsd() { for (const k of _BTC_KEYS) if (PRICES[k] > 0) return PRICES[k]; return null; }
export function priceFor(t) {
  if (!t) return null;
  const u = String(t).toUpperCase();
  if (PRICES[u] > 0) return PRICES[u];
  return _BTC_KEYS.includes(u) ? _btcUsd() : null;
}
export function refOptions() {
  const s = new Set(['USD']);
  for (const t of Object.keys(PRICES)) s.add(_BTC_KEYS.includes(t) ? 'BTC' : t);
  return [...s];
}
function priceOf(ref) { return ref === 'USD' ? 1 : priceFor(ref); }

// Value of `atoms` of asset `hex` in reference currency `ref`; falls back to
// USD when the chosen reference is unpriced. Returns {v, ref} or null.
// The price feed's price of one whole unit of an asset (or 'BTC') in USD, or null when unpriced.
export function unitPrice(hex) {
  const p = priceFor(hex === 'BTC' ? 'BTC' : priceTicker(hex));
  return p > 0 ? p : null;
}
export function refValue(hex, atoms, ref) {
  const pu = priceFor(priceTicker(hex));
  if (!(pu > 0)) return null;
  let r = ref || 'USD', pr = priceOf(r);
  if (!(pr > 0)) { r = 'USD'; pr = 1; }
  const units = Number(BigInt(atoms)) / Math.pow(10, assetMeta(hex).precision || 0);
  return { v: (units * pu) / pr, ref: r };
}
export function fmtRef(v, ref) {
  const dp = ref === 'BTC' ? 8 : (Math.abs(v) >= 1 ? 2 : 6);
  return v.toLocaleString(undefined, { maximumFractionDigits: dp }) + ' ' + ref;
}
export function refValueStr(hex, atoms, ref) {
  const rv = refValue(hex, atoms, ref);
  return rv ? '≈ ' + fmtRef(rv.v, rv.ref) : '';
}

// ---- any-asset fee exchange rates ----
export async function fetchFeeRates() {
  try {
    const d = await fetch(FEERATES_URL).then((r) => r.json());
    const ref = d.bitcoin;   // tSEQ (policy) reference rate — or ABSENT; never fabricated
    const map = {};
    if (ref > 0 && POLICY_HEX) map[POLICY_HEX] = { rate: ref, source: 'reference' };
    for (const [k, v] of Object.entries(d)) {
      if (k === 'bitcoin' || !(v > 0)) continue;
      map[k] = { rate: v };
    }
    feeRates = map;
    await stSet('local', 'ext.feeRatesCache', map);
  } catch {}
}

// /feerates is keyed by ticker plus "bitcoin" (=tSEQ); resolve by hex OR ticker.
export function feeRateEntry(hex) {
  return feeRates[hex] || feeRates[assetMeta(hex).ticker];
}
export function feeRateFor(hex) {
  const e = feeRateEntry(hex);
  const r = e && e.rate;
  if (!(r > 0)) throw new Error('no fee rate for ' + assetMeta(hex).ticker + '; try again');
  return BigInt(r);
}

// Feerate for feeRate() when the POLICY asset pays: scale the reference feerate
// by tSEQ's own published rate (no privilege; may not be 1:1).
export function policyFeeRate() {
  const pr = Number(feeRateFor(POLICY_HEX));
  return Math.max(1, Math.ceil(DEFAULT_FEERATE * EXCHANGE_RATE_SCALE / pr));
}

// The assets currently usable for fees (for the popup's fee picker).
export function feePricedAssets(heldHexes) {
  return heldHexes.filter((h) => { const e = feeRateEntry(h); return e && e.rate > 0; });
}
