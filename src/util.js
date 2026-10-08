// Small pure helpers shared by the background engine and the popup.
import { decodeBolt11 } from '../vendor/bolt11.js';

// lwk takes u64 -> JS BigInt. `d` = decimal precision of the asset.
export function fmtAtoms(atoms, d) {
  atoms = BigInt(atoms);
  const neg = atoms < 0n;
  if (neg) atoms = -atoms;
  const base = 10n ** BigInt(d);
  let s = (atoms / base).toString();
  if (d > 0) {
    const f = (atoms % base).toString().padStart(d, '0').replace(/0+$/, '');
    if (f) s += '.' + f;
  }
  return (neg ? '-' : '') + s;
}

export function parseAtoms(str, d) {
  str = (str || '').trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error('enter a valid amount');
  let [i, f = ''] = str.split('.');
  if (f.length > d) throw new Error(`max ${d} decimals for this asset`);
  f = (f + '0'.repeat(d)).slice(0, d);
  return BigInt(i) * (10n ** BigInt(d)) + BigInt(f || '0');
}

export function hexToBytes(hex) {
  hex = (hex || '').replace(/^0x/, '');
  if (hex.length % 2) throw new Error('bad hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// Human-readable error strings for the most common node/wallet failures.
export function prettyErr(e) {
  const m = String((e && e.message) ?? e ?? 'unknown error');
  if (/insufficient funds|missing \d+ units/i.test(m)) return 'Not enough funds to cover the amount plus the network fee.';
  if (/min relay fee not met|fee rate too low/i.test(m)) return 'The fee rate is below the network minimum; raise it and try again.';
  if (/bad-txns-inputs-missingorspent/i.test(m)) return 'An input was already spent (the wallet view was stale); sync and try again.';
  if (/Failed to fetch|NetworkError|load failed/i.test(m)) return 'Network error: could not reach the backend.';
  return m;
}

// A bolt11 Lightning invoice (any network prefix used by SeqLN nodes).
export function looksLikeBolt11(s) {
  return /^ln(bc|tb|tbs|ert|sq|tsq)[0-9a-z]+$/i.test((s || '').trim());
}

// What a Lightning invoice is paid in, as the wallet keys its Lightning nodes: 'BTC' for a
// Bitcoin invoice, the asset id an invoice on Sequentia names in its `a` field. The node that
// pays it must hold that: { kind } or { error } (a Sequentia invoice naming no asset is not one
// the node pays).
export function lnInvoiceKind(bolt11) {
  const d = decodeBolt11(bolt11);
  if (!d.ok) return { error: 'not an invoice this wallet can pay: ' + d.error };
  return { kind: d.chain === 'btc' ? 'BTC' : d.asset };
}

// chrome.storage helpers (promise-style, single-key).
export async function stGet(area, key, fallback = null) {
  const o = await chrome.storage[area].get(key);
  return o[key] === undefined ? fallback : o[key];
}
export async function stSet(area, key, val) {
  await chrome.storage[area].set({ [key]: val });
}
export async function stDel(area, key) {
  await chrome.storage[area].remove(key);
}
