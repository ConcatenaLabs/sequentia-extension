// A payment to a code another store of the phrase handed out (the payment name's stock keeps such
// codes, and the phrase may be open elsewhere) is refused by this store's mailbox and taken in only
// by the library's catch-up, a step of `sync` that runs at most once every ten minutes of median
// time and reads only what the operator has settled. The host (offscreen-leaves.js) keeps the
// refused coins and syncs whenever that catch-up is open by the library's own clock, until it
// holds each one, so the payment shows within seconds when the catch-up is open and within its ten
// minutes otherwise, never at the next daily sync (sequentia-extension#214); without holding the
// rest of its upkeep back, without spinning when the node does not answer, and bounded.
// A payment to a code of this store's own made more than an hour ago is read by the mailbox in
// developer mode too.
//   node --test test/catch-up-wait.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { requestWaits, phraseCoinsRefused, caughtUpWhole, catchUpWait, catchUpAfterSync, catchUpHeld, catchUpAttempt, catchUpGate,
  catchUpSyncIn, CATCH_UP_RETRY_MS, CATCH_UP_SLOW_MS, CATCH_UP_SLOW_AFTER, CATCH_UP_TRIES, CATCH_UP_LAST_MS, CATCH_UP_EVERY_S, REQUEST_HOLDS_S }
  from '../src/leaf-schedule.js';

const NEVER = 'refused: a coin for owner nonce ab12, which this wallet never drew';
const refusal = (id) => ({ refused: [{ leaf_id: id, reason: NEVER }] });

test('the rules: the refused coins are kept until each is held; whole catch-ups are counted', () => {
  assert.deepEqual(phraseCoinsRefused({ refused: [{ leaf_id: 'x', reason: NEVER }, { leaf_id: 'y', reason: 'refused: the record does not decode' }] }), ['x']);
  assert.equal(caughtUpWhole({ caught_up: { restored: [], more: true } }), false);
  assert.equal(caughtUpWhole({ caught_up: { restored: [] } }), true);
  let w = catchUpWait(null, { mailbox: refusal('x'), now: 1000 });
  assert.deepEqual(w, { since: 1000, pending: ['x'], tries: 0, nulls: 0, attemptAt: null });
  assert.equal(catchUpWait(w, { mailbox: refusal('y'), now: 2000 }).since, 1000, 'a second refusal keeps the start');
  // A whole catch-up without the coin (the operator has not settled it): the wait goes on.
  let r = catchUpAfterSync(w, { sync: { caught_up: { restored: [{ leaf_id: 'other', asset: 'a', value: '1' }] } }, now: 5000 });
  assert.deepEqual(r.arrived, [], 'a coin the other store made itself is not announced');
  assert.equal(r.wait.tries, 1);
  assert.deepEqual(r.wait.pending, ['x']);
  // Held: by the catch-up's restored, or by the coins.
  r = catchUpAfterSync(r.wait, { sync: { caught_up: { restored: [{ leaf_id: 'x', asset: 'a', value: '7', kind: 'mailbox' }] } }, now: 9000 });
  assert.equal(r.wait, null);
  assert.deepEqual(r.arrived, [{ leaf_id: 'x', asset: 'a', value: '7', kind: 'mailbox' }]);
  const h = catchUpHeld(w, [{ leaf_id: 'x', asset: 'a', value: '7', state: 'live' }], 9000);
  assert.equal(h.wait, null);
  assert.equal(h.arrived.length, 1);
  assert.equal(catchUpHeld(w, [{ leaf_id: 'x', state: 'pending' }], 9000).wait.pending.length, 1, 'the operator\'s word pending is not held');
  // Refused and restored in one sync.
  r = catchUpAfterSync(null, { sync: { mailbox: refusal('z'), caught_up: { restored: [{ leaf_id: 'z', asset: 'a', value: '3' }] } }, now: 1 });
  assert.equal(r.wait, null);
  assert.deepEqual(r.arrived.map((c) => c.leaf_id), ['z']);
});

