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
// Answer: { id, ok: true, value } or { id, ok: false, error: { kind, message, code?, status? } }.
// A refusal is the library's own JSON, so the page shows it in the library's own words.

import init, { installStore, ArcaWallet, arcaWalletExists } from './pkg/leaf_wallet.js'

const STORE_DIR = '.leaf-wallet'
let wallet = null
let ready = null
let broken = null   // a wasm panic leaves the module unusable until the worker is replaced
let chain = Promise.resolve()

function errorOf (e) {
  if (typeof e === 'string') {
    try {
      const j = JSON.parse(e)
      if (j && j.error) return j.error
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
  if (!ready) ready = (async () => { await init(); await installStore(STORE_DIR) })()
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
