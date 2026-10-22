// A site's fill of an interactive maker's order (`dexFillOnchain`, the on-chain room's
// path), through the real provider router with the approval decided as the approval page
// decides it, against a live maker on a private chain anchored to a regtest parent:
// SeqDEX's wallet daemon (oceand) holding the maker's coins and its order-book maker
// (seqob-maker) resting an offer to sell the Sequence token for USDX and co-signing each
// lift over the relay's courier (test/market/maker.mjs).
//
//   honest    the fill settles in a block: the taker gets exactly what the approval
//             showed, at its usual address and in the clear (every output paying the
//             wallet explicit), the maker exactly what its offer asked, and each side's
//             balance moves by that and its fee;
//   market    the site's market order (`placeOrder`, the SeqDEX site's default view)
//             buys 100 tSEQ: the wallet plans it from the book, takes the interactive
//             maker's ask (no covenant order rests here), shows one approval with what
//             is given, got and paid, and fills it in the clear; the trade is listed
//             "sent", then "settled" once the relay calls the fill final;
//   blinded-coins  the wallet holds its USDX only at its blinded address: a fill that
//             receives at the usual address spends coins in the clear only, so it is
//             refused before any approval, saying why;
//   shortpay  the maker pays one atom less than the request asked and keeps it in its
//             own change; the wallet refuses before signing, in words, and nothing moves;
//   blind     the maker blinds the output that pays the wallet to a key of the maker's
//             own; refused the same way.
//
// The hostile modes need a maker built to misbehave: SeqDEX's seqob-maker built from a checkout
// with test/market/hostile-maker.patch applied (`git apply`), which the drive runs with
// SEQOB_HOSTILE set to the mode. The honest mode runs SeqDEX's maker as it ships.
//
//   SEQUENTIAD=… SEQOBD=… OCEAND=… SEQOB_MAKER=… SEQOB_OCTL=… \
//     node test/regtest/interactive-maker.mjs [honest|shortpay|blind] [evidence-dir]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startChain } from '../market/chain.mjs';
import { startBox } from '../market/box.mjs';
import { startInteractiveMaker } from '../market/maker.mjs';

