// A private chain for the market drives: a Sequentia regtest chain anchored to a
// regtest parent (both run by one sequentiad binary), two issued assets the node takes
// fees in, an esplora shim over the node, and the on-chain relay (seqobd) watching it.
//
//   const c = await startChain({ sequentiad, seqobd, work, log, nodeArgs });
//   ... c.call(method, params), c.mine(n), c.bury(n), c.fund(address, asset, amount), c.stop()
//
// `nodeArgs` are added to the chain node's command line (an interactive maker's wallet
// daemon, maker.mjs, reads blocks through the node's block filter index).
//
// Every process is a child of the caller, stopped by its PID in `stop()`; every file
// lives under `work`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { rpcCall, startEsploraShim } from '../regtest/esplora-shim.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const COIN = 100000000;

// A node answers -28 (loading, verifying blocks) while it warms up, and may do so again
// after its first answer: such a call is asked again, for up to a minute.
async function warm(ask) {
  for (let i = 0; ; i++) {
    try { return await ask(); } catch (e) { if (e.code !== -28 || i >= 300) throw e; await sleep(200); }
  }
}

export async function startChain({ sequentiad, seqobd, work, log = () => {}, nodeArgs = [] }) {
  fs.mkdirSync(path.join(work, 'parent'), { recursive: true });
  fs.mkdirSync(path.join(work, 'node'), { recursive: true });
  const procs = [];
  const parentPort = await freePort();
  const parent = spawn(sequentiad, [`-datadir=${path.join(work, 'parent')}`, '-chain=regtest', `-rpcport=${parentPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
    '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-disablewallet'], { stdio: 'ignore' });
  procs.push(parent);
  const pcall = (m, p = []) => warm(() => rpcCall({ url: `http://127.0.0.1:${parentPort}/`, auth: 'u:p' }, m, p));
  for (let i = 0; ; i++) { try { await pcall('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
  const burn = (await pcall('getdescriptorinfo', ['raw(51)'])).descriptor;
  await pcall('generatetodescriptor', [5, burn]);
  const rpcPort = await freePort();
  const node = spawn(sequentiad, [`-datadir=${path.join(work, 'node')}`, '-chain=elementsregtest', '-con_bitcoin_anchor=1', '-validateanchor=1', '-mainchainrpchost=127.0.0.1',
    `-mainchainrpcport=${parentPort}`, '-mainchainrpcuser=u', '-mainchainrpcpassword=p', '-parentgenesisblockhash=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
    '-anchorpollinterval=1', '-anchorminconf=1', `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
    '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-txindex=1', '-par=1', '-evbparams=simplicity:-1:::', '-initialfreecoins=2100000000000000',
    '-anyonecanspendaremine=1', '-blindedaddresses=0', '-con_default_blinded_addresses=0', '-validatepegin=0', '-con_parent_chain_signblockscript=51',
    '-con_any_asset_fees=1', '-fallbackfee=0.0001', '-maxtxfee=100', ...nodeArgs], { stdio: 'ignore' });
  procs.push(node);
  const rpc = { url: `http://127.0.0.1:${rpcPort}/`, auth: 'u:p' };
  const call = (m, p = []) => warm(() => rpcCall(rpc, m, p));
  const wcall = (m, p = []) => warm(() => rpcCall({ ...rpc, url: rpc.url + 'wallet/bank' }, m, p));
  for (let i = 0; ; i++) { try { await call('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
  await sleep(2000);   // the anchor watcher's first look at the parent
  await call('createwallet', ['bank']);
  const mine = async (n = 1) => call('generatetoaddress', [n, await wcall('getnewaddress')]);
  await mine(101); await wcall('rescanblockchain');
  const policy = (await call('getsidechaininfo')).pegged_asset;
  const genesis = await call('getblockhash', [0]);
  const issue = async (n) => { const a = (await wcall('issueasset', { assetamount: n, tokenamount: 0, blind: false, fee_asset: 'bitcoin' })).asset; await mine(1); return a; };
  const X = await issue(1000), Y = await issue(10000000);
  const rates = await call('getfeeexchangerates'); rates[X] = COIN; rates[Y] = COIN;
  await call('setfeeexchangerates', [rates]);
  log(`chain: policy ${policy}, X ${X}, Y ${Y}, node pid ${node.pid}, parent pid ${parent.pid}`);

  const shim = await startEsploraShim({ rpc, port: await freePort() });
  const relayPort = await freePort();
  const relayLog = fs.openSync(path.join(work, 'seqobd.log'), 'a');
  const relay = spawn(seqobd, [`-listen=127.0.0.1:${relayPort}`, `-node-rpc=127.0.0.1:${rpcPort}`, '-node-rpc-user=u', '-node-rpc-pass=p',
    '-watch-interval=1s', '-min-expiry=5s', '-fill-anchor-depth=2'], { stdio: ['ignore', relayLog, relayLog] });
  procs.push(relay);
  const R = `http://127.0.0.1:${relayPort}`;
  for (let i = 0; ; i++) { try { if ((await fetch(R + '/v1/markets')).ok) break; } catch (e) { if (i > 150) throw e; } await sleep(200); }
  log(`relay seqobd pid ${relay.pid} at ${R}`);

  // Bury: parent blocks over the chain's anchor, so the relay can call a fill final. The
  // chain anchors each new block to the parent tip; burying means parent blocks past
  // the anchor, then a block that reads the new tip.
  const bury = async (n = 3) => {
    for (let i = 0; i < n; i++) { await pcall('generatetodescriptor', [1, burn]); await sleep(1200); await mine(1); }
  };
  const fund = async (address, asset, amount) => wcall('sendtoaddress', { address, amount, assetlabel: asset, fee_asset_label: 'bitcoin' });
  const advance = async (secs) => {
    const t = (await call('getblockheader', [await call('getbestblockhash')])).time;
    await call('setmocktime', [t + secs + 60]); await mine(12);
  };
  const stop = async () => {
    try { await shim.close(); } catch {}
    if (relay.exitCode == null) { relay.kill('SIGTERM'); await new Promise((r) => (relay.exitCode != null ? r() : relay.once('exit', r))); }
    try { await call('stop'); } catch {}
    if (node.exitCode == null) await new Promise((r) => node.once('exit', r));
    try { await pcall('stop'); } catch {}
    if (parent.exitCode == null) await new Promise((r) => parent.once('exit', r));
  };
  return { rpc, call, wcall, pcall, mine, bury, fund, advance, policy, genesis, X, Y, shim, relay: R, relayPid: relay.pid, nodePid: node.pid, parentPid: parent.pid, stop };
}
