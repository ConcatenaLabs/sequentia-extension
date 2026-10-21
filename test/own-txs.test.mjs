// reapplyUnseen: the page's own broadcasts are put back after a scan only when the scan did
// not return them. The fake wollet keeps unspent outputs the way the kit's applyTransaction
// does: every output of the transaction it is given goes back into the unspent set.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reapplyUnseen, OWN_TX_MAX_AGE_MS } from '../vendor/own-txs.js'

const tx = (id, spends = [], outs = 1) => ({ id, spends, outs, txid: () => ({ toString: () => id }) })

function fakeWollet (held) {
  const txs = new Map(held.map((t) => [t.id, t]))
  const unspent = () => {
    const spent = new Set([...txs.values()].flatMap((t) => t.spends))
    const out = new Set()
    for (const t of txs.values()) for (let i = 0; i < t.outs; i++) if (!spent.has(`${t.id}:${i}`)) out.add(`${t.id}:${i}`)
    return out
  }
  const extra = new Set()
  return {
    applied: [],
    transactions: () => [...txs.values()],
    // As the kit: the given transaction's outputs are unspent from now on, whatever spends them.
    applyTransaction (t) { this.applied.push(t.id); txs.set(t.id, t); for (let i = 0; i < t.outs; i++) extra.add(`${t.id}:${i}`) },
    utxos: () => new Set([...unspent(), ...extra])
  }
}

const byHex = (all) => (hex) => all[hex]

test('a transaction the scan returned is not applied again, so a coin spent since stays spent', () => {
  const send = tx('send', [], 2) // the page's own send: output 1 is its change
  const board = tx('board', ['send:1']) // the leaf wallet's board spends that change
  const w = fakeWollet([send, board])
  assert.deepEqual([...w.utxos()].sort(), ['board:0', 'send:0'])
  const ring = [{ hex: 'send', at: 1000 }]
  const applied = reapplyUnseen(w, ring, byHex({ send }), 2000)
  assert.deepEqual(applied, [])
  assert.deepEqual(w.applied, [])
  assert.ok(!w.utxos().has('send:1'), 'the boarded change is not spendable again')
})

test('the old behaviour, applying it anyway, brings the spent change back (what the guard prevents)', () => {
  const send = tx('send', [], 2)
  const board = tx('board', ['send:1'])
  const w = fakeWollet([send, board])
  w.applyTransaction(send)
  assert.ok(w.utxos().has('send:1'))
})

test('a broadcast the scan has not returned yet is applied again', () => {
  const fresh = tx('fresh', ['old:0'])
  const old = tx('old')
  const w = fakeWollet([old]) // the scan predates the broadcast of `fresh`
  const applied = reapplyUnseen(w, [{ hex: 'fresh', at: 1000 }], byHex({ fresh }), 2000)
  assert.deepEqual(applied, ['fresh'])
  assert.ok(!w.utxos().has('old:0'), 'its input reads as spent')
})

test('entries older than an hour are dropped from the ring and not applied', () => {
  const a = tx('a'), b = tx('b')
  const w = fakeWollet([])
  const now = 10 * OWN_TX_MAX_AGE_MS
  const ring = [{ hex: 'a', at: now - OWN_TX_MAX_AGE_MS - 1 }, { hex: 'b', at: now - 5 }]
  const applied = reapplyUnseen(w, ring, byHex({ a, b }), now)
  assert.deepEqual(applied, ['b'])
  assert.deepEqual(ring.map((e) => e.hex), ['b'])
})

test('one transaction that cannot be read does not stop the others', () => {
  const b = tx('b')
  const w = fakeWollet([])
  const toTx = (hex) => { if (hex === 'bad') throw new Error('HexToBytes'); return b }
  assert.deepEqual(reapplyUnseen(w, [{ hex: 'bad', at: 5 }, { hex: 'b', at: 5 }], toTx, 10), ['b'])
})
