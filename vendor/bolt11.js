// bolt11.js — what the wallet reads from a BOLT11 invoice, with no I/O: the network its prefix
// names, the amount, the payment hash, the final CLTV delta and, on a Sequentia network, the asset
// it is paid in.
//
// An invoice on a Sequentia network names its asset in the tagged field `a` (type 29): 52 five-bit
// groups whose first 256 bits are the asset id in display order, the hex the node's RPC and the
// explorer print. The node refuses to decode a Sequentia invoice without it (no asset is implied by
// its absence) and refuses to pay one in any other asset. On a Bitcoin network an invoice is paid in
// bitcoin and `a` is an unknown field, skipped. Where a field appears twice the first counts, as it
// does for the node.
//
// The node stays the authority on an invoice: these readers let the page pick the right hosted node
// before it asks one to pay, and let a caller refuse an invoice that cannot be its own before
// anything is sent. Layout of the data part: timestamp (7 groups), tagged fields (type 1, length 2
// big-endian, data), signature (104), checksum (6).

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// The invoice prefix of each network SeqLN runs on (`ln` + this + the amount).
export const BOLT11_NETWORKS = {
  sqt: { chain: 'seq', network: 'sequentia' },
  tsqt: { chain: 'seq', network: 'sequentia-testnet' },
  sqrt: { chain: 'seq', network: 'sequentia-regtest' },
  bc: { chain: 'btc', network: 'bitcoin' },
  tb: { chain: 'btc', network: 'testnet' },
  tbs: { chain: 'btc', network: 'signet' },
  bcrt: { chain: 'btc', network: 'regtest' },
};

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
  }
  return chk;
}

function groupsToHex(groups, nbytes) {
  let acc = 0, bits = 0; const out = [];
  for (const g of groups) {
    acc = ((acc << 5) | g) & 0xffff; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); if (out.length === nbytes) break; }
  }
  return out.length === nbytes ? out.map((x) => x.toString(16).padStart(2, '0')).join('') : null;
}

// The pieces of an invoice string, without checking its checksum (the legacy readers below never
// did, and their callers' tests build invoices that carry none): { hrp, vals } or null.
function split(bolt11) {
  if (typeof bolt11 !== 'string') return null;
  let s = bolt11.trim().toLowerCase();
  if (s.startsWith('lightning:')) s = s.slice('lightning:'.length);
  const sep = s.lastIndexOf('1');                         // bech32 separator (the data part uses no '1')
  if (sep < 1) return null;
  const hrp = s.slice(0, sep), data = s.slice(sep + 1);
  const vals = [];
  for (const ch of data) { const v = CHARSET.indexOf(ch); if (v < 0) return null; vals.push(v); }
  if (vals.length < 7 + 104 + 6) return null;
  return { hrp, vals };
}

// Each tagged field as { type, data } (data = its five-bit groups), in order; stops at a field
// that runs past the end.
function fields(vals) {
  const end = vals.length - 104 - 6;
  const out = [];
  let i = 7;
  while (i + 3 <= end) {
    const type = vals[i];
    const len = (vals[i + 1] << 5) | vals[i + 2];
    i += 3;
    if (i + len > end) break;
    out.push({ type, data: vals.slice(i, i + len) });
    i += len;
  }
  return out;
}

// The network letters of a prefix: what lies between `ln` and the amount.
function networkLetters(hrp) {
  const m = /^ln([a-z]+?)(\d.*)?$/.exec(hrp);
  return m ? m[1] : null;
}

