// A payment to a code another store of the phrase handed out (the payment name's stock keeps such
// codes, and the phrase may be open elsewhere) is refused by this store's mailbox and taken in only
// by the library's catch-up, a step of `sync` that runs at most every ten minutes. The host
// (offscreen-leaves.js) syncs as soon as its mailbox read refuses such a coin, and every
// CATCH_UP_POLL_MS until a catch-up has run, so the payment shows within seconds when the catch-up
// is due and within its ten minutes otherwise, never at the next daily sync (sequentia-extension#214).
// A payment to a code of this store's own made more than an hour ago is read by the mailbox in
// developer mode too.
//   node --test test/catch-up-wait.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { requestWaits, phraseCoinRefused, caughtUpWhole, catchUpWait, catchUpSyncDue, catchUpSyncIn, catchUpRanAt, CATCH_UP_POLL_MS,
  CATCH_UP_WAIT_MS, CATCH_UP_EVERY_MS }
  from '../src/leaf-schedule.js';

const NEVER = 'refused: a coin for owner nonce ab12, which this wallet never drew';

test('the rules: a refused phrase coin starts the wait, a whole catch-up ends it, it lapses by itself', () => {
  assert.equal(phraseCoinRefused({ refused: [{ leaf_id: 'x', reason: NEVER }] }), true);
  assert.equal(phraseCoinRefused({ refused: [{ leaf_id: 'x', reason: 'refused: the record does not decode' }] }), false);
  assert.equal(phraseCoinRefused(null), false);
  assert.equal(caughtUpWhole({ caught_up: null }), false);
  assert.equal(caughtUpWhole({ caught_up: { error: 'unreachable' } }), false);
  assert.equal(caughtUpWhole({ caught_up: { restored: [], more: true } }), false);
  assert.equal(caughtUpWhole({ caught_up: { restored: [] } }), true);
  let w = catchUpWait(null, { mailbox: { refused: [{ reason: NEVER }] }, now: 1000 });
  assert.deepEqual(w, { since: 1000, syncedAt: null });
  assert.equal(catchUpSyncDue(w, 1000), true, 'synced at once');
  w = catchUpWait(w, { sync: { caught_up: null, mailbox: {} }, now: 2000 });
  assert.deepEqual(w, { since: 1000, syncedAt: 2000 });
  assert.equal(catchUpSyncDue(w, 2000 + CATCH_UP_POLL_MS - 1), false);
  assert.equal(catchUpSyncDue(w, 2000 + CATCH_UP_POLL_MS), true);
  assert.equal(catchUpWait(w, { sync: { caught_up: { restored: [{}] } }, now: 3000 }), null);
  assert.equal(catchUpWait(w, { now: 1000 + CATCH_UP_WAIT_MS }), null, 'lapses');
  assert.equal(catchUpWait(null, { sync: { caught_up: null, mailbox: { refused: [{ reason: NEVER }] } }, now: 5 }).since, 5,
    'a sync that refused one and ran no catch-up starts it');
  assert.equal(catchUpWait(null, { sync: { caught_up: {}, mailbox: { refused: [{ reason: NEVER }] } }, now: 5 }), null,
    'its own catch-up ran after its mailbox: nothing waits');
});

test('the host waits for the library\'s catch-up to fall due before it syncs for one', () => {
  const w = { since: 100_000, syncedAt: null };
  assert.equal(catchUpSyncIn(w, 100_000, null), 0, 'no catch-up seen: at once');
  assert.equal(catchUpSyncIn(w, 100_000, 40_000), 40_000 + CATCH_UP_EVERY_MS - 100_000, 'one seen a minute ago: when it is due again');
  assert.equal(catchUpSyncDue(w, 40_000 + CATCH_UP_EVERY_MS, 40_000), true);
  assert.equal(catchUpSyncIn(null, 1, null), Infinity);
  assert.equal(catchUpRanAt(5, { caught_up: null }, 9), 5, 'none ran');
  assert.equal(catchUpRanAt(5, { caught_up: { restored: [] } }, 9), 9);
  assert.equal(catchUpRanAt(5, { caught_up: { more: true } }, 9), null, 'cut short: due again at once');
  assert.equal(catchUpRanAt(5, { caught_up: { error: 'x' } }, 9), null, 'failed: the library tries again at the next sync');
});

test('a request waits however long ago it was handed out, until it lapses', () => {
  const s = (asked, state = 'waiting', owner = 'k', lapses = 90000) => ({ now: 10000, receive_requests: [{ owner, state, asked_at: asked, lapses_at: lapses }] });
  assert.equal(requestWaits(s(9000)), true);
  assert.equal(requestWaits(s(10000 - 7200)), true, 'a code of the name, two hours old');
  assert.equal(requestWaits(s(9000, 'lapsed')), false);
  assert.equal(requestWaits(s(9000, 'waiting', 'restored')), false);
  assert.equal(requestWaits(s(9000, 'waiting', 'k', 9999)), false, 'past its lapse');
  assert.equal(requestWaits({ now: 1 }), false);
});

// ---- the host itself, over simulated time, against a model of the library ----

