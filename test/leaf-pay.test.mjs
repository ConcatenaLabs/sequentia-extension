// A payment that needs a planned coin, made through the next round by itself; and care's
// planning reach. The host (offscreen-leaves.js) runs these rules over the library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { careArgs, channelsToClose, releaseDone, plannedCoins, payThrough, RELEASE_POLL_MS, RELEASE_WAIT_MS, RELEASE_TRIES, RELEASE_TIMEOUT, ROUND_POLL_MS, SETTLE_GAVE_UP } from '../src/leaf-schedule.js';

const X = 'aa'.repeat(32);

test('care plans with the library\'s own reach: its arguments', () => {
  assert.deepEqual(careArgs(), { channels: true });
  assert.deepEqual(careArgs(21), { channels: true, scan: 21 });
  assert.equal(RELEASE_POLL_MS, 15_000);
  assert.equal(RELEASE_WAIT_MS, 3 * 3600_000);
  assert.equal(RELEASE_TRIES, 3);
});

test('a release is done once no coin it gave up is still live or in its round', () => {
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'given' }], ['a']), false);
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'forfeited' }, { leaf_id: 'n', state: 'live' }], ['a']), false);
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'live' }], ['a']), false);
  assert.equal(releaseDone([{ leaf_id: 'a', state: 'spent' }, { leaf_id: 'n', state: 'live' }], ['a']), true);
  assert.equal(releaseDone([], ['a']), true, 'a coin gone from the list is done with');
});

test('the planned coins are the current coins of open and stopped plans', () => {
  const m = plannedCoins([
    { plan_id: 'p1', state: 'open', coin: 'c1', steps: [{ state: 'waiting' }] },
    { plan_id: 'p2', state: 'open', coin: 'c2', steps: [{ state: 'done', leaf_id: 's1' }, { state: 'waiting' }] },
    { plan_id: 'p3', state: 'cancelled', coin: 'c3', steps: [] },
    { plan_id: 'p4', state: 'stopped', coin: 'c4', steps: [] },
  ]);
  assert.deepEqual([...m.keys()].sort(), ['c1', 'c4', 's1']);
  assert.equal(m.get('s1').plan_id, 'p2');
  assert.equal(plannedCoins(null).size, 0);
});

// A fake library: `send` refused `planned` until the release's round is final.
function fakeLibrary({ refusals = 1, freedAfterSyncs = 2, other = null } = {}) {
  const log = [];
  let sends = 0, syncs = 0, released = false;
  let clock = 1_000_000;
  const io = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; log.push(['sleep', ms]); },
    run: async (command, args) => {
      log.push([command, args]);
      if (command === 'send') {
        sends++;
        if (other) throw other;
        if (sends <= refusals) throw { kind: 'planned', asset: X, release: ['big' + sends], message: 'refused: short; … releasing 1 of them covers it' };
        return { result: { sent: { value: '500000' } }, start: {} };
      }
      if (command === 'plan_release') { released = true; return { result: { plans: [{ plan_id: 'p', state: 'open' }], participations: [{ state: 'pending' }] }, start: {} }; }
      throw new Error('no command ' + command);
    },
    sync: async () => { syncs++; log.push(['sync']); },
    coins: async () => {
      const done = released && syncs >= freedAfterSyncs;
      return [{ leaf_id: 'big' + sends, state: done ? 'spent' : 'given' }, { leaf_id: 'new', state: done ? 'live' : 'pending' }];
    },
    waits: [],
    waiting: (st) => io.waits.push(st && { ...st }),
  };
  return { io, log, get sends() { return sends; }, get syncs() { return syncs; }, get clock() { return clock; } };
}

