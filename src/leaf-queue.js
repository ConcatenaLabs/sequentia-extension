// The leaf wallet's commands, one at a time, the person's first.
//
// The library answers one command at a time (its worker takes them in the order they were sent).
// The host keeps at most one command in the worker and holds the rest here, by priority, the
// person's first, and fairly: no caller, however often it asks, keeps the rest from their turn.
//
//   createQueue({ send, now? }) -> { call(op, args, prio, opts?), personWaits(), running(), stats(), failAll(e) }
//     send(op, args) -> a promise of the worker's answer for one command.
//     prio: PERSON (a person waits on it), PROMPT (something a person started waits on it, such as
//     the faucet's coin taken in, or the receive code), PASS (a step of the host's scheduled pass,
//     and the reads that show a payment), UPKEEP (work the rest of the wallet asks for, the default).
//     opts: { share, dropAfterMs, cap, read, from }
//       share        a read: one asked while the same read (same command, same arguments) waits at
//                    the same priority gets that one's answer (computed after both asked), so a
//                    caller asking the same thing over and over adds nothing to the line. Never
//                    across priorities: a person's read never takes an upkeep read's answer;
//       dropAfterMs  UPKEEP only, a read whose caller asks again by itself: refused with kind 'busy'
//                    once it has waited that long, so the line cannot grow without end behind a slow
//                    library; a sharer that gives none keeps the read whatever its first asker gave;
//       cap          { key, most }: a read refused at once with kind 'busy', which its caller sees,
//                    when `most` reads of the same key (one caller) already wait;
//       read         a person's read: it goes at its priority but does not make the wallet's own
//                    work step aside (personWaits), which only a person's other commands do;
//       from         who asked (for the state a capture reads), kept with the command.
//
// The order: the highest priority waiting, first asked first, except that a priority with work
// waiting that FAIR_TURN commands of higher priorities have gone past is served next (the highest
// such first). So a person's command waits at most for the command running and one command of each
// lower priority whose turn has come (three at most: a prompt read, a step of the host's own work,
// an upkeep read), and under persons' commands back to back every lower priority with work waiting
// still gets one command in every FAIR_TURN + 1 or better. The scheduled pass waits likewise at most
// for the command running and an upkeep read now and then, so it ends.
//
// A command still running after `hungAfter(op, args)` ms is reported once to `onHung`, which
// decides what to do (the host restarts the worker: a hung library otherwise holds every command
// after it for good).

export const PERSON = 3;
export const PROMPT = 2;
export const PASS = 1;
export const UPKEEP = 0;
// How many commands of higher priorities may go past work waiting before that work's turn.
export const FAIR_TURN = 3;

// The shape of a command's arguments, for the state a capture reads: the keys, and what kind of
// value each holds, never the values (a receive request, an address, an amount).
export function argsShape(args) {
  if (!args || typeof args !== 'object') return typeof args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v === 'object' ? `{${Object.keys(v).join(',')}}` : typeof v;
  }
  return out;
}
const commandOf = (op, args) => (op === 'run' && args && args.command ? String(args.command) : op);

