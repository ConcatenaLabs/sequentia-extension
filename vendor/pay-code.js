// A wallet's one receive code: a BIP321 payment request that carries every way the wallet takes
// a payment, so whoever pays picks the way that fits what they send.
//
//   BITCOIN:<ADDRESS>?ark=<ARK ADDRESS>&sequentia=<RECEIVE REQUEST>
//
//   address     the wallet's address, the same tb1 address on both chains: what any Bitcoin
//               wallet pays, and the way of last resort for every asset
//   ark         an address of the wallet's on a Bitcoin ark (Bark's own BIP321 parameter): BTC
//               paid there arrives in seconds
//   sequentia   a Sequentia receive request (single use): an asset paid there arrives in seconds
//
// Neither extra parameter is required (no `req-` prefix), so a wallet that knows neither sees a
// plain bitcoin: request for the address. Other BIP321 parameters (amount, label, message,
// lightning) are read and kept. A code that asks an amount of a Sequentia asset carries an invoice
// in that asset as `lightning` (its network and asset are in the invoice) and no `amount`, which
// BIP321 counts in BTC.
//
// The code is made to be scanned at a glance. The scheme and every bech32 part (the address, the
// ark address, an invoice, the receive request) are written in upper case, which a QR code holds
// in its alphanumeric mode at 5.5 bits a character instead of 8; only `?ark=`, `&sequentia=` and
// the like are bytes. Readers take either case and hand bech32 parts on in lower case.
//
// The receive request travels short (`SQR1…`, bech32m, human part `sqr`). The leaf library's own
// spelling is the hex of a JSON object, about a thousand characters, and much of it is what a
// payer able to pay it knows already: its own operator and chain. The short form keeps only what
// the payer cannot know:
//
//   byte 0         version, 1
//   byte 1         flags: 1 the vtxo-2 template, 2 a landing, 4 an asset, 8 a value, 16 channels
//   bytes 2-5      the first 4 bytes of the operator's key       } checked against the payer's
//   bytes 6-9      the first 4 bytes of the chain's genesis hash } own, never taken from here
//   bytes 10-41    owner           bytes 42-73   owner nonce       bytes 74-105   mailbox
//   bytes 106-107  exit delay units (big-endian)                   bytes 108-111  until (big-endian)
//   then, as flagged: landing (20 bytes), asset (32), value (8, big-endian), channels (a count
//   byte, then per channel its asset (32) and its leaf (32))
//
// A payer on the same operator and chain rebuilds the library's request from it with its own
// operator and genesis (`expandRequest`); any other payer could not pay the request in the tree
// anyway, and pays the address. A request with anything the short form does not carry stays in
// the library's spelling, which every reader still takes, as it takes codes made before the
// short form.
//
// This module only writes and reads the code. Which way a payment takes, and whether a wallet
// shows one code, are its caller's choices. No DOM: it runs under Node (pay-code.test.mjs).
// Ambra mobile holds the same format (app/lib/src/data/pay_code.dart) and the browser extension
// a copy of this file (vendor/pay-code.js): change all three together.

// Characters left as they are in a value; everything else is percent-encoded (RFC 3986 unreserved
// and the sub-delimiters a query value may hold without ambiguity).
const PLAIN = /[A-Za-z0-9\-._~!$'()*,;:@/]/

function enc (v) {
  let out = ''
  for (const ch of String(v)) {
    if (PLAIN.test(ch)) { out += ch; continue }
    for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

function dec (v) {
  try { return decodeURIComponent(v.replace(/\+/g, '%20')) } catch { throw new Error('the code has a broken escape') }
}

// ---- bech32 and bech32m (BIP173, BIP350), without BIP173's 90-character limit ----------------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32 = 1, BECH32M = 0x2bc830a3

function polymod (values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]
  }
  return chk >>> 0
}

function hrpExpand (hrp) {
  const out = []
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5)
  out.push(0)
  for (const c of hrp) out.push(c.charCodeAt(0) & 31)
  return out
}

function convert (data, from, to, pad) {
  let acc = 0, bits = 0
  const out = [], max = (1 << to) - 1
  for (const v of data) {
    acc = ((acc << from) | v) & 0xffffff
    bits += from
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max) }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max) } else if (bits >= from || ((acc << (to - bits)) & max)) return null
  return out
}

// `s` split into its human part and its 5-bit words, with which checksum it holds (BECH32,
// BECH32M) or null.
function bechParts (s) {
  const t = String(s || '')
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return null
  const l = t.toLowerCase(), p = l.lastIndexOf('1')
  if (p < 1 || p + 7 > l.length || l.length > 2000) return null
  const hrp = l.slice(0, p), data = []
  for (const c of hrp) if (c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126) return null
  for (const c of l.slice(p + 1)) { const d = CHARSET.indexOf(c); if (d < 0) return null; data.push(d) }
  const sum = polymod([...hrpExpand(hrp), ...data])
  return sum === BECH32 || sum === BECH32M ? { hrp, data, sum } : null
}

