// When the leaf wallet syncs by itself: pure rules over the library's answers,
// shared by the offscreen document's host and the tests. The same rules as the web
// wallet's developer mode (sequentia-web-wallet/leaves.js).

// Whether something is moving that sync must follow now, whatever the schedule says:
// a coin pending, being sent, given to a participation, under a forfeit or on its way
// out, or a participation not yet done.
const MOVING = new Set(['pending', 'sending', 'given', 'forfeited', 'exiting']);
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
