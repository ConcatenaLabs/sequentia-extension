// The leaf wallet's host in the offscreen document.
//
// The leaf wallet is the operator's wallet library compiled to wasm (leaves/pkg),
// run in a dedicated worker (leaves/worker.js): the library is blocking, and only a
// worker may block on its synchronous requests. This module owns that worker for as
// long as the offscreen document lives, so the service worker never waits on a sync:
// it asks, and the answer comes back as a message.
//
// When a wallet opens it syncs once, whatever the schedule says (a planned coin's step
// is taken up only by a sync), then runs `care`.
//
// While a wallet is open it syncs on the library's own schedule (`schedule`: when a
// coin's refresh window opens, while a receive request waits; when it falls due, and
// when the time it first gave after the last sync arrives, whatever `due` says), and
// every 30 s while
// something is moving (a coin pending, being sent, given or on its way out, or a
// participation not done). Each sync's mailbox answer becomes `leafArrived` events,
// and a schedule that falls due becomes `leafSyncDue`, sent to the service worker,
// which relays them to connected sites.
//
// After every sync and every command that can change a balance, it reports the library's
// `balance` as `leafBalance`, which the service worker keeps for the popup.
//
// What the wallet does by itself, in either mode, is the library's `care`, run once after
// the wallet opens and after a sync or a tick of the schedule at most every ten minutes
// (`careDue`): it takes up every open claim named for one of the wallet's receive keys
// (`scan`: the kit wallet's next receive index and 20 more, which the service worker
// keeps current), cancels each refresh plan whose coin has moved, plans every coin of a
// round (`plan_within`: PLAN_EVERY_ROUND_LEAF), and asks a round's refresh for a coin no
// round made once that refresh could run within ten days. A claim taken up counts in the
// balance like any leaf. Each run is reported as `leafCared` and kept for developer mode
// (`status`).
//
// A planned coin is paid out of round by no wallet, so every command a person or a site
// starts (`run` with `paying`) is asked through `payThrough`: a refusal of kind `planned`
// gives the coins the library names up in the next round (`plan_release`), syncs every
// 15 s until that round has freed them, and asks the same command again. The host carries
// that wait itself, so it outlives the service worker; while it waits, `status` names what
// is released (`releasing`) and `leafReleasing` is sent.
//
// Messages (scope 'leaf'), answered { ok, value } or { ok: false, error: { kind, message } }:
//   'status'                                -> { open, lastSync, lastError, schedule }
//   'start' { mnemonic, config?, nodePassword? } -> opens the wallet of that mnemonic
//        (created against `config` when this browser holds none); answers { created, info? }
//   'run'   { command, args, paying? }      -> the library's { result, start }; with
//        `paying`, a command the planned coins cover is made through the next round
//   'sync'                                  -> runs sync now (events as on the schedule)
//   'watch' { takes, tickMs? }              -> the takes to sync for every tickMs while
//        their forfeits wait on the wallet; each change of one is sent as `leafTake`
//   'scan'  { scan }                        -> the receive keys `care` looks for claims under
//   'care'                                  -> runs `care` now, whenever it last ran
//   'stop'                                  -> closes the wallet and stops the schedule
// The mnemonic is handed to the worker and not kept here.

import { inFlight, nextAskMs, freshRequestWaits, syncDecision, careDue, careSummary, careArgs, payThrough, CARE_EVERY_MS } from './src/leaf-schedule.js';

const TICK_MS = 60_000;
let worker = null;
let next = 1;
const pending = new Map();
let failed = null;
const S = { open: false, fp: null, timer: null, heldFor: null, schedule: null, coins: [], participations: [], lastSync: null, lastError: null, tickMs: TICK_MS,
  watch: new Set(), watchMs: 3000, seen: new Map(), scan: null, careAt: null, careMs: CARE_EVERY_MS, lastCare: null, releasing: null };

