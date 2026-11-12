// The id the explorer indexes a script by, for /scripthash/<id>/utxo and /scripthash/<id>/txs:
// the SHA-256 of the scriptPubKey's bytes, in the order SHA-256 gives them.
//
// Electrum's protocol byte-reverses that hash, and so did three callers here once. This explorer
// does not: it answers the reversed form with an empty list, which reads exactly like "nothing
// there" (no coins in the enclave, no delegation, an order that was never funded). The test
// explorer-script-hash.test.mjs pins this function to the testnet explorer's recorded answer
// (tooling/fixtures/explorer-scripthash-answer.json). Every caller of the explorer by a script's
// hash uses this one function; there is no second convention anywhere in the page.
export async function explorerScriptHash (scriptHex) {
  const hex = String(scriptHex || '')
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) throw new Error('not a script: ' + hex.slice(0, 16))
  const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}
