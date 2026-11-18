// The leaf host's scheduled pass always ends, and what a person asks is answered within seconds,
// however much else asks the library meanwhile (sequentia-extension#219).
//
// The case it comes from: an Ambra browser wallet open for hours with constant traffic. Each figure
// of the overview asked the leaf library for its coins (the Lightning-to-ark move's `liveMoving`
// reads them at once, and the extension handed it a call that sends a command and returns a
// promise), several times a second and never waited for; each `coins` took about 90 ms on a
// wallet holding many leaves, so the line in front of the library grew by about nine commands a
// second. The scheduled pass waited in that line at every step and never ended, so the mailbox was
// not read and the receive code (whose `schedule` read waited in the same line) never came.
//
// Here the library answers each command after a modeled time, and other parts of the wallet ask it
// in a flood. The pass must keep running at its pace, the mailbox must be read, a person's read must
// wait at most for the command running, the line must stay bounded, and a pass with a long step
// (handing the library thousands of keys) must stop at its bound and say so.
//   node --test test/upkeep-pass-ends.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// The library: every command takes `cost(command)` ms of the worker's time, one at a time.
function library({ cost = (c) => (c === 'coins' ? 90 : c === 'sync' ? 2000 : 40) } = {}) {
  const L = { calls: [], cost };
  L.run = (command) => {
    L.calls.push({ at: Date.now(), command });
    switch (command) {
      case 'schedule': return { now: Math.floor(Date.now() / 1000), due: false, next_sync_at: Math.floor(Date.now() / 1000) + 86400, why: null,
        receive_requests: [{ owner: 'k', state: 'waiting', asked_at: Math.floor(Date.now() / 1000) - 60, lapses_at: Math.floor(Date.now() / 1000) + 80000 }] };
      case 'mailbox': return { accepted: [], refused: [], waiting: [] };
      case 'sync': return { mailbox: { accepted: [] }, caught_up: null, schedule: { now: Math.floor(Date.now() / 1000) } };
      case 'coins': case 'participations': case 'channels': case 'channel_sync': case 'claims': return [];
      case 'balance': return { assets: {} };
      case 'info': return { operator: 'op', server_info: { assets: [] } };
      case 'address': return { address: 'x' };
      default: return null;
    }
  };
  return L;
}

async function host(L, storage) {
  const events = [];
  const logs = [];
  let listener = null;
  globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  globalThis.chrome = {
    runtime: {
      id: 'test',
      onMessage: { addListener: (f) => { listener = f; } },
      sendMessage: async (m) => { if (m && m.scope === 'leaf-event') events.push({ at: Date.now(), ...m }); },
    },
  };
  // One command in the worker at a time, each answered after its modeled cost.
  globalThis.Worker = class {
    constructor() { this.chain = Promise.resolve(); }
    postMessage({ id, op, args }) {
      this.chain = this.chain.then(() => new Promise((done) => {
        const ms = op === 'run' ? L.cost(args.command) : 0;
        setTimeout(() => {
          let m;
          try { m = { id, ok: true, value: op === 'exists' ? true : op === 'run' ? { result: L.run(args.command, args.args || {}) } : true }; }
          catch (e) { m = { id, ok: false, error: { message: String(e.message) } }; }
          this.onmessage({ data: m });
          done();
        }, ms);
      }));
    }
    terminate() {}
  };
  for (const k of ['info', 'warn', 'log']) {
    const was = console[k];
    console[k] = (...a) => { logs.push({ at: Date.now(), line: a.join(' ') }); if (process.env.VERBOSE) was(...a); };
  }
  await import('../offscreen-leaves.js?run=' + Math.random());
  const ask = (op, args) => new Promise((ok) => listener({ scope: 'leaf', op, args }, { id: 'test' }, ok));
  return { events, logs, ask };
}

// The tests' own lines (the host's console is captured for its lines).
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms, step = 50, each = null) {
  for (let t = 0; t < ms; t += step) { if (each) each(); mock.timers.tick(step); await flush(); }
}
// Time runs on until `p` settles, for at most `ms`: -> { done, value }.
async function within(p, ms, step = 50) {
  let done = false, value;
  p.then((v) => { done = true; value = v; }, (e) => { done = true; value = { ok: false, error: e }; });
  for (let t = 0; t < ms && !done; t += step) { mock.timers.tick(step); await flush(); }
  return { done, value };
}
function timed(f) {
  return async () => {
    const saved = { info: console.info, warn: console.warn, log: console.log };
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
    try { await f(); } finally { mock.timers.reset(); Object.assign(console, saved); }
  };
}
async function opened({ L = library(), storage = new Map(), scan = undefined } = {}) {
  const h = await host(L, storage);
  const p = h.ask('start', { mnemonic: 'test phrase', defaultMode: true, defaultModeAt: 1, careMs: 3600_000, scan });
  await advance(2000);
  const r = await within(p, 120_000);
  assert.ok(r.done && r.value.ok, 'the wallet opened');
  await advance(20_000);
  return { L, storage, ...h };
}
const since = (L, t, command) => L.calls.filter((c) => c.at >= t && c.command === command);

