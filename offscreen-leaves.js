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
// `balance` as `leafBalance`, which the service worker keeps for the popup, with what of
// each asset its issuer has frozen for this wallet (`frozen`: held leaves of a supervised
// asset whose landing the node shows frozen or the asset paused, and the on-chain coins the
// library counts frozen). While it holds a leaf of a supervised asset it reads its coins on
// every tick, so a freeze or a lift shows within a tick.
//
// At care's pace, in either mode, it reads the operator's equivocation bond (`bond`: once
// the wallet has seen it bonded, the library requires it from then on, and refuses a
// receive or a swap while it is missing or in notice) and runs `watch_bond`, which checks
// the wallet's evidence against the chain and the mempool and sends the slash itself
// should the operator key have signed twice under one salt. Both are kept for developer
// mode (`status`: `bond`, `lastWatch`); nothing is said while the bond stands.
//
// What the wallet does by itself, in either mode, is the library's `care`, run once after
// the wallet opens and after a sync or a tick of the schedule at most every ten minutes
// (`careDue`): it takes up every open claim named for one of the wallet's receive keys
// (`scan`: the kit wallet's next receive index and 20 more, which the service worker
// keeps current), cancels each refresh plan whose coin has moved, plans a coin of a round
// once its first step could run within ten days, and asks a round's refresh for a coin no
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
//   'watchBond'                             -> reads the bond and runs `watch_bond` now
//   'stop'                                  -> closes the wallet and stops the schedule
//   'defaults' { on, quietUntil? }          -> default mode on the pinned operator, or not:
//        while on, coins that land at the wallet's address on the chain are boarded by
//        themselves (vendor/default-arca.js, never before `quietUntil`, when the kit wallet's
//        own payment may still be spending them), and the mailbox is read every few seconds
//        while nothing is asked, so a payment to the receive code shows at once
// The mnemonic is handed to the worker and not kept here.

import { inFlight, nextAskMs, freshRequestWaits, syncDecision, careDue, careSummary, careArgs, payThrough, CARE_EVERY_MS, laterMode } from './src/leaf-schedule.js';
import { frozenAtoms } from './src/leaf-profiles.js';
import { redoingAtoms } from './vendor/default-arca.js';
import { boardCandidates, boardAll, boardSpent } from './vendor/default-arca.js';

const TICK_MS = 60_000;
let worker = null;
let next = 1;
const pending = new Map();
let failed = null;
const S = { open: false, fp: null, timer: null, heldFor: null, schedule: null, coins: [], participations: [], lastSync: null, lastError: null, tickMs: TICK_MS,
  watch: new Set(), watchMs: 3000, seen: new Map(), scan: null, careAt: null, careMs: CARE_EVERY_MS, lastCare: null, releasing: null, bond: null, lastWatch: null,
  defaultMode: false, defaultModeAt: -1, quietUntil: 0, lastAsked: 0, info: null, boardRefused: new Map(), lastBoard: null, mailTimer: null };

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
// change it, which keeps it for the popup's figures and headline (`leafBalance`), with
// what of each asset is frozen by its issuer (both modes show it under the figure).
async function reportBalance() {
  try {
    const b = (await call('run', { command: 'balance' })).result;
    const frozen = {};
    for (const [a, v] of frozenAtoms(S.coins, b)) frozen[a] = v.toString();
    S.frozenShown = Object.keys(frozen).length > 0;
    // What of each asset a Bitcoin reorganisation took back out of the chain and is being redone.
    const redoing = {};
    for (const c of S.coins || []) if (c && c.asset && redoing[c.asset] === undefined) { const n = redoingAtoms(S.coins, c.asset); if (n > 0n) redoing[c.asset] = n.toString(); }
    // What a board just made spent on the chain, once: the service worker keeps it until its own
    // reading of the chain shows the coins spent (onchainLessBoards).
    const boards = S.newBoards || {};
    S.newBoards = {};
    emit('leafBalance', { balance: b, frozen, redoing, boards });
  } catch { /* the next change reports it again */ }
}
// Whether the wallet holds a leaf of a supervised asset (one that lands at its key), or
// shows something frozen (a landed coin stays frozen on the chain until a lift).
const SUPERVISED_HELD = new Set(['pending', 'live', 'offered', 'sending', 'given', 'forfeited', 'exiting']);
function holdsSupervised() {
  return !!S.frozenShown || S.coins.some((c) => c.landing && SUPERVISED_HELD.has(c.state));
}
const SCAN_BUSY = /Scan already in progress/;
const READS = new Set(['info', 'address', 'balance', 'coins', 'record', 'boards', 'participations', 'schedule', 'refusals', 'quote', 'board_quote', 'exit_quote',
  'take_quote', 'order_quote', 'orders', 'plans', 'claims', 'distributions',
  // The trade composer's quotes and reads (vendor/user-trade.js): they move no coin.
  'settle_quote', 'order_fill_resting_quote', 'swap_read', 'swaps', 'offboard_quote',
  'lightning_pay_quote', 'lightning_receive_quote', 'lightning_payments', 'lightning_receives']);

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
  await watchBond();
  return S.lastCare;
}