test('a payment the planned coins cover is made through the next round, with no prompt', async () => {
  const f = fakeLibrary();
  const v = await payThrough('send', { request: 'r', amount: '500000', asset: X }, f.io);
  assert.deepEqual(v.result, { sent: { value: '500000' } });
  assert.equal(f.sends, 2, 'asked again once');
  assert.deepEqual(f.log.find((l) => l[0] === 'plan_release'), ['plan_release', { leaves: ['big1'] }]);
  assert.ok(f.syncs >= 2, 'synced until the round freed the coin');
  assert.ok(f.log.some((l) => l[0] === 'sleep' && l[1] === RELEASE_POLL_MS), 'polled every 15 s');
  // The host was told what is released while it waited, and then that the wait is over.
  assert.equal(f.io.waits[0].command, 'send');
  assert.deepEqual(f.io.waits[0].coins, ['big1']);
  assert.equal(f.io.waits.at(-1), null);
});

test('any other refusal is the library\'s, untouched, and nothing is released', async () => {
  const no = { kind: 'refused', message: 'refused: no' };
  const f = fakeLibrary({ other: no });
  await assert.rejects(payThrough('send', {}, f.io), (e) => e === no);
  assert.ok(!f.log.some((l) => l[0] === 'plan_release'));
  // A `planned` refusal naming nothing to release is the library's too.
  const g = fakeLibrary({ other: { kind: 'planned', release: [], message: 'short' } });
  await assert.rejects(payThrough('send', {}, g.io), (e) => e.message === 'short');
});

test('a release that never frees its coins gives up in plain words after three hours, having paid nothing', async () => {
  const f = fakeLibrary({ freedAfterSyncs: Infinity });
  await assert.rejects(payThrough('send', {}, f.io), (e) => e.kind === 'refused' && e.message === RELEASE_TIMEOUT);
  assert.equal(f.sends, 1);
  assert.ok(f.clock - 1_000_000 >= RELEASE_WAIT_MS);
  assert.match(RELEASE_TIMEOUT, /nothing was paid/);
});

test('at most three releases for one payment, then the library\'s refusal', async () => {
  const f = fakeLibrary({ refusals: 10 });
  await assert.rejects(payThrough('send', {}, f.io), (e) => e.kind === 'planned');
  assert.equal(f.log.filter((l) => l[0] === 'plan_release').length, RELEASE_TRIES);
  assert.equal(f.sends, RELEASE_TRIES + 1);
});

// RB6 (2026-11-18): two default-mode payments by name from the browser were said "declined" while
// the wallet held about 250,000 of the asset: once on its channel's side (`in_channel`), once in a
// round of its own whose coins it had not taken yet (`settle_first`). The web wallet pays both after
// the round (its leaves.js `paying`); so does this host now.
test('a payment whose coins wait for a round settles them first and goes, never declined', async () => {
  const log = [];
  let clock = 0, sends = 0, asks = 0;
  const io = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; log.push(['sleep', ms]); },
    sync: async () => { log.push(['sync']); },
    coins: async () => [],
    waits: [],
    waiting: (st) => io.waits.push(st && { ...st }),
    run: async (command, args) => {
      log.push([command, args]);
      if (command === 'send') {
        sends++;
        if (sends === 1) throw { kind: 'settle_first', asset: X, coins: ['r1'], final_in_seconds: 240, message: 'refused: … settle them first (settle_first) …' };
        return { result: { sent: { value: '100000000' } }, start: {} };
      }
      if (command === 'settle_first') { asks++; return { result: asks < 3 ? { ready: false, settling: ['r1'] } : { ready: true, settling: [] }, start: {} }; }
      throw new Error('no command ' + command);
    },
  };
  const v = await payThrough('send', { request: 'r', amount: '100000000', asset: X }, io);
  assert.deepEqual(v.result, { sent: { value: '100000000' } });
  assert.equal(sends, 2, 'asked again once the coins were through');
  assert.deepEqual(log.find((l) => l[0] === 'settle_first'), ['settle_first', { coins: ['r1'] }], 'the coins the refusal named');
  assert.equal(asks, 3, 'asked until ready');
  assert.ok(log.some((l) => l[0] === 'sleep' && l[1] === ROUND_POLL_MS));
  assert.equal(io.waits[0].why, 'settle');
  assert.equal(io.waits.at(-1), null);
  // No coins named: the asset's.
  let n = 0;
  const io2 = { ...io, waiting: null };
  io2.run = async (c, a) => { if (c === 'send' && n++ === 0) throw { kind: 'settle_first', asset: X, coins: [], message: 'm' }; if (c === 'settle_first') { io2.asked = a; return { ready: true }; } return { result: 'ok' }; };
  assert.equal((await payThrough('send', {}, io2)).result, 'ok');
  assert.deepEqual(io2.asked, { asset: X });
});

