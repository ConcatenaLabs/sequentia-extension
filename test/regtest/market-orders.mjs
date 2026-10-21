// A site's market and limit orders (`placeOrder`, `getOrders`, `cancelOrder`) on a
// private chain anchored to a regtest parent, through the real provider router with the
// approvals decided as the approval page decides them, against a local on-chain relay
// that watches the chain:
//
//  - a maker places a limit order to sell that nothing on the book crosses: its approval
//    shows what is given, got and paid, each in the reference currency; the order is
//    funded, listed once its funding is in a block, and shown open;
//  - a taker's market order fills part of it: one transaction pays the maker on the
//    chain and the taker in the same transaction; the taker's trade is "sent" until the
//    relay calls the fill final, then "settled";
//  - the taker's limit order fills the rest; the maker's order is filled, its credits
//    count in the maker's figure and move into its own coins;
//  - an order that rests cannot be taken back before its time (the words say when);
//    after it, it is taken back and its coins return;
//  - refused before any approval: a trade against BTC the wallet cannot settle, a
//    market order with nothing on the book, a limit order with no price.
//
//   SEQUENTIAD=/path/to/sequentiad SEQOBD=/path/to/seqobd node test/regtest/market-orders.mjs [evidence-dir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startChain } from '../market/chain.mjs';
import { startBox } from '../market/box.mjs';

