// The extension finds, counts, unbonds and withdraws the stakes of its key under
// both locks a Sequentia wallet bonds with, against a private sequentiad chain,
// through the service worker's own message handlers.
//
//   SEQUENTIAD=/path/to/sequentiad node test/regtest/stake-unbond.mjs
//
// Two stakes are bonded to the wallet's staking key (m/2/0) with the kit, as the
// web wallet and Ambra bond them: one under the height lock of 43,200 blocks, one
// under the time lock of 2,532 units of 512 seconds. Then, through the worker:
//   * both are listed (`stakes`), bonded, and counted in the Sequence token's figure;
//   * an unbond before either lock has passed is refused by the wallet before any
//     review, and the same unbond built anyway is refused by the node;
//   * the chain's clock moves 16 days on and 43,200 blocks are produced: both are
//     unbonded, each through its review (`stakeUnbondReview`, `stakeStepConfirm`),
//     the fee out of the stake;
//   * a withdrawal before the unbonding depth is refused by the wallet, and by the
//     node when built anyway;
//   * once the parent chain has moved the depth on, both are withdrawn into the
//     wallet, and the stakes are no longer listed.
//
// Every transaction is checked into a block. Nodes and data live in REGTEST_DIR
// (default: a fresh directory under the system temporary directory) and are
// removed at the end unless KEEP=1.
//
// Not part of `node --test 'test/*.test.mjs'`: it needs a sequentiad binary.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rpcCall, startEsploraShim } from './esplora-shim.mjs';

