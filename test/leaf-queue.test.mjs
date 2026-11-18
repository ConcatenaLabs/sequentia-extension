// The leaf wallet's commands, one at a time, the person's first (src/leaf-queue.js), and the host's
// use of it (offscreen-leaves.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQueue, argsShape, PERSON, PROMPT, PASS, UPKEEP, FAIR_TURN } from '../src/leaf-queue.js';

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

test('the scheduled pass goes before the rest of the upkeep, after a prompt', async () => {
  const w = worker(5);
  const q = createQueue({ send: w.send });
  const all = [q.call('run', { command: 'a' }), q.call('run', { command: 'b' }, UPKEEP), q.call('run', { command: 'c' }, PASS),
    q.call('run', { command: 'd' }, PROMPT), q.call('run', { command: 'e' }, PASS)];
  await Promise.all(all);
  assert.deepEqual(w.ran, ['a', 'd', 'c', 'e', 'b']);
});

test('a read asked while the same read waits shares its answer; a different one does not', async () => {
  const w = worker(10);
  const q = createQueue({ send: w.send });
  const first = q.call('run', { command: 'sync' });
  const reads = [1, 2, 3].map(() => q.call('run', { command: 'coins', args: {} }, UPKEEP, { share: true }));
  const other = q.call('run', { command: 'coins', args: { k: 1 } }, UPKEEP, { share: true });
  const unshared = q.call('run', { command: 'coins', args: {} }, UPKEEP);
  await Promise.all([first, ...reads, other, unshared]);
  assert.deepEqual(w.ran, ['sync', 'coins', 'coins', 'coins']);
  assert.equal(q.stats().shared, 2);
});

test('a read nobody inside waits on is refused as busy past its bound, and said', async () => {
  let t = 0;
  const dropped = [];
  let release;
  const q = createQueue({ send: (op, a) => (a.command === 'sync' ? new Promise((r) => { release = r; }) : Promise.resolve(a.command)), now: () => t,
    onDropped: (l) => dropped.push(...l) });
  const sync = q.call('run', { command: 'sync' });
  const read = q.call('run', { command: 'coins', args: { a: 1 } }, UPKEEP, { dropAfterMs: 1000, from: 'x.js:1 f' });
  const kept = q.call('run', { command: 'balance' }, UPKEEP);
  await sleep(1);
  t = 1500;
  assert.deepEqual(q.stats().top.map((x) => x.what), ['coins from x.js:1 f', 'balance']);
  release(1);
  await sync;
  await assert.rejects(read, (e) => e.kind === 'busy');
  assert.equal(await kept, 'balance', 'a command with no bound is kept');
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].from, 'x.js:1 f');
  assert.equal(q.stats().dropped, 1);
});

test('a person\'s command and the host\'s own are never shared nor dropped; a caller that keeps a read keeps it', async () => {
  let t = 0;
  let release;
  const ran = [];
  const q = createQueue({ send: (op, a) => { ran.push(a.command + ':' + JSON.stringify(a.k ?? null)); return a.command === 'sync' ? new Promise((r) => { release = r; }) : Promise.resolve(a.command); }, now: () => t });
  const sync = q.call('run', { command: 'sync' });
  const outside = q.call('run', { command: 'balance', k: 1 }, UPKEEP, { share: true, dropAfterMs: 1000 });
  const person = q.call('run', { command: 'balance', k: 1 }, PERSON, { share: true, dropAfterMs: 1000 });
  const own = q.call('run', { command: 'balance', k: 1 }, PASS, { share: true, dropAfterMs: 1000 });
  const kept = q.call('run', { command: 'coins', k: 2 }, UPKEEP, { share: true, dropAfterMs: 1000 });
  const keeper = q.call('run', { command: 'coins', k: 2 }, UPKEEP, { share: true });
  await sleep(1);
  t = 5000;
  release(1);
  await sync;
  assert.equal(await person, 'balance', 'a person\'s read, past the bound, answered');
  assert.equal(await own, 'balance');
  await assert.rejects(outside, (e) => e.kind === 'busy', 'the outside read alone is dropped');
  assert.equal(await kept, 'coins', 'a read a caller keeps is kept for every sharer');
  assert.equal(await keeper, 'coins');
  assert.deepEqual(ran, ['sync:null', 'balance:1', 'balance:1', 'coins:2'], 'the person\'s and the host\'s reads each ran by themselves');
  assert.equal(q.stats().shared, 1);
});

