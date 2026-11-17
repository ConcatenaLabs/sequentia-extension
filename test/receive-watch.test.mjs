// receive-watch.js: what Receive says about a payment coming in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeReceiveWatch } from '../vendor/receive-watch.js'

const USDX = 'aa'.repeat(32), ORNG = 'bb'.repeat(32)

test('a payment arriving, then counted: "arriving", then received for its amount', () => {
  const w = makeReceiveWatch()
  assert.equal(w.start({ BTC: { settled: 0 }, [USDX]: { settled: 1000 } }), null)
  assert.deepEqual(w.update({ BTC: { settled: 0 }, [USDX]: { settled: 1000, arriving: 2500 } }), { kind: 'arriving', asset: USDX })
  assert.deepEqual(w.update({ BTC: { settled: 0 }, [USDX]: { settled: 3500 } }), { kind: 'received', asset: USDX, atoms: 2500n })
  // Nothing new: the last word stays.
  assert.deepEqual(w.update({ BTC: { settled: 0 }, [USDX]: { settled: 3500 } }), { kind: 'received', asset: USDX, atoms: 2500n })
})

test('a payment counted at once, in an asset the wallet did not hold: received', () => {
  const w = makeReceiveWatch()
  w.start({ BTC: { settled: 0 } })
  assert.deepEqual(w.update({ BTC: { settled: 0 }, [ORNG]: { settled: 7 } }), { kind: 'received', asset: ORNG, atoms: 7n })
  // A second payment is reported for its own amount.
  assert.deepEqual(w.update({ BTC: { settled: 50000 }, [ORNG]: { settled: 7 } }), { kind: 'received', asset: 'BTC', atoms: 50000n })
})

test('a move of the wallet\'s own, and a trade, say nothing', () => {
  const w = makeReceiveWatch()
  w.start({ [USDX]: { settled: 1000 }, BTC: { settled: 100 } })
  // Taken from the chain into the tree: counted as arriving while it settles, the total unchanged.
  assert.equal(w.update({ [USDX]: { settled: 0, arriving: 1000 }, BTC: { settled: 100 } }), null)
  assert.equal(w.update({ [USDX]: { settled: 1000 }, BTC: { settled: 100 } }), null)
  // A trade: one asset down, another up.
  assert.equal(w.update({ [USDX]: { settled: 400 }, BTC: { settled: 160 } }), null)
  assert.equal(w.update({ [USDX]: { settled: 400 }, BTC: { settled: 160 } }), null)
})

test('a payment out, then a payment in: the payment in is seen whole', () => {
  const w = makeReceiveWatch()
  w.start({ [USDX]: { settled: 1000 } })
  assert.equal(w.update({ [USDX]: { settled: 600 } }), null)
  assert.deepEqual(w.update({ [USDX]: { settled: 900 } }), { kind: 'received', asset: USDX, atoms: 300n })
})

test('not watching (Receive closed): nothing is said; opening again starts afresh', () => {
  const w = makeReceiveWatch()
  assert.equal(w.update({ [USDX]: { settled: 5 } }), null)
  w.start({ [USDX]: { settled: 5 } })
  w.update({ [USDX]: { settled: 9 } })
  w.stop()
  assert.equal(w.watching(), false)
  assert.equal(w.start({ [USDX]: { settled: 9 } }), null)
  assert.equal(w.state(), null)
})

test('coins of the wallet\'s own coming home say nothing: only value it did not hold is received', () => {
  // The change of a payment sent before Receive opened, on its way, then counted.
  let w = makeReceiveWatch()
  w.start({ [USDX]: { settled: 0, arriving: 890 } })
  assert.equal(w.update({ [USDX]: { settled: 890 } }), null)
  // A move of its own with a fee in the asset: down, on its way, then counted.
  w = makeReceiveWatch()
  w.start({ [USDX]: { settled: 1000 } })
  assert.equal(w.update({ [USDX]: { settled: 0, arriving: 990 } }), null)
  assert.equal(w.update({ [USDX]: { settled: 990 } }), null)
  // A payment that lands while coins of its own come home: only the payment.
  assert.deepEqual(w.update({ [USDX]: { settled: 990, arriving: 300 } }), { kind: 'arriving', asset: USDX })
  assert.deepEqual(w.update({ [USDX]: { settled: 1290 } }), { kind: 'received', asset: USDX, atoms: 300n })
  w = makeReceiveWatch()
  w.start({ [USDX]: { settled: 0, arriving: 500 } })
  assert.deepEqual(w.update({ [USDX]: { settled: 700 } }), { kind: 'received', asset: USDX, atoms: 200n })
})
