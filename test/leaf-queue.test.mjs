// The leaf wallet's commands, one at a time, the person's first (src/leaf-queue.js), and the host's
// use of it (offscreen-leaves.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQueue, PERSON, PROMPT, UPKEEP } from '../src/leaf-queue.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A worker that answers each command after `ms`, recording the order it ran them in.
function worker(ms = 20) {
  const ran = [];
  let busy = 0, most = 0;
  const send = async (op, args) => { busy++; most = Math.max(most, busy); ran.push(args.command); await sleep(ms); busy--; return { result: args.command }; };
  return { ran, send, most: () => most };
}

test('a person’s command goes ahead of every upkeep command queued, and waits only for the one running', async () => {
  const w = worker();
  const q = createQueue({ send: w.send });
  const up = ['sync', 'care', 'bond', 'claims'].map((c) => q.call('run', { command: c }, UPKEEP));
  await sleep(5);
  const quote = q.call('run', { command: 'swap_read' }, PERSON);
  assert.equal(q.personWaits(), true);
  assert.deepEqual(await quote, { result: 'swap_read' });
  await Promise.all(up);
  assert.deepEqual(w.ran, ['sync', 'swap_read', 'care', 'bond', 'claims']);
  assert.equal(w.most(), 1, 'one command in the worker at a time');
  assert.equal(q.personWaits(), false);
});

test('among equals the first asked runs first; a prompt goes before upkeep and after a person', async () => {
  const w = worker(5);
  const q = createQueue({ send: w.send });
  const all = [q.call('run', { command: 'a' }), q.call('run', { command: 'b' }, UPKEEP), q.call('run', { command: 'c' }, PROMPT),
    q.call('run', { command: 'd' }, PERSON), q.call('run', { command: 'e' }, PERSON)];
  await Promise.all(all);
  assert.deepEqual(w.ran, ['a', 'd', 'e', 'c', 'b']);
});

test('a command that never answers is reported once, and failAll lets every caller go', async () => {
  let t = 0;
  const hung = [];
  const q = createQueue({ send: () => new Promise(() => {}), now: () => t, hungAfter: () => 1000, onHung: (h) => hung.push(h) });
  const a = q.call('run', { command: 'sync' });
  const b = q.call('run', { command: 'coins' }, PERSON);
  t = 2000;
  await sleep(1100);
  assert.equal(hung.length, 1);
  assert.equal(hung[0].args.command, 'sync');
  q.failAll(new Error('the leaf wallet did not answer'));
  await assert.rejects(a, /did not answer/);
  await assert.rejects(b, /did not answer/);
  assert.equal(q.running(), null);
});

test('a slow command is named with what it waited', async () => {
  let t = 0;
  const slow = [];
  const q = createQueue({ send: async () => { t += 12_000; return 1; }, now: () => t, onSlow: (s) => slow.push(s) });
  await q.call('run', { command: 'sync' });
  await sleep(1);
  assert.equal(slow.length, 1);
  assert.equal(slow[0].ms, 12_000);
});

const host = readFileSync(new URL('../offscreen-leaves.js', import.meta.url), 'utf8');

test('the host sends every command through the queue, a person’s at PERSON', () => {
  assert.match(host, /function call\(op, args = \{\}, prio = UPKEEP\) \{\n  return Q\.call\(op, args, prio\);/);
  assert.match(host, /run: \(c, a\) => runCommand\(c, a, PERSON\)/);
  assert.match(host, /command: 'mailbox' \}, PROMPT\)/, "the faucet's coin taken in goes before upkeep");
  // Only post() talks to the worker.
  assert.equal((host.match(/worker\.postMessage/g) || []).length, 1);
});

test('the scheduled pass gives way to a person between its commands, and starts in a quiet moment', () => {
  const tick = host.slice(host.indexOf('async function tick()'), host.indexOf('// One command of the library.'));
  assert.ok((tick.match(/giveWay\(\);/g) || []).length >= 6, 'between its steps');
  assert.match(tick, /if \(e === HELD\) wait = 5000;/);
  assert.match(tick, /PERSON_QUIET_MS - \(Date\.now\(\) - \(S\.lastAsked \|\| 0\)\)/);
  assert.match(tick, /PASS_DEFER_MOST_MS/, 'never put off for good');
  assert.match(host, /if \(yieldNow\(\)\) \{ S\.bondLater = true; return S\.lastCare; \}/);
});

test('a sync asked for a trade waits for a person and shares the last one', () => {
  assert.match(host, /if \(command === 'sync'\) return await syncForCaller\(!!args\.paying\);/);
  assert.match(host, /while \(upkeepHeld\(\) \|\| Q\.personWaits\(\)\) await/);
  assert.match(host, /Date\.now\(\) - S\.lastSync\.at < SYNC_SHARED_MS\) return S\.lastSyncValue/);
});

test('a hung library is started again rather than holding every command after it', () => {
  assert.match(host, /onHung: [\s\S]{0,300}restartWorker\(/);
  assert.match(host, /function restartWorker\(e\) \{[\s\S]{0,200}worker\.terminate\(\)/);
});