test('fair turns: persons\' commands back to back never keep lower work from its turn', async () => {
  const w = worker(1);
  const q = createQueue({ send: w.send });
  // A person's reads keep coming (each asked as the last is answered), with a prompt read, two steps
  // of the host's own work and two upkeep reads waiting.
  let n = 0;
  const persons = async () => { while (n < 12) { n++; await q.call('run', { command: 'P' + n }, PERSON, { read: true }); } };
  const p = persons();
  const lower = [q.call('run', { command: 'prompt' }, PROMPT), q.call('run', { command: 'pass1' }, PASS), q.call('run', { command: 'pass2' }, PASS),
    q.call('run', { command: 'up1' }, UPKEEP), q.call('run', { command: 'up2' }, UPKEEP)];
  await Promise.all([p, ...lower]);
  const at = (c) => w.ran.indexOf(c);
  assert.equal(FAIR_TURN, 3);
  // The person's command already running, then FAIR_TURN more go past the lower work: its turn.
  assert.ok(at('prompt') <= FAIR_TURN + 1, `the prompt read's turn came after at most ${FAIR_TURN} others went past it (${w.ran.join(' ')})`);
  assert.ok(at('pass1') <= FAIR_TURN + 2 && at('up1') <= FAIR_TURN + 3, w.ran.join(' '));
  assert.ok(at('pass2') < at('P12') && at('up2') < at('P12'), 'every lower command ran while the persons kept asking');
  // Between two persons' commands, at most one command of each lower priority.
  const ps = w.ran.map((c, i) => [c, i]).filter(([c]) => /^P\d/.test(c)).map(([, i]) => i);
  for (let k = 1; k < ps.length; k++) assert.ok(ps[k] - ps[k - 1] - 1 <= 3, `a person waited behind ${ps[k] - ps[k - 1] - 1} others`);
});

test('a person\'s reads do not make the wallet\'s own work step aside; the same read shares within its priority; a caller\'s waiting reads are capped, visibly', async () => {
  let release;
  const q = createQueue({ send: (op, a) => (a.command === 'sync' ? new Promise((r) => { release = r; }) : Promise.resolve(a.command + (a.k ?? ''))) });
  const sync = q.call('run', { command: 'sync' }, PASS);
  const read = q.call('run', { command: 'orders' }, PERSON, { read: true, share: true });
  assert.equal(q.personWaits(), false, 'a person\'s read waiting');
  const again = q.call('run', { command: 'orders' }, PERSON, { read: true, share: true });
  const outside = q.call('run', { command: 'orders' }, UPKEEP, { share: true });
  const cap = { key: 'site', most: 2 };
  const a = q.call('run', { command: 'orders', k: 1 }, PERSON, { read: true, share: true, cap });
  const b = q.call('run', { command: 'orders', k: 2 }, PERSON, { read: true, share: true, cap });
  const c = q.call('run', { command: 'orders', k: 3 }, PERSON, { read: true, share: true, cap });
  await assert.rejects(c, (e) => e.kind === 'busy' && /already wait/.test(e.message), 'the third is refused at once, as busy');
  const same = q.call('run', { command: 'orders', k: 1 }, PERSON, { read: true, share: true, cap });
  const pay = q.call('run', { command: 'send' }, PERSON);
  assert.equal(q.personWaits(), true, 'a person\'s payment waiting');
  release('s');
  assert.deepEqual(await Promise.all([sync, read, again, outside, a, b, same, pay]), ['s', 'orders', 'orders', 'orders', 'orders1', 'orders2', 'orders1', 'send']);
  const st = q.stats();
  assert.equal(st.shared, 2, 'the person\'s same read shared, and the identical capped one; the upkeep read ran by itself');
  assert.equal(st.capped, 1);
});

