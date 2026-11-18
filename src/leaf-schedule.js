// When the leaf wallet syncs by itself: pure rules over the library's answers,
// shared by the offscreen document's host and the tests. The same rules as the web
// wallet's developer mode (sequentia-web-wallet/leaves.js).

// Whether something is moving that sync must follow now, whatever the schedule says:
// a coin pending, being sent, held for an in-tree swap (the other wallet completes it,
// and only a sync reads what it pays this one), given to a participation, under a
// forfeit or on its way out, or a participation not yet done.
const MOVING = new Set(['pending', 'sending', 'offered', 'given', 'forfeited', 'exiting']);
const DONE_PARTICIPATION = new Set(['released', 'void', 'expired', 'refused']);
export function inFlight(coins, participations) {
  if ((coins || []).some((c) => MOVING.has(c.state))) return true;
  return (participations || []).some((p) => !DONE_PARTICIPATION.has(p.state) && !p.released);
}

// Whether to sync now. The time to hold to is the schedule's next_sync_at as it was
// first given after the last sync (`held`): a schedule that moves that time on at every
// read (a coin given to a refresh reads now + 1 h each time, and is not `due` until its
// home date) is still synced once the time first given arrives. Also when the schedule
// is due, and while something moves. Answers { sync, why, held } (the time to hold to
// next: null once a sync runs). The web wallet's leaves.js holds the same rule.
export function syncDecision(schedule, held, moving) {
  const s = schedule || {};
  const at = typeof held === 'number' ? held : (typeof s.next_sync_at === 'number' ? s.next_sync_at : null);
  if (s.due) return { sync: true, why: 'schedule', held: null };
  if (at != null && typeof s.now === 'number' && s.now >= at) return { sync: true, why: 'time', held: null };
  if (moving) return { sync: true, why: 'moving', held: null };
  return { sync: false, why: null, held: at };
}

// How long until the host asks again: the schedule's own time when it is nearer than
// the tick, otherwise the tick. A schedule that is due is due now.
export function nextAskMs(schedule, tickMs) {
  if (!schedule) return tickMs;
  if (schedule.due) return 0;
  const next = schedule.next_sync_at;
  const now = schedule.now;
  if (typeof next !== 'number' || typeof now !== 'number') return tickMs;
  return Math.max(0, Math.min(tickMs, (next - now) * 1000));
}

// Whether a receive request this wallet handed out still waits, however long ago: the codes the
// wallet's payment name leaves with the name service are such requests, handed out to payers up to
// a day after they were made. While one waits, the host reads the mailbox on every tick in either
// mode (default mode reads it every few seconds anyway), so a payment to the name or to an older
// code shows within a tick instead of at the library's next daily sync. A request handed out
// before requests carried a lapse date (`lapses_at` null) waits, for the library, until it is paid
// or forgotten; here it counts as waiting for REQUEST_HOLDS_S from when it was handed out, the
// life every request now has, and after that only the library's daily sync reads for it.
export const REQUEST_HOLDS_S = 27 * 86400;
export function requestWaits(schedule) {
  if (!schedule || typeof schedule.now !== 'number') return false;
  return (schedule.receive_requests || []).some((r) => {
    if (!r || r.state !== 'waiting' || r.owner === 'restored') return false;
    const lapses = typeof r.lapses_at === 'number' ? r.lapses_at : typeof r.asked_at === 'number' ? r.asked_at + REQUEST_HOLDS_S : null;
    return lapses != null && lapses > schedule.now;
  });
}

