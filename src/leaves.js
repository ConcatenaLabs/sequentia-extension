// The service worker's side of the leaf wallet.
//
// The leaf wallet itself runs in the offscreen document (offscreen-leaves.js), which
// holds the operator wallet library's store and syncs it on the library's schedule.
// This module keeps the operator each wallet joined, starts the offscreen host when the
// wallet unlocks, closes it when the wallet locks, and asks it for what the provider and
// the popup need. Nothing about a leaf is decided here: every answer and every refusal
// is the library's.
//
// Leaves are a developer-mode rail: in user mode nothing of them is shown and no
// provider method reaches them. A wallet that joined an operator keeps its leaf wallet
// open and syncing in either mode all the same, since its coins must be refreshed or
// taken home on their dates, and their value counts in each asset's figure and the
// headline (the host reports it after every change, see `leafBalance`).

import { ensureOffscreen, offscreenUp } from './offscreen-doc.js';
import { stGet, stSet, stDel } from './util.js';
import { sessionMnemonic } from './vault.js';
import { mode, setMode, walletTag } from './mode.js';
import { claimScan } from './leaf-schedule.js';

export { mode, setMode };

const LEGACY_CONFIG_KEY = 'ext.leaves';
const CONFIGS_KEY = 'ext.leaves.byWallet';   // { [walletTag]: the operator joined }
const ADDRESS_KEY = 'ext.leaves.address';     // { [walletTag]: { address, script_pubkey } }
const SUM_KEY = 'ext.leaves.sum';             // { [walletTag]: { at, perAsset: { asset: atoms }, frozen: { asset: atoms } } }

export const NOT_DEVELOPER = 'leaves are a developer-mode rail: turn developer mode on in the wallet’s Settings';
export const NOT_JOINED = 'this wallet has not joined a leaf operator: join one in the wallet’s Settings';

// A refusal from the library (or the host), in its own words.
export class LeafError extends Error {
  constructor(e) {
    super((e && e.message) ? e.message : String(e));
    this.kind = (e && e.kind) || 'error';
    if (e && e.code) this.code = e.code;
    if (e && e.status) this.status = e.status;
    // A payment the planned coins would cover: their asset, and which to give up.
    if (e && e.asset) this.asset = e.asset;
    if (e && Array.isArray(e.release)) this.release = e.release;
  }
}

// ---- the operator joined, for each wallet: its server, the node, the exit delays ----
export async function config() {
  const tag = await walletTag();
  if (!tag) return null;
  const all = (await stGet('local', CONFIGS_KEY)) || {};
  if (all[tag]) return all[tag];
  // The one operator kept before it was kept for each wallet is this wallet's, once.
  const legacy = await stGet('local', LEGACY_CONFIG_KEY);
  if (legacy) {
    all[tag] = legacy;
    await stSet('local', CONFIGS_KEY, all);
    await stDel('local', LEGACY_CONFIG_KEY);
    return legacy;
  }
  return null;
}
async function setConfig(cfg) {
  const tag = await walletTag();
  if (!tag) throw new Error('open the wallet first');
  const all = (await stGet('local', CONFIGS_KEY)) || {};
  all[tag] = cfg;
  await stSet('local', CONFIGS_KEY, all);
}

// The leaf wallet's value per asset, as the host last reported it (leaves of every
// state the library counts), for the popup's figures and headline; and what of each asset
// its issuer has frozen for this wallet (`frozen`), which both modes say under the figure.
export async function leafSum() {
  const tag = await walletTag();
  const all = (await stGet('local', SUM_KEY)) || {};
  return (tag && all[tag]) || null;
}
export async function rememberLeafSum(balance, frozen) {
  const tag = await walletTag();
  if (!tag) return;
  const perAsset = {};
  for (const [a, states] of Object.entries((balance && balance.arca) || {})) {
    let t = 0n;
    for (const v of Object.values(states || {})) t += BigInt(v);
    if (t > 0n) perAsset[a] = t.toString();
  }
  const all = (await stGet('local', SUM_KEY)) || {};
  const fz = {};
  for (const [a, v] of Object.entries(frozen || {})) if (BigInt(v) > 0n) fz[a] = String(v);
  all[tag] = { at: Date.now(), perAsset, frozen: fz };
  await stSet('local', SUM_KEY, all);
}

// One on-chain address of the leaf wallet, the same each time it is asked: the address
// a site shows for funding a board or an exit's fee coin. Taking a new one on every ask
// would let a site grow the wallet's scan without end.
export async function address() {
  await requireLeaves();
  const tag = await walletTag();
  const all = (await stGet('local', ADDRESS_KEY)) || {};
  if (all[tag] && all[tag].address) return all[tag];
  const a = await run('address');
  all[tag] = { address: a.address, script_pubkey: a.script_pubkey };
  await stSet('local', ADDRESS_KEY, all);
  return all[tag];
}