test('a settle that never ends, or that keeps the payment short, is said in plain words with nothing sent', async () => {
  let clock = 0;
  const base = { now: () => clock, sleep: async (ms) => { clock += ms; }, sync: async () => {}, coins: async () => [] };
  const never = { ...base, run: async (c) => { if (c === 'send') throw { kind: 'settle_first', asset: X, message: 'm' }; return { ready: false }; } };
  await assert.rejects(payThrough('send', {}, never), (e) => e.code === 'settle_gave_up' && e.message === SETTLE_GAVE_UP);
  assert.ok(clock >= RELEASE_WAIT_MS);
  let sends = 0;
  const always = { ...base, run: async (c) => { if (c === 'send') { sends++; throw { kind: 'settle_first', asset: X, message: 'm' }; } return { ready: true }; } };
  await assert.rejects(payThrough('send', {}, always), (e) => e.code === 'settle_gave_up');
  assert.equal(sends, RELEASE_TRIES + 1);
  assert.match(SETTLE_GAVE_UP, /nothing was sent/);
  // An offboard's quote answers at once, as the library gave it.
  const r = { kind: 'settle_first', asset: X, message: 'm' };
  await assert.rejects(payThrough('offboard_quote', {}, { ...base, run: async () => { throw r; } }), (e) => e === r);
});

test('a payment the channel side covers closes the channel into the next round, then pays', async () => {
  const log = [];
  let clock = 0, sends = 0, syncs = 0;
  const held = [];
  const io = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sync: async () => { syncs++; },
    coins: async () => [{ leaf_id: 'ch1', state: syncs >= 2 ? 'spent' : 'given' }],
    channelsHeld: (a) => held.push(a),
    run: async (command, args) => {
      log.push([command, args]);
      if (command === 'send') { sends++; if (sends === 1) throw { kind: 'in_channel', asset: X, close: ['ch1'], side: '24998266207313', message: 'refused: … closing 1 of them into the next round …' }; return { result: 'paid' }; }
      if (command === 'quote') return { result: { coins: [{ leaf: 'ch1', fee: '3' }] } };
      if (command === 'participate') return { result: { participation: 'p1' } };
      throw new Error('no command ' + command);
    },
  };
  assert.equal((await payThrough('send', { asset: X }, io)).result, 'paid');
  assert.deepEqual(log.find((l) => l[0] === 'quote'), ['quote', { leaves: ['ch1'] }]);
  assert.deepEqual(log.find((l) => l[0] === 'participate'), ['participate', { leaves: ['ch1'], shown: [{ leaf: 'ch1', fee: '3' }] }], 'the fee the quote showed');
  assert.ok(syncs >= 2, 'followed until the channel coin is spent');
  assert.deepEqual(held, [X, null], 'care holds its channels while the payment waits, then lets go');
});

test('default mode keeps its money in coins: care opens no channel, and each live one is closed', () => {
  assert.deepEqual(careArgs(21, { channels: false }), { channels: false, scan: 21 });
  assert.deepEqual(careArgs(21, { channels: true }), { channels: true, scan: 21 });
  const chans = [{ leaf_id: 'a', coin_state: 'live' }, { leaf_id: 'b', coin_state: 'given' }, { leaf_id: 'c', coin_state: 'live' }, { coin_state: 'live' }];
  assert.deepEqual(channelsToClose(chans), ['a', 'c']);
  assert.deepEqual(channelsToClose(chans, [{ leaf_id: 'c', state: 'given' }]), ['a'], 'one already in a round is left alone');
  assert.deepEqual(channelsToClose(null), []);
});