// A coin paid to a receive request that another store of the phrase handed out (the phrase open in
// another browser, in Ambra or in the web wallet, or a store this browser held before: the payment
// name's stock keeps their codes until each is handed out or lapses). Every store of the phrase
// reads it in its mailbox, and each one that never drew its owner nonce refuses it there, once;
// only the library's catch-up between stores of one phrase, a step of `sync`, takes it in. The
// library runs that step at most once every CATCH_UP_EVERY_S of median time (the chain's clock,
// the `now` of every `schedule`), and the step reads only what the operator has settled, so a
// catch-up run seconds after the payment can end whole without it (arca #904).
//
// So the host keeps the refused coins (`pending`, by leaf id) and syncs for them whenever the
// library's catch-up is open again, until each one is held: a catch-up restored it, or the
// wallet's coins list it. Between two attempts at least CATCH_UP_RETRY_MS pass, whatever the
// library answered or threw, and CATCH_UP_SLOW_MS once CATCH_UP_SLOW_AFTER attempts in a row ran
// no catch-up (the operator or the node not answering). The wait ends once every coin is held,
// after CATCH_UP_TRIES whole catch-ups without one of them (about an hour of the library's
// cadence: an operator settles a payment within seconds to minutes, so a coin six catch-ups do not
// find is not coming soon, and the library's own catch-ups and daily sync still look for it), or
// at the latest CATCH_UP_LAST_MS after it began. The library's words for the refusal: "a coin for
// owner nonce …, which this wallet never drew".
export const NEVER_DREW = /which this wallet never drew/;
export const CATCH_UP_EVERY_S = 600;
export const CATCH_UP_RETRY_MS = 60_000;
export const CATCH_UP_SLOW_AFTER = 10;
export const CATCH_UP_SLOW_MS = 10 * 60_000;
export const CATCH_UP_TRIES = 6;
export const CATCH_UP_LAST_MS = 24 * 3600_000;
const listed = (v) => (Array.isArray(v) ? v : []);

// The leaf ids of the coins a mailbox answer refused for that reason.
export function phraseCoinsRefused(mailbox) {
  return listed(mailbox && mailbox.refused).filter((r) => r && r.leaf_id && NEVER_DREW.test(String(r.reason || ''))).map((r) => String(r.leaf_id));
}
export function phraseCoinRefused(mailbox) {
  return phraseCoinsRefused(mailbox).length > 0;
}
// Whether a sync's catch-up ran to its end: its `caught_up` is the catch-up's answer (null when
// none ran), `{ error }` when it failed, and carries `more` when its time ran out before the end.
export function caughtUpWhole(syncResult) {
  const c = syncResult && syncResult.caught_up;
  return !!c && typeof c === 'object' && c.error == null && !c.more;
}

// When the library's catch-up is open next (`openAt`, median-time seconds; 0 open now; null not
// known), after a sync's answer, `libNow` being the library's median time then (the answer's own
// `schedule.now` first): a whole catch-up closes it for CATCH_UP_EVERY_S; one cut short (`more`) or
// failed is open again at once (the library has not stamped it). A sync that ran none while the
// time was not known says one ran within the last CATCH_UP_EVERY_S: half of it is taken, so a
// wallet opened again soon after one runs neither a burst of syncs nor the whole wait.
export function catchUpGate(openAt, syncResult, libNow) {
  const s = syncResult && syncResult.schedule;
  const at = s && typeof s.now === 'number' ? s.now : libNow;
  const c = syncResult && syncResult.caught_up;
  if (c && typeof c === 'object') {
    if (c.more || c.error != null) return 0;
    return typeof at === 'number' ? at + CATCH_UP_EVERY_S : openAt;
  }
  if (openAt == null && typeof at === 'number') return at + CATCH_UP_EVERY_S / 2;
  return openAt;
}

