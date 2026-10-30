// The Bitcoin ark wallet's dedicated worker.
//
// It runs Bark's wallet on Bitcoin, compiled to wasm (./pkg, built from the operator
// repository's `bark-wasm/`), and nothing else. The wallet keeps its store in IndexedDB,
// reaches its ark server over gRPC-web and reads the chain from an Esplora server; its
// daemon runs here for as long as the page is open: it claims Lightning payments the
// server holds for the wallet, takes in payments sent to it in the ark, follows its boards
// to the chain. When the page asks (btc-ark.js renewDue: at open and after each sync) it schedules
// with the server a renewal of each coin that the server runs by itself shortly before the coin's
// expiry, page open or not (`schedule_refreshes`), and renews in the server's next round a coin
// that is due and has none scheduled (`refresh`).
//
// Messages, one at a time, in order: { id, op, args } with op
//   'open' { network, mnemonic, server, esplora, log? } -> opens (or creates) the wallet
//   'run'  { command, args }                            -> the wallet's answer (JSON)
//   'close'                                             -> stops the wallet
// Answer: { id, ok: true, value } or { id, ok: false, error: { message } }, the error in
// the wallet's own words.

import init, { BtcArk, setLogLevel } from './pkg/bark_wasm.js'

let wallet = null
let ready = null
let broken = null   // a wasm panic leaves the module unusable until the worker is replaced
let chain = Promise.resolve()

function errorOf (e) {
  if (e instanceof WebAssembly.RuntimeError) {
    broken = 'the wallet stopped (' + e.message + '); reload the page to start it again'
    return { message: broken }
  }
  return { message: typeof e === 'string' ? e : (e && e.message) ? e.message : String(e) }
}

async function handle (op, args) {
  if (broken) throw broken
  if (!ready) ready = init()
  await ready
  switch (op) {
    case 'open':
      setLogLevel(args.log || 'warn')
      if (wallet) { wallet.close(); wallet.free(); wallet = null }
      wallet = await BtcArk.open(String(args.network), String(args.mnemonic), String(args.server), String(args.esplora))
      return true
    case 'run':
      if (!wallet) throw 'no wallet is open'
      return JSON.parse(await wallet.run(String(args.command), JSON.stringify(args.args || {})))
    case 'close':
      if (wallet) { wallet.close(); wallet.free(); wallet = null }
      return true
    default:
      throw 'no operation ' + op
  }
}

self.onmessage = (ev) => {
  const { id, op, args } = ev.data || {}
  chain = chain.then(async () => {
    try {
      self.postMessage({ id, ok: true, value: await handle(op, args || {}) })
    } catch (e) {
      self.postMessage({ id, ok: false, error: errorOf(e) })
    }
  })
}