// The operator's bond, read (which engages the library's ratchet) and watched.
async function watchBond() {
  try { S.bond = (await call('run', { command: 'bond' })).result; } catch (e) { S.bond = { error: errorOf(e) }; }
  try { S.lastWatch = { at: Date.now(), value: (await call('run', { command: 'watch_bond', args: {} })).result }; }
  catch (e) { S.lastWatch = { at: Date.now(), error: errorOf(e) }; }
  const w = S.lastWatch.value || {};
  console.info(`[leaves] bond: ${S.bond && (S.bond.state || (S.bond.error && S.bond.error.message))}; watch: ${(w.slashed || []).length} slash(es)${S.lastWatch.error ? ', ' + S.lastWatch.error.message : ''}`);
  return { bond: S.bond, lastWatch: S.lastWatch };
}

function plan(ms) {
  clearTimeout(S.timer);
  if (!S.open) return;
  S.timer = setTimeout(() => { tick().catch(() => {}); }, ms);
}


// ---- default mode: coins on the chain go into the tree, payments show in seconds ----
const MAILBOX_POLL_MS = 10_000;
const MAILBOX_QUIET_MS = 20_000;

// Each asset the operator serves, held at the phrase's keys on the chain at least at its
// smallest leaf, is boarded whole less its fee (vendor/default-arca.js boardAll: the fee the
// library quoted for that very board, in the asset boarded). Coins the library refused to
// board are asked again only once they change.
// The leaf wallet finds its on-chain coins by a gap of 20 unused keys past the last key it handed
// out or saw holding an UNSPENT coin, where the kit wallet finds them by a gap past the last key
// with any history: a coin at a key past the leaf wallet's window (keys used and spent before it
// looked) is shown in the balance and never boarded. So the leaf wallet is handed keys (`address`,
// each the next key) until its window covers every key the kit wallet handed out (`S.scan`, the
// receive index and 20 more), once per key, remembered per wallet in this document's storage.
async function coverReceiveKeys() {
  const want = Number(S.scan || 0) - 20;
  if (!(want > 0) || !S.fp) return 0;
  const key = 'ext.leaves.window.' + S.fp;
  let had = 0;
  try { had = Number(localStorage.getItem(key) || 0); } catch {}
  let n = 0;
  for (let i = had; i < want; i++) {
    try { await call('run', { command: 'address' }); } catch (e) { console.warn('[leaves] handing the leaf wallet its keys:', e && e.message); break; }
    n++;
    try { localStorage.setItem(key, String(i + 1)); } catch {}
  }
  if (n) console.info(`[leaves] the leaf wallet reads its on-chain coins up to key ${had + n + 20} now (${n} key(s) handed to it)`);
  return n;
}

async function boardArrivals() {
  if (!S.open || !S.defaultMode || Date.now() < S.quietUntil) return;
  if (!S.info) { try { S.info = (await call('run', { command: 'info' })).result; } catch { return; } }
  await coverReceiveKeys();
  let balance;
  try { balance = (await call('run', { command: 'balance' })).result; } catch { return; }
  let boarded = false;
  for (const c of boardCandidates(balance, S.info)) {
    if (S.boardRefused.get(c.asset) === String(c.onchain)) continue;
    try {
      const v = await boardAll(async (cmd, a) => (await runCommand(cmd, a)).result, c);
      if (v) {
        boarded = true; S.lastBoard = { at: Date.now(), asset: c.asset, value: v };
        if (v.spent) (S.newBoards || (S.newBoards = {}))[c.asset] = boardSpent(c.onchain, v.spent, Date.now());
        emit('leafArrived', { asset: c.asset, value: String(c.onchain), kind: 'board' });
      }
      else S.boardRefused.set(c.asset, String(c.onchain));
      console.info(`[leaves] board of ${c.asset.slice(0, 8)}: ${v ? 'boarded' : 'nothing to board after the fee'}`);
    } catch (e) {
      S.boardRefused.set(c.asset, String(c.onchain));
      S.lastBoard = { at: Date.now(), asset: c.asset, error: errorOf(e) };
      console.warn(`[leaves] board of ${c.asset.slice(0, 8)} refused: ${e && e.message}`);
    }
  }
  if (boarded) await reportBalance();
}