// The wait: null, or { since, pending: [leaf id], tries, nulls, attemptAt } (`tries`: whole
// catch-ups since it began; `nulls`: attempts in a row that ran no catch-up; times in ms).
const ended = (w, now) => !w || !w.pending.length || w.tries >= CATCH_UP_TRIES || now - w.since >= CATCH_UP_LAST_MS;
// A mailbox answer that refused coins of the phrase adds them (a second refusal keeps the start).
export function catchUpWait(w, { mailbox = null, now }) {
  if (w && ended(w, now)) w = null;
  const ids = phraseCoinsRefused(mailbox);
  if (!ids.length) return w;
  const base = w || { since: now, pending: [], tries: 0, nulls: 0, attemptAt: null };
  return { ...base, pending: [...new Set([...base.pending, ...ids])] };
}
// An attempt that threw (the schedule or the sync): it counts towards the cadence.
export function catchUpAttempt(w, now) {
  return w ? { ...w, attemptAt: now, nulls: w.nulls + 1 } : w;
}
// The coins of `w` the wallet now holds, from `restored` entries or `coins` (a coin the store lists
// in any state but the operator's word `pending`), as { wait, arrived: [{ leaf_id, asset, value,
// kind }] }.
function take(w, found, now) {
  if (!w) return { wait: null, arrived: [] };
  const arrived = [];
  const pending = [];
  for (const id of w.pending) {
    const c = found.get(id);
    if (c) arrived.push({ leaf_id: id, asset: c.asset, value: String(c.value ?? ''), kind: c.kind || 'caught up' });
    else pending.push(id);
  }
  const next = { ...w, pending };
  return { wait: ended(next, now) ? null : next, arrived };
}
// After a sync: its own mailbox's refusals join the wait first (the sync's catch-up runs after its
// mailbox step, so one sync can refuse a coin and restore it), then what its catch-up restored is
// taken off, and the attempt is counted.
export function catchUpAfterSync(w, { sync, now }) {
  w = catchUpWait(w, { mailbox: sync && sync.mailbox, now });
  if (!w) return { wait: null, arrived: [] };
  const c = sync && sync.caught_up;
  const ran = !!c && typeof c === 'object';
  const counted = { ...w, attemptAt: now, tries: w.tries + (caughtUpWhole(sync) ? 1 : 0), nulls: ran ? 0 : w.nulls + 1 };
  const found = new Map(listed(ran ? c.restored : null).filter((r) => r && r.leaf_id).map((r) => [String(r.leaf_id), r]));
  return take(counted, found, now);
}
// After the wallet's coins were read.
export function catchUpHeld(w, coins, now) {
  const found = new Map(listed(coins).filter((c) => c && c.leaf_id && c.state !== 'pending').map((c) => [String(c.leaf_id), c]));
  return take(w, found, now);
}
// How long until the host syncs for the wait (0: now; Infinity: no wait): once the library's
// catch-up is open (`openAt` against `libNow`, the library's median time as last read, counted at
// one second a second; the host reads the schedule again at every tick and syncs only once it is
// open), and once the cadence since the last attempt allows.
export function catchUpSyncIn(w, { now, libNow = null, openAt = null }) {
  if (ended(w, now)) return Infinity;
  const gap = w.nulls >= CATCH_UP_SLOW_AFTER ? CATCH_UP_SLOW_MS : CATCH_UP_RETRY_MS;
  const retry = w.attemptAt == null ? 0 : w.attemptAt + gap - now;
  const gate = openAt == null || typeof libNow !== 'number' ? 0 : (openAt - libNow) * 1000;
  return Math.max(0, retry, gate);
}

// What the wallet does by itself, in either mode, is the library's `care`: after a sync,
// at most every CARE_EVERY_MS and once after the leaf wallet opens. It takes up every
// open claim named for one of the wallet's receive keys, cancels each refresh plan whose
// coin has moved, plans a coin of a round once its first step could run within ten days
// (the library's own reach, so the coin is free to trade and pay until then), and asks a refresh in a round for a coin no
// round made (a board, a coin received or claimed out of round) once that refresh could
// run within ten days, since it costs a fee, so that a later `care` can plan the new one.
// The web wallet's leaves.js holds the same rules.
export const CARE_EVERY_MS = 10 * 60_000;

// The arguments `care` runs with: the claim scan, and, in developer mode, the wallet's channels
// cared for (each read and its credit folded, and one opened in each asset the operator makes
// channels of, from half of the wallet's leaves of it). In default mode (`channels` false) care
// neither opens nor folds a channel: the wallet keeps its money in coins, which every payment and
// trade can spend, and closes any channel it still holds into a coin at the next round
// (`channelsToClose`), as the web wallet's contract says (its docs/DEFAULT_MODE.md). Its planning
// reach is the library's own.
export function careArgs(scan, { channels = true } = {}) {
  const a = { channels: !!channels };
  if (scan) a.scan = scan;
  return a;
}

// The channel coins default mode closes into plain coins at the next round: each live one that no
// participation holds yet. The web wallet's leaves.js channelsToClose.
export function channelsToClose(channels, coins = []) {
  const held = new Set((coins || []).filter((c) => c && c.state !== 'live').map((c) => c.leaf_id));
  return (channels || []).filter((c) => c && c.coin_state === 'live' && c.leaf_id && !held.has(c.leaf_id)).map((c) => c.leaf_id);
}