// bolt11AmountMsat — the invoice amount in msat from its prefix, or null when it is absent or not
// confidently parseable (an amountless invoice, an unknown prefix, a sub-msat `p` amount).
// CONSERVATIVE by design: null rather than a guess, so an overpay guard it feeds never refuses a valid
// invoice. On a Sequentia network the amount is in thousandths of the asset's atoms, as on Bitcoin it
// is in thousandths of a satoshi: m=1e-3, u=1e-6, n=1e-9, p=1e-12 of a unit; msat = units * 1e11.
export function bolt11AmountMsat(bolt11) {
  if (typeof bolt11 !== 'string') return null;
  const m = /^(?:lightning:)?ln(tsqt|sqrt|sqt|bcrt|tbs|tsb|bc|tb|sb)(\d*)([munp]?)1/i.exec(bolt11.trim());
  if (!m || !m[2]) return null;   // no prefix match, or an amountless invoice
  let n; try { n = BigInt(m[2]); } catch { return null; }
  switch ((m[3] || '').toLowerCase()) {
    case 'm': return n * 100000000n;
    case 'u': return n * 100000n;
    case 'n': return n * 100n;
    case 'p': return (n % 10n === 0n) ? n / 10n : null;
    case '':  return n * 100000000000n;
    default:  return null;
  }
}

// bolt11PaymentHash — the `p` field (type 1, 52 groups) as 32-byte lowercase hex, or null when it
// cannot be confidently extracted (a gate fed by it fails closed on null).
export function bolt11PaymentHash(bolt11) {
  const p = split(bolt11);
  if (!p) return null;
  let h = null;
  for (const f of fields(p.vals)) if (f.type === 1 && f.data.length === 52 && h === null) h = groupsToHex(f.data, 32);
  return h;
}

// bolt11MinFinalCltv — the `c` field (type 24) as a Number, the BOLT11 default of 18 when absent,
// or null when the invoice cannot be parsed. The first `c` counts.
export function bolt11MinFinalCltv(bolt11) {
  const p = split(bolt11);
  if (!p) return null;
  for (const f of fields(p.vals)) {
    if (f.type === 24) { let acc = 0; for (const g of f.data) acc = acc * 32 + g; return acc; }
  }
  return 18;
}

// bolt11Asset — the asset a Sequentia invoice is paid in (its `a` field, display-order hex), or null:
// for a Bitcoin invoice, for one that names none, and for one that does not parse.
export function bolt11Asset(bolt11) {
  const d = decodeBolt11(bolt11, { checksum: false });
  return d.ok && d.chain === 'seq' ? d.asset : null;
}

// decodeBolt11 — everything above in one reading:
//   { ok: true, network, chain: 'seq'|'btc', asset (hex on 'seq', null on 'btc'), amountMsat (BigInt|null),
//     paymentHash, minFinalCltv }
// or { ok: false, error } for a string that is not an invoice the node would decode: an unknown
// prefix, a broken checksum (unless { checksum: false }), no payment hash, or, on a Sequentia network,
// no `a` field or one of the wrong length.
export function decodeBolt11(bolt11, { checksum = true } = {}) {
  const p = split(bolt11);
  if (!p) return { ok: false, error: 'not a BOLT11 invoice' };
  const letters = networkLetters(p.hrp);
  const net = letters != null ? BOLT11_NETWORKS[letters] : null;
  if (!net) return { ok: false, error: `an invoice for an unknown network (${p.hrp})` };
  if (checksum) {
    const chk = [];
    for (const c of p.hrp) chk.push(c.charCodeAt(0) >> 5);
    chk.push(0);
    for (const c of p.hrp) chk.push(c.charCodeAt(0) & 31);
    if (polymod(chk.concat(p.vals)) !== 1) return { ok: false, error: 'the invoice checksum does not verify (a character is wrong or missing)' };
  }
  let asset = null, assetErr = null;
  if (net.chain === 'seq') {
    for (const f of fields(p.vals)) {
      if (f.type !== 29) continue;
      if (f.data.length !== 52) assetErr = `a: expected 52 characters, got ${f.data.length}`;
      else asset = groupsToHex(f.data, 32);
      break;
    }
    if (assetErr) return { ok: false, error: assetErr };
    if (!asset) return { ok: false, error: `a: missing: an invoice on ${net.network} must name the asset it is paid in` };
  }
  const paymentHash = bolt11PaymentHash(bolt11);
  if (!paymentHash) return { ok: false, error: 'the invoice carries no payment hash' };
  return { ok: true, network: net.network, chain: net.chain, asset,
    amountMsat: bolt11AmountMsat(bolt11), paymentHash, minFinalCltv: bolt11MinFinalCltv(bolt11) };
}