test('a flood of the same upkeep read: the pass keeps its pace, the mailbox is read, the line stays short', timed(async () => {
  const { L, ask } = await opened();
  // What each overview did: a `coins` per figure, sent and never waited for, 20 a second, for
  // ten minutes (the library drains about eleven a second).
  const answers = [];
  const t0 = Date.now();
  let n = 0;
  await advance(10 * 60_000, 50, () => { answers.push(ask('run', { command: 'coins', args: {} })); n++; });
  const passes = since(L, t0, 'schedule').length;
  const mail = since(L, t0, 'mailbox');
  const coins = since(L, t0, 'coins').length;
  const st = (await within(ask('status'), 1000)).value.value;
  say(`flood: ${n} coins asked, ${coins} ran; passes ${passes}, mailbox reads ${mail.length}, waiting now ${st.diag ? st.diag.queue.waiting : '?'}`);
  assert.ok(passes >= 8, `the pass ran ${passes} times in ten minutes`);
  assert.ok(mail.length >= 10, `${mail.length} mailbox reads in ten minutes`);
  const gaps = mail.slice(1).map((c, i) => c.at - mail[i].at);
  assert.ok(Math.max(...gaps) <= 70_000, `longest gap between mailbox reads ${Math.max(...gaps)} ms`);
  assert.ok(st.diag.queue.shared > n / 3, `the same read asked while one waits shares its answer (${st.diag.queue.shared} shared)`);
  assert.ok(coins < n * 0.7, `${coins} of ${n} ran`);
  assert.ok(st.diag.queue.waiting <= 5, `${st.diag.queue.waiting} commands waiting`);
  const all = await within(Promise.all(answers), 60_000);
  assert.ok(all.done && all.value.every((r) => r.ok), 'every caller got an answer within a minute');
  await within(ask('stop'), 10_000);
}));

test('a person\'s read under the flood waits only for the command running', timed(async () => {
  const { ask } = await opened();
  let flood = true;
  const pending = [];
  const spin = () => { if (flood) pending.push(ask('run', { command: 'coins', args: { n: pending.length % 7 } })); };
  await advance(60_000, 50, spin);
  const t = Date.now();
  let at = null;
  const p = ask('run', { command: 'schedule', args: {}, prompt: true }).then((r) => { at = Date.now(); return r; });
  await advance(5000, 50, spin);
  flood = false;
  say(`a prompt read under the flood answered ${at ? 'in ' + (at - t) + ' ms' : 'not in 5 s'}`);
  assert.ok(at && at - t <= 500, at ? `answered after ${at - t} ms` : 'not answered in 5 s');
  assert.equal((await p).ok, true);
  await within(Promise.all(pending), 200_000);
  await within(ask('stop'), 10_000);
}));

test('a flood of different reads: the line is bounded in time, and each read dropped is said', timed(async () => {
  const { L, ask, logs } = await opened();
  const t0 = Date.now();
  const pending = [];
  let k = 0;
  await advance(6 * 60_000, 50, () => { pending.push(ask('run', { command: 'coins', args: { k: k++ } })); });
  const st = (await within(ask('status'), 1000)).value.value;
  const passes = since(L, t0, 'schedule').length;
  const q = (st.diag && st.diag.queue) || {};
  say(`different reads: ${k} asked; waiting ${q.waiting}, oldest ${q.oldestMs} ms, dropped ${q.dropped}; passes ${passes}`);
  assert.ok(passes >= 4, `${passes} passes in six minutes`);
  assert.ok(q.oldestMs <= 125_000, 'nothing waits much past the bound');
  assert.ok(q.dropped > 0);
  assert.ok(logs.some((l) => /upkeep read\(s\) asked from outside the host were not run/.test(l.line)), 'the drops are said');
  const rs = await within(Promise.all(pending), 200_000);
  assert.ok(rs.done, 'every caller is answered');
  const busy = rs.value.filter((r) => !r.ok && r.error.kind === 'busy').length;
  say(`different reads: ${busy} refused as busy, ${rs.value.filter((r) => r.ok).length} answered`);
  assert.ok(busy > 0, 'a dropped read is refused as busy');
  await within(ask('stop'), 10_000);
}));

test('a pass with a long step stops at its bound, says where, and the next passes go on', timed(async () => {
  // The kit wallet has handed out 3,000 keys the leaf wallet has not been handed yet.
  const L = library({ cost: (c) => (c === 'address' ? 90 : c === 'sync' ? 2000 : 40) });
  const { ask, logs } = await opened({ L, scan: 3020 });
  const t0 = Date.now();
  await advance(4 * 60_000, 100);
  const mail = since(L, t0, 'mailbox');
  const keys = since(L, t0 - 30_000, 'address').length;
  const bound = logs.filter((l) => /the pass stopped at its bound/.test(l.line));
  say(`long step: ${keys} keys handed in 4.5 min; mailbox reads ${mail.length}; bound lines ${bound.length}${bound[0] ? ': ' + bound[0].line : ''}`);
  assert.ok(mail.length >= 8, `${mail.length} mailbox reads in four minutes`);
  assert.ok(keys > 100, 'the keys keep being handed, pass after pass');
  assert.ok(bound.length >= 1 && /address/.test(bound[0].line), 'the bound names the command it stopped in');
  await within(ask('stop'), 10_000);
}));