// The library as the host sees it: a schedule a day away, one request two hours old; `sync` runs
// the catch-up only once ten minutes have passed since the last (the library's CATCH_UP_EVERY), and
// the catch-up takes in every coin paid to another store's code; the mailbox refuses such a coin
// once (its cursor moves past it) and takes a coin paid to this store's own code.
function library() {
  const L = { lastCatchUp: null, elsewhere: [], own: [], syncs: [], mailboxReads: 0 };
  const secs = () => Math.floor(Date.now() / 1000);
  L.run = (command, args) => {
    switch (command) {
      case 'schedule': return { now: secs(), due: false, next_sync_at: secs() + 86400, why: null,
        receive_requests: [{ owner: 'k', state: 'waiting', asked_at: secs() - 7200, lapses_at: secs() + 80000 }] };
      case 'mailbox': {
        L.mailboxReads++;
        const refused = L.elsewhere.filter((c) => !c.refused).map((c) => { c.refused = true; return { leaf_id: c.leaf_id, reason: NEVER }; });
        const accepted = L.own.splice(0);
        return { accepted, refused, waiting: [] };
      }
      case 'sync': {
        const mailbox = L.run('mailbox');
        let caught_up = null;
        if (L.lastCatchUp == null || secs() - L.lastCatchUp >= 600) {
          L.lastCatchUp = secs();
          caught_up = { restored: L.elsewhere.splice(0).map(({ leaf_id, asset, value }) => ({ leaf_id, asset, value, kind: 'mailbox' })), given_elsewhere: [] };
        }
        L.syncs.push({ at: Date.now(), args, caughtUp: !!caught_up });
        return { mailbox, caught_up };
      }
      case 'coins': case 'participations': case 'channels': case 'channel_sync': case 'claims': return [];
      case 'balance': return { assets: {} };
      default: return null;
    }
  };
  return L;
}

async function host(L) {
  const events = [];
  let listener = null;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
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
      } catch (e) { queueMicrotask(() => this.onmessage({ data: { id, ok: false, error: { message: String(e) } } })); return; }
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

async function opened(defaultMode) {
  const L = library();
  const h = await host(L);
  const p = h.ask('start', { mnemonic: 'test phrase', defaultMode, defaultModeAt: 1, careMs: 3600_000 });
  await flush();
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  await advance(5000);
  assert.ok(L.syncs.length >= 1 && L.syncs[0].caughtUp, 'the open sync ran a catch-up');
  return { L, ...h };
}

test('default mode, idle: a payment to another store\'s code shows within seconds once the catch-up is due', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  try {
    const { L, events } = await opened(true);
    await advance(11 * 60_000);
    const syncsBefore = L.syncs.length;
    const paid = Date.now();
    L.elsewhere.push({ leaf_id: 'coin-a', asset: 'aa'.repeat(32), value: '100000000' });
    await advance(60_000);
    const at = arrivedAt(events, 'coin-a');
    console.log(`coin-a: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid`);
    assert.ok(at, 'the payment showed');
    assert.ok(at - paid <= 15_000, `shown ${(at - paid) / 1000} s after it was paid`);
    assert.equal(L.syncs.length - syncsBefore, 1, 'one sync took it in');
    assert.deepEqual(L.syncs.at(-1).args, { deposits: false });
  } finally { mock.timers.reset(); }
});

test('default mode, idle: when the catch-up ran minutes ago, the payment shows when it falls due, and the syncs stop then', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  try {
    const { L, events } = await opened(true);
    await advance(3 * 60_000);
    const paid = Date.now();
    const due = (L.lastCatchUp + 600) * 1000;
    L.elsewhere.push({ leaf_id: 'coin-b', asset: 'bb'.repeat(32), value: '5' });
    await advance(12 * 60_000);
    const at = arrivedAt(events, 'coin-b');
    console.log(`coin-b: ${at ? (at - paid) / 1000 + ' s after it was paid, ' + (at - due) / 1000 + ' s after the catch-up fell due' : 'not shown'}; syncs while it waited: ${L.syncs.filter((x) => x.at >= paid && (!at || x.at <= at)).length}`);
    assert.ok(at, 'the payment showed');
    assert.ok(at - due <= CATCH_UP_POLL_MS + 15_000, `shown ${(at - due) / 1000} s after the catch-up fell due (${(at - paid) / 1000} s after it was paid)`);
    const during = L.syncs.filter((s) => s.at >= paid && s.at <= at).length;
    assert.ok(during <= 3, `${during} syncs while it waited`);
    const after = L.syncs.filter((s) => s.at > at).length;
    assert.equal(after, 0, 'no sync once it is in');
  } finally { mock.timers.reset(); }
});

test('developer mode, idle: a payment to a code of its own two hours old is read within a tick', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  try {
    const { L, events } = await opened(false);
    await advance(5 * 60_000);
    const paid = Date.now();
    L.own.push({ leaf_id: 'coin-c', asset: 'cc'.repeat(32), value: '7', kind: 'mailbox' });
    await advance(2 * 60_000);
    const at = arrivedAt(events, 'coin-c');
    console.log(`coin-c: ${at ? (at - paid) / 1000 + ' s' : 'not shown'} after it was paid`);
    assert.ok(at, 'the payment showed');
    assert.ok(at - paid <= 61_000, `shown ${(at - paid) / 1000} s after it was paid`);
  } finally { mock.timers.reset(); }
});

test('idle with nothing paid: no sync beyond the open one; the mailbox read once a tick in developer mode', async () => {
  for (const defaultMode of [true, false]) {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    try {
      const { L } = await opened(defaultMode);
      const reads0 = L.mailboxReads;
      await advance(30 * 60_000);
      const perMin = (L.mailboxReads - reads0) / 30;
      console.log(`${defaultMode ? 'default' : 'developer'} mode, idle 30 min: ${L.syncs.length} sync(s), ${perMin} mailbox read(s) a minute`);
      assert.equal(L.syncs.length, 1);
      if (!defaultMode) assert.ok(perMin <= 1.05, `${perMin} reads a minute`);
    } finally { mock.timers.reset(); }
  }
});
