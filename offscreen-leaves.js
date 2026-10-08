// The leaf wallet's host in the offscreen document.
//
// The leaf wallet is the operator's wallet library compiled to wasm (leaves/pkg),
// run in a dedicated worker (leaves/worker.js): the library is blocking, and only a
// worker may block on its synchronous requests. This module owns that worker for as
// long as the offscreen document lives, so the service worker never waits on a sync:
// it asks, and the answer comes back as a message.
//
// While a wallet is open it syncs on the library's own schedule (`schedule`: when a
// coin's refresh window opens, while a receive request waits), and every 30 s while
// something is moving (a coin pending, being sent, given or on its way out, or a
// participation not done). Each sync's mailbox answer becomes `leafArrived` events,
// and a schedule that falls due becomes `leafSyncDue`, sent to the service worker,
// which relays them to connected sites.
//
// Messages (scope 'leaf'), answered { ok, value } or { ok: false, error: { kind, message } }:
//   'status'                                -> { open, lastSync, lastError, schedule }
//   'start' { mnemonic, config?, nodePassword? } -> opens the wallet of that mnemonic
//        (created against `config` when this browser holds none); answers { created, info? }
//   'run'   { command, args }               -> the library's { result, start }
//   'sync'                                  -> runs sync now (events as on the schedule)
//   'stop'                                  -> closes the wallet and stops the schedule
// The mnemonic is handed to the worker and not kept here.

import { inFlight, nextAskMs, freshRequestWaits } from './src/leaf-schedule.js';

const TICK_MS = 60_000;
let worker = null;
let next = 1;
const pending = new Map();
let failed = null;
const S = { open: false, fp: null, timer: null, schedule: null, coins: [], participations: [], lastSync: null, lastError: null, tickMs: TICK_MS };

function errorOf(e) {
  if (e && typeof e === 'object' && e.message) return { kind: e.kind || 'error', message: e.message, code: e.code, status: e.status };
  return { kind: 'error', message: String(e) };
}

function ensureWorker() {
  if (worker && !failed) return;
  worker = new Worker(new URL('./leaves/worker.js', import.meta.url), { type: 'module' });
  failed = null;
  worker.onmessage = (ev) => {
    const m = ev.data || {};
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.ok(m.value); else p.no(m.error || { kind: 'error', message: 'the leaf wallet failed' });
  };
  worker.onerror = (ev) => {
    failed = { kind: 'worker', message: 'the leaf wallet did not start: ' + ((ev && ev.message) || 'the worker failed') };
    for (const p of pending.values()) p.no(failed);
    pending.clear();
  };
}

function call(op, args = {}) {
  ensureWorker();
  if (failed) return Promise.reject(failed);
  const id = next++;
  return new Promise((ok, no) => {
    pending.set(id, { ok, no });
    worker.postMessage({ id, op, args });
  });
}

async function fingerprint(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('leaf-host/' + String(text).trim()));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function emit(event, data) {
  chrome.runtime.sendMessage({ scope: 'leaf-event', event, data }).catch(() => {});
}

function arrivals(mailbox) {
  for (const c of ((mailbox && mailbox.accepted) || [])) {
    emit('leafArrived', { leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? ''), kind: c.kind });
  }
}

async function sync(by) {
  const v = await call('run', { command: 'sync', args: {} });
  const r = (v && v.result) || {};
  S.lastSync = { at: Date.now(), by };
  console.info(`[leaves] sync (${by}): mailbox accepted ${((r.mailbox && r.mailbox.accepted) || []).length}`);
  arrivals(r.mailbox);
  emit('leafSynced', { by, mailbox: r.mailbox || null });
  try {
    S.coins = (await call('run', { command: 'coins' })).result || [];
    S.participations = (await call('run', { command: 'participations' })).result || [];
  } catch { /* the next tick reads them again */ }
  return v;
}

function plan(ms) {
  clearTimeout(S.timer);
  if (!S.open) return;
  S.timer = setTimeout(() => { tick().catch(() => {}); }, ms);
}

let ticking = false;
async function tick() {
  if (!S.open || ticking) return;
  ticking = true;
  let wait = S.tickMs;
  try {
    const s = (await call('run', { command: 'schedule' })).result;
    S.schedule = s;
    const moving = inFlight(S.coins, S.participations);
    if (s && s.due) emit('leafSyncDue', { now: s.now, next_sync_at: s.next_sync_at, why: s.why ?? null });
    if ((s && s.due) || moving) {
      await sync(s && s.due ? 'schedule' : 'moving');
      S.schedule = (await call('run', { command: 'schedule' })).result;
    } else if (freshRequestWaits(s)) {
      // A request just handed out: read the mailbox, not the whole sync.
      const mb = (await call('run', { command: 'mailbox' })).result;
      if (mb && mb.accepted && mb.accepted.length) console.info(`[leaves] mailbox read (a request waits): accepted ${mb.accepted.length}`);
      arrivals(mb);
      S.schedule = (await call('run', { command: 'schedule' })).result;
    }
    S.lastError = null;
    wait = inFlight(S.coins, S.participations) ? Math.min(S.tickMs, 30_000) : nextAskMs(S.schedule, S.tickMs);
  } catch (e) {
    S.lastError = errorOf(e);
    console.warn('[leaves] the scheduled pass failed:', S.lastError.message);
  }
  ticking = false;
  plan(Math.max(wait, 1000));
}

// Starts run one at a time, so two at once open the wallet once.
let starting = Promise.resolve();

async function start(args) {
  if (!args.mnemonic) throw { kind: 'refused', message: 'the wallet is locked' };
  if (args.tickMs) S.tickMs = Number(args.tickMs);
  // Two callers may ask at once (an unlock, and a site's request): the wallet of
  // this mnemonic, already open, is left as it is. Only a digest of the mnemonic
  // is kept to tell.
  const fp = await fingerprint(args.mnemonic);
  if (S.open && S.fp === fp && !args.config) return { created: false, info: null };
  const has = await call('exists', { mnemonic: args.mnemonic });
  let info = null;
  if (has) {
    await call('open', { mnemonic: args.mnemonic, nodePassword: args.nodePassword || undefined });
  } else {
    if (!args.config) throw { kind: 'refused', message: 'this wallet has not joined a leaf operator: join one in the wallet’s Settings' };
    info = await call('create', { mnemonic: args.mnemonic, config: args.config });
  }
  S.open = true;
  S.fp = fp;
  console.info(`[leaves] the leaf wallet is open (${has ? 'from its store' : 'created'}); it syncs on its schedule`);
  plan(0);
  return { created: !has, info };
}

async function handle(op, args) {
  if (op === 'start') {
    const run = starting.then(() => start(args));
    starting = run.catch(() => {});
    return run;
  }
  switch (op) {
    case 'status':
      return { open: S.open, lastSync: S.lastSync, lastError: S.lastError, schedule: S.schedule };
    case 'run':
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      return await call('run', { command: String(args.command), args: args.args || {} });
    case 'sync':
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      return await sync('asked');
    case 'stop':
      if (S.open) console.info('[leaves] the leaf wallet is closed');
      S.open = false;
      S.fp = null;
      clearTimeout(S.timer);
      if (worker) await call('close').catch(() => {});
      return true;
    default:
      throw { kind: 'refused', message: 'no operation ' + op };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.scope !== 'leaf' || sender.id !== chrome.runtime.id) return;
  handle(msg.op, msg.args || {})
    .then((value) => sendResponse({ ok: true, value }))
    .catch((e) => sendResponse({ ok: false, error: errorOf(e) }));
  return true;
});
