// A wallet's one receive code: a BIP321 payment request that carries every way the wallet takes
// a payment, so whoever pays picks the way that fits what they send.
//
//   bitcoin:<address>?ark=<Ark address>&sequentia=<receive request>
//
//   address     the wallet's address, the same tb1 address on both chains: what any Bitcoin
//               wallet pays, and the way of last resort for every asset
//   ark         an address of the wallet's on a Bitcoin ark (Bark's own BIP321 parameter): BTC
//               paid there arrives in seconds
//   sequentia   a Sequentia receive request (single use): an asset paid there arrives in seconds
//
// Neither extra parameter is required (no `req-` prefix), so a wallet that knows neither sees a
// plain bitcoin: request for the address. Other BIP321 parameters (amount, label, message,
// lightning) are read and kept.
//
// This module only writes and reads the code. Which way a payment takes, and whether a wallet
// shows one code, are its caller's choices. No DOM: it runs under Node (pay-code.test.mjs).

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

// -> 'bitcoin:…' from { address, ark?, sequentia?, amount?, label?, message?, lightning? }
export function buildPayCode ({ address, ark, sequentia, amount, label, message, lightning } = {}) {
  if (!address || !/^[A-Za-z0-9]+$/.test(String(address))) throw new Error('a receive code needs the wallet\'s address')
  const q = []
  if (amount != null) q.push(['amount', String(amount)])
  if (label) q.push(['label', label])
  if (message) q.push(['message', message])
  if (lightning) q.push(['lightning', lightning])
  if (ark) q.push(['ark', ark])
  if (sequentia) q.push(['sequentia', sequentia])
  return 'bitcoin:' + address + (q.length ? '?' + q.map(([k, v]) => k + '=' + enc(v)).join('&') : '')
}

// -> { address, ark, sequentia, amount, label, message, lightning, other } or null when `text` is
// not a bitcoin: request. Throws on a request it cannot honour: a required parameter it does not
// know (BIP321's `req-`), or a parameter given twice where only one is meant.
export function readPayCode (text) {
  const s = String(text || '').trim()
  const m = /^bitcoin:([^?]*)(?:\?(.*))?$/i.exec(s)
  if (!m) return null
  const out = { address: m[1] ? dec(m[1]) : null, ark: null, sequentia: null, amount: null, label: null, message: null, lightning: null, other: {} }
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
      out[key] = value
    } else if (required) {
      throw new Error('the code asks for something this wallet cannot do (' + key + ')')
    } else {
      out.other[key] = value
    }
  }
  if (!out.address && !out.ark && !out.sequentia && !out.lightning) throw new Error('the code names no way to pay')
  return out
}
