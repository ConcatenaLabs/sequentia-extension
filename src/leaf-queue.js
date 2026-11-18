// The leaf wallet's commands, one at a time, the person's first.
//
// The library answers one command at a time (its worker takes them in the order they were sent).
// The host keeps at most one command in the worker and holds the rest here, so a command a person
// waits on (a trade's quote, a payment, the faucet's coin taken in) goes ahead of every command the
// wallet's own upkeep has queued: it waits at most for the one command already running.
//
//   createQueue({ send, now? }) -> { call(op, args, prio, opts?), personWaits(), running(), stats(), failAll(e) }
//     send(op, args) -> a promise of the worker's answer for one command.
//     prio: PERSON (a person waits on it), PROMPT (something a person started waits on it, such as
//     the faucet's coin taken in, or the receive code), PASS (a step of the host's scheduled pass,
//     and the reads that show a payment), UPKEEP (work the rest of the wallet asks for, the default).
//     opts: { share, dropAfterMs, from }
//       share        a read: one asked while the same read (same command, same arguments) waits at
//                    the same priority gets that one's answer, so a caller asking the same thing
//                    over and over adds nothing to the line;
//       dropAfterMs  a read nobody inside the host waits on: refused with kind 'busy' once it has
//                    waited that long, so the line cannot grow without end behind a slow library;
//       from         who asked (for the state a capture reads), kept with the command.
//
// The scheduled pass's own commands go before the rest of the upkeep: a pass waits at most for the
// one command running, whatever else was asked meanwhile, so it ends.
//
// A command still running after `hungAfter(op, args)` ms is reported once to `onHung`, which
// decides what to do (the host restarts the worker: a hung library otherwise holds every command
// after it for good).

export const PERSON = 3;
export const PROMPT = 2;
export const PASS = 1;
export const UPKEEP = 0;

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

export function createQueue({ send, now = () => Date.now(), hungAfter = () => 10 * 60_000, onHung = null, onSlow = null, slowMs = 10_000, onDropped = null }) {
  const waiting = [];
  let running = null;
  let seq = 0;
  let watchdog = null;
  const counts = { asked: 0, shared: 0, dropped: 0, ran: 0 };

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

  function pump() {
    if (running) return;
    dropStale();
    if (!waiting.length) return;
    // The highest priority first; among equals, the first asked.
    let i = 0;
    for (let k = 1; k < waiting.length; k++) if (waiting[k].prio > waiting[i].prio) i = k;
    const job = waiting.splice(i, 1)[0];
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
    call(op, args = {}, prio = UPKEEP, { share = false, dropAfterMs = null, from = null } = {}) {
      counts.asked++;
      return new Promise((ok, no) => {
        const key = share ? op + '\n' + JSON.stringify(args) : null;
        const same = key && waiting.find((w) => w.key === key && w.prio === prio);
        if (same) {
          counts.shared++;
          same.subs.push({ ok, no });
          // Someone still wants it: its bound counts from the latest ask.
          if (same.dropAfterMs != null) same.at = now();
          return;
        }
        waiting.push({ op, args, prio, subs: [{ ok, no }], at: now(), seq: seq++, key, dropAfterMs, from });
        pump();
      });
    },
    // Whether a person waits on a command now: one queued or running at PROMPT or above.
    personWaits: () => waiting.some((w) => w.prio >= PROMPT) || !!(running && running.prio >= PROMPT),
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