test('the rules: the cadence holds on every answer and every throw, and the wait is bounded', () => {
  let w = catchUpWait(null, { mailbox: refusal('x'), now: 0 });
  assert.equal(catchUpSyncIn(w, { now: 0 }), 0, 'at once when the gate is not known');
  assert.equal(catchUpSyncIn(w, { now: 0, libNow: 100, openAt: 400 }), 300_000, 'when the library\'s catch-up is open');
  w = catchUpAttempt(w, 10);
  assert.equal(catchUpSyncIn(w, { now: 10 }), CATCH_UP_RETRY_MS, 'a thrown attempt counts');
  for (let i = 1; i < CATCH_UP_SLOW_AFTER; i++) w = catchUpAttempt(w, 10);
  assert.equal(catchUpSyncIn(w, { now: 10 }), CATCH_UP_SLOW_MS, 'the library\'s own cadence once attempts keep running none');
  w = catchUpAfterSync(w, { sync: { caught_up: { restored: [] } }, now: 20 }).wait;
  assert.equal(w.nulls, 0);
  assert.equal(catchUpSyncIn(w, { now: 20 }), CATCH_UP_RETRY_MS);
  for (let i = 1; i < CATCH_UP_TRIES; i++) w = catchUpAfterSync(w, { sync: { caught_up: { restored: [] } }, now: 20 + i }).wait;
  assert.equal(w, null, `ends after ${CATCH_UP_TRIES} whole catch-ups without the coin`);
  w = catchUpWait(null, { mailbox: refusal('x'), now: 0 });
  assert.equal(catchUpWait(w, { now: CATCH_UP_LAST_MS }), null, 'and at the latest after its outer bound');
  assert.equal(catchUpSyncIn(null, { now: 0 }), Infinity);
  // The gate, in the library's median time.
  assert.equal(catchUpGate(null, { caught_up: { restored: [] }, schedule: { now: 1000 } }, 900), 1000 + CATCH_UP_EVERY_S);
  assert.equal(catchUpGate(1600, { caught_up: { more: true } }, 1000), 0, 'cut short: open at once');
  assert.equal(catchUpGate(1600, { caught_up: { error: 'x' } }, 1000), 0, 'failed: open at once');
  assert.equal(catchUpGate(1600, { caught_up: null }, 1000), 1600);
  assert.equal(catchUpGate(null, { caught_up: null }, 1000), 1000 + CATCH_UP_EVERY_S / 2, 'none ran, time not known: half the gate');
});

test('a request waits until it lapses; one with no lapse date for the life every request has', () => {
  const s = (r) => ({ now: 10_000_000, receive_requests: [{ owner: 'k', state: 'waiting', ...r }] });
  assert.equal(requestWaits(s({ asked_at: 10_000_000 - 7200, lapses_at: 10_090_000 })), true, 'a code of the name, two hours old');
  assert.equal(requestWaits(s({ asked_at: 9_000_000, lapses_at: 9_999_999 })), false, 'past its lapse');
  assert.equal(requestWaits(s({ asked_at: 10_000_000 - 7200, lapses_at: null })), true, 'no lapse date, two hours old');
  assert.equal(requestWaits(s({ asked_at: 10_000_000 - REQUEST_HOLDS_S - 1, lapses_at: null })), false, 'no lapse date, past the life of a request');
  assert.equal(requestWaits(s({ lapses_at: null })), false, 'no lapse date and no time: left to the daily sync');
  assert.equal(requestWaits(s({ asked_at: 10_000_000, state: 'lapsed' })), false);
  assert.equal(requestWaits(s({ asked_at: 10_000_000, owner: 'restored' })), false);
  assert.equal(requestWaits({ now: 1 }), false);
});

// ---- the host itself, over simulated time, against a model of the library ----