// The host's answers come back as messages; the service worker never blocks on one.
async function host(op, args = {}) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ scope: 'leaf', op, args });
  if (!r) throw new LeafError({ kind: 'worker', message: 'the leaf wallet did not answer' });
  if (!r.ok) throw new LeafError(r.error);
  return r.value;
}

// Joins an operator: creates the leaf wallet of this mnemonic against `cfg`, which pins
// the operator's key and the node's chain (the library's `create`). Answers its `info`.
export async function join(cfg) {
  const mnemonic = await sessionMnemonic();
  if (!mnemonic) throw new Error('the wallet is locked');
  if (!cfg || !cfg.server || !cfg.node_url) throw new Error('name the operator’s server and the node');
  const clean = {};
  for (const k of ['server', 'node_url', 'node_user', 'node_password', 'exit_delay_units', 'min_exit_delay_units', 'max_exit_delay_units', 'tick_ms', 'care_ms']) {
    if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '') clean[k] = cfg[k];
  }
  const v = await host('start', { mnemonic, config: clean, nodePassword: clean.node_password, tickMs: clean.tick_ms, careMs: clean.care_ms, scan: scanNow() });
  // A wallet created now answers its `info` as every command answers, { result, start }.
  const info = (v.info && v.info.result) || (await host('run', { command: 'info' })).result;
  await setConfig({ ...clean, operator: info && info.operator, joinedAt: Date.now() });
  return info;
}

// The kit wallet's next receive index, which the service worker knows and the host does
// not: `care` looks for claims under it and 20 more keys (`claimScan`).
let receiveIndex = () => null;
export function setReceiveIndexSource(fn) { receiveIndex = fn; }
const scanNow = () => { try { return claimScan(receiveIndex()); } catch { return claimScan(null); } };

// Opens the leaf wallet in the offscreen host when this wallet joined an operator and is
// unlocked, in either mode; when it is already open, tells it the receive keys `care`
// scans. Answers whether it is open.
export async function ensureRunning() {
  const cfg = await config();
  if (!cfg) return false;
  const mnemonic = await sessionMnemonic();
  if (!mnemonic) return false;
  const st = await host('status');
  if (st.open) {
    const scan = scanNow();
    if (st.scan !== scan) await host('scan', { scan });
    return true;
  }
  await host('start', { mnemonic, nodePassword: cfg.node_password, tickMs: cfg.tick_ms, careMs: cfg.care_ms, scan: scanNow() });
  return true;
}

// Closes the leaf wallet (on lock). Never brings the offscreen document up just to
// close it.
export async function stop() {
  if (!(await offscreenUp())) return;
  try { await chrome.runtime.sendMessage({ scope: 'leaf', op: 'stop', args: {} }); } catch {}
}

// What a provider method needs before it may touch leaves.
export async function requireLeaves() {
  if ((await mode()) !== 'developer') throw new Error(NOT_DEVELOPER);
  if (!(await config())) throw new Error(NOT_JOINED);
  if (!(await sessionMnemonic())) throw new Error('the wallet is locked');
  try { await ensureRunning(); } catch (e) {
    throw new LeafError({ kind: e.kind || 'worker', message: 'the leaf wallet did not start: ' + e.message });
  }
}

// One command of the library that a person or a site starts: its `result` (the `start`
// part is the library's own witness and re-check, which it acts on itself). A command the
// unplanned coins cannot cover and planned ones can is made through the next round, by
// itself: the host gives the planned coins up in that round and asks again once it is
// final (`payThrough`, src/leaf-schedule.js), so the answer can take one round.
export async function run(command, args = {}) {
  await requireLeaves();
  return (await host('run', { command, args, paying: true })).result;
}
// One command of the library in either mode, for the work the wallet carries on by
// itself (a take's forfeits, an order's listing): what was started in developer mode
// must finish whatever the mode is now. Nothing reaches a site through it.
export async function runAny(command, args = {}) {
  if (!(await config())) throw new Error(NOT_JOINED);
  if (!(await sessionMnemonic())) throw new Error('the wallet is locked');
  await ensureRunning();
  return (await host('run', { command, args })).result;
}

// An operation of the offscreen host itself (`watch`: the takes to sync for).
export async function hostOp(op, args = {}) {
  if (!(await ensureRunning())) return null;
  return await host(op, args);
}

export async function status() {
  if (!(await offscreenUp())) return { open: false };
  return await host('status');
}
// `care` now, whenever it last ran (developer mode's Run now).
export async function careNow() {
  await requireLeaves();
  return await host('care');
}
export async function syncNow() {
  await requireLeaves();
  return (await host('sync')).result;
}
