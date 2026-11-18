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
// code shows within a tick instead of at the library's next daily sync.
export function requestWaits(schedule) {
  if (!schedule || typeof schedule.now !== 'number') return false;
  return (schedule.receive_requests || []).some((r) => r.state === 'waiting' && r.owner !== 'restored'
    && (typeof r.lapses_at !== 'number' || r.lapses_at > schedule.now));
}

// A coin paid to a receive request that another store of the phrase handed out (the phrase open in
// another browser, in Ambra or in the web wallet, or a store this browser held before: the payment
// name's stock keeps their codes until each is handed out or lapses). Every store of the phrase
// reads it in its mailbox, and each one that never drew its owner nonce refuses it there; only the
// library's catch-up between stores of one phrase, a step of `sync` that runs at most every ten
// minutes, takes it in. So such a refusal is the sign that a payment to this wallet waits for a
// catch-up: the host syncs once the catch-up is due (at once, unless the host saw one run within
// the last CATCH_UP_EVERY_MS), and again every CATCH_UP_POLL_MS until a sync's catch-up has run to
// its end, for at most CATCH_UP_WAIT_MS. The library's words for the refusal: "a coin for owner
// nonce …, which this wallet never drew".
export const NEVER_DREW = /which this wallet never drew/;
export const CATCH_UP_POLL_MS = 30_000;
export const CATCH_UP_WAIT_MS = 15 * 60_000;
// The library's CATCH_UP_EVERY (600 median-time seconds), less a minute for the median time's
// steps: before then a sync runs no catch-up.
export const CATCH_UP_EVERY_MS = 9 * 60_000;
export function phraseCoinRefused(mailbox) {
  const refused = mailbox && Array.isArray(mailbox.refused) ? mailbox.refused : [];
  return refused.some((r) => r && NEVER_DREW.test(String(r.reason || '')));
}
// Whether a sync's catch-up ran to its end: its `caught_up` is the catch-up's answer (null when
// none ran), `{ error }` when it failed, and carries `more` when its time ran out before the end.
export function caughtUpWhole(syncResult) {
  const c = syncResult && syncResult.caught_up;
  return !!c && typeof c === 'object' && c.error == null && !c.more;
}
// The host's wait for a catch-up (`w`: null, or { since, syncedAt }), after a mailbox read
// (`mailbox`) or a sync (`sync`, the library's answer) at `now` (ms): a phrase coin refused starts
// it (keeping the start of one under way), a sync whose catch-up ran whole ends it, and it ends by
// itself CATCH_UP_WAIT_MS after it started. A sync's own mailbox step runs before its catch-up, so
// a coin that sync refused and took in at once leaves nothing to wait for.
export function catchUpWait(w, { mailbox = null, sync = null, now }) {
  if (w && now - w.since >= CATCH_UP_WAIT_MS) w = null;
  if (sync) {
    if (caughtUpWhole(sync)) return null;
    if (phraseCoinRefused(sync.mailbox)) return { since: w ? w.since : now, syncedAt: now };
    return w ? { ...w, syncedAt: now } : null;
  }
  if (phraseCoinRefused(mailbox)) return w || { since: now, syncedAt: null };
  return w;
}
// When the host last saw a sync run a catch-up to its end (`ranAt`, ms), after a sync's answer at
// `now`: the library's ten minutes count from there. One cut short (`more`) reads on at the next
// sync, so it is due at once again; one that failed is tried again at the next sync too.
export function catchUpRanAt(ranAt, syncResult, now) {
  const c = syncResult && syncResult.caught_up;
  if (!c || typeof c !== 'object') return ranAt;
  return c.more || c.error != null ? null : now;
}
// How long until the host syncs for the catch-up the wait holds (0: now; Infinity: no wait): once
// the library's catch-up is due again (CATCH_UP_EVERY_MS after `ranAt`, the last one seen run), and
// every CATCH_UP_POLL_MS after the last sync, until the wait ends.
export function catchUpSyncIn(w, now, ranAt = null) {
  if (!w || now - w.since >= CATCH_UP_WAIT_MS) return Infinity;
  const due = ranAt == null ? 0 : ranAt + CATCH_UP_EVERY_MS - now;
  const poll = w.syncedAt == null ? 0 : w.syncedAt + CATCH_UP_POLL_MS - now;
  return Math.max(0, due, poll);
}
export function catchUpSyncDue(w, now, ranAt = null) {
  return catchUpSyncIn(w, now, ranAt) === 0;
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

// The arguments `care` runs with: the claim scan, and the wallet's channels cared for (each read
// and its credit folded, and one opened in each asset the operator makes channels of, from half of
// the wallet's leaves of it). Its planning reach is the library's own.
export function careArgs(scan) {
  const a = { channels: true };
  if (scan) a.scan = scan;
  return a;
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

// One command asked through the next round when it needs a planned coin. `io` gives
// `run(command, args)` (the library's answer, or a throw of its refusal `{kind, message,
// asset?, release?}`), `sync()`, `coins()`, `sleep(ms)`, `now()` (ms) and, optionally,
// `waiting(state | null)`, told what is released while the wallet waits for the round.
export async function payThrough(command, args, io) {
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = io.now || (() => Date.now());
  for (let i = 0; ; i++) {
    try { return await io.run(command, args); } catch (e) {
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
