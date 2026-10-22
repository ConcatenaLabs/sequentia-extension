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

// Whether a receive request handed out within the last `windowSecs` (median time)
// still waits. While one does, the host reads the mailbox on every tick, so a payment
// a site asked for arrives in about a minute rather than at the library's next daily
// sync. Past the window the library's own schedule applies again.
export const FRESH_REQUEST_SECS = 3600;
export function freshRequestWaits(schedule, windowSecs = FRESH_REQUEST_SECS) {
  if (!schedule || typeof schedule.now !== 'number') return false;
  return (schedule.receive_requests || []).some((r) => r.state === 'waiting' && r.owner !== 'restored'
    && typeof r.asked_at === 'number' && schedule.now - r.asked_at < windowSecs);
}

// What the wallet does by itself, in either mode, is the library's `care`: after a sync,
// at most every CARE_EVERY_MS and once after the leaf wallet opens. It takes up every
// open claim named for one of the wallet's receive keys, cancels each refresh plan whose
// coin has moved, plans every coin of a round at the first `care` after the coin is made
// (`plan_within`: PLAN_EVERY_ROUND_LEAF), and asks a refresh in a round for a coin no
// round made (a board, a coin received or claimed out of round) once that refresh could
// run within ten days, since it costs a fee, so that a later `care` can plan the new one.
// The web wallet's leaves.js holds the same rules.
export const CARE_EVERY_MS = 10 * 60_000;

// `care`'s planning reach: every leaf of a round is planned at the first care after it is
// made (the library's PLAN_EVERY_ROUND_LEAF).
export const PLAN_EVERY_ROUND_LEAF = 4294967295;

// The arguments `care` runs with: the claim scan, and every leaf of a round planned.
export function careArgs(scan) {
  const a = { plan_within: PLAN_EVERY_ROUND_LEAF };
  if (scan) a.scan = scan;
  return a;
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