test('a command still waiting can be raised to a higher priority; one running cannot', async () => {
  let release;
  const w = [];
  const q = createQueue({ send: (op, a) => { w.push(a.command); return a.command === 'first' ? new Promise((r) => { release = r; }) : Promise.resolve(a.command); } });
  const first = q.call('run', { command: 'first' }, PASS, { ticket: {} });
  const t1 = {}, t0 = {};
  const later = q.call('run', { command: 'person' }, PERSON);
  const mine = q.call('run', { command: 'step' }, PASS, { ticket: t1 });
  const up = q.call('run', { command: 'up' }, UPKEEP, { ticket: t0, share: true, dropAfterMs: 1 });
  assert.equal(q.raise(t1, PERSON), true, 'raised while it waits');
  assert.equal(q.raise(t1, PASS), false, 'never lowered');
  assert.equal(q.raise({}, PERSON), false);
  assert.equal(q.raise(t0, PROMPT), true, 'an upkeep read raised is no longer dropped or shared');
  await sleep(1);
  assert.equal(q.raise({ job: null }, PERSON), false);
  release('f');
  assert.deepEqual(await Promise.all([first, later, mine, up]), ['f', 'person', 'step', 'up']);
  assert.deepEqual(w, ['first', 'person', 'step', 'up'], 'the raised step went with the person\'s commands, ahead of PASS');
});

test('the shape of a command\'s arguments names its keys and kinds, never its values', () => {
  assert.deepEqual(argsShape({ request: 'sq1secret', amount: '5', orders: ['a', 'b'], shown: { fee: 1 }, n: null }),
    { request: 'string', amount: 'string', orders: 'array(2)', shown: '{fee}', n: 'null' });
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
  assert.match(host, /function call\(op, args = \{\}, prio = PASS, opts\) \{[\s\S]{0,400}return Q\.call\(op, args, prio, opts\);/);
  assert.match(host, /run: \(c, a\) => runCommand\(c, a, level, site \? \(READS\.has\(c\) \? siteRead\(site, from\) : siteWrite\(site, from\)\)\n\s+: READS\.has\(c\) \? \(asks \? \{ from \} : personRead\(from\)\) : personWrite\(from\)\)/);
  assert.match(host, /const level = site \? SITE : PERSON;/, 'a site\'s unapproved commands after the person\'s own');
  assert.match(host, /command: 'mailbox' \}, PROMPT\)/, "the faucet's coin taken in goes before upkeep");
  // Only post() talks to the worker.
  assert.equal((host.match(/worker\.postMessage/g) || []).length, 1);
});

test('the scheduled pass gives way to a person between its commands, and starts in a quiet moment', () => {
  const tick = host.slice(host.indexOf('async function tick()'), host.indexOf('// One command of the library.'));
  assert.ok((tick.match(/giveWay\(\);/g) || []).length >= 6, 'between its steps');
  assert.match(tick, /if \(e === HELD\) \{ wait = 5000; end = 'gave way'; \}/);
  assert.match(tick, /else if \(e === BOUND\) \{/, 'a pass stops at its bound');
  assert.match(host, /if \(passOver\(\)\) throw BOUND;/);
  assert.match(tick, /PERSON_QUIET_MS - \(Date\.now\(\) - \(S\.lastAsked \|\| 0\)\)/);
  assert.match(tick, /PASS_DEFER_MOST_MS/, 'never put off for good');
  assert.match(host, /if \(yieldNow\(\)\) \{ S\.bondLater = true; return S\.lastCare; \}/);
});

test('a sync asked for a trade waits for a person and shares the last one', () => {
  assert.match(host, /if \(command === 'sync'\) return await syncForCaller\(!!args\.paying, !!args\.paying && \(!!args\.person \|\| !!site\), !!site\);/);
  assert.match(host, /while \(stepAside\(\) && Date\.now\(\) < until\) await/, 'waits for a person, at most SYNC_WAITS_MOST_MS (and the step-aside bound)');
  assert.match(host, /Date\.now\(\) - S\.lastSync\.at < SYNC_SHARED_MS\) return S\.lastSyncValue/);
});