export function bech32mEncode (hrp, bytes) {
  const data = convert(bytes, 8, 5, true)
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ BECH32M
  const chk = []
  for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31)
  return hrp + '1' + [...data, ...chk].map((d) => CHARSET[d]).join('')
}

// -> { hrp, bytes } or null when `s` is not bech32m with a good checksum.
export function bech32mDecode (s) {
  const p = bechParts(s)
  if (!p || p.sum !== BECH32M) return null
  const bytes = convert(p.data.slice(0, -6), 5, 8, false)
  return bytes ? { hrp: p.hrp, bytes: Uint8Array.from(bytes) } : null
}

// ---- the short receive request -------------------------------------------------------------

export const REQUEST_HRP = 'sqr'
const F_V2 = 1, F_LANDING = 2, F_ASSET = 4, F_VALUE = 8, F_CHANNELS = 16
// The keys the short form carries; a request with any other is left in the library's spelling.
const CARRIED = new Set(['kind', 'genesis_hash', 'operator', 'owner', 'owner_nonce', 'mailbox', 'exit_delay_units',
  'until', 'landing', 'asset', 'value', 'template', 'channels'])

const isHex = (s, n) => typeof s === 'string' && s.length === 2 * n && /^[0-9a-fA-F]+$/.test(s)
const hexBytes = (s) => { const b = []; for (let i = 0; i < s.length; i += 2) b.push(parseInt(s.slice(i, i + 2), 16)); return b }
const bytesHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// The library's request text (`<word>:<hex of its JSON>`) -> its JSON, or null.
export function libraryRequest (text) {
  const s = String(text || '').trim()
  const i = s.indexOf(':')
  if (i <= 0) return null
  const prefix = s.slice(0, i), hex = s.slice(i + 1)
  if (!/^[A-Za-z0-9-]+$/.test(prefix) || !hex.length || hex.length % 2 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  let v
  try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hexBytes(hex)))) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return (v.kind === 'request' || v.arca_request !== undefined) ? v : null
}

// The library's request text -> its short form (`sqr1…`, lower case), or null when the request
// carries anything the short form does not (it is then kept as it is).
export function compactRequest (text) {
  const r = libraryRequest(text)
  if (!r || r.kind !== 'request') return null
  for (const k of Object.keys(r)) if (!CARRIED.has(k)) return null
  if (!isHex(r.operator, 32) || !isHex(r.genesis_hash, 32) || !isHex(r.owner, 32) || !isHex(r.owner_nonce, 32) ||
      !isHex(r.mailbox, 32)) return null
  const delay = r.exit_delay_units, until = r.until
  if (!Number.isInteger(delay) || delay < 0 || delay > 0xffff) return null
  if (!Number.isInteger(until) || until < 0 || until > 0xffffffff) return null
  if (r.template !== undefined && r.template !== 'vtxo-2') return null
  if (r.landing !== undefined && !isHex(r.landing, 20)) return null
  if (r.asset !== undefined && !isHex(r.asset, 32)) return null
  if (r.value !== undefined && !(typeof r.value === 'string' && /^\d+$/.test(r.value) && BigInt(r.value) < 1n << 64n)) return null
  const channels = r.channels === undefined ? null : Object.entries(r.channels || {})
  if (channels && (!channels.length || channels.length > 255 || channels.some(([a, l]) => !isHex(a, 32) || !isHex(l, 32)))) return null
  let flags = 0
  if (r.template) flags |= F_V2
  if (r.landing !== undefined) flags |= F_LANDING
  if (r.asset !== undefined) flags |= F_ASSET
  if (r.value !== undefined) flags |= F_VALUE
  if (channels) flags |= F_CHANNELS
  const b = [1, flags, ...hexBytes(r.operator).slice(0, 4), ...hexBytes(r.genesis_hash).slice(0, 4),
    ...hexBytes(r.owner), ...hexBytes(r.owner_nonce), ...hexBytes(r.mailbox),
    delay >> 8, delay & 0xff, (until >>> 24) & 0xff, (until >>> 16) & 0xff, (until >>> 8) & 0xff, until & 0xff]
  if (r.landing !== undefined) b.push(...hexBytes(r.landing))
  if (r.asset !== undefined) b.push(...hexBytes(r.asset))
  if (r.value !== undefined) { let v = BigInt(r.value); const vb = []; for (let i = 0; i < 8; i++) { vb.unshift(Number(v & 0xffn)); v >>= 8n } b.push(...vb) }
  if (channels) { b.push(channels.length); for (const [a, l] of channels) b.push(...hexBytes(a), ...hexBytes(l)) }
  return bech32mEncode(REQUEST_HRP, b)
}