// How often the host reads the wallet's channels from the operator in default mode: every
// CHANNEL_POLL_MS while the popup is open and the wallet was used, opened or paid within
// CHANNEL_FAST_FOR_MS, so a payment into a channel is in the figure within a second; otherwise
// every CHANNEL_POLL_IDLE_MS. Each read runs the library's witness, which the operator hands out
// at a bounded rate, so only a wallet in use reads fast. The web wallet's leaves.js holds the
// same rules.
export const CHANNEL_POLL_MS = 300;
export const CHANNEL_POLL_IDLE_MS = 5000;
export const CHANNEL_FAST_FOR_MS = 3 * 60_000;

// The pace of the next read: `visible` whether the popup is open, `usedAt` the last time the wallet
// was used, opened or paid.
export function channelPollMs({ visible, usedAt, now }) {
  if (!visible || now - (usedAt || 0) > CHANNEL_FAST_FOR_MS) return CHANNEL_POLL_IDLE_MS;
  return CHANNEL_POLL_MS;
}

const bigOf = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };

// The credit a channel read brought in: each channel whose credit grew, and by how much.
export function channelArrivals(before, after) {
  const was = new Map((before || []).filter((c) => c && !c.error).map((c) => [c.leaf_id, bigOf(c.credit)]));
  const out = [];
  for (const c of after || []) {
    if (!c || c.error || !was.has(c.leaf_id)) continue;
    const d = bigOf(c.credit) - was.get(c.leaf_id);
    if (d > 0n) out.push({ leaf_id: c.leaf_id, asset: c.asset, atoms: d });
  }
  return out;
}

// The wallet's channels a payer can pay now, by asset (live, their round final): what a receive
// code names (the library's `receive` puts them under `channels`).
export function payableChannels(channels) {
  const m = {};
  for (const c of channels || []) if (c && c.coin_state === 'live' && c.final === true && !(c.asset in m)) m[c.asset] = c.leaf_id;
  return m;
}

// Whether a kept receive code names the channels the wallet can be paid over now (`payable`, as
// payableChannels gives them): a code made before a channel opened, or after it closed, is made
// again.
export function codeNamesChannels(kept, payable) {
  const now = payable || {};
  const had = (kept && kept.channels) || {};
  const ka = Object.keys(had).sort(); const na = Object.keys(now).sort();
  return ka.length === na.length && ka.every((a, i) => a === na[i] && had[a] === now[a]);
}

// A planned coin carries refund halves the wallet signed, so no wallet pays it out of
// round. A command the unplanned coins cannot cover and planned ones can is refused by the
// library with kind `planned`, naming the coins whose release covers it (`release`). The
// wallet pays it through the next round, by itself: `plan_release` gives those coins up in
// the next round for leaves of its own that no plan names, it syncs every RELEASE_POLL_MS
// until none of them is still the wallet's to spend or in that round (the round final, the
// new leaves held), at most RELEASE_WAIT_MS, and asks the same command again; at most
// RELEASE_TRIES releases for one command (a released coin comes back less its refresh fee
// and its own margins, so one release can fall short). Every other refusal is the library's.
export const RELEASE_POLL_MS = 15_000;
export const RELEASE_WAIT_MS = 3 * 3600_000;
export const RELEASE_TRIES = 3;
export const RELEASE_TIMEOUT = 'the next round did not free the coins this payment needs in time; nothing was paid, and the payment can be asked again';

// Whether the coins a release gave up are done with: none of them is still the wallet's
// to spend or in the round that gives them up (their round final, the forfeits handed
// over at sync), so the new leaves are held and the payment can be asked again.
const RELEASING = new Set(['live', 'pending', 'given', 'offered', 'sending', 'forfeited']);
export function releaseDone(coins, released) {
  const by = new Map((coins || []).map((c) => [c.leaf_id, c]));
  return (released || []).every((id) => { const c = by.get(id); return !c || !RELEASING.has(c.state); });
}

// The current coin of each open or stopped plan: the leaf its next step gives up.
// -> Map(leaf id -> plan)
export function plannedCoins(plans) {
  const out = new Map();
  for (const p of plans || []) {
    if (p.state !== 'open' && p.state !== 'stopped') continue;
    const current = ((p.steps || []).filter((st) => st.leaf_id).map((st) => st.leaf_id).pop()) || p.coin;
    out.set(current, p);
  }
  return out;
}

