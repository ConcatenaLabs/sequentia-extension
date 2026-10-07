// The extension's pool join, move and leave against a private sequentiad
// chain, through the service worker's own message handlers.
//
//   SEQUENTIAD=/path/to/sequentiad node test/regtest/stake-records.mjs [block-one|fork]
//
// block-one: a custom chain whose stake records are second-generation from
//   block 1 (the custom-chain default). Join (two transactions, one block),
//   find the record from the staking key's script, move, leave; the old
//   one-transaction join refused; a join whose second transaction is refused
//   resumed without paying twice; a spend refused without a chain tip.
// fork: -posrecordsv2height set a few blocks ahead, so the extension signs a
//   move the legacy way below it, refuses to sign across it, and signs the
//   second-generation way from it.
//
// Every transaction is checked into a block, with its vsize against the fee
// allowance in src/staking.js. Nodes and data live in REGTEST_DIR (default: a
// fresh directory under the system temporary directory) and are removed at the
// end unless KEEP=1.
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

const MODE = process.argv[2] || 'block-one';
const EXE = process.env.SEQUENTIAD;
if (!EXE) { console.log('SKIP: set SEQUENTIAD to a sequentiad binary'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = process.env.REGTEST_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ext-stake-records-'));
fs.mkdirSync(WORK, { recursive: true });

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COIN = 100_000_000;
const UNBONDING = 5;
const PARENT_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

const log = (...a) => console.log('[stake-records]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// ---- nodes -----------------------------------------------------------------
const children = [];
// A failed assertion ends the process; the nodes must not outlive it.
process.on('exit', () => { for (const c of children) if (c.exitCode == null) c.kill('SIGTERM'); });
async function startNode(name, args, rpcPort) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(EXE, [
    `-datadir=${dir}`, `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
    '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-disablewallet', '-txindex=1', ...args,
  ], { stdio: 'ignore' });
  children.push(child);
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

const forkHeight = MODE === 'fork' ? 20 : null;
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
  '-con_default_blinded_addresses=0', `-posunbonding=${UNBONDING}`, '-posunbonddepth=3', '-pospayoutnotice=3',
  `-staker=${producerKey.pub}:${COIN}`,
  ...(forkHeight ? [`-posrecordsv2height=${forkHeight}`, `-poshardeningheight=${forkHeight}`] : []),
  ...extra,
];
const seqPort = await freePort();
let seq = await startNode('sequentia', seqArgs(['-acceptnonstdtxn=1']), seqPort);

/// One block from the mempool, anchored to a fresh parent block. Returns its
/// height and the ids it carries.
async function produce() {
  await parent.call('generatetodescriptor', [1, parentDescriptor]);
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
const sizes = {};
async function vsize(txid, what) {
  const t = await seq.call('getrawtransaction', [txid, 1]);
  const fee = t.vout.filter((o) => o.scriptPubKey.type === 'fee').reduce((a, o) => a + Math.round(o.value * COIN), 0);
  sizes[what] = { vsize: t.vsize, fee };
  return t;
}

// ---- the chain's coins: genesis OP_TRUE to the extension's wallet -----------
const genesisHash = await seq.call('getblockhash', [0]);
const policyAsset = (await seq.call('getsidechaininfo')).pegged_asset;
await produce();

// ---- the extension, pointed at this chain ----------------------------------
const shimPort = await freePort();
const pools = { block_seconds: 1, pools: [], stakers: 0, network_weight: '0' };
const shim = await startEsploraShim({ rpc: seq.rpc, port: shimPort, pools });
register(pathToFileURL(path.join(ROOT, 'test/regtest/loader.mjs')).href, {
  data: {
    base: shim.url, t4: 'http://127.0.0.1:9/', policyAsset, genesis: genesisHash,
    recordsV2Height: forkHeight,
  },
});
await import(pathToFileURL(path.join(ROOT, 'test/regtest/sw-stubs.mjs')).href);
const lwk = await import(pathToFileURL(path.join(ROOT, 'pkg/lwk_wasm.js')).href);
lwk.initSync({ module: fs.readFileSync(path.join(ROOT, 'pkg/lwk_wasm_bg.wasm')) });
const engine = await import(pathToFileURL(path.join(ROOT, 'src/engine.js')).href);
await import(pathToFileURL(path.join(ROOT, 'background.js')).href);
const ui = globalThis.__sw.ui;   // the service worker's own message listener
const config = await import(pathToFileURL(path.join(ROOT, 'src/config.js')).href);
assert.equal(config.ESPLORA, shim.url + '/api');
const staking = await import(pathToFileURL(path.join(ROOT, 'src/staking.js')).href);

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
  const id = await seq.call('sendrawtransaction', [raw]);
  await mined([id], 'funding');
}
// From here on the node relays under its default policy, as the testnet does.
await stopNode(seq);
seq = await startNode('sequentia', seqArgs([]), seqPort);
shim.setRpc(seq.rpc);
await engine.sync();

// A bond, so the delegation lends weight. The extension does not offer
// bonding; the harness bonds through the kit, as the node wallet would.
{
  const pset = await engine.withWollet(async () => engine.getNetwork().txBuilder()
    .addStakeOutput(controller, UNBONDING, BigInt(50 * COIN)).feeRate(2000).finish(engine.getWollet()).toString());
  const { txid } = await engine.broadcastRaw({ psetB64: await engine.signPset(pset) });
  await mined([txid], 'bond');
  await engine.sync();
}

const keyOf = async () => {
  const { secp256k1 } = await import(pathToFileURL(path.join(ROOT, 'vendor/btc.js')).href);
  return [...secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)].map((x) => x.toString(16).padStart(2, '0')).join('');
};
const P = await keyOf(), Q = await keyOf(), R = await keyOf();
const delegationOf = async () => (await seq.call('getdelegationinfo'))[controller] ?? null;
const forgetHints = () => chrome.storage.local.remove('seq.staking.signerHints');

const results = { mode: MODE, txs: {}, refusals: {} };

// ---- overview before ---------------------------------------------------------
{
  const o = await ui('stakingOverview');
  assert.equal(o.supported, true);
  assert.equal(o.delegation, null);
  assert.equal(o.stakerKey, controller);
}

// ---- the old one-transaction join is refused --------------------------------
if (MODE === 'block-one') {
  const pset = await engine.withWollet(async () => engine.getNetwork().txBuilder()
    .addDelegationOutput(controller, P, 100000n).feeRate(2000).finish(engine.getWollet()).toString());
  const signed = await engine.signPset(pset);
  const hex = await engine.withWollet(async () => engine.getWollet().finalize(new lwk.Pset(signed)).extractTx().toString());
  const r = (await seq.call('testmempoolaccept', [[hex]]))[0];
  assert.equal(r.allowed, false);
  results.refusals.oldJoin = r['reject-reason'];
  log('old one-transaction join refused:', r['reject-reason']);
}

// ---- join: two transactions, one block ---------------------------------------
async function join(signer, what) {
  const r = await ui('stakingDelegate', { signer });
  const auth = await vsize(r.authorizationTxid, what + ' authorization');
  const create = await vsize(r.txid, what + ' record');
  // The record is funded by the authorization's coin alone.
  assert.deepEqual(create.vin.map((i) => i.txid), [r.authorizationTxid]);
  const blk = await mined([r.authorizationTxid, r.txid], what);
  results.txs[what] = { authorization: r.authorizationTxid, record: r.txid, block: blk.height };
  void auth;
  return r;
}

let joinBlock;
if (MODE === 'block-one') {
  // A join whose record is refused leaves the authorization coin; joining
  // again spends that coin instead of paying the staking key twice.
  shim.failNextPost(2);   // the second POST of the join is the record
  let err = null;
  try { await ui('stakingDelegate', { signer: P }); } catch (e) { err = e; }
  assert.ok(err && /went through \(([0-9a-f]{64})\) but the record was refused/.test(err.message), String(err && err.message));
  const stranded = err.message.match(/\(([0-9a-f]{64})\)/)[1];
  results.refusals.recordRefusedOnce = err.message;
  log('record refused once (forced by the shim); authorization', stranded, 'left unspent');
  const r = await ui('stakingDelegate', { signer: P });
  assert.equal(r.authorizationTxid, stranded, 'the second join reuses the first payment');
  const create = await vsize(r.txid, 'join record (resumed)');
  assert.deepEqual(create.vin.map((i) => i.txid), [stranded]);
  const blk = await mined([stranded, r.txid], 'join (resumed)');
  results.txs.join = { authorization: stranded, record: r.txid, block: blk.height, resumed: true };
  joinBlock = blk.height;
} else {
  const r = await join(P, 'join');
  joinBlock = results.txs.join.block;
  void r;
}
assert.equal(await delegationOf(), P, 'the node counts the delegation to P');
log('getdelegationinfo:', controller, '->', P, 'at', joinBlock);

// ---- the record is found from the staking key's script ----------------------
{
  await forgetHints();             // no hint, and the board lists no pool:
  await engine.sync();             // only the staking key's script can find it
  const o = await ui('stakingOverview');
  assert.ok(o.delegation, 'the overview finds the record');
  assert.equal(o.delegation.signer, P);
  assert.equal(o.delegation.txid, results.txs.join.record);
  assert.equal(o.delegation.confirmed, true);
  assert.equal(typeof o.delegation.atoms, 'string');
  log('overview finds the record', `${o.delegation.txid}:${o.delegation.vout}`, 'with no hint and an empty board');
}

// ---- move ----------------------------------------------------------------------
async function move(to, what, expectSigning) {
  const r = await ui('stakingSpend', { rotateTo: to });
  assert.equal(r.repointed, true);
  assert.equal(r.signing, expectSigning, `${what} signing`);
  await vsize(r.txid, what);
  const blk = await mined([r.txid], what);
  results.txs[what] = { txid: r.txid, block: blk.height, signing: r.signing };
  assert.equal(await delegationOf(), to);
  return blk;
}

if (MODE === 'fork') {
  // Below the fork, far enough from it: legacy.
  let tip = await seq.call('getblockcount');
  assert.ok(tip + 1 + 3 < forkHeight, `tip ${tip} is too close to the fork ${forkHeight} for this case`);
  await move(Q, 'move below the fork', 'legacy');
  // Walk up to the margin: the extension refuses to sign across the change.
  while ((await seq.call('getblockcount')) < forkHeight - 3) await produce();
  tip = await seq.call('getblockcount');
  let err = null;
  try { await ui('stakingSpend', { rotateTo: R }); } catch (e) { err = e; }
  assert.ok(err && err.message.includes(`block ${forkHeight} changes how the network signs stake records`)
    && err.message.includes(`once block ${forkHeight - 1} is mined`), String(err && err.message));
  assert.equal(await delegationOf(), Q, 'nothing was broadcast');
  assert.deepEqual(await seq.call('getrawmempool'), []);
  results.refusals.acrossFork = `tip ${tip}: ${err.message}`;
  log(`tip ${tip}, fork ${forkHeight}: refused:`, err.message);
  // What the refusal spares the user: the kit's legacy spend for this tip,
  // valid in the next block, is refused once the next block is the fork's.
  const record = (await ui('stakingOverview')).delegation;
  const stale = lwk.buildDelegationSpendTx({
    mnemonic: MNEMONIC, recordTxid: record.txid, recordVout: record.vout, recordValue: record.atoms,
    currentSigner: record.signer, rotateTo: R, feeAtoms: '600', locktime: tip, tipHeight: tip,
    recordsV2Height: forkHeight,
  }, engine.getNetwork());
  assert.equal(stale.signing, 'legacy');
  assert.equal((await seq.call('testmempoolaccept', [[stale.rawHex]]))[0].allowed, true, 'valid in the next block');
  while ((await seq.call('getblockcount')) < forkHeight - 1) await produce();
  const late = (await seq.call('testmempoolaccept', [[stale.rawHex]]))[0];
  assert.equal(late.allowed, false);
  results.refusals.legacyAtFork = late['reject-reason'];
  log(`the same move signed at tip ${tip}, tested at tip ${forkHeight - 1}:`, late['reject-reason']);
  await move(R, 'move at the fork', 'segwitV0');
  results.txs['move at the fork'].forkHeight = forkHeight;
  assert.equal(results.txs['move at the fork'].block, forkHeight);
} else {
  await move(Q, 'move', 'segwitV0');
}

// ---- a spend without a chain tip is refused -----------------------------------
{
  shim.failTipHeight(true);
  let err = null;
  try { await ui('stakingSpend', { rotateTo: null }); } catch (e) { err = e; }
  shim.failTipHeight(false);
  assert.ok(err && /could not read the chain height/.test(err.message), String(err && err.message));
  assert.deepEqual(await seq.call('getrawmempool'), []);
  results.refusals.noTip = err.message;
  log('no chain tip: refused:', err.message);
}

// ---- leave -----------------------------------------------------------------------
{
  await engine.sync();
  const before = BigInt((await engine.balances()).seq[policyAsset] || '0');
  const held = BigInt((await ui('stakingOverview')).delegation.atoms);
  const r = await ui('stakingSpend', { rotateTo: null });
  assert.equal(r.repointed, false);
  assert.equal(r.signing, 'segwitV0');
  await vsize(r.txid, 'leave');
  const blk = await mined([r.txid], 'leave');
  results.txs.leave = { txid: r.txid, block: blk.height, signing: r.signing };
  assert.equal(await delegationOf(), null, 'no delegation after leaving');
  await engine.sync();
  const after = BigInt((await engine.balances()).seq[policyAsset] || '0');
  const back = after - before;
  results.txs.leave.returnedAtoms = back.toString();
  const spendFee = (staking.SPEND_VBYTES * 2000n + 999n) / 1000n;
  assert.equal(back, held - spendFee, 'the record comes back less the spend fee');
  const o = await ui('stakingOverview');
  assert.equal(o.delegation, null);
}

// ---- fee allowances cover what was built ------------------------------------------
results.sizes = sizes;
console.log(JSON.stringify(results, null, 2));
for (const [what, s] of Object.entries(sizes)) {
  if (/authorization/.test(what)) continue;   // a wallet PSET, priced by the kit
  const allowance = /record/.test(what) ? staking.CREATE_VBYTES : staking.SPEND_VBYTES;
  assert.ok(BigInt(s.vsize) <= allowance, `${what}: ${s.vsize} vB exceeds the ${allowance} vB allowance`);
}

await shim.close();
await stopNode(seq);
await stopNode(parent);
if (process.env.KEEP !== '1') fs.rmSync(WORK, { recursive: true, force: true });
log('OK', MODE);
process.exit(0);