// The library as the host sees it. Its median time (`now`) runs at `rate` of the wall clock. A
// schedule a day away unless `dueAt`; one request (`request`, by default two hours old). `sync`
// runs the catch-up only once CATCH_UP_EVERY_S of median time have passed since the last, and the
// catch-up takes in every coin paid to another store's code that the operator has settled
// (`settleMs` after it was paid; `never` never), plus `change`, coins the other store made itself.
// The mailbox refuses such a coin once (its cursor moves past it) and takes a coin paid to this
// store's own code. `down`: 'schedule', 'sync' or 'both' throw, as when the node does not answer.
function library({ rate = 1, request = null, lastCatchUpAgo = null } = {}) {
  const t0 = Date.now();
  const L = { calls: [], lastCatchUp: null, elsewhere: [], own: [], change: [], syncs: [], mailboxReads: 0, scheduleReads: [], dueAt: null,
    settleMs: 0, down: null };
  const secs = () => Math.floor(t0 / 1000 + (Date.now() - t0) * rate / 1000);
  if (lastCatchUpAgo != null) L.lastCatchUp = secs() - lastCatchUpAgo;
  L.secs = secs;
  L.run = (command, args) => {
    L.calls.push({ at: Date.now(), command });
    if (L.down && (L.down === 'both' || L.down === command) && (command === 'schedule' || command === 'sync')) throw new Error('the node does not answer');
    switch (command) {
      case 'schedule': {
        L.scheduleReads.push(Date.now());
        const due = L.dueAt != null && Date.now() >= L.dueAt;
        return { now: secs(), due, next_sync_at: due ? secs() : secs() + 86400, why: null,
          receive_requests: [request ? request(secs()) : { owner: 'k', state: 'waiting', asked_at: secs() - 7200, lapses_at: secs() + 80000 }] };
      }
      case 'mailbox': {
        L.mailboxReads++;
        const refused = L.elsewhere.filter((c) => !c.refused).map((c) => { c.refused = true; return { leaf_id: c.leaf_id, reason: NEVER }; });
        return { accepted: L.own.splice(0), refused, waiting: [] };
      }
      case 'sync': {
        const mailbox = L.run('mailbox');
        let caught_up = null;
        if (L.lastCatchUp == null || secs() - L.lastCatchUp >= CATCH_UP_EVERY_S) {
          L.lastCatchUp = secs();
          const ripe = L.elsewhere.filter((c) => !c.never && Date.now() - c.paidAt >= L.settleMs);
          L.elsewhere = L.elsewhere.filter((c) => !ripe.includes(c));
          caught_up = { restored: [...ripe, ...L.change.splice(0)].map(({ leaf_id, asset, value }) => ({ leaf_id, asset, value, kind: 'mailbox' })), given_elsewhere: [] };
        }
        if (L.dueAt != null && Date.now() >= L.dueAt) L.dueAt = null;
        L.syncs.push({ at: Date.now(), args, caughtUp: !!caught_up });
        return { mailbox, caught_up, schedule: { now: secs() } };
      }
      case 'coins': case 'participations': case 'channels': case 'channel_sync': case 'claims': return [];
      case 'balance': return { assets: {} };
      default: return null;
    }
  };
  L.pay = (leaf_id, extra = {}) => L.elsewhere.push({ leaf_id, asset: 'bb'.repeat(32), value: '5', paidAt: Date.now(), ...extra });
  return L;
}