const EXE = process.env.SEQUENTIAD;
if (!EXE) { console.log('SKIP: set SEQUENTIAD to a sequentiad binary'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = process.env.REGTEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ext-stake-unbond-'));
fs.mkdirSync(WORK, { recursive: true });

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COIN = 100_000_000;
const UNBONDING = 5;          // the chain's shortest lock, in blocks: both locks below are longer
const DEPTH = 3;              // parent blocks an unbonding output waits before its withdrawal
const HEIGHT_CSV = 43200;
const TIME_CSV = (1 << 22) | 2532;
const PARENT_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

const log = (...a) => console.log('[stake-unbond]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---- nodes -----------------------------------------------------------------
const children = [];
process.on('exit', () => { for (const c of children) if (c.exitCode == null) c.kill('SIGTERM'); });
async function startNode(name, args, rpcPort) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(EXE, [
    `-datadir=${dir}`, `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
    '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-disablewallet', '-txindex=1', ...args,
  ], { stdio: 'ignore' });
  children.push(child);
  log(name, 'pid', child.pid);
  const rpc = { url: `http://127.0.0.1:${rpcPort}/`, auth: 'u:p' };
  for (let i = 0; ; i++) {
    try { await rpcCall(rpc, 'getblockcount'); break; } catch (e) {
      if (i > 300) throw new Error(`${name} did not start: ${e.message}`);
      await sleep(200);
    }
  }
  return { rpc, child, call: (m, p) => rpcCall(rpc, m, p) };
}
async function stopNode(n) {
  try { await n.call('stop'); } catch {}
  if (n.child.exitCode == null) await new Promise((r) => n.child.once('exit', r));
}

const producerKey = await (async () => {
  const { secp256k1, btc } = await import(pathToFileURL(path.join(ROOT, 'vendor/btc.js')).href);
  const sk = secp256k1.utils.randomSecretKey();
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { wif: btc.WIF({ wif: 0xef }).encode(sk), pub: hex(secp256k1.getPublicKey(sk, true)) };
})();

const parentPort = await freePort();
const parent = await startNode('parent', ['-chain=regtest'], parentPort);
const parentDescriptor = (await parent.call('getdescriptorinfo', ['raw(51)'])).descriptor;
await parent.call('generatetodescriptor', [5, parentDescriptor]);

const seqArgs = (extra) => [
  '-chain=elementsregtest', '-par=1', '-persistmempool=0',
  '-con_bitcoin_anchor=1', '-validateanchor=1', '-mainchainrpchost=127.0.0.1', `-mainchainrpcport=${parentPort}`,
  '-mainchainrpcuser=u', '-mainchainrpcpassword=p', `-parentgenesisblockhash=${PARENT_GENESIS}`,
  '-con_parent_chain_signblockscript=51', '-anchorpollinterval=1', '-anchorminconf=1',
  '-con_pos=1', '-posvrf=1', '-posslotinterval=1', '-signblockscript=51', '-initialfreecoins=2100000000000000',
  '-anyonecanspendaremine=0', '-con_blocksubsidy=0', '-con_connect_genesis_outputs=1', '-validatepegin=0',
  '-con_default_blinded_addresses=0', `-posunbonding=${UNBONDING}`, `-posunbonddepth=${DEPTH}`, '-pospayoutnotice=3',
  `-staker=${producerKey.pub}:${COIN}`,
  ...extra,
];
const seqPort = await freePort();
let seq = await startNode('sequentia', seqArgs(['-acceptnonstdtxn=1']), seqPort);

/// One block from the mempool. With `parentToo`, anchored to a fresh parent block.
async function produce(parentToo = true) {
  if (parentToo) await parent.call('generatetodescriptor', [1, parentDescriptor]);
  const before = await seq.call('getblockcount');
  let r;
  for (let i = 0; ; i++) {
    try { r = await seq.call('generateposblock', [producerKey.wif]); break; } catch (e) {
      if (i > 50) throw e;
      await sleep(200);   // the anchor watcher has not seen the parent block yet
    }
  }
  const b = await seq.call('getblock', [r.hash, 1]);
  assert.equal(b.height, before + 1);
  return { height: b.height, txids: b.tx };
}
async function mined(txids, what) {
  const blk = await produce();
  for (const t of txids) assert.ok(blk.txids.includes(t), `${what}: ${t} is not in block ${blk.height}`);
  log(`${what}: block ${blk.height} carries ${txids.join(', ')}`);
  return blk;
}

// ---- the chain's coins: genesis OP_TRUE to the extension's wallet -----------
const genesisHash = await seq.call('getblockhash', [0]);
const policyAsset = (await seq.call('getsidechaininfo')).pegged_asset;
await produce();

const shimPort = await freePort();
const shim = await startEsploraShim({ rpc: seq.rpc, port: shimPort, pools: { block_seconds: 1, pools: [], stakers: 0, network_weight: '0' } });
register(pathToFileURL(path.join(ROOT, 'test/regtest/loader.mjs')).href, {
  data: { base: shim.url, t4: 'http://127.0.0.1:9/', policyAsset, genesis: genesisHash, recordsV2Height: null, unbondDepth: DEPTH },
});
await import(pathToFileURL(path.join(ROOT, 'test/regtest/sw-stubs.mjs')).href);
const lwk = await import(pathToFileURL(path.join(ROOT, 'pkg/lwk_wasm.js')).href);
lwk.initSync({ module: fs.readFileSync(path.join(ROOT, 'pkg/lwk_wasm_bg.wasm')) });
const engine = await import(pathToFileURL(path.join(ROOT, 'src/engine.js')).href);
await import(pathToFileURL(path.join(ROOT, 'background.js')).href);
const ui = globalThis.__sw.ui;
const config = await import(pathToFileURL(path.join(ROOT, 'src/config.js')).href);
assert.equal(config.ESPLORA, shim.url + '/api');
assert.equal(config.UNBOND_ANCHOR_DEPTH, DEPTH);
const staking = await import(pathToFileURL(path.join(ROOT, 'src/staking.js')).href);
const SR = await import(pathToFileURL(path.join(ROOT, 'vendor/stake-records.js')).href);
assert.deepEqual(SR.STAKE_CSVS, [HEIGHT_CSV, TIME_CSV], 'the locks the wallets bond with');

await engine.openFromPhrase(MNEMONIC);
await engine.sync();
const walletAddr = engine.currentAddress(false).address;
const controller = engine.stakerPublicKey();
log('wallet', walletAddr, 'staking key', controller);
{
  const g = await seq.call('getblock', [genesisHash, 2]);
  let src = null;
  for (const tx of g.tx) for (const o of tx.vout) if (o.scriptPubKey.hex === '51' && o.value > 0) src = { txid: tx.txid, vout: o.n, value: o.value };
  assert.ok(src, 'an OP_TRUE genesis output');
  const opTrue = (await seq.call('decodescript', ['51'])).segwit.address;
  const raw = await seq.call('createrawtransaction', [[{ txid: src.txid, vout: src.vout }],
    [{ [walletAddr]: 1000 }, { [opTrue]: Number((src.value - 1000 - 0.001).toFixed(8)) }, { fee: 0.001 }]]);
  await mined([await seq.call('sendrawtransaction', [raw])], 'funding');
}
// From here on the node relays under its default policy, as the testnet does.
await stopNode(seq);
seq = await startNode('sequentia', seqArgs([]), seqPort);
shim.setRpc(seq.rpc);
await engine.sync();

const results = { txs: {}, refusals: {}, fees: {} };

// ---- two stakes, bonded the way the web wallet and Ambra bond --------------------
async function bond(csv, atoms, what) {
  const pset = await engine.withWollet(async () => engine.getNetwork().txBuilder()
    .addStakeOutput(controller, csv, BigInt(atoms)).feeRate(2000).finish(engine.getWollet()).toString());
  const { txid } = await engine.broadcastRaw({ psetB64: await engine.signPset(pset) });
  const blk = await mined([txid], what);
  results.txs[what] = { txid, block: blk.height };
  await engine.sync();
  return txid;
}
const hBond = await bond(HEIGHT_CSV, 50 * COIN, 'bond under the height lock');
const tBond = await bond(TIME_CSV, 60 * COIN, 'bond under the time lock');
const stakeInfo = await seq.call('getstakerinfo', [false, true]).catch(() => null);
if (stakeInfo) log('node getstakerinfo has the key:', controller in stakeInfo);

const listed = async () => (await ui('stakes')).stakes;
const one = (list, txid) => list.find((s) => s.txid === txid);
{
  const list = await listed();
  const h = one(list, hBond), t = one(list, tBond);
  assert.ok(h && t, 'both stakes are listed: ' + JSON.stringify(list));
  assert.equal(h.csv, HEIGHT_CSV); assert.equal(h.timeLock, false); assert.equal(h.state, 'bonded');
  assert.equal(t.csv, TIME_CSV); assert.equal(t.timeLock, true); assert.equal(t.state, 'bonded');
  assert.equal(h.held, String(50 * COIN)); assert.equal(t.held, String(60 * COIN));
  log(`listed: ${h.txid} bonded until block ${h.maturesAt} (${h.lock}); ${t.txid} bonded until median time ${t.maturesAtTime} (${t.lock}, tip's ${t.tipTime})`);
  results.listedBonded = { height: { maturesAt: h.maturesAt, lock: h.lock }, time: { maturesAtTime: t.maturesAtTime, tipTime: t.tipTime, lock: t.lock } };
  // Found from the chain, not from what this run stored: a restored wallet finds them too.
  globalThis.localStorage.removeItem('ext.stakes.' + controller);
  const again = await listed();
  assert.ok(one(again, hBond) && one(again, tBond), 'found again from the chain alone');
}
{
  const sum = await staking.stakedSum({ maxAgeMs: 0 });
  assert.equal(sum.atoms, String(110 * COIN), 'both stakes count in what is staked');
  results.stakedSum = sum.atoms;
  // The popup's balance: the Sequence token's one figure counts what is staked, in both
  // modes, and its parts are a tap away in user mode.
  const ov = await ui('overview', { withLn: false });
  const row = ov.rows.find((r) => r.key === policyAsset);
  assert.ok(row, 'the Sequence token has its row');
  assert.equal(row.staked, String(110 * COIN));
  assert.equal(BigInt(row.total), BigInt(row.onchain) + BigInt(row.leaves || 0) + BigInt(row.ln) + BigInt(row.staked), 'the figure is on-chain + leaves + Lightning + staked');
  const { userSplit } = await import(pathToFileURL(path.join(ROOT, 'src/balance-view.js')).href);
  results.overview = { mode: ov.mode, onchain: row.onchain, staked: row.staked, total: row.total, userSplit: userSplit(row, String) };
  log('overview: tSEQ figure', row.total, '=', row.onchain, 'on-chain +', row.staked, 'staked; user mode split:', results.overview.userSplit);
}

// ---- an unbond before the lock ---------------------------------------------------
const ctx = staking.stakeCtx();
const entry = (txid) => JSON.parse(ctx.store.getItem(ctx.stakesKey)).find((x) => x.txid === txid);
for (const [txid, what] of [[hBond, 'height'], [tBond, 'time']]) {
  let err = null;
  try { await ui('stakeUnbondReview', { txid }); } catch (e) { err = e; }
  assert.ok(err && /cannot be unbonded yet/.test(err.message), String(err && err.message));
  const s = await SR.stakeState(ctx, entry(txid), await seq.call('getblockcount'));
  const early = await SR.buildUnbond(ctx, { ...s, state: 'unbondable' });
  let nerr = null;
  try { await engine.broadcastRaw({ hex: early.rawHex }); } catch (e) { nerr = e; }
  assert.ok(nerr && /non-BIP68-final/.test(nerr.message), String(nerr && nerr.message));
  results.refusals[`unbond before the ${what} lock`] = { wallet: err.message, node: nerr.message };
  log(`unbond before the ${what} lock: wallet "${err.message}"; node "${nerr.message}"`);
}
assert.deepEqual(await seq.call('getrawmempool'), [], 'nothing early reached the mempool');

// ---- the locks pass: the clock 16 days on, and 43,200 blocks ------------------------
{
  let clock = Math.floor(Date.now() / 1000) + 16 * 86400;
  await seq.call('setmocktime', [clock]);
  const t0 = Date.now();
  const target = results.txs['bond under the height lock'].block + HEIGHT_CSV;
  let n = await seq.call('getblockcount');
  while (n + 1 < target) {
    try { await seq.call('generateposblock', [producerKey.wif]); } catch (e) {
      // Each block is a slot after the last, ahead of the clock: the clock is moved on.
      if (!/time-too-new/.test(e.message)) throw e;
      const tipTime = (await seq.call('getblockheader', [await seq.call('getbestblockhash')])).time;
      clock = Math.max(clock, tipTime) + 3600;
      await seq.call('setmocktime', [clock]);
      continue;
    }
    n++;
    if (n % 5000 === 0) log(`  block ${n} of ${target - 1}`);
  }
  clock += 3600; await seq.call('setmocktime', [clock]);
  log(`produced to block ${n} in ${Math.round((Date.now() - t0) / 1000)} s; next block ${n + 1} is the height lock's ${target}`);
}

// ---- both unbonded, each through its review ---------------------------------------------
for (const [txid, what] of [[hBond, 'height'], [tBond, 'time']]) {
  const s = one(await listed(), txid);
  assert.equal(s.state, 'unbondable', `${what}: ${JSON.stringify(s)}`);
  const rv = await ui('stakeUnbondReview', { txid });
  const cap = BigInt(lwk.unbondFeeCap(rv.stake));
  assert.ok(BigInt(rv.fee) <= cap && BigInt(rv.fee) > 0n, 'the fee is out of the stake, at most 1% of it');
  assert.equal(BigInt(rv.stake) - BigInt(rv.fee), BigInt(rv.unbonding));
  const r = await ui('stakeStepConfirm', { id: rv.id });
  assert.equal(r.signing, 'segwitV0');
  const tx = await seq.call('getrawtransaction', [r.txid, 1]);
  const fee = tx.vout.filter((o) => o.scriptPubKey.type === 'fee').reduce((a, o) => a + Math.round(o.value * COIN), 0);
  assert.equal(String(fee), rv.fee, 'the fee paid is the fee shown');
  const blk = await mined([r.txid], `unbond of the ${what}-locked stake`);
  results.txs[`unbond ${what}`] = { txid: r.txid, block: blk.height, fee: rv.fee, vsize: tx.vsize };
  const after = one(await listed(), txid);
  assert.equal(after.state, 'unbonding');
  assert.equal(after.held, rv.unbonding, 'an unbonding stake counts its unbonding output');
}
{
  const sum = await staking.stakedSum({ maxAgeMs: 0 });
  results.stakedWhileUnbonding = sum.atoms;
  log('staked while unbonding:', sum.atoms);
}

// ---- a withdrawal before the depth ------------------------------------------------------
{
  let err = null;
  try { await ui('stakeClaimReview', { txid: hBond }); } catch (e) { err = e; }
  assert.ok(err && /cannot be withdrawn yet/.test(err.message), String(err && err.message));
  const s = await SR.stakeState(ctx, entry(hBond), await seq.call('getblockcount'));
  const early = await SR.buildClaim(ctx, { ...s, state: 'claimable' }, walletAddr);
  let nerr = null;
  try { await engine.broadcastRaw({ hex: early.rawHex }); } catch (e) { nerr = e; }
  assert.ok(nerr && /bad-unbond-premature/.test(nerr.message), String(nerr && nerr.message));
  results.refusals['withdrawal before the depth'] = { wallet: err.message, node: nerr.message };
  log(`withdrawal before the depth: wallet "${err.message}"; node "${nerr.message}"`);
}

// ---- the depth passes: both withdrawn into the wallet ------------------------------------
for (let i = 0; i < 40 && one(await listed(), hBond).state !== 'claimable'; i++) await produce();
await engine.sync();
const before = BigInt((await engine.balances()).seq[policyAsset] || '0');
let back = 0n;
for (const [txid, what] of [[hBond, 'height'], [tBond, 'time']]) {
  const s = one(await listed(), txid);
  assert.equal(s.state, 'claimable', `${what}: ${JSON.stringify(s)}`);
  const rv = await ui('stakeClaimReview', { txid });
  const r = await ui('stakeStepConfirm', { id: rv.id });
  const blk = await mined([r.txid], `withdrawal of the ${what}-locked stake`);
  const tx = await seq.call('getrawtransaction', [r.txid, 1]);
  results.txs[`withdraw ${what}`] = { txid: r.txid, block: blk.height, out: rv.out, fee: rv.fee, vsize: tx.vsize };
  back += BigInt(rv.out);
}
await engine.sync();
const after = BigInt((await engine.balances()).seq[policyAsset] || '0');
assert.equal(after - before, back, 'the withdrawn stakes are in the wallet');
const left = await listed();
assert.ok(!one(left, hBond) && !one(left, tBond), 'withdrawn stakes are no longer listed');
assert.equal((await staking.stakedSum({ maxAgeMs: 0 })).atoms, '0', 'nothing counted as staked once withdrawn');
for (const k of ['unbond height', 'unbond time']) assert.ok(results.txs[k].vsize <= SR.VBYTES.unbond, `${k} ${results.txs[k].vsize} vB within ${SR.VBYTES.unbond}`);
for (const k of ['withdraw height', 'withdraw time']) assert.ok(results.txs[k].vsize <= SR.VBYTES.claim, `${k} ${results.txs[k].vsize} vB within ${SR.VBYTES.claim}`);

console.log(JSON.stringify(results, null, 2));
await shim.close();
await stopNode(seq);
await stopNode(parent);
if (process.env.KEEP !== '1') fs.rmSync(WORK, { recursive: true, force: true });
log('OK');
process.exit(0);
