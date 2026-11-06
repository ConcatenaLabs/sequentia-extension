// A faucet payment to the receive code is taken in by a mailbox read, never a whole sync, so the
// popup says Received within seconds of the faucet's answer (sequentia-faucet#25).
//   node --test test/faucet-take-in.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readUntil } from '../src/leaf-schedule.js';
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { forbiddenIn } from '../vendor/user-trade.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the mailbox is read every two seconds until the coin is there', async () => {
  let t = 0, reads = 0, there = false;
  const got = await readUntil({ came: () => there, ms: 45000, every: 2000, now: () => t, sleep: async (ms) => { t += ms; },
    read: async () => { reads++; if (reads === 3) there = true; } });
  assert.equal(got, true);
  assert.equal(reads, 3);
  assert.equal(t, 4000);
});

test('a coin another read took in first counts with no read; one that never comes ends at ms', async () => {
  let reads = 0;
  assert.equal(await readUntil({ came: () => true, ms: 45000, read: async () => { reads++; } }), true);
  assert.equal(reads, 0);
  let t = 0;
  assert.equal(await readUntil({ came: () => false, ms: 45000, every: 2000, now: () => t, sleep: async (ms) => { t += ms; }, read: async () => { reads++; } }), false);
  assert.equal(t, 45000);
  assert.equal(reads, 23);
});

test('a read the library does not answer in time (busy with a sync) is not waited for', async () => {
  const t0 = Date.now();
  const got = await readUntil({ came: () => false, ms: 300, read: () => new Promise(() => {}) });
  assert.equal(got, false);
  assert.ok(Date.now() - t0 < 1000);
});

test('the service worker: the code shown before at once, the coin taken in, never a sync, never the address because the faucet is busy', () => {
  const dm = read('src/default-mode.js');
  const f = dm.slice(dm.indexOf('export async function faucet('), dm.indexOf('// ---- send ----'));
  assert.ok(!/hostOp\('sync'\)/.test(f), 'no whole sync');
  assert.match(f, /code = await leafCode\(false, \{ quick \}\);/);
  assert.match(f, /if \(e\.alreadyPaid \|\| e\.reason === 'busy'\) throw e;/);
  assert.match(f, /if \(quick && e\.status === 400\) \{ await forgetCode\(\); quick = false; continue; \}/);
  assert.match(f, /leaves\.hostOp\('takeIn', \{ asset: hex, since: t0 \}\)/);
  assert.match(f, /DEFAULT_WORDS\.faucetOnItsWay\(what\(j\)\)/);
  assert.match(f, /e\.status = r\.status; e\.reason = j\.reason \|\| null;/);
  const host = read('offscreen-leaves.js');
  assert.match(host, /case 'takeIn':[\s\S]{0,140}return await takeIn\(args\);/);
  assert.match(host, /arrivals\(\(await call\('run', \{ command: 'mailbox' \}\)\)\.result\)/);
  const popup = read('popup/popup.js');
  assert.match(popup, /faucetWaiting = r\.arriving && r\.arriving\.asset \? r\.arriving : null;/);
  assert.match(popup, /msg\.event === 'leafArrived' && faucetWaiting/);
});

test('the words while the coin is on its way say nothing of how it travels', () => {
  const s = DEFAULT_WORDS.faucetOnItsWay('5,000 OILX');
  assert.equal(s, 'The faucet sent 5,000 OILX. It shows in your balance as soon as your wallet has taken it in, usually within a few minutes.');
  assert.deepEqual(forbiddenIn(s), []);
});
