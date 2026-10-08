// The service worker's side of the leaf wallet (developer mode).
//
// The leaf wallet itself runs in the offscreen document (offscreen-leaves.js), which
// holds the operator wallet library's store and syncs it on the library's schedule.
// This module keeps the wallet's mode and the operator the user joined, starts the
// offscreen host when the wallet unlocks, closes it when the wallet locks, and asks it
// for what the provider and the popup need. Nothing about a leaf is decided here:
// every answer and every refusal is the library's.

import { ensureOffscreen, offscreenUp } from './offscreen-doc.js';
import { stGet, stSet } from './util.js';
import { sessionMnemonic } from './vault.js';

const CONFIG_KEY = 'ext.leaves';
const SETTINGS_KEY = 'ext.settings';

export const NOT_DEVELOPER = 'leaves are a developer-mode rail: turn developer mode on in the wallet’s Settings';
export const NOT_JOINED = 'this wallet has not joined a leaf operator: join one in the wallet’s Settings';

// A refusal from the library (or the host), in its own words.
export class LeafError extends Error {
  constructor(e) {
    super((e && e.message) ? e.message : String(e));
    this.kind = (e && e.kind) || 'error';
    if (e && e.code) this.code = e.code;
    if (e && e.status) this.status = e.status;
  }
}

// ---- the mode: one setting, 'user' until the user changes it ----
export async function mode() {
  const s = (await stGet('local', SETTINGS_KEY)) || {};
  return s.mode === 'developer' ? 'developer' : 'user';
}
export async function setMode(m) {
  if (m !== 'developer' && m !== 'user') throw new Error("the mode is 'developer' or 'user'");
  const s = (await stGet('local', SETTINGS_KEY)) || {};
  s.mode = m;
  await stSet('local', SETTINGS_KEY, s);
  return m;
}

// ---- the operator joined: its server, the node, the exit delays ----
export async function config() { return (await stGet('local', CONFIG_KEY)) || null; }

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
  for (const k of ['server', 'node_url', 'node_user', 'node_password', 'exit_delay_units', 'min_exit_delay_units', 'max_exit_delay_units', 'tick_ms']) {
    if (cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== '') clean[k] = cfg[k];
  }
  const v = await host('start', { mnemonic, config: clean, nodePassword: clean.node_password, tickMs: clean.tick_ms });
  // A wallet created now answers its `info` as every command answers, { result, start }.
  const info = (v.info && v.info.result) || (await host('run', { command: 'info' })).result;
  await stSet('local', CONFIG_KEY, { ...clean, operator: info && info.operator, joinedAt: Date.now() });
  return info;
}

// Opens the leaf wallet in the offscreen host when developer mode is on, an operator is
// joined and the wallet is unlocked; a no-op when it is already open. Answers whether
// it is open.
export async function ensureRunning() {
  if ((await mode()) !== 'developer') return false;
  const cfg = await config();
  if (!cfg) return false;
  const mnemonic = await sessionMnemonic();
  if (!mnemonic) return false;
  const st = await host('status');
  if (st.open) return true;
  await host('start', { mnemonic, nodePassword: cfg.node_password, tickMs: cfg.tick_ms });
  return true;
}

// Closes the leaf wallet (on lock, or when developer mode is turned off). Never brings
// the offscreen document up just to close it.
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

// One command of the library: its `result` (the `start` part is the library's own
// witness and re-check, which it acts on itself).
export async function run(command, args = {}) {
  await requireLeaves();
  return (await host('run', { command, args })).result;
}
export async function status() {
  if (!(await offscreenUp())) return { open: false };
  return await host('status');
}
export async function syncNow() {
  await requireLeaves();
  return (await host('sync')).result;
}