function errorOf(e) {
  if (e && typeof e === 'object' && e.message) {
    const out = { kind: e.kind || 'error', message: e.message, code: e.code, status: e.status };
    // A payment the planned coins would cover: their asset, and which to give up.
    if (e.asset) out.asset = e.asset;
    if (Array.isArray(e.release)) out.release = e.release;
    return out;
  }
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

// The leaf wallet's balance, reported to the service worker after anything that can
// change it, which keeps it for the popup's figures and headline (`leafBalance`).
async function reportBalance() {
  try {
    const b = (await call('run', { command: 'balance' })).result;
    emit('leafBalance', { balance: b });
  } catch { /* the next change reports it again */ }
}
const SCAN_BUSY = /Scan already in progress/;
const READS = new Set(['info', 'address', 'balance', 'coins', 'record', 'boards', 'participations', 'schedule', 'refusals', 'quote', 'board_quote', 'exit_quote',
  'take_quote', 'order_quote', 'orders', 'plans', 'claims', 'distributions']);

// The takes the service worker asked the host to watch (`watch`): while one waits on
// the wallet (its forfeits not yet handed over), the host syncs every `watchMs`, so
// they go in as soon as the operator builds the round, well inside its forfeit window.
// Each change of a watched take is reported as `leafTake`.
const TAKE_WAITS = new Set(['pending', 'issued']);
function takeWaits() {
  return S.participations.some((p) => S.watch.has(p.participation) && !p.released && TAKE_WAITS.has(String(p.state)));
}
function reportTakes() {
  for (const p of S.participations) {
    if (!S.watch.has(p.participation)) continue;
    const key = `${p.state}/${p.round || ''}/${p.released ? 1 : 0}`;
    if (S.seen.get(p.participation) === key) continue;
    S.seen.set(p.participation, key);
    console.info(`[leaves] take ${p.participation.slice(0, 12)}…: ${p.state}${p.round ? ', round ' + p.round.slice(0, 12) + '…' : ''}${p.released ? ', released' : ''}`);
    emit('leafTake', { take: p.participation, participation: p });
  }
}

function arrivals(mailbox) {
  for (const c of ((mailbox && mailbox.accepted) || [])) {
    emit('leafArrived', { leaf_id: c.leaf_id, asset: c.asset, value: String(c.value ?? ''), kind: c.kind });
  }
}

async function sync(by) {
  const v = await call('run', { command: 'sync', args: {} });
  const r = (v && v.result) || {};
  S.heldFor = null;
  S.lastSync = { at: Date.now(), by };
  console.info(`[leaves] sync (${by}): mailbox accepted ${((r.mailbox && r.mailbox.accepted) || []).length}`);
  arrivals(r.mailbox);
  emit('leafSynced', { by, mailbox: r.mailbox || null });
  try {
    S.coins = (await call('run', { command: 'coins' })).result || [];
    S.participations = (await call('run', { command: 'participations' })).result || [];
  } catch { /* the next tick reads them again */ }
  reportTakes();
  await reportBalance();
  return v;
}

// `care`, when it is due (or `force`d): the wallet's own upkeep, with no prompt.
async function careIfDue(force = false) {
  if (!S.open || (!force && !careDue(S.careAt, Date.now(), S.careMs))) return null;
  S.careAt = Date.now();
  try {
    const v = (await call('run', { command: 'care', args: careArgs(S.scan) })).result;
    const sum = careSummary(v);
    S.lastCare = { at: Date.now(), value: v, summary: sum };
    console.info(`[leaves] care: ${sum.taken} claim(s) taken up, ${sum.planned} plan(s) signed, ${sum.cancelled} cancelled, ${sum.refreshing} sent to a round, ${sum.later} not yet near`);
    if (sum.taken || sum.planned || sum.cancelled || sum.refreshing) {
      try {
        S.coins = (await call('run', { command: 'coins' })).result || [];
        S.participations = (await call('run', { command: 'participations' })).result || [];
      } catch { /* the next sync reads them */ }
      await reportBalance();
    }
    // A claim taken up arrives as any coin does: the asset is its coin's.
    for (const c of (v && Array.isArray(v.claims) ? v.claims : [])) {
      if (!c || !c.taken_up || c.error) continue;
      const coin = S.coins.find((x) => x.leaf_id === c.leaf_id);
      emit('leafArrived', { leaf_id: c.leaf_id, asset: coin ? coin.asset : null, value: String(c.value ?? ''), kind: 'claim' });
    }
  } catch (e) {
    S.lastCare = { at: Date.now(), error: errorOf(e) };
    console.warn('[leaves] care failed:', S.lastCare.error.message);
  }
  emit('leafCared', S.lastCare);
  return S.lastCare;
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
    let d = syncDecision(s, S.heldFor, moving);
    S.heldFor = d.held;
    // A take the service worker asked to watch, and the host has not synced since:
    // sync now, whatever the schedule says (its forfeits may be due within minutes).
    if (!d.sync && S.watchPending) d = { sync: true, why: 'take' };
    // Once when the wallet opens, whatever the schedule says: the schedule wakes a
    // planned coin only at its plan's sync_by, and a wallet back after an expiry must
    // take up the coin the plan's step made before it shows its balance.
    if (!d.sync && S.syncOnOpen) d = { sync: true, why: 'open' };
    if (d.sync) {
      S.watchPending = false;
      await sync(d.why);
      S.syncOnOpen = false;
      await careIfDue();
      S.schedule = (await call('run', { command: 'schedule' })).result;
    } else if (careDue(S.careAt, Date.now(), S.careMs)) {
      await careIfDue();
      S.schedule = (await call('run', { command: 'schedule' })).result;
    } else if (freshRequestWaits(s)) {
      // A request just handed out: read the mailbox, not the whole sync.
      const mb = (await call('run', { command: 'mailbox' })).result;
      if (mb && mb.accepted && mb.accepted.length) console.info(`[leaves] mailbox read (a request waits): accepted ${mb.accepted.length}`);
      arrivals(mb);
      if (mb && mb.accepted && mb.accepted.length) await reportBalance();
      S.schedule = (await call('run', { command: 'schedule' })).result;
    }
    S.lastError = null;
    wait = inFlight(S.coins, S.participations) ? Math.min(S.tickMs, 30_000) : nextAskMs(S.schedule, S.tickMs);
    if (takeWaits()) wait = Math.min(wait, S.watchMs);
  } catch (e) {
    S.lastError = errorOf(e);
    console.warn('[leaves] the scheduled pass failed:', S.lastError.message);
  }
  ticking = false;
  plan(Math.max(wait, 1000));
}

