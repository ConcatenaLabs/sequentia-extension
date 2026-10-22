// A live interactive maker on the market drives' private chain (chain.mjs): SeqDEX's
// wallet daemon (oceand) holding the maker's coins, and its order-book maker
// (seqob-maker -mode samechain) resting a signed offer on the chain's relay and
// co-signing each lift over the relay's courier, as the testnet's makers do.
//
//   const m = await startInteractiveMaker({ chain, oceand, seqobMaker, seqobOctl, work,
//     give: { asset, atoms }, want: { asset, atoms }, log });
//   ... m.offer, m.balance(), m.stop()
//
// The maker sells `give` for `want` (side sell, base = give.asset). `extraArgs` go on
// the maker's command line and `env` into its environment. Its account is
// funded from the chain's bank with explicit coins of `give.asset` (and `fund`, extra
// coins as [{ asset, amount }]); the fee is paid in what it gives, valued at
// the chain's published rates. Every process is a child of the caller, stopped by its
// PID in `stop()`; every file lives under `work`.
//
// The wallet daemon speaks SeqDEX's own regtest network (bech32 and blech32 "bcrt"),
// the chain its own (elementsregtest, "ert"): the same witness programs under other
// prefixes, so the daemon's (confidential) address is funded at the explicit address of
// its script, `explicitAddress`.
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { freePort } from './chain.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 20000 }, (e, stdout, stderr) => (e ? reject(new Error(String(stderr || e.message).trim())) : resolve(String(stdout))));
});