// Default mode: every coin received out of round is given up in the operator's next round for
// a coin of the wallet's own (`refresh_received`), which ends what its senders could still do
// with it; at most once every two minutes, and not while the wallet's own payment is under way.
// Until that round is final the coin counts as arriving. Nothing is said unless it goes wrong.
const REFRESH_EVERY_MS = 120_000;
async function refreshReceived() {
  if (!S.open || !S.defaultMode || Date.now() < S.quietUntil) return;
  if (S.refreshedAt && Date.now() - S.refreshedAt < REFRESH_EVERY_MS) return;
  S.refreshedAt = Date.now();
  try {
    const v = await runCommand('refresh_received', {});
    const r = (v && v.result) || {};
    S.lastRefresh = { at: Date.now(), value: r };
    if ((r.refreshed || []).length) { console.info(`[leaves] ${r.refreshed.length} coin(s) received out of round given up in the next round`); await reportBalance(); }
    for (const l of r.left || []) console.info(`[leaves] a received coin left as it is: ${l.why}`);
  } catch (e) {
    S.lastRefresh = { at: Date.now(), error: errorOf(e) };
    console.warn(`[leaves] refreshing what was received: ${e && e.message}`);
  }
}

function watchMailbox() {
  clearTimeout(S.mailTimer);
  if (!S.open || !S.defaultMode) return;
  S.mailTimer = setTimeout(async () => {
    if (S.open && S.defaultMode && !ticking && Date.now() - S.lastAsked > MAILBOX_QUIET_MS) {
      try {
        const mb = (await call('run', { command: 'mailbox' })).result;
        if (mb && ((mb.accepted || []).length || (mb.pending || []).length)) {
          arrivals(mb);
          await reportBalance();
        }
      } catch { /* the next read tries again */ }
    }
    watchMailbox();
  }, MAILBOX_POLL_MS);
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
    // A freeze or a lift is read from the node at each coin's landing by `coins`: while
    // the wallet holds a leaf of a supervised asset, read them on every tick.
    if (!d.sync && holdsSupervised()) {
      S.coins = (await call('run', { command: 'coins' })).result || [];
      await reportBalance();
    }
    if (S.defaultMode) await boardArrivals();
    if (S.defaultMode) await refreshReceived();
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
      // A command that moves coins (a take, an order, a board, a send) changes what
      // the schedule follows: read the coins and participations again now, so the
      // next tick syncs for what moves instead of waiting for the next sync to see it.
      try {
        S.coins = (await call('run', { command: 'coins' })).result || [];
        S.participations = (await call('run', { command: 'participations' })).result || [];
      } catch { /* the next sync reads them */ }
      await reportBalance();
      if (inFlight(S.coins, S.participations)) plan(1000);
    }
  }
}

// Default mode's upkeep follows the mode set last: each message carries when the mode it was read
// from was set, and an older one than the host already has is ignored (a start that read the
// mode before the person changed it arrives after the change).
function setDefaultMode(on, at) {
  const v = laterMode({ on: S.defaultMode, at: S.defaultModeAt }, on, at);
  S.defaultMode = v.on;
  S.defaultModeAt = v.at;
}

// Starts run one at a time, so two at once open the wallet once.
let starting = Promise.resolve();

async function start(args) {
  if (!args.mnemonic) throw { kind: 'refused', message: 'the wallet is locked' };
  if (args.tickMs) S.tickMs = Number(args.tickMs);
  if (args.careMs) S.careMs = Math.max(1000, Number(args.careMs));
  if (args.scan) S.scan = Number(args.scan);
  if (args.defaultMode !== undefined) setDefaultMode(args.defaultMode, args.defaultModeAt);
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
  S.info = null;
  S.boardRefused = new Map();
  await reportBalance();
  plan(0);
  watchMailbox();
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
      return { open: S.open, lastSync: S.lastSync, lastError: S.lastError, schedule: S.schedule, lastCare: S.lastCare, scan: S.scan, releasing: S.releasing,
        bond: S.bond, lastWatch: S.lastWatch, defaultMode: S.defaultMode, lastBoard: S.lastBoard };
    case 'scan':
      if (args.scan) S.scan = Number(args.scan);
      return { scan: S.scan };
    case 'care':
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      return await careIfDue(true);
    case 'watchBond':
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      return await watchBond();
    case 'run': {
      if (!S.open) throw { kind: 'refused', message: 'the leaf wallet is not open' };
      const command = String(args.command);
      if (args.paying) S.lastAsked = Date.now();
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
    case 'defaults':
      setDefaultMode(args.on, args.at);
      if (args.quietUntil) S.quietUntil = Math.max(S.quietUntil, Number(args.quietUntil));
      watchMailbox();
      return { defaultMode: S.defaultMode, quietUntil: S.quietUntil };
    case 'stop':
      clearTimeout(S.mailTimer);
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