// One command of the library. The node runs one UTXO-set scan at a time, and every wallet
// sharing it scans: a read refused for that alone is asked again, a little later. A
// command that signs or moves anything is never repeated here; the caller sees the refusal.
async function runCommand(command, cargs) {
  try {
    for (let i = 0; ; i++) {
      try { return await call('run', { command, args: cargs }); }
      catch (e) {
        if (!(READS.has(command) || command === 'sync') || i >= 8 || !SCAN_BUSY.test(String((e && e.message) || e))) throw e;
        await new Promise((r) => setTimeout(r, 750 * (i + 1)));
      }
    }
  } finally {
    if (!READS.has(command)) {
      await reportBalance();
      // A command that moves coins (a take, an order, a board, a send) changes what
      // the schedule follows: read the coins and participations again now, so the
      // next tick syncs for what moves instead of waiting for the next sync to see it.
      try {
        S.coins = (await call('run', { command: 'coins' })).result || [];
        S.participations = (await call('run', { command: 'participations' })).result || [];
      } catch { /* the next sync reads them */ }
      if (inFlight(S.coins, S.participations)) plan(1000);
    }
  }
}

// Starts run one at a time, so two at once open the wallet once.
let starting = Promise.resolve();

async function start(args) {
  if (!args.mnemonic) throw { kind: 'refused', message: 'the wallet is locked' };
  if (args.tickMs) S.tickMs = Number(args.tickMs);
  if (args.careMs) S.careMs = Math.max(1000, Number(args.careMs));
  if (args.scan) S.scan = Number(args.scan);
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
    // A phrase that already holds leaves with this operator (another browser, Ambra, the web
    // wallet) finds them under its mailbox key: restore once, as Ambra's join does.
    try { await call('run', { command: 'restore', args: {} }); } catch (e) { console.warn('[leaves] restore after joining:', e && e.message); }
  }
  S.open = true;
  S.fp = fp;
  S.careAt = null;      // care once after the wallet opens,
  S.syncOnOpen = true;  // after one sync
  console.info(`[leaves] the leaf wallet is open (${has ? 'from its store' : 'created'}); it syncs on its schedule`);
  await reportBalance();
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
      return { open: S.open, lastSync: S.lastSync, lastError: S.lastError, schedule: S.schedule, lastCare: S.lastCare, scan: S.scan, releasing: S.releasing };
    case 'scan':
      if (args.scan) S.scan = Number(args.scan);
      return { scan: S.scan };
    case 'care':
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      return await careIfDue(true);
    case 'run': {
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      const command = String(args.command);
      if (!args.paying) return await runCommand(command, args.args || {});
      return await payThrough(command, args.args || {}, {
        run: runCommand,
        sync: () => sync('release'),
        coins: async () => (await call('run', { command: 'coins' })).result || [],
        waiting: (st) => {
          const first = !!st && !S.releasing;
          S.releasing = st ? { command: st.command, coins: st.coins, asset: st.asset, since: st.since } : null;
          if (first) console.info(`[leaves] ${st.command}: the unplanned leaves fall short; ${st.coins.length} planned leaf(s) given up in the next round, the payment asked again once it is final`);
          emit('leafReleasing', S.releasing);
        },
      });
    }
    case 'sync':
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      return await sync('asked');
    case 'watch': {
      S.watch = new Set((args.takes || []).map(String));
      if (args.tickMs) S.watchMs = Math.max(1000, Number(args.tickMs));
      // A take just made, or one left from before a restart: sync for it now.
      if (S.open && S.watch.size) { S.watchPending = true; plan(0); }
      return { watching: [...S.watch] };
    }
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