const { SEQUENTIAD, SEQOBD, OCEAND, SEQOB_MAKER, SEQOB_OCTL } = process.env;
if (!SEQUENTIAD || !SEQOBD || !OCEAND || !SEQOB_MAKER || !SEQOB_OCTL) { console.log('SKIP: set SEQUENTIAD, SEQOBD, OCEAND, SEQOB_MAKER and SEQOB_OCTL'); process.exit(0); }
const MODE = process.argv[2] || 'honest';
if (!['honest', 'market', 'shortpay', 'blind', 'blinded-coins'].includes(MODE)) throw new Error('mode: honest | market | shortpay | blind | blinded-coins');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = process.argv[3] || null;
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-interactive-maker-'));
const ORIGIN = 'https://sequentiatestnet.com';
// A public test phrase, never funded anywhere but a local chain.
const TAKER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COIN = 100000000n;
const lines = [];
const say = (s) => { console.log(`[interactive-maker ${MODE}] ` + s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chain = null, box = null, maker = null, failed = false;
try {
  chain = await startChain({ sequentiad: SEQUENTIAD, seqobd: SEQOBD, work: WORK, log: say, nodeArgs: ['-blockfilterindex=1'] });
  const SEQ = chain.policy, Y = chain.Y;
  // The maker sells 1,000 of the Sequence token for 370 USDX: 0.37 USDX each.
  maker = await startInteractiveMaker({ chain, oceand: OCEAND, seqobMaker: SEQOB_MAKER, seqobOctl: SEQOB_OCTL, work: WORK,
    give: { asset: SEQ, atoms: 1000n * COIN }, want: { asset: Y, atoms: 370n * COIN }, fund: [{ asset: Y, amount: 1 }],
    env: ['shortpay', 'blind'].includes(MODE) ? { SEQOB_HOSTILE: MODE } : {}, log: say });
  box = await startBox({ esplora: chain.shim.url, relay: chain.relay, rpc: chain.rpc, site: null,
    assets: { [SEQ]: ['tSEQ', 'Sequence (test)', 8], [Y]: ['USDX', 'Dollar (test)', 8] }, prices: { USDX: 1, tSEQ: 0.37, tBTC: 84200 } });
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
  const ui = globalThis.__sw.ui;
  await perms.grant(ORIGIN);
  const ask = (m, p) => router.handleDappRequest(ORIGIN, m, p);

  await vault.vaultCreate(TAKER, 'regtest-only');
  await engine.ensureOpen();
  await Promise.allSettled([A.loadRegistry(), A.loadPrices(), A.fetchFeeRates()]);
  const takerAddr = engine.currentAddress(false).address;
  await chain.fund(MODE === 'blinded-coins' ? engine.currentAddress(true).address : takerAddr, Y, 1000);
  await chain.mine(1);
  await engine.sync();
  const bal = (h) => BigInt(engine.availableFor(h));
  say(`taker ${takerAddr} holds ${bal(Y)} USDX atoms and ${bal(SEQ)} tSEQ atoms`);

  // The offer as the relay serves it.
  const offer = maker.offer;
  const take = 100n * COIN;   // 100 tSEQ of the 1,000 on offer
  const m0 = await maker.balance(), y0 = bal(Y), s0 = bal(SEQ);

  if (MODE === 'blinded-coins') {
    const before = opened.length;
    await assert.rejects(ask('dexFillOnchain', { base: SEQ, quote: Y, offerId: offer.offer_id, takeBase: String(take) }), (e) => {
      say('refused before any approval: ' + e.message);
      assert.match(e.message, /receives at your usual address and so spends coins held in the clear, and 1000 of your USDX is held at a blinded address: 0 USDX in the clear of the 37\.00003 needed/);
      return true;
    });
    assert.equal(opened.length, before, 'no approval opened');
    assert.equal(bal(SEQ) - s0, 0n); assert.equal(y0 - bal(Y), 0n);
    throw Object.assign(new Error('done'), { done: true });
  }

  if (MODE === 'market') {
    const market = await import(pathToFileURL(path.join(ROOT, 'src/market.js')).href);
    const before = opened.length;
    const pending = ask('placeOrder', { type: 'market', base: SEQ, quote: Y, side: 'buy', amount: String(take) });
    for (let i = 0; i < 600 && opened.length === before; i++) await sleep(50);
    assert.ok(opened.length > before, 'an approval opened');
    const id = new URL(opened.at(-1)).searchParams.get('id');
    const { approval } = await ui('approval.get', { id });
    const flat = [approval.display.text, ...(approval.display.rows || []).map(([k, v]) => k + ': ' + v), approval.display.detail].join('\n');
    say('approval:\n    ' + flat.replace(/\n/g, '\n    '));
    assert.match(flat, /Buy 100 tSEQ at the best prices on the book/);
    assert.match(flat, /You give: 37 USDX/);
    assert.match(flat, /You get: 100 tSEQ/);
    assert.match(flat, /Fees: 0\.00003 USDX/);
    await ui('approval.decide', { id, approve: true });
    const res = await pending;
    say('result: ' + JSON.stringify(res));
    assert.equal(res.filled, 1, 'one order taken');
    let mine = await ask('getOrders', {});
    const tr = mine.trades.find((t) => t.trade === res.trade);
    const fillTx = tr.fills[0].txid;
    say(`trade ${tr.trade}: ${tr.state}, fill ${fillTx}`);
    assert.equal(tr.state, 'sent');
    await chain.mine(1); await engine.sync();
    const tx = await chain.call('getrawtransaction', [fillTx, true]);
    for (const o of tx.vout) say(`  out ${o.n}: ${o.value != null ? o.value + ' ' + String(o.asset).slice(0, 8) + ' explicit' : 'blinded'} -> ${o.scriptPubKey.address || o.scriptPubKey.type || 'fee'}`);
    assert.ok(tx.vout.every((o) => o.value != null), 'every output of the fill is explicit');
    assert.equal(bal(SEQ) - s0, take, 'the wallet got 100 tSEQ');
    const dY = y0 - bal(Y);
    assert.ok(dY > 37n * COIN && dY < 37n * COIN + COIN / 100n, 'paid 37 USDX and its fee: ' + dY);
    say(`taker: +${bal(SEQ) - s0} tSEQ atoms, -${dY} USDX atoms`);
    let settled = null;
    for (let i = 0; i < 20 && !settled; i++) {
      await chain.bury(1);
      mine = await ask('getOrders', {});
      const t2 = mine.trades.find((t) => t.trade === res.trade);
      if (t2.state === 'settled') settled = t2;
    }
    say(settled ? `trade settled: ${JSON.stringify(settled)}` : 'trade not called settled by the relay: ' + JSON.stringify(mine.trades.find((t) => t.trade === res.trade)));
    say('the relay\'s fills: ' + JSON.stringify((await (await fetch(`${chain.relay}/v1/market/${SEQ}/${Y}/fills`)).json()).fills));
    if (EVIDENCE) fs.copyFileSync(path.join(WORK, 'seqobd.log'), path.join(EVIDENCE, 'extension-interactive-market-seqobd.log'));
    assert.ok(settled, 'the relay calls the fill final');
    if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'extension-interactive-market-tx.json'), JSON.stringify(tx, null, 1));
    throw Object.assign(new Error('done'), { done: true });
  }

  // The approval, read as the page reads it, approved.
  const before = opened.length;
  const pending = ask('dexFillOnchain', { base: SEQ, quote: Y, offerId: offer.offer_id, takeBase: String(take) });
  for (let i = 0; i < 400 && opened.length === before; i++) await sleep(50);
  assert.ok(opened.length > before, 'an approval opened');
  const id = new URL(opened.at(-1)).searchParams.get('id');
  const { approval } = await ui('approval.get', { id });
  const flat = [approval.display.text, ...(approval.display.deltas || []).map((d) => `${d.ticker} ${d.atoms}`), approval.display.detail].join('\n');
  say('approval:\n    ' + flat.replace(/\n/g, '\n    '));
  assert.match(flat, /USDX -3700000000/);
  assert.match(flat, /tSEQ 10000000000/);
  await ui('approval.decide', { id, approve: true });

  if (MODE === 'honest') {
    const res = await pending;
    say('result: ' + JSON.stringify(res));
    await chain.mine(1); await engine.sync();
    const tx = await chain.call('getrawtransaction', [res.txid, true]);
    assert.ok(tx.confirmations >= 1, 'the swap is in a block');
    say(`swap ${res.txid} (${tx.vsize} vB) in block ${tx.blockhash.slice(0, 16)}…, ${tx.confirmations} confirmation(s)`);
    for (const o of tx.vout) say(`  out ${o.n}: ${o.value != null ? o.value + ' ' + String(o.asset).slice(0, 8) + ' explicit' : 'blinded (valuecommitment ' + String(o.valuecommitment).slice(0, 10) + '…)'} -> ${o.scriptPubKey.address || o.scriptPubKey.type || 'fee'}`);
    // Every output paying the wallet is at its usual address, in the clear: the receive
    // output (100 tSEQ, at the wallet's address for this swap) and the change beside it.
    const rcv = tx.vout.find((o) => o.asset === SEQ && o.value != null && BigInt(Math.round(o.value * 1e8)) === take);
    assert.ok(rcv, 'the 100 tSEQ are paid in the clear');
    const at = rcv.scriptPubKey.address;
    assert.ok((await chain.call('getaddressinfo', [at])).iswitness, 'a usual (segwit, unblinded) address');
    const mine = tx.vout.filter((o) => o.scriptPubKey && o.scriptPubKey.address === at);
    assert.ok(mine.length >= 2, 'the receive and the change pay the usual address: ' + mine.length);
    assert.ok(mine.every((o) => o.value != null && o.asset), 'every output paying the wallet is explicit');
    const gotClear = mine.filter((o) => o.asset === SEQ).reduce((a, o) => a + BigInt(Math.round(o.value * 1e8)), 0n);
    assert.equal(gotClear, take, 'the 100 tSEQ arrive in the clear');
    if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, `extension-interactive-${MODE}-tx.json`), JSON.stringify(tx, null, 1));
    const dS = bal(SEQ) - s0, dY = y0 - bal(Y);
    say(`taker: +${dS} tSEQ atoms, -${dY} USDX atoms (3700000000 paid plus the network fee in USDX)`);
    assert.equal(dS, take, 'the taker got exactly what it bought');
    assert.ok(dY > 37n * COIN && dY < 37n * COIN + COIN / 100n, 'the taker paid 37 USDX and a small fee: ' + dY);
    let m1;
    for (let i = 0; i < 60; i++) { m1 = await maker.balance(); if ((m1[Y]?.total || 0n) > (m0[Y]?.total || 0n)) break; await sleep(500); }
    const mY = (m1[Y]?.total || 0n) - (m0[Y]?.total || 0n), mS = (m0[SEQ]?.total || 0n) - (m1[SEQ]?.total || 0n);
    say(`maker: +${mY} USDX atoms, -${mS} tSEQ atoms`);
    assert.equal(mY, 37n * COIN, 'the maker got exactly what its offer asked');
    assert.equal(mS, take, 'the maker gave exactly what was taken (the fee came out of the taker\'s USDX)');
  } else {
    let err = null;
    try { const res = await pending; say('result: ' + JSON.stringify(res)); } catch (e) { err = e; }
    await chain.mine(1); await engine.sync();
    const dS = bal(SEQ) - s0, dY = y0 - bal(Y);
    say(`taker after: ${dS >= 0n ? '+' : ''}${dS} tSEQ atoms, -${dY} USDX atoms`);
    assert.ok(err, `the wallet signed the ${MODE} maker's swap: taker +${dS} tSEQ atoms for -${dY} USDX atoms`);
    say('refused: ' + err.message);
    assert.match(err.message, /refusing the maker's swap/);
    assert.match(err.message, MODE === 'shortpay' ? /output 0 pays 9999999999 of [0-9a-f]{64} where this wallet asked for 10000000000/ : /the maker blinded output 0, which this wallet asked to receive explicitly|output 0 is not blinded to this wallet's key/);
    assert.equal(dS, 0n, 'nothing moved: tSEQ');
    assert.equal(dY, 0n, 'nothing moved: USDX');
  }
} catch (e) {
  if (!e?.done) { failed = true; console.error(e); lines.push('FAILED: ' + (e && e.stack || e)); }
} finally {
  if (EVIDENCE) {
    fs.writeFileSync(path.join(EVIDENCE, `extension-interactive-${MODE}.log`), lines.join('\n') + '\n');
    for (const [k, f] of Object.entries(maker?.logs || {})) { try { fs.copyFileSync(f, path.join(EVIDENCE, `extension-interactive-${MODE}-${k}.log`)); } catch {} }
  }
  try { await maker?.stop(); } catch {}
  try { await box?.close(); } catch {}
  try { await chain?.stop(); } catch {}
  fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