test('a hung library is started again rather than holding every command after it', () => {
  assert.match(host, /onHung: [\s\S]{0,300}restartWorker\(/);
  assert.match(host, /function restartWorker\(e\) \{[\s\S]{0,200}worker\.terminate\(\)/);
});

test('a read the trade composer asks while nobody waits is the wallet’s own work, not a person’s', () => {
  assert.match(host, /const asks = !site && !!args\.paying && \(!READS\.has\(command\) \|\| upkeepHeld\(\)\);\n      const person = asks \|\| \(!!args\.paying && \(!!args\.person \|\| !!site\)\);/);
  assert.match(host, /if \(args\.paying && !person\) return await runCommand\(command, args\.args \|\| \{\}, UPKEEP, upkeep\);/);
  assert.match(host, /const upkeep = READS\.has\(command\) \? \{ share: true, dropAfterMs: args\.keep \? null : OUTSIDE_READ_WAIT_MOST_MS, from \} : \{ from \};/);
  // Who says a read is a person's: every `run` of a site or the developer page, a quote held by the
  // popup or a site, a payment being prepared; and a trade's background follow says it is not.
  const sw = readFileSync(new URL('../src/leaves.js', import.meta.url), 'utf8');
  assert.match(sw, /host\('run', \{ command, args, paying: true, person: true, site: origin \|\| undefined, from: callerOf\(\) \}\)/);
  // A site's commands name their origin, but none it asks inside an approval: those are the person's.
  const pr = readFileSync(new URL('../src/provider-router.js', import.meta.url), 'utf8');
  assert.match(pr, /const o = await leaves\.run\('swap_offer', args, \{ origin \}\);/);
  assert.match(pr, /const quote = await leaves\.run\('take_quote', args, \{ origin \}\);/);
  assert.match(pr, /return await leaves\.run\('send', \{ request: text, asset: plan\.asset, amount: plan\.amount \}\);/);
  const popup = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /rpc\('default\.leaf', \{ command: cmd, args: args \|\| \{\}, person: tradeHolds > 0 \}\)/);
  // A site's trade engine and review: whose each command is comes from that site's own side
  // (src/site-context.js, test/site-context.test.mjs).
  const site = readFileSync(new URL('../src/site-trade.js', import.meta.url), 'utf8');
  assert.match(site, /leaves: side\.leaves,/, 'each site\'s engine asks through its own side');
  assert.match(site, /leaves: reviewLeaves\(side, /, 'and its review');
  const dm = readFileSync(new URL('../src/default-mode.js', import.meta.url), 'utf8');
  assert.match(dm, /async function leafInfo\(\) \{\n  return await leaves\.ask\('info'\);/);
  assert.match(dm, /const b = await leaves\.ask\('balance'\);/, 'what the tree holds, before a send');
  assert.equal((dm.match(/leaves\.runUser\('offboard_quote', [^\n]*\{ person: true \}\)/g) || []).length, 3, 'every quote of a payment out of the tree');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  assert.match(bg, /'default\.leafInfo': async \(\) => await leaves\.ask\('info'\),/);
  // Only a person's command moves lastAsked, which keeps the mailbox read off for 20 s.
  const run = host.slice(host.indexOf("case 'run': {"), host.indexOf("case 'sync':"));
  assert.ok(run.indexOf('if (args.paying && !person)') < run.indexOf('if (asks) noteAsked();'));
});

test('the mailbox is read no oftener than twice what the last read took', () => {
  assert.match(host, /const mailboxGapMs = \(\) => Math\.max\(MAILBOX_POLL_MS, 2 \* \(S\.mailCostMs \|\| 0\)\);/);
  assert.match(host, /if \(mailboxDue\(\)\) await readMailboxNow\(\);/);
  assert.match(host, /if \(!ticking && mailboxDue\(\)\) await readMailboxNow\(\);/);
});