async function host(L, storage) {
  const events = [];
  let listener = null;
  globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  globalThis.chrome = {
    runtime: {
      id: 'test',
      onMessage: { addListener: (f) => { listener = f; } },
      sendMessage: async (m) => { if (m && m.scope === 'leaf-event') events.push({ at: Date.now(), ...m }); },
    },
  };
  globalThis.Worker = class {
    postMessage({ id, op, args }) {
      let value;
      try {
        value = op === 'exists' ? true : op === 'run' ? { result: L.run(args.command, args.args || {}) } : true;
      } catch (e) { queueMicrotask(() => this.onmessage({ data: { id, ok: false, error: { message: String(e.message) } } })); return; }
      queueMicrotask(() => this.onmessage({ data: { id, ok: true, value } }));
    }
    terminate() {}
  };
  // A fresh instance of the host for each run.
  await import('../offscreen-leaves.js?run=' + Math.random());
  const ask = (op, args) => new Promise((ok) => listener({ scope: 'leaf', op, args }, { id: 'test' }, ok));
  return { events, ask };
}

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms, step = 250) {
  for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await flush(); }
}
const arrivedAt = (events, leaf) => (events.find((e) => e.event === 'leafArrived' && e.data.leaf_id === leaf) || {}).at;
const arrivals = (events) => events.filter((e) => e.event === 'leafArrived').map((e) => e.data.leaf_id);

async function opened(defaultMode, { lib = {}, storage = new Map(), L = null } = {}) {
  L = L || library(lib);
  const h = await host(L, storage);
  const p = h.ask('start', { mnemonic: 'test phrase', defaultMode, defaultModeAt: 1, careMs: 3600_000 });
  await flush();
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  await advance(5000);
  assert.ok(L.syncs.length >= 1, 'the open sync ran');
  return { L, storage, ...h };
}
function timed(f) {
  return async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    try { await f(); } finally { mock.timers.reset(); }
  };
}
const after = (L, t) => L.syncs.filter((s) => s.at > t);

test('default mode, idle: a payment to another store\'s code shows within seconds once the catch-up is open', timed(async () => {
  const { L, events } = await opened(true);
  await advance(11 * 60_000);
  const paid = Date.now(), n = L.syncs.length;
  L.pay('coin-a');
  await advance(60_000);
  const at = arrivedAt(events, 'coin-a');
  console.log(`coin-a: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid; ${L.syncs.length - n} sync(s)`);
  assert.ok(at && at - paid <= 15_000);
  assert.equal(L.syncs.length - n, 1, 'one sync took it in');
  assert.deepEqual(L.syncs.at(-1).args, { deposits: false });
}));

test('default mode, idle: paid minutes after a catch-up, it shows when the library\'s catch-up opens, with one sync', timed(async () => {
  const { L, events } = await opened(true);
  await advance(3 * 60_000);
  const paid = Date.now();
  const opens = (L.lastCatchUp + CATCH_UP_EVERY_S) * 1000;
  L.pay('coin-b');
  await advance(12 * 60_000);
  const at = arrivedAt(events, 'coin-b');
  const during = after(L, paid).filter((s) => !at || s.at <= at).length;
  console.log(`coin-b: ${at ? (at - paid) / 1000 + ' s after it was paid, ' + (at - opens) / 1000 + ' s after the catch-up opened' : 'not shown'}; syncs while it waited: ${during}`);
  assert.ok(at && at - opens <= 61_000);
  assert.ok(during <= 2, `${during} syncs`);
  assert.equal(after(L, at).length, 0, 'no sync once it is in');
}));

test('M1: a refusal read between ticks never pushes the next tick back', timed(async () => {
  const { L } = await opened(true);
  await advance(3 * 60_000);
  const paid = Date.now();
  L.pay('coin-x');
  L.dueAt = paid + 20_000;
  await advance(7 * 60_000);
  const first = after(L, paid)[0];
  console.log(`M1: schedule due at +20 s; first sync after the refusal at +${first ? (first.at - paid) / 1000 : '-'} s; ticks in 7 min: ${L.scheduleReads.filter((t) => t > paid).length}`);
  assert.ok(first && first.at - (paid + 20_000) <= 61_000, `the schedule's sync ran at +${first ? (first.at - paid) / 1000 : 'never'} s`);
  assert.deepEqual(first.args, {}, 'the schedule\'s own sync, whole');
}));

