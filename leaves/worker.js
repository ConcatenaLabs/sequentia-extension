// The leaf wallet's dedicated worker.
//
// It runs the operator wallet library (the same library the operator's command-line
// wallet runs, compiled to wasm: ./pkg, built from the operator repository's
// `wallet-wasm/`) and nothing else. The library is blocking: every request it makes to
// its node and to the operator is a synchronous XMLHttpRequest, which only a worker may
// block on, so the page never freezes while a sync waits on the network.
//
// Its store is SQLite on the origin's private file system (OPFS), installed before any
// wallet is opened. SQLite commits each write to disk before the next statement, so
// what the library writes before it broadcasts or hands anything over survives a
// closed tab. The storage admits one worker at a time: a second tab is refused at
// install, which keeps one wallet running per browser.
//
// Messages, one at a time, in order: { id, op, args } with op
//   'exists' { mnemonic }                 -> whether this browser holds that wallet
//   'create' { mnemonic, config }         -> creates it; answers its `info`
//   'open'   { mnemonic, nodePassword? }  -> opens it
//   'run'    { command, args }            -> { result, start }, as the library answers
//   'close'                               -> drops the open wallet
//   'pause'  { url }                      -> where the library's pauses wait (below)
//   'wait'   { ms }                       -> one pause, as the library makes it (to check the wait)
// Answer: { id, ok: true, value } or { id, ok: false, error: { kind, message, code?, status? } }.
// A refusal is the library's own JSON, so the page shows it in the library's own words.
//
// The library pauses between two tries (a node route that answers "slow down", an operator
// that does not answer), and a worker blocked in it can only wait by blocking. Left to itself
// the library watches the clock, a processor core busy for the whole pause. So this worker gives
// it a wait of its own (`setPause`): a synchronous request to a path of the page's own site that
// holds it open for the pause and then answers (the node route's /hold, named by the page with
// 'pause'), which costs the browser nothing. A site without that path answers otherwise, and
// from then on the library waits on the clock as before.

import init, * as leaf from './pkg/leaf_wallet.js'
import { holdThrough } from './hold.js'

const { installStore, ArcaWallet, arcaWalletExists } = leaf

const STORE_DIR = '.leaf-wallet'
let wallet = null
let ready = null
let broken = null   // a wasm panic leaves the module unusable until the worker is replaced
let chain = Promise.resolve()
const site = { url: null }   // the site's hold, from the page ('pause'); null: the clock

// Blocks this worker for up to `ms` through the site's hold (leaves/hold.js). Returns early when
// the hold is refused, absent or broken; the library then waits out the rest on the clock.
const hold = (ms) => holdThrough(site, ms)

function errorOf (e) {
  if (typeof e === 'string') {
    try {
      const j = JSON.parse(e)
      // The refusal, with what the command cost before it when the library says.
      if (j && j.error) return j.cost ? { ...j.error, cost: j.cost } : j.error
    } catch {}
    return { kind: 'error', message: e }
  }
  if (e instanceof WebAssembly.RuntimeError) {
    broken = 'the wallet library stopped (' + e.message + '); reload the page to start it again'
    return { kind: 'panic', message: broken }
  }
  return { kind: 'error', message: (e && e.message) ? e.message : String(e) }
}

async function handle (op, args) {
  if (broken) throw broken
  if (!ready) ready = (async () => { await init(); await installStore(STORE_DIR); if (typeof leaf.setPause === 'function') leaf.setPause(hold) })()
  await ready
  switch (op) {
    case 'exists':
      return arcaWalletExists(args.mnemonic)
    case 'create':
      if (wallet) { wallet.free(); wallet = null }
      wallet = ArcaWallet.create(args.mnemonic, JSON.stringify(args.config || {}))
      return JSON.parse(wallet.run('info', '{}'))
    case 'open':
      if (wallet) { wallet.free(); wallet = null }
      wallet = ArcaWallet.open(args.mnemonic, args.nodePassword || undefined)
      return true
    case 'run':
      if (!wallet) throw JSON.stringify({ error: { kind: 'refused', message: 'no wallet is open' } })
      return JSON.parse(wallet.run(String(args.command), JSON.stringify(args.args || {})))
    case 'close':
      if (wallet) { wallet.free(); wallet = null }
      return true
    case 'pause':
      site.url = typeof args.url === 'string' && args.url ? args.url : null
      return true
    case 'wait':
      if (typeof leaf.pause !== 'function') throw JSON.stringify({ error: { kind: 'refused', message: 'this library has no pause' } })
      leaf.pause(Math.max(0, Math.min(60000, Number(args.ms) || 0)))
      return true
    default:
      throw JSON.stringify({ error: { kind: 'refused', message: 'no operation ' + op } })
  }
}

self.onmessage = (ev) => {
  const { id, op, args } = ev.data || {}
  chain = chain.then(async () => {
    try {
      const value = await handle(op, args || {})
      self.postMessage({ id, ok: true, value })
    } catch (e) {
      self.postMessage({ id, ok: false, error: errorOf(e) })
    }
  })
}