// How often a payment that waits for the wallet's own round asks whether it is through. The web
// wallet's ROUND_POLL_MS.
export const ROUND_POLL_MS = 5_000;
// A payment whose coins waited for RELEASE_TRIES rounds and still cannot go: said in plain words,
// never the library's own text (it names the asset by its id). The web wallet's settleGaveUp.
export const SETTLE_GAVE_UP = 'This payment could not go through yet: nothing was sent, and your money stays in your wallet.';

// One command asked through the next round when the wallet's own coins need one first, never
// refused for it (the web wallet's leaves.js `paying`):
//   `planned`      the unplanned coins fall short and the planned ones it names cover it: they are
//                  given up in the next round for leaves no plan names (`plan_release`);
//   `settle_first` what the wallet shows is held back only for want of a round (coins at the
//                  operator's depth limit, received and not settled, in a round of the wallet's own
//                  whose new coins it has not taken yet): those coins go through the next round
//                  (`settle_first`, which gives up nothing twice), asked again until it answers
//                  ready;
//   `in_channel`   the wallet's side of a channel would cover it: the channels it names are closed
//                  into the next round (`quote`, then `participate`), each giving back a leaf of the
//                  wallet's own, and `channelsHeld(asset)` is told so care opens none meanwhile.
// Then the same command is asked again; at most RELEASE_TRIES rounds for one command. `io` gives
// `run(command, args)` (the library's answer, or a throw of its refusal `{kind, message, asset?,
// release?, coins?, close?}`), `sync()`, `coins()`, `sleep(ms)`, `now()` (ms) and, optionally,
// `waiting(state | null)`, told what goes through a round while the wallet waits for it, and
// `channelsHeld(asset | null)`.
export async function payThrough(command, args, io) {
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = io.now || (() => Date.now());
  const result = (v) => (v && typeof v === 'object' && 'result' in v ? v.result : v);
  for (let i = 0; ; i++) {
    try { return await io.run(command, args); } catch (e) {
      // An offboard's quote answers at once, as the library gave it: the payment is reviewed then,
      // and the offboard made on that review waits for its round.
      if (e && e.kind === 'settle_first' && command !== 'offboard_quote') {
        if (i >= RELEASE_TRIES) throw { kind: 'refused', code: 'settle_gave_up', message: SETTLE_GAVE_UP };
        const coins = Array.isArray(e.coins) && e.coins.length ? e.coins : null;
        const ask = coins ? { coins } : { asset: e.asset };
        const state = { command, coins: coins || [], asset: e.asset || null, since: now(), why: 'settle' };
        if (io.waiting) io.waiting(state);
        try {
          const until = now() + RELEASE_WAIT_MS;
          for (let first = true; ; first = false) {
            if (!first) { try { await io.sync(); } catch { /* asked again at the next poll */ } }
            let v = null;
            try { v = result(await io.run('settle_first', ask)); } catch (s) {
              // A library without the command: the refusal stands.
              if (/no command|unknown command/i.test(String((s && s.message) || ''))) throw e;
            }
            if (v && v.ready) break;
            if (now() >= until) throw { kind: 'refused', code: 'settle_gave_up', message: SETTLE_GAVE_UP };
            await sleep(ROUND_POLL_MS);
          }
        } finally { if (io.waiting) io.waiting(null); }
        continue;
      }
      if (e && e.kind === 'in_channel' && Array.isArray(e.close) && e.close.length && i < RELEASE_TRIES) {
        const state = { command, coins: e.close, asset: e.asset || null, since: now(), why: 'channel' };
        if (io.waiting) io.waiting(state);
        if (io.channelsHeld) io.channelsHeld(e.asset || true);
        try {
          const q = result(await io.run('quote', { leaves: e.close }));
          state.answer = result(await io.run('participate', { leaves: e.close, shown: q && q.coins }));
          if (io.waiting) io.waiting(state);
          const until = now() + RELEASE_WAIT_MS;
          for (;;) {
            try { await io.sync(); } catch { /* the next poll syncs again */ }
            let cs = null;
            try { cs = await io.coins(); } catch { /* read again at the next poll */ }
            if (cs && releaseDone(cs, e.close)) break;
            if (now() >= until) throw { kind: 'refused', message: RELEASE_TIMEOUT };
            await sleep(ROUND_POLL_MS);
          }
        } finally { if (io.waiting) io.waiting(null); if (io.channelsHeld) io.channelsHeld(null); }
        continue;
      }
      if (!e || e.kind !== 'planned' || !Array.isArray(e.release) || !e.release.length || i >= RELEASE_TRIES) throw e;
      const state = { command, coins: e.release, asset: e.asset || null, since: now() };
      if (io.waiting) io.waiting(state);
      try {
        state.answer = await io.run('plan_release', { leaves: e.release });
        if (io.waiting) io.waiting(state);
        const until = now() + RELEASE_WAIT_MS;
        for (;;) {
          try { await io.sync(); } catch { /* the next poll syncs again */ }
          let cs = null;
          try { cs = await io.coins(); } catch { /* read again at the next poll */ }
          if (cs && releaseDone(cs, e.release)) break;
          if (now() >= until) throw { kind: 'refused', message: RELEASE_TIMEOUT };
          await sleep(RELEASE_POLL_MS);
        }
      } finally { if (io.waiting) io.waiting(null); }
    }
  }
}