// The short form's fields -> { operatorPrefix, genesisPrefix, request } (`request` the library's
// JSON less operator and genesis), or null when `text` is not one.
export function readShortRequest (text) {
  const d = bech32mDecode(String(text || '').trim())
  if (!d || d.hrp !== REQUEST_HRP) return null
  const b = d.bytes
  if (b.length < 112 || b[0] !== 1) return null
  const flags = b[1]
  if (flags & ~31) return null
  const at = (i, n) => bytesHex(b.slice(i, i + n))
  const r = { kind: 'request', owner: at(10, 32), owner_nonce: at(42, 32), mailbox: at(74, 32),
    exit_delay_units: (b[106] << 8) | b[107], until: b[108] * 0x1000000 + (b[109] << 16) + (b[110] << 8) + b[111] }
  let i = 112
  const need = (n) => { if (i + n > b.length) throw new Error('short'); const s = i; i += n; return s }
  try {
    if (flags & F_LANDING) r.landing = at(need(20), 20)
    if (flags & F_ASSET) r.asset = at(need(32), 32)
    if (flags & F_VALUE) { const s = need(8); let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(b[s + k]); r.value = v.toString() }
    if (flags & F_V2) r.template = 'vtxo-2'
    if (flags & F_CHANNELS) {
      const n = b[need(1)]
      if (!n) return null
      r.channels = {}
      for (let k = 0; k < n; k++) { const s = need(64); r.channels[at(s, 32)] = at(s + 32, 32) }
    }
  } catch { return null }
  if (i !== b.length) return null
  return { operatorPrefix: at(2, 4), genesisPrefix: at(6, 4), request: r }
}

// A receive request as a code carries it (short, or in the library's spelling) -> the library's
// request text that a payer on `info`'s operator and chain pays, or null when it is not for
// them. `info` is the leaf library's (`operator`, `genesis_hash`).
export function expandRequest (text, info) {
  if (!info || !isHex(info.operator, 32) || !isHex(info.genesis_hash, 32)) return null
  const s = String(text || '').trim()
  const short = readShortRequest(s)
  if (!short) {
    const r = libraryRequest(s)
    return r && r.operator === info.operator && r.genesis_hash === info.genesis_hash ? s : null
  }
  if (info.operator.slice(0, 8).toLowerCase() !== short.operatorPrefix) return null
  if (info.genesis_hash.slice(0, 8).toLowerCase() !== short.genesisPrefix) return null
  const { kind, ...rest } = short.request
  const json = JSON.stringify({ kind, genesis_hash: info.genesis_hash, operator: info.operator, ...rest })
  return 'arca:' + bytesHex(new TextEncoder().encode(json))
}

// ---- the code ------------------------------------------------------------------------------

// A bech32 or bech32m part in upper case for the picture; anything else as it is.
const up = (v) => bechParts(v) ? String(v).toUpperCase() : String(v)
// A part handed on: bech32 in lower case, as every library takes it.
const down = (v) => v != null && bechParts(v) ? v.toLowerCase() : v

// -> 'BITCOIN:…' from { address, ark?, sequentia?, amount?, label?, message?, lightning? }. A
// `sequentia` request in the library's spelling goes in short when it can.
export function buildPayCode ({ address, ark, sequentia, amount, label, message, lightning } = {}) {
  if (!address || !/^[A-Za-z0-9]+$/.test(String(address))) throw new Error('a receive code needs the wallet\'s address')
  const q = []
  if (amount != null) q.push(['amount', enc(amount)])
  if (label) q.push(['label', enc(label)])
  if (message) q.push(['message', enc(message)])
  if (lightning) q.push(['lightning', enc(up(lightning))])
  if (ark) q.push(['ark', enc(up(ark))])
  if (sequentia) {
    const short = compactRequest(sequentia)
    q.push(['sequentia', short ? short.toUpperCase() : enc(sequentia)])
  }
  return 'BITCOIN:' + up(address) + (q.length ? '?' + q.map(([k, v]) => k + '=' + v).join('&') : '')
}

// -> { address, ark, sequentia, amount, label, message, lightning, other } or null when `text` is
// not a bitcoin: request. Bech32 parts come back in lower case; `sequentia` as the code carries it
// (short, or the library's spelling: `expandRequest` makes it payable). Throws on a request it
// cannot honour: a required parameter it does not know (BIP321's `req-`), or a parameter given
// twice where only one is meant.
export function readPayCode (text) {
  const s = String(text || '').trim()
  const m = /^bitcoin:([^?]*)(?:\?(.*))?$/i.exec(s)
  if (!m) return null
  const out = { address: m[1] ? down(dec(m[1])) : null, ark: null, sequentia: null, amount: null, label: null, message: null, lightning: null, other: {} }
  const known = new Set(['ark', 'sequentia', 'amount', 'label', 'message', 'lightning'])
  for (const part of (m[2] || '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    let key = (i < 0 ? part : part.slice(0, i)).toLowerCase()
    const value = i < 0 ? '' : dec(part.slice(i + 1))
    const required = key.startsWith('req-')
    if (required) key = key.slice(4)
    if (known.has(key)) {
      if (out[key] != null) throw new Error('the code names ' + key + ' twice')
      out[key] = (key === 'ark' || key === 'lightning' || key === 'sequentia') ? down(value) : value
    } else if (required) {
      throw new Error('the code asks for something this wallet cannot do (' + key + ')')
    } else {
      out.other[key] = value
    }
  }
  if (!out.address && !out.ark && !out.sequentia && !out.lightning) throw new Error('the code names no way to pay')
  return out
}