// ---- bech32 / bech32m, enough to move an address between prefixes ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [];
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)); } }
  if (pad && bits > 0) out.push((acc << (to - bits)) & ((1 << to) - 1));
  return out;
}
function encode(hrp, words, bech32m) {
  const chk = polymod(hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0])) ^ (bech32m ? 0x2bc830a3 : 1);
  return hrp + '1' + words.concat([0, 1, 2, 3, 4, 5].map((i) => (chk >>> (5 * (5 - i))) & 31)).map((d) => CHARSET[d]).join('');
}
// The explicit address, under `hrp`, of a segwit address's script: a bech32 address is
// re-prefixed; a blech32 (confidential) one, whose data is the witness version, a 33-byte
// blinding key and the program under a 12-character checksum, loses its key.
export function explicitAddress(address, hrp) {
  const a = address.toLowerCase();
  const words = [...a.slice(a.lastIndexOf('1') + 1)].map((c) => CHARSET.indexOf(c));
  if (words.some((d) => d < 0)) throw new Error('not a bech32 address: ' + address);
  if (words.length < 80) return rehrp(address, hrp);
  const program = convertBits(words.slice(1, -12), 5, 8, false).slice(33);
  if (program.length !== 20 && program.length !== 32) throw new Error('not a blech32 segwit address: ' + address);
  return encode(hrp, [words[0], ...convertBits(program, 8, 5, true)], words[0] !== 0);
}
export function rehrp(address, hrp) {
  const a = address.toLowerCase();
  const sep = a.lastIndexOf('1');
  const data = [...a.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error('not a bech32 address: ' + address);
  const const_ = polymod(hrpExpand(a.slice(0, sep)).concat(data));
  if (const_ !== 1 && const_ !== 0x2bc830a3) throw new Error('bad bech32 checksum: ' + address);
  const payload = data.slice(0, -6);
  const chk = polymod(hrpExpand(hrp).concat(payload, [0, 0, 0, 0, 0, 0])) ^ const_;
  const sum = [0, 1, 2, 3, 4, 5].map((i) => (chk >>> (5 * (5 - i))) & 31);
  return hrp + '1' + payload.concat(sum).map((d) => CHARSET[d]).join('');
}

// A public test phrase, never funded anywhere but a local chain.
const MAKER_PHRASE = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

export async function startInteractiveMaker({ chain, oceand, seqobMaker, seqobOctl, work, give, want, fund = [], extraArgs = [], env = {}, name = 'maker', mnemonic = MAKER_PHRASE, log = () => {} }) {
  const dir = path.join(work, name);
  fs.mkdirSync(path.join(dir, 'ocean'), { recursive: true });
  const procs = [];
  const nodeUrl = new URL(chain.rpc.url);
  const nodeRpc = `http://${chain.rpc.auth}@${nodeUrl.host}`;
  const oceanPort = await freePort();
  const ocean = `127.0.0.1:${oceanPort}`;
  const oceanLog = fs.openSync(path.join(dir, 'oceand.log'), 'a');
  const od = spawn(oceand, [], {
    env: { ...process.env,
      OCEAN_NETWORK: 'sequentia-regtest', OCEAN_NATIVE_ASSET: chain.policy, OCEAN_NODE_RPC_ADDR: nodeRpc,
      OCEAN_BLOCKCHAIN_SCANNER_TYPE: 'elements', OCEAN_DB_TYPE: 'badger', OCEAN_NO_TLS: 'true', OCEAN_NO_PROFILER: 'true',
      OCEAN_DATADIR: path.join(dir, 'ocean'), OCEAN_PORT: String(oceanPort), OCEAN_LOG_LEVEL: '4',
      OCEAN_MNEMONIC: mnemonic, OCEAN_PASSWORD: randomBytes(12).toString('hex') },
    stdio: ['ignore', oceanLog, oceanLog] });
  procs.push(od);
  log(`${name}: oceand pid ${od.pid} at ${ocean}`);

  // The account, once the daemon has made and unlocked its wallet.
  let address = null;
  const deadline = (s) => Date.now() + s * 1000;
  for (const until = deadline(90); !address && Date.now() < until;) {
    try {
      const out = await run(seqobOctl, ['-ocean', ocean, '-account', 'mm', '-action', 'create']);
      address = (out.match(/address\[mm\] (\S+)/) || [])[1] || null;
    } catch (e) {
      if (/already exists/.test(e.message)) {
        const out = await run(seqobOctl, ['-ocean', ocean, '-account', 'mm', '-action', 'address']);
        address = (out.match(/address\[mm\] (\S+)/) || [])[1] || null;
      } else await sleep(400);
    }
  }
  if (!address) throw new Error(`${name}: oceand never made its account (see ${path.join(dir, 'oceand.log')})`);
  const chainAddress = explicitAddress(address, 'ert');
  log(`${name}: account mm, address ${address} (${chainAddress} on the chain)`);

  // Its coins: what it sells, and whatever else the drive asks for.
  const units = (atoms) => Number(atoms) / 1e8;
  await chain.fund(chainAddress, give.asset, units(BigInt(give.atoms) * 2n));
  for (const f of fund) await chain.fund(chainAddress, f.asset, f.amount);
  await chain.mine(1);
  const balance = async () => {
    const out = await run(seqobOctl, ['-ocean', ocean, '-account', 'mm', '-action', 'balance']);
    const b = {};
    for (const m of out.matchAll(/balance\[mm\] ([0-9a-f]{64}) confirmed=(\d+) unconfirmed=(\d+) locked=(\d+) total=(\d+)/g)) b[m[1]] = { confirmed: BigInt(m[2]), unconfirmed: BigInt(m[3]), locked: BigInt(m[4]), total: BigInt(m[5]) };
    return b;
  };
  for (const until = deadline(90); ;) {
    const b = await balance().catch(() => ({}));
    if (b[give.asset] && b[give.asset].confirmed >= BigInt(give.atoms)) break;
    if (Date.now() > until) throw new Error(`${name}: oceand never saw its funding (see ${path.join(dir, 'oceand.log')})`);
    await sleep(500);
  }

  // The maker, resting its offer on the chain's relay.
  const makerKey = randomBytes(32).toString('hex');
  const makerLog = fs.openSync(path.join(dir, 'seqob-maker.log'), 'a');
  const mk = spawn(seqobMaker, ['-mode', 'samechain', '-relay', chain.relay, '-ocean', ocean, '-account', 'mm',
    '-base', give.asset, '-quote', want.asset, '-side', 'sell', '-base-amount', String(give.atoms), '-quote-amount', String(want.atoms),
    '-min-anchor-depth', '0', '-expiry', '1h', ...extraArgs],
  { env: { ...process.env, ...env, SEQOB_MAKER_PRIV: makerKey, SEQOB_NODE_RPC: nodeRpc }, stdio: ['ignore', makerLog, makerLog] });
  procs.push(mk);
  log(`${name}: seqob-maker pid ${mk.pid}`);
  let offer = null;
  for (const until = deadline(90); !offer && Date.now() < until;) {
    if (mk.exitCode != null) throw new Error(`${name}: seqob-maker exited ${mk.exitCode} (see ${path.join(dir, 'seqob-maker.log')})`);
    try {
      const j = await (await fetch(`${chain.relay}/v1/market/${give.asset}/${want.asset}/orderbook`)).json();
      offer = (j.offers || []).find((o) => !o.covenant && o.same_chain && o.offer_asset === give.asset) || null;
    } catch {}
    if (!offer) await sleep(300);
  }
  if (!offer) throw new Error(`${name}: the offer never reached the relay (see ${path.join(dir, 'seqob-maker.log')})`);
  log(`${name}: offer ${offer.offer_id} gives ${offer.offer_amount} for ${offer.want_amount}, receive address ${offer.same_chain.maker_recv_address}`);

  const stop = async () => {
    for (const p of [mk, od]) {
      if (p.exitCode == null && p.signalCode == null) {
        p.kill('SIGTERM');
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 20000);
        await new Promise((r) => (p.exitCode != null || p.signalCode != null ? r() : p.once('exit', r)));
        clearTimeout(t);
      }
    }
  };
  return { ocean, address, chainAddress, offer, balance, stop, pids: { oceand: od.pid, maker: mk.pid }, logs: { ocean: path.join(dir, 'oceand.log'), maker: path.join(dir, 'seqob-maker.log') } };
}
