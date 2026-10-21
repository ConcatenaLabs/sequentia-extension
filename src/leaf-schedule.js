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
// coin has moved, plans each coin whose refresh step could run within ten days, and asks
// a refresh in a round for a coin no round made (a board, a coin received or claimed out
// of round), so that a later `care` can plan the new one. The web wallet's leaves.js
// holds the same rules.
export const CARE_EVERY_MS = 10 * 60_000;

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