test('M2: with the node down during a wait, the host asks at its cadence, not without pause', timed(async () => {
  for (const down of ['both', 'sync', 'schedule']) {
    const { L, ask } = await opened(true);
    await advance(11 * 60_000);
    L.down = down;
    const n = L.calls.length;
    L.pay('coin-d-' + down);
    await advance(5 * 60_000, 100);
    const calls = L.calls.slice(n).filter((c) => c.command === 'schedule' || c.command === 'sync');
    console.log(`M2 (${down} throws): ${calls.length} schedule/sync calls in 5 min`);
    const syncs = calls.filter((c) => c.command === 'sync');
    assert.ok(syncs.length <= 6, `${syncs.length} sync attempts in 5 min`);
    assert.ok(syncs.every((c, i) => i === 0 || c.at - syncs[i - 1].at >= CATCH_UP_RETRY_MS), 'a minute at least between two attempts');
    assert.ok(calls.length <= 15, `${calls.length} calls in 5 min`);
    L.down = null;
    await ask('stop');
  }
}));

test('M3: a catch-up that ends whole before the operator settled the coin does not end the wait', timed(async () => {
  const { L, events } = await opened(true);
  L.settleMs = 20_000;
  await advance(11 * 60_000);
  const paid = Date.now();
  L.pay('coin-t');
  await advance(25 * 60_000);
  const at = arrivedAt(events, 'coin-t');
  const during = after(L, paid).filter((s) => !at || s.at <= at).length;
  console.log(`M3: shown ${at ? (at - paid) / 1000 + ' s' : 'never'} after it was paid; syncs while it waited: ${during}`);
  assert.ok(at && at - paid <= 11 * 60_000, 'shown at the next catch-up');
  assert.ok(during <= 3);
  assert.equal(after(L, at).length, 0, 'no sync once it is in');
}));

test('M3: a coin no catch-up ever brings ends the wait after the stated number of catch-ups, then nothing more', timed(async () => {
  const { L, events } = await opened(true);
  await advance(11 * 60_000);
  const paid = Date.now();
  L.pay('coin-n', { never: true });
  await advance(3 * 3600_000, 1000);
  const syncs = after(L, paid);
  const last = syncs.at(-1);
  console.log(`M3 cap: ${syncs.length} syncs, ${syncs.filter((s) => s.caughtUp).length} with a catch-up, the last at +${last ? Math.round((last.at - paid) / 60_000) : '-'} min`);
  assert.equal(syncs.filter((s) => s.caughtUp).length, CATCH_UP_TRIES);
  assert.ok(syncs.length <= CATCH_UP_TRIES + 2);
  assert.ok(last.at - paid <= 70 * 60_000);
  assert.ok(!arrivals(events).includes('coin-n'));
}));

test('L1: opened again a minute after a catch-up, the wallet knows when the next opens and syncs once for it', timed(async () => {
  const storage = new Map();
  const first = await opened(true, { storage });
  await first.ask('stop');
  await advance(60_000);
  const { L, events } = await opened(true, { storage, L: first.L });
  const paid = Date.now(), n = L.syncs.length;
  const opens = (L.lastCatchUp + CATCH_UP_EVERY_S) * 1000;
  L.pay('coin-r');
  await advance(15 * 60_000);
  const at = arrivedAt(events, 'coin-r');
  const during = L.syncs.slice(n).filter((s) => !at || s.at <= at).length;
  console.log(`L1 reopen: shown ${at ? (at - paid) / 1000 + ' s after it was paid, ' + (at - opens) / 1000 + ' s after the catch-up opened' : 'never'}; syncs while it waited: ${during}`);
  assert.ok(at && at - opens <= 61_000);
  assert.ok(during <= 2, `${during} syncs`);
}));

