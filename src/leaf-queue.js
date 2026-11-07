// The leaf wallet's commands, one at a time, the person's first.
//
// The library answers one command at a time (its worker takes them in the order they were sent).
// The host keeps at most one command in the worker and holds the rest here, so a command a person
// waits on (a trade's quote, a payment, the faucet's coin taken in) goes ahead of every command the
// wallet's own upkeep has queued: it waits at most for the one command already running.
//
//   createQueue({ send, now? }) -> { call(op, args, prio), personWaits(), running(), failAll(e) }
//     send(op, args) -> a promise of the worker's answer for one command.
//     prio: PERSON (a person waits on it), PROMPT (something a person started waits on it, such as
//     the faucet's coin taken in), UPKEEP (the wallet's own work, the default).
//
// A command still running after `hungAfter(op, args)` ms is reported once to `onHung`, which
// decides what to do (the host restarts the worker: a hung library otherwise holds every command
// after it for good).

export const PERSON = 2;
export const PROMPT = 1;
export const UPKEEP = 0;

export function createQueue({ send, now = () => Date.now(), hungAfter = () => 10 * 60_000, onHung = null, onSlow = null, slowMs = 10_000 }) {
  const waiting = [];
  let running = null;
  let seq = 0;
  let watchdog = null;

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

  function pump() {
    if (running || !waiting.length) return;
    // The highest priority first; among equals, the first asked.
    let i = 0;
    for (let k = 1; k < waiting.length; k++) if (waiting[k].prio > waiting[i].prio) i = k;
    const job = waiting.splice(i, 1)[0];
    const r = running = { ...job, started: now() };
    check();
    Promise.resolve().then(() => send(job.op, job.args)).then(job.ok, job.no).finally(() => {
      const ms = now() - r.started;
      if (onSlow && ms >= slowMs) { try { onSlow({ op: job.op, args: job.args, prio: job.prio, ms, waited: r.started - job.at }); } catch {} }
      if (running === r) running = null;
      pump();
    });
  }

  return {
    call(op, args = {}, prio = UPKEEP) {
      return new Promise((ok, no) => { waiting.push({ op, args, prio, ok, no, at: now(), seq: seq++ }); pump(); });
    },
    // Whether a person waits on a command now: one queued or running at PROMPT or above.
    personWaits: () => waiting.some((w) => w.prio >= PROMPT) || !!(running && running.prio >= PROMPT),
    running: () => (running ? { op: running.op, prio: running.prio, ms: now() - running.started } : null),
    waiting: () => waiting.length,
    // The worker is gone: every command waiting fails with `e`, and the one running is let go of
    // (its answer, should one come, is ignored by the host).
    failAll(e) {
      for (const w of waiting.splice(0)) w.no(e);
      if (running) { running.no(e); running = null; }
      clearTimeout(watchdog);
    },
  };
}