// Whether `care` runs now: at the first chance after the wallet opens, then at most every
// `every` ms. `last` is when it last ran (ms), or null.
export function careDue(last, nowMs, every = CARE_EVERY_MS) {
  return last == null || nowMs - last >= every;
}

// How many receive keys `care` looks for claims under: the kit wallet's next receive
// index and 20 more, so a claim named by any address the kit handed out is found (the
// leaf wallet's own index counter is its own).
export function claimScan(nextIndex) {
  const n = Number(nextIndex);
  return (Number.isInteger(n) && n > 0 ? n : 0) + 20;
}

// What a `care` answer did, counted: claims taken up (a leaf id came back), plans made,
// plans cancelled, coins sent to a round's refresh. Anything at all means the balance may
// have moved.
export function careSummary(answer) {
  const a = answer || {};
  const claims = Array.isArray(a.claims) ? a.claims : [];
  const planned = Array.isArray(a.planned) ? a.planned : [];
  const cancelled = Array.isArray(a.cancelled) ? a.cancelled : [];
  const refreshing = Array.isArray(a.refreshing) ? a.refreshing : [];
  return {
    taken: claims.filter((c) => c && c.taken_up && !c.error).length,
    held: claims.filter((c) => c && c.leaf_id && (c.held || c.error)).length,
    planned: planned.filter((p) => p && p.plan_id).length,
    unplanned: planned.filter((p) => p && p.error).length,
    cancelled: cancelled.filter((p) => p && p.state === 'cancelled').length,
    refreshing: refreshing.filter((r) => r && r.participation && !r.error).length,
    later: Number(a.not_yet_planned || 0),
  };
}

// Default mode's upkeep, as the host keeps it: the newer of what it has and what it is told,
// by when the mode each was read from was set (`at`, ms; 0 for a mode never set). A tie takes
// what it is told. -> { on, at }
export function laterMode(cur, on, at) {
  const t = Number.isFinite(Number(at)) ? Number(at) : 0;
  if (t < cur.at) return cur;
  return { on: !!on, at: t };
}

// Reads (`read`: the wallet's mailbox) until `came()` says what is awaited has arrived, or `ms` have
// passed: a read that has not answered by then is not waited for (the library may be busy with a
// sync; what it takes in later is reported as any arrival is), and the next read comes `every` ms
// after the last. -> came().
export async function readUntil({ read, came, ms, every = 2000, now = Date.now, sleep = (t) => new Promise((r) => setTimeout(r, t)) }) {
  const until = now() + ms;
  const left = () => Math.max(0, until - now());
  while (!came() && left() > 0) {
    let timer;
    const answered = await Promise.race([
      Promise.resolve().then(read).then(() => true, () => true),
      new Promise((r) => { timer = setTimeout(() => r(false), left()); }),
    ]);
    clearTimeout(timer);
    if (!answered || came() || !left()) break;
    await sleep(Math.min(every, left()));
  }
  return came();
}