test('L1: opened with no record of the last catch-up, a minute after one: no burst of syncs', timed(async () => {
  const { L, events } = await opened(true, { lib: { lastCatchUpAgo: 60 } });
  await advance(30_000);
  const paid = Date.now(), n = L.syncs.length;
  L.pay('coin-q');
  await advance(15 * 60_000);
  const at = arrivedAt(events, 'coin-q');
  const during = L.syncs.slice(n).filter((s) => !at || s.at <= at).length;
  console.log(`L1 no record: shown ${at ? (at - paid) / 1000 + ' s' : 'never'} after it was paid; syncs while it waited: ${during}`);
  assert.ok(at && at - paid <= 11 * 60_000);
  assert.ok(during <= 6, `${during} syncs`);
}));

test('L1: on a chain whose median time runs at half speed, the wait follows the library\'s clock and ends with the coin', timed(async () => {
  const { L, events } = await opened(true, { lib: { rate: 0.5 } });
  await advance(30_000);
  const paid = Date.now(), n = L.syncs.length;
  L.pay('coin-s');
  await advance(40 * 60_000, 500);
  const at = arrivedAt(events, 'coin-s');
  const during = L.syncs.slice(n).filter((s) => !at || s.at <= at).length;
  console.log(`L1 half speed: shown ${at ? (at - paid) / 1000 + ' s' : 'never'} after it was paid; syncs while it waited: ${during}`);
  assert.ok(at, 'shown');
  assert.ok(during <= 2, `${during} syncs`);
}));

test('L2: a payment refused and restored by one sync is announced, and another store\'s own coins are not', timed(async () => {
  const { L, events, ask } = await opened(true);
  await advance(11 * 60_000);
  L.pay('coin-f');
  L.change.push({ leaf_id: 'change-of-the-other-store', asset: 'cc'.repeat(32), value: '1' });
  const p = ask('sync');
  await advance(1000);
  assert.equal((await p).ok, true);
  assert.equal(L.syncs.at(-1).caughtUp, true);
  assert.ok(arrivals(events).includes('coin-f'), 'announced');
  assert.ok(!arrivals(events).includes('change-of-the-other-store'), 'not announced');
}));

test('developer mode, idle: a payment to a code of its own two hours old is read within a tick', timed(async () => {
  const { L, events } = await opened(false);
  await advance(5 * 60_000);
  const paid = Date.now();
  L.own.push({ leaf_id: 'coin-c', asset: 'cc'.repeat(32), value: '7', kind: 'mailbox' });
  await advance(2 * 60_000);
  const at = arrivedAt(events, 'coin-c');
  console.log(`coin-c: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid`);
  assert.ok(at && at - paid <= 61_000);
}));

test('developer mode: a request with no lapse date is read for the life of a request, not for ever', timed(async () => {
  for (const [age, reads] of [[7200, true], [REQUEST_HOLDS_S + 60, false]]) {
    const { L, ask } = await opened(false, { lib: { request: (now) => ({ owner: 'k', state: 'waiting', asked_at: now - age, lapses_at: null }) } });
    const m = L.mailboxReads;
    await advance(10 * 60_000);
    console.log(`no lapse date, ${Math.round(age / 86400)} d old: ${L.mailboxReads - m} mailbox read(s) in 10 min`);
    assert.equal(L.mailboxReads - m > 0, reads);
    await ask('stop');
  }
}));

test('idle with nothing paid: no sync beyond the open one; the mailbox read once a tick in developer mode', timed(async () => {
  for (const defaultMode of [true, false]) {
    const { L, ask } = await opened(defaultMode);
    const reads0 = L.mailboxReads;
    await advance(30 * 60_000);
    const perMin = (L.mailboxReads - reads0) / 30;
    console.log(`${defaultMode ? 'default' : 'developer'} mode, idle 30 min: ${L.syncs.length} sync(s), ${perMin} mailbox read(s) a minute`);
    assert.equal(L.syncs.length, 1);
    if (!defaultMode) assert.ok(perMin <= 1.05);
    await ask('stop');
  }
}));