export function createQueue({ send, now = () => Date.now(), hungAfter = () => 10 * 60_000, onHung = null, onSlow = null, slowMs = 10_000, onDropped = null, onCapped = null }) {
  const waiting = [];
  let running = null;
  let seq = 0;
  let watchdog = null;
  const counts = { asked: 0, shared: 0, dropped: 0, capped: 0, ran: 0, turns: 0 };
  // For each priority: how many commands of higher priorities started while it had work waiting,
  // since it last started one.
  const passed = new Map();

  function check() {
    clearTimeout(watchdog);
    if (!running) return;
    const left = running.started + hungAfter(running.op, running.args) - now();
    if (left <= 0) {
      if (!running.reported) { running.reported = true; if (onHung) onHung({ op: running.op, args: running.args, ms: now() - running.started }); }
      return;
    }
    watchdog = setTimeout(check, Math.min(left, 60_000));
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
  }

  const settle = (job, f, v) => { for (const s of job.subs) { try { s[f](v); } catch {} } };

  // The reads that have waited past their bound, refused with one word each.
  function dropStale() {
    const t = now();
    let gone = null;
    for (let k = waiting.length - 1; k >= 0; k--) {
      const w = waiting[k];
      if (w.dropAfterMs == null || t - w.at < w.dropAfterMs) continue;
      waiting.splice(k, 1);
      counts.dropped += w.subs.length;
      (gone || (gone = [])).push(w);
      settle(w, 'no', { kind: 'busy', message: 'the wallet was busy with other work; it is asked again later' });
    }
    if (gone && onDropped) { try { onDropped(gone.map((w) => ({ command: commandOf(w.op, w.args), from: w.from, waited: t - w.at, callers: w.subs.length }))); } catch {} }
  }

  // The next command: the highest priority waiting, unless a lower one with work waiting has been
  // gone past FAIR_TURN times (the highest such); first asked first within a priority.
  function next() {
    const levels = [...new Set(waiting.map((w) => w.prio))].sort((a, b) => b - a);
    let level = levels[0];
    for (const l of levels.slice(1)) if ((passed.get(l) || 0) >= FAIR_TURN) { level = l; counts.turns++; break; }
    for (const l of levels) if (l < level) passed.set(l, (passed.get(l) || 0) + 1);
    passed.set(level, 0);
    return waiting.findIndex((w) => w.prio === level);
  }

  function pump() {
    if (running) return;
    dropStale();
    if (!waiting.length) return;
    const job = waiting.splice(next(), 1)[0];
    const r = running = { ...job, started: now() };
    counts.ran++;
    check();
    Promise.resolve().then(() => send(job.op, job.args)).then((v) => settle(job, 'ok', v), (e) => settle(job, 'no', e)).finally(() => {
      const ms = now() - r.started;
      if (onSlow && ms >= slowMs) { try { onSlow({ op: job.op, args: job.args, prio: job.prio, ms, waited: r.started - job.at, from: job.from }); } catch {} }
      if (running === r) running = null;
      pump();
    });
  }

  return {
    call(op, args = {}, prio = UPKEEP, { share = false, dropAfterMs = null, cap = null, read = false, from = null } = {}) {
      counts.asked++;
      // Dropping is the upkeep's alone.
      if (prio !== UPKEEP) dropAfterMs = null;
      return new Promise((ok, no) => {
        const key = share ? op + '\n' + JSON.stringify(args) : null;
        const same = key && waiting.find((w) => w.key === key && w.prio === prio);
        if (same) {
          counts.shared++;
          same.subs.push({ ok, no });
          // A caller that cannot take a refusal keeps the read; else someone still wants it, and
          // its bound counts from the latest ask.
          if (dropAfterMs == null) same.dropAfterMs = null;
          else if (same.dropAfterMs != null) same.at = now();
          return;
        }
        if (cap && cap.key != null && waiting.filter((w) => w.capKey === cap.key).length >= cap.most) {
          counts.capped++;
          if (onCapped) { try { onCapped({ command: commandOf(op, args), from, most: cap.most }); } catch {} }
          no({ kind: 'busy', message: `${cap.most} reads asked by the same caller already wait for the wallet; ask again once they are answered` });
          return;
        }
        waiting.push({ op, args, prio, subs: [{ ok, no }], at: now(), seq: seq++, key, dropAfterMs, from, read: !!read, capKey: cap ? cap.key : null });
        pump();
      });
    },
    // Whether a person waits on a command that makes the wallet's own work step aside: one queued or
    // running at PROMPT or above that is not a person's read (which the order serves first anyway).
    personWaits: () => waiting.some((w) => w.prio >= PROMPT && !w.read) || !!(running && running.prio >= PROMPT && !running.read),
    running: () => (running ? { op: running.op, command: commandOf(running.op, running.args), shape: argsShape(running.op === 'run' ? running.args.args : running.args),
      prio: running.prio, ms: now() - running.started, waited: running.started - running.at, from: running.from } : null),
    waiting: () => waiting.length,
    // What the line holds, for a capture: how many wait at each priority, the commands most asked
    // (with who asked them), the oldest wait, and the counts since the start.
    stats() {
      const t = now();
      const byPrio = {};
      const byCommand = new Map();
      let oldest = 0;
      for (const w of waiting) {
        byPrio[w.prio] = (byPrio[w.prio] || 0) + 1;
        const k = commandOf(w.op, w.args) + (w.from ? ' from ' + w.from : '');
        byCommand.set(k, (byCommand.get(k) || 0) + w.subs.length);
        oldest = Math.max(oldest, t - w.at);
      }
      const top = [...byCommand].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([what, n]) => ({ what, n }));
      return { waiting: waiting.length, byPrio, top, oldestMs: oldest, ...counts };
    },
    // The worker is gone: every command waiting fails with `e`, and the one running is let go of
    // (its answer, should one come, is ignored by the host).
    failAll(e) {
      for (const w of waiting.splice(0)) settle(w, 'no', e);
      if (running) { settle(running, 'no', e); running = null; }
      clearTimeout(watchdog);
    },
  };
}
