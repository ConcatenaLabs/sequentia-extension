// A payment that needs a planned coin, made through the next round by itself; and care's
// planning reach. The host (offscreen-leaves.js) runs these rules over the library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { careArgs, releaseDone, plannedCoins, payThrough, PLAN_EVERY_ROUND_LEAF, RELEASE_POLL_MS, RELEASE_WAIT_MS, RELEASE_TRIES, RELEASE_TIMEOUT } from '../src/leaf-schedule.js';

const X = 'aa'.repeat(32);

test('care plans every leaf of a round: its arguments', () => {
  assert.equal(PLAN_EVERY_ROUND_LEAF, 4294967295);
  assert.deepEqual(careArgs(), { plan_within: 4294967295 });
  assert.deepEqual(careArgs(21), { plan_within: 4294967295, scan: 21 });
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