const EXE = process.env.SEQUENTIAD, SEQOBD = process.env.SEQOBD;
if (!EXE || !SEQOBD) { console.log('SKIP: set SEQUENTIAD and SEQOBD'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = process.argv[2] || null;
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-market-orders-'));
const ORIGIN = 'https://sequentiatestnet.com';
// Public test phrases, never funded anywhere but a local chain.
const MAKER = 'exist carry drive collect lend cereal occur much tiger just involve mean';
const TAKER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COIN = 100000000n;
const lines = [];
const say = (s) => { console.log('[market-orders] ' + s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chain = null, box = null, failed = false;
try {
  chain = await startChain({ sequentiad: EXE, seqobd: SEQOBD, work: WORK, log: say });
  const { X, Y } = chain;
  box = await startBox({ esplora: chain.shim.url, relay: chain.relay, rpc: chain.rpc, site: null,
    assets: { [X]: ['GOLD', 'Gold (test)', 8], [Y]: ['USDX', 'Dollar (test)', 8] }, prices: { GOLD: 4146, USDX: 1, SEQ: 0.37, tBTC: 84200 } });
  register(pathToFileURL(path.join(ROOT, 'test/regtest/loader.mjs')).href, { data: { base: box.url, t4: 'http://127.0.0.1:9/', policyAsset: chain.policy, genesis: chain.genesis, recordsV2Height: null } });
  await import(pathToFileURL(path.join(ROOT, 'test/regtest/sw-stubs.mjs')).href);
  const opened = [];
  globalThis.chrome.tabs.create = async ({ url }) => { opened.push(url); };
  const lwk = await import(pathToFileURL(path.join(ROOT, 'pkg/lwk_wasm.js')).href);
  lwk.initSync({ module: fs.readFileSync(path.join(ROOT, 'pkg/lwk_wasm_bg.wasm')) });
  const engine = await import(pathToFileURL(path.join(ROOT, 'src/engine.js')).href);
  await import(pathToFileURL(path.join(ROOT, 'background.js')).href);
  const router = await import(pathToFileURL(path.join(ROOT, 'src/provider-router.js')).href);
  const perms = await import(pathToFileURL(path.join(ROOT, 'src/permissions.js')).href);
  const vault = await import(pathToFileURL(path.join(ROOT, 'src/vault.js')).href);
  const A = await import(pathToFileURL(path.join(ROOT, 'src/assets.js')).href);
  const market = await import(pathToFileURL(path.join(ROOT, 'src/market.js')).href);
  const ui = globalThis.__sw.ui;
  await perms.grant(ORIGIN);
  const ask = (m, p) => router.handleDappRequest(ORIGIN, m, p);

  // One worker holds one wallet at a time: a scan still running for the last one is
  // let finish before the next opens (two browser profiles need no such care).
  async function use(phrase) {
    if (engine.isOpen()) { await engine.sync().catch(() => {}); await market.progressOrders().catch(() => {}); }
    engine.closeWallet();
    await vault.vaultCreate(phrase, 'regtest-only');
    await engine.ensureOpen();
    await Promise.allSettled([A.loadRegistry(), A.loadPrices(), A.fetchFeeRates()]);
    await engine.sync();
  }
  // Asks, reads the approval as the page reads it, decides it.
  async function approve(method, params, expect = [], approveIt = true) {
    const before = opened.length;
    const pending = ask(method, params);
    for (let i = 0; i < 400 && opened.length === before; i++) await sleep(50);
    if (opened.length === before) return pending;   // refused before any approval: rethrows
    const id = new URL(opened.at(-1)).searchParams.get('id');
    const { approval } = await ui('approval.get', { id });
    const flat = [approval.display.text, ...(approval.display.rows || []).map(([k, v]) => k + ': ' + v), approval.display.detail].join('\n');
    for (const re of expect) assert.match(flat, re, flat);
    say(`approval "${approval.method}":\n    ` + flat.replace(/\n/g, '\n    '));
    await ui('approval.decide', { id, approve: approveIt });
    return pending;
  }
  async function refused(label, method, params, want) {
    const before = opened.length;
    await assert.rejects(ask(method, params), (e) => { assert.match(e.message, want); say(`${label}: refused before any approval: ${e.message}`); return true; });
    assert.equal(opened.length, before, label + ': no approval opened');
  }
  const bal = (h) => BigInt(engine.availableFor(h));
  const figure = async (h) => BigInt((await engine.balances()).seq[h] || 0);

  // ---- the two wallets ----
  await use(MAKER);
  const makerAddr = engine.currentAddress(false).address;
  await use(TAKER);
  const takerAddr = engine.currentAddress(false).address;
  await chain.fund(makerAddr, X, 2); await chain.fund(takerAddr, Y, 20000); await chain.fund(takerAddr, X, 1);
  await chain.mine(1);
  say(`maker ${makerAddr} holds 2 GOLD; taker ${takerAddr} holds 20000 USDX and 1 GOLD`);

  // ---- refusals before any approval ----
  await use(TAKER);
  await refused('a market order with nothing on the book', 'placeOrder', { type: 'market', base: X, quote: Y, side: 'buy', amount: String(COIN / 10n) }, /nothing on the book can be traded/);
  await refused('a limit order with no price', 'placeOrder', { type: 'limit', base: X, quote: Y, side: 'buy', amount: String(COIN / 10n) }, /price .* is required/);
  await refused('a trade against BTC this wallet cannot settle', 'placeOrder', { type: 'market', base: X, quote: 'BTC', side: 'buy', amount: String(COIN / 10n) }, /nothing on the book can be traded at this market right now/);

  // ---- the maker's limit order rests ----
  await use(MAKER);
  const price = 4146n * COIN;
  const placed = await approve('placeOrder', { type: 'limit', base: X, quote: Y, side: 'sell', amount: String(COIN / 2n), price: String(price) },
    [/Place an order on the book to sell 0\.5 GOLD at your price/, /You give: 0\.5 GOLD \(≈ 2,073 USD\)/, /You get: up to 2073 USDX \(≈ 2,073 USD\)/, /Fees: 0\.0000\d+ GOLD/, /Your order: Sell 0\.5 GOLD at 4,146|Your order: Sell 0\.5 GOLD at 4146/, /taken back/]);
  assert.ok(placed.order, 'the order was placed: ' + JSON.stringify(placed));
  say('placed: ' + JSON.stringify(placed));
  let mine = await ask('getOrders', {});
  assert.ok(['placing', 'open'].includes(mine.orders[0].state), mine.orders[0].state);
  say('maker order before its funding is in a block: ' + mine.orders[0].state);
  await chain.mine(1);
  await market.progressOrders();
  mine = await ask('getOrders', {});
  assert.equal(mine.orders[0].state, 'open', JSON.stringify(mine.orders[0]));
  say('maker order: ' + JSON.stringify(mine.orders[0]));
  const book = await (await fetch(`${chain.relay}/v1/market/${X}/${Y}/orderbook`)).json();
  assert.equal(book.offers.length, 1);
  assert.equal(book.offers[0].offer_amount, String(COIN / 2n));
  say(`the relay lists it: offer ${book.offers[0].offer_id} holding ${book.offers[0].offer_amount} at ${book.offers[0].covenant.covenant_txid}:${book.offers[0].covenant.covenant_vout}`);
  await refused('taking an order back before its time', 'cancelOrder', { order: placed.order }, /can be taken back from .* UTC; until then it stays on the book/);

  // ---- the taker's market order ----
  await use(TAKER);
  // The page polls the wallet while it trades, as the site does.
  let polling = false, poller = null;
  const startPolling = () => { polling = true; poller = (async () => { while (polling) { await ask('getBalances', {}).catch(() => {}); await ask('getOrders', {}).catch(() => {}); await sleep(700); } })(); };
  const stopPolling = async () => { polling = false; await poller; };
  startPolling();
  const y0 = bal(Y), x0 = bal(X);
  const t1 = await approve('placeOrder', { type: 'market', base: X, quote: Y, side: 'buy', amount: String(COIN / 5n) },
    [/Buy 0\.2 GOLD at the best prices on the book/, /You give: 829\.2 USDX \(≈ 829\.2 USD\)/, /You get: 0\.2 GOLD \(≈ 829\.2 USD\)/, /Fees: .* USDX/]);
  assert.equal(t1.filled, 1, JSON.stringify(t1));
  let tr = await ask('getOrders', {});
  const fillTx = tr.trades[0].fills[0].txid;
  assert.equal(tr.trades[0].state, 'sent');
  const raw = await chain.call('getrawtransaction', [fillTx, true]);
  say(`market order filled by ${fillTx} (${raw.vsize} vB): out 0 ${raw.vout[0].value} ${raw.vout[0].asset.slice(0, 8)} to the maker, out 1 ${raw.vout[1].value} ${raw.vout[1].asset.slice(0, 8)} rests again`);
  await chain.mine(1);
  await engine.sync();
  assert.equal(bal(X) - x0, COIN / 5n, 'the taker got 0.2 GOLD');
  say(`taker: +${bal(X) - x0} GOLD atoms, -${y0 - bal(Y)} USDX atoms`);
  for (let i = 0; i < 20; i++) { tr = await ask('getOrders', {}); if (tr.trades[0].state === 'settled') break; await chain.bury(1); await sleep(1500); }
  assert.equal(tr.trades[0].state, 'settled', JSON.stringify(tr.trades[0]));
  say('taker trade, once the relay calls the fill final: ' + JSON.stringify(tr.trades[0]));

  // ---- the maker sees its order partly filled ----
  await stopPolling();
  await use(MAKER);
  mine = await ask('getOrders', {});
  assert.equal(mine.orders[0].filled, String(COIN / 5n));
  assert.equal(mine.orders[0].state, 'open');
  say('maker order after the fill: ' + JSON.stringify({ state: mine.orders[0].state, filled: mine.orders[0].filled, holds: mine.orders[0].holds, fills: mine.orders[0].fills }));

  // ---- the taker's limit order fills the rest ----
  await use(TAKER);
  startPolling();
  const t2 = await approve('placeOrder', { type: 'limit', base: X, quote: Y, side: 'buy', amount: String(3n * COIN / 10n), price: String(price) },
    [/Buy 0\.3 GOLD now at your price or better\./, /You give: 1243\.8 USDX/, /You get: 0\.3 GOLD/]);
  assert.equal(t2.filled, 1); assert.equal(t2.order, null);
  await chain.mine(1);
  for (let i = 0; i < 20; i++) { tr = await ask('getOrders', {}); if (tr.trades.every((t) => t.state === 'settled')) break; await chain.bury(1); await sleep(1500); }
  assert.ok(tr.trades.every((t) => t.state === 'settled'), JSON.stringify(tr.trades));

  // ---- a buy that crosses nothing rests: the order sells the quote ----
  const t3 = await approve('placeOrder', { type: 'limit', base: X, quote: Y, side: 'buy', amount: String(COIN / 10n), price: String(4000n * COIN) },
    [/Place an order on the book to buy 0\.1 GOLD at your price/, /You give: 400 USDX/]);
  assert.ok(t3.order, JSON.stringify(t3));
  await chain.mine(1); await market.progressOrders();
  const rev = await (await fetch(`${chain.relay}/v1/market/${Y}/${X}/orderbook`)).json();
  assert.equal(rev.offers.length, 1);
  say(`the taker's buy rests on the reversed market: it sells ${rev.offers[0].offer_amount} USDX atoms for GOLD at ${rev.offers[0].covenant.rate_num}/${rev.offers[0].covenant.rate_den}`);

  await stopPolling();

  // ---- the maker: filled, its credits counted and moved into its own coins ----
  await use(MAKER);
  mine = await ask('getOrders', {});
  assert.equal(mine.orders[0].state, 'filled', JSON.stringify(mine.orders[0]));
  assert.equal(mine.orders[0].filled, String(COIN / 2n));
  say('maker order: ' + JSON.stringify({ state: mine.orders[0].state, filled: mine.orders[0].filled, settled: mine.orders[0].settled, fills: mine.orders[0].fills.length }));
  engine.watchCredits(true); await engine.sync();
  // The credits count in the maker's figure whether or not they have moved yet (a move
  // costs a small fee in USDX).
  assert.ok(await figure(Y) > 2073n * COIN - 10000n && await figure(Y) <= 2073n * COIN, 'the credits count in the maker\'s USDX figure: ' + await figure(Y));
  say(`maker USDX figure ${await figure(Y)} (credits), its own coins ${bal(Y)}`);
  await market.progressOrders();
  await chain.mine(1); await engine.sync();
  assert.ok(bal(Y) > 2072n * COIN, 'the credits moved into the maker\'s own coins: ' + bal(Y));
  say(`after the move: maker's own USDX coins ${bal(Y)}`);

  // ---- an order taken back after its time ----
  const p2 = await approve('placeOrder', { type: 'limit', base: X, quote: Y, side: 'sell', amount: String(COIN / 10n), price: String(5000n * COIN) }, [/Place an order on the book to sell 0\.1 GOLD/]);
  await chain.mine(1); await market.progressOrders();
  mine = await ask('getOrders', {});
  const o2 = mine.orders.find((o) => o.order === p2.order);
  assert.equal(o2.state, 'open'); assert.equal(o2.can_take_back, false);
  await chain.advance(86400 + 600);
  mine = await ask('getOrders', {});
  assert.equal(mine.orders.find((o) => o.order === p2.order).can_take_back, true);
  await engine.sync(); const x1 = bal(X);
  const back = await approve('cancelOrder', { order: p2.order }, [/Take back what is left of your order: 0\.1 GOLD/, /You get back: 0\.0999\d+ GOLD/]);
  await chain.mine(1); await engine.sync();
  const rt = await chain.call('getrawtransaction', [back.txid, true]);
  say(`take-back ${back.txid}: ${rt.confirmations} confirmations, outputs ${JSON.stringify(rt.vout.map((o) => [o.value, (o.asset || '').slice(0, 8), o.scriptPubKey.address || o.scriptPubKey.type]))}`);
  const owned = engine.getWollet().utxos().filter((u) => u.outpoint().txid().toString() === back.txid).length;
  say(`the wallet holds ${owned} output(s) of the take-back; addr check ${JSON.stringify(await chain.call('getaddressinfo', [rt.vout[0].scriptPubKey.address]).catch((e) => e.message))}`.slice(0, 300));
  assert.ok(bal(X) - x1 > COIN / 10n - 100000n, 'the coins came back: ' + (bal(X) - x1));
  mine = await ask('getOrders', {});
  assert.equal(mine.orders.find((o) => o.order === p2.order).state, 'withdrawn');
  say(`taken back by ${back.txid}: +${bal(X) - x1} GOLD atoms`);
  await refused('taking it back twice', 'cancelOrder', { order: p2.order }, /taken back already/);
} catch (e) {
  failed = true; console.error(e);
} finally {
  if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'extension-market-orders.log'), lines.join('\n') + '\n');
  try { await box?.close(); } catch {}
  try { await chain?.stop(); } catch {}
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
