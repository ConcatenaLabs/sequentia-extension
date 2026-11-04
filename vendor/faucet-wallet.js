// The testnet faucet pays each asset once per wallet (sequentia-faucet, "Once per wallet"). A
// wallet names itself to the faucet by its id, sent with every request as `wallet`:
//
//   hex( sha256( "sequentia-faucet-wallet/1" || scriptPubKey of its first receive address ) )
//
// the first receive address being the wallet's Sequentia address at index 0. One phrase gives
// one id in the web wallet, Ambra browser and Ambra mobile, on any device and after a restore,
// and the id says nothing a payment to that address would not. Before a request the wallet reads
// which assets it has already received (`GET /faucet/claimed?wallet=<id>`) and shows them.
//
// The browser extension copies this file into its `vendor/`, and Ambra mobile carries the same
// rule in Dart (`faucet_wallet.dart`): change them together. The vector in
// faucet-wallet.test.mjs is the one all three check.

export const FAUCET_WALLET_TAG = 'sequentia-faucet-wallet/1'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
function polymod (values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i]
  }
  return chk >>> 0
}

// A segwit address (tb1…, bech32 for version 0, bech32m above) -> the bytes of its scriptPubKey,
// or null when it is not one.
export function scriptPubKeyOf (address) {
  const s = String(address || '').trim()
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return null
  const a = s.toLowerCase()
  const at = a.lastIndexOf('1')
  if (at < 1 || a.length - at < 8) return null
  const hrp = a.slice(0, at)
  const data = []
  for (const c of a.slice(at + 1)) { const v = CHARSET.indexOf(c); if (v < 0) return null; data.push(v) }
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31))
  const chk = polymod(expand.concat(data))
  const version = data[0]
  if (chk !== (version === 0 ? 1 : 0x2bc830a3) || version > 16) return null
  let acc = 0; let bits = 0
  const prog = []
  for (const v of data.slice(1, -6)) {
    acc = (acc << 5) | v; bits += 5
    if (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff) }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1))) return null
  if (prog.length < 2 || prog.length > 40 || (version === 0 && prog.length !== 20 && prog.length !== 32)) return null
  return Uint8Array.from([version ? 0x50 + version : 0, prog.length, ...prog])
}

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// -> the wallet's id from the scriptPubKey of its first receive address (bytes, or hex).
export async function faucetWalletId (scriptPubKey) {
  const spk = typeof scriptPubKey === 'string'
    ? Uint8Array.from(scriptPubKey.match(/../g) || [], (h) => parseInt(h, 16))
    : Uint8Array.from(scriptPubKey)
  if (!spk.length) throw new Error('no scriptPubKey')
  const tag = new TextEncoder().encode(FAUCET_WALLET_TAG)
  const msg = new Uint8Array(tag.length + spk.length)
  msg.set(tag); msg.set(spk, tag.length)
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', msg)))
}

// -> the wallet's id from its first receive address, as text.
export async function faucetWalletIdOf (address) {
  const spk = scriptPubKeyOf(address)
  if (!spk) throw new Error('not a segwit address: ' + address)
  return faucetWalletId(spk)
}

// The assets this wallet has already received from the faucet, as a Set of its labels ('BTC',
// 'tSEQ', 'USDX', …), or null when the faucet could not be asked (the buttons then stay as they
// are, and a refusal still says what happened).
export async function faucetClaimed (fetchFn, faucetUrl, walletId) {
  try {
    const r = await fetchFn(String(faucetUrl).replace(/\/$/, '') + '/claimed?wallet=' + encodeURIComponent(walletId), { cache: 'no-store' })
    if (!r.ok) return null
    const j = await r.json()
    return Array.isArray(j && j.claimed) ? new Set(j.claimed.map(String)) : null
  } catch { return null }
}

// The label the faucet uses for a button's asset ('' is tSEQ).
export const faucetLabel = (asset) => asset || 'tSEQ'

// A faucet answer that says the wallet already has the asset: no other route is tried, and the
// wallet marks it received.
export const faucetAlreadyPaid = (status, body) => status === 429 && !!body && body.claimed === true

// What a button says, by whether the wallet has received its asset.
export const FAUCET_WORDS = {
  received: (label) => `${label} received`,
  rule: 'The faucet pays each asset once per wallet. Once your wallet has an asset from it, trade for more of it in the wallet.',
}
