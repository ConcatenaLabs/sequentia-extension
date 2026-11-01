// leaves/pkg is the operator repository CI's leaf-wallet-pkg artifact, copied exactly
// (scripts/fetch-leaf-wallet.sh): its files match the SHA256SUMS it carries, and BUILT_FROM names
// the arca commit it was built from, so the wasm a release serves is traced by its sha256.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const dir = new URL('../leaves/pkg/', import.meta.url)
test('leaves/pkg matches the SHA256SUMS of the CI artifact it came from', () => {
  const sums = readFileSync(new URL('SHA256SUMS', dir), 'utf8').trim().split('\n').map((l) => l.split(/\s+/))
  assert.deepEqual(sums.map((s) => s[1]).sort(), ['leaf_wallet.d.ts', 'leaf_wallet.js', 'leaf_wallet_bg.wasm'])
  for (const [sum, f] of sums) assert.equal(createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex'), sum, f)
  assert.match(readFileSync(new URL('BUILT_FROM', dir), 'utf8').trim(), /^[0-9a-f]{40}$/)
  assert.deepEqual(readdirSync(dir).sort(), ['BUILT_FROM', 'SHA256SUMS', 'leaf_wallet.d.ts', 'leaf_wallet.js', 'leaf_wallet_bg.wasm'])
})
