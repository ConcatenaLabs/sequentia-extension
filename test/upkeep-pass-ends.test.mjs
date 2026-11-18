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

// The library: every command takes `cost(command)` ms of the worker's time, one at a time. Each call
// records the priority the host ran it at (its `leafHostDiag().running`, when the host has one).
// `boards`: that many assets the operator serves, each with coins at the wallet's address to board.
// `planned`: the first `send` is refused for coins a plan holds, until they are released.
function library({ cost = (c) => (c === 'coins' ? 90 : c === 'sync' ? 2000 : 40), boards = 0, planned = false } = {}) {
  // `refuse`: commands refused as busy; `accept`: coins the next mailbox read takes in.
  const L = { calls: [], cost, onchain: new Map(), released: !planned, refuse: new Set(), accept: [] };
  for (let i = 0; i < boards; i++) L.onchain.set(i.toString(16).padStart(64, '0'), 1000n);
  L.run = (command, args, prio) => {
    L.calls.push({ at: Date.now(), command, prio, args });
    if (L.refuse.has(command)) throw { kind: 'busy', message: 'the wallet was busy' };
    if (command === 'mailbox' && L.accept.length) return { accepted: L.accept.splice(0), refused: [], waiting: [] };
    switch (command) {
      case 'info': return { operator: 'op', server_info: { assets: [...L.onchain.keys()].map((asset) => ({ asset, min_leaf: '10' })) } };
      case 'balance': return { assets: {}, sequentia_onchain: Object.fromEntries([...L.onchain].filter(([, v]) => v > 0n).map(([a, v]) => [a, String(v)])) };
      case 'board_quote': return { fee: { asset: args.asset, amount: '1' } };
      case 'board': L.onchain.set(args.asset, 0n); return { txid: 'b'.repeat(64) };
      case 'send':
        if (!L.released) throw { kind: 'planned', message: 'the coins it needs are planned', asset: 'aa', release: ['c1'] };
        return { sent: true };
      case 'plan_release': L.released = true; return { released: ['c1'] };
    }
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
        let prio;
        try { prio = globalThis.leafHostDiag ? (globalThis.leafHostDiag().running || {}).prio : undefined; } catch {}
        setTimeout(() => {
          let m;
          try { m = { id, ok: true, value: op === 'exists' ? true : op === 'run' ? { result: L.run(args.command, args.args || {}, prio) } : true }; }
          catch (e) { m = { id, ok: false, error: e && e.kind ? e : { message: String(e.message) } }; }
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
  delete globalThis.leafHostDiag;
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

// The priorities the host's queue gives (src/leaf-queue.js): PERSON 3, PROMPT 2, PASS 1, UPKEEP 0.
const PERSON_P = 3, PROMPT_P = 2;

test('every read a person asks for answers within the command running, never shared, never dropped', timed(async () => {
  // Later, a sync that holds the library 150 s: past the 120 s after which an outside read is
  // refused as busy.
  let longSync = false;
  const L = library({ cost: (c) => (c === 'coins' ? 90 : c === 'sync' ? (longSync ? 150_000 : 2000) : 40) });
  const { ask } = await opened({ L });
  let k = 0, flood = true;
  const pending = [];
  // A flood of different reads, and the same `balance` an outside caller keeps asking.
  const spin = () => { if (flood) { pending.push(ask('run', { command: 'coins', args: { k: k++ } })); pending.push(ask('run', { command: 'balance', args: {} })); } };
  await advance(30_000, 50, spin);
  // Each way a person's read reaches the host: a site's or the developer page's (`run`, person), a
  // quote held by the popup or a site (`runUser` with person), Receive and Send (`ask`, prompt).
  const reads = [
    ['site or developer page', { command: 'balance', args: {}, paying: true, person: true }],
    ['a quote a person waits on', { command: 'take_quote', args: { x: 1 }, paying: true, person: true }],
    ['Receive or Send', { command: 'balance', args: {}, prompt: true }],
  ];
  for (const [who, a] of reads) {
    const t = Date.now();
    const r = await within(ask('run', a), 1000, 10);
    const ran = L.calls.filter((c) => c.at >= t && c.command === a.command);
    say(`${who}: ${r.done ? 'answered in ' + (Date.now() - t) + ' ms' : 'not answered in 1 s'}, ran at ${ran.map((c) => c.prio).join(',')}`);
    assert.ok(r.done && r.value.ok, `${who}: answered within the command running`);
    assert.ok(ran.some((c) => c.prio >= PROMPT_P), `${who}: ran at a person's priority, by itself`);
  }
  // The composer's background follow (no hold, no person): still the wallet's own work.
  const bg = ask('run', { command: 'swaps', args: {}, paying: true });
  await advance(2000, 50, spin);
  const bgRan = L.calls.filter((c) => c.command === 'swaps');
  assert.ok(bgRan.every((c) => c.prio === 0), 'a trade\'s background read stays upkeep');
  // A person's read asked while the pass's 150 s sync runs: answered after it, never refused as busy.
  flood = false;
  await within(Promise.all(pending), 400_000);
  longSync = true;
  const t = Date.now();
  const sync = ask('sync', {});
  await advance(200, 50);
  const slow = ask('run', { command: 'balance', args: { n: 1 }, paying: true, person: true });
  const r = await within(slow, 200_000);
  say(`a person's read behind a 150 s command: ${r.done ? (r.value.ok ? 'answered' : 'refused: ' + JSON.stringify(r.value.error)) : 'not answered'} after ${Date.now() - t} ms`);
  assert.ok(r.done && r.value.ok, 'never dropped as busy');
  await within(sync, 200_000);
  await within(bg, 10_000);
  await within(ask('stop'), 10_000);
}));

test('a site polling its orders at a person\'s priority does not keep the mailbox read off', timed(async () => {
  const { L, ask } = await opened();
  const t0 = Date.now();
  const polls = [];
  let i = 0;
  await advance(2 * 60_000, 50, () => { if (i++ % 100 === 0) polls.push(ask('run', { command: 'orders', args: {}, paying: true, person: true })); });
  const mail = since(L, t0, 'mailbox');
  const ran = since(L, t0, 'orders');
  say(`a site polling every 5 s: ${ran.length} polls at ${[...new Set(ran.map((c) => c.prio))].join(',')}; mailbox reads in 2 min: ${mail.length}`);
  assert.ok(ran.length >= 20 && ran.every((c) => c.prio === PERSON_P), 'each poll at a person\'s priority');
  assert.ok(mail.length >= 8, `${mail.length} mailbox reads in two minutes`);
  await within(Promise.all(polls), 10_000);
  await within(ask('stop'), 10_000);
}));

test('taking the coins home runs at a person\'s priority', timed(async () => {
  const L = library({ planned: true });
  // One coin to take home, which the quote asks an exit for.
  const run = L.run;
  L.run = (command, args, prio) => (command === 'coins' ? (run(command, args, prio), [{ leaf_id: 'h1', asset: 'aa'.repeat(32), value: '5', state: 'live' }]) : run(command, args, prio));
  const { ask } = await opened({ L });
  let k = 0;
  const pending = [];
  const spin = () => { pending.push(ask('run', { command: 'coins', args: { k: k++ } })); };
  const t0 = Date.now();
  const q = await within(ask('homeQuote', {}), 5000, 50);
  assert.ok(q.done && q.value.ok, 'quoted');
  const home = L.calls.filter((c) => c.at >= t0 && ['channels', 'coins', 'exit_quote'].includes(c.command));
  say(`home quote ran at ${home.map((c) => c.command + ':' + c.prio).join(', ')}`);
  for (const cmd of ['channels', 'exit_quote']) {
    assert.ok(home.some((c) => c.command === cmd) && home.filter((c) => c.command === cmd).every((c) => c.prio === PERSON_P), `the home quote's ${cmd} at PERSON`);
  }
  assert.ok(home.some((c) => c.command === 'coins' && c.prio === PERSON_P), 'its coins read at PERSON');
  await within(Promise.all(pending), 60_000);
  await within(ask('stop'), 10_000);
}));

test('a payment\'s release, its sync and its polls run at a person\'s priority', timed(async () => {
  const L = library({ planned: true });
  const { ask } = await opened({ L });
  let k = 0;
  const pending = [];
  const spin = () => { pending.push(ask('run', { command: 'coins', args: { k: k++ } })); };
  const t1 = Date.now();
  const pay = ask('run', { command: 'send', args: { request: 'r' }, paying: true });
  const r = await within(pay, 120_000, 50);
  await advance(1000, 50, spin);
  // From the release's sync to the payment asked again: the sync, its reads and the poll of the coins.
  const calls = L.calls.filter((c) => c.at >= t1);
  const rel = calls.findIndex((c) => c.command === 'plan_release');
  const from = calls.findIndex((c, i) => i > rel && c.command === 'sync');
  const again = calls.findIndex((c, i) => i > from && c.command === 'send');
  const poll = calls.slice(from, again);
  say(`release: send ${r.done && r.value.ok ? 'made' : 'not made'}; from its sync to the send again: ${poll.map((c) => c.command + ':' + c.prio).join(', ')}`);
  assert.ok(r.done && r.value.ok, 'made through the release');
  assert.ok(rel >= 0 && from > rel && again > from, 'released, synced, asked again');
  // Other work may run between two of the person's commands (each then waits for that one only),
  // but every command of the release is the person's: its sync, the sync's reads, and the poll of
  // the coins that let the payment go again (the last read before it).
  assert.equal(poll[0].prio, PERSON_P, 'the release\'s sync at PERSON');
  for (const cmd of ['coins', 'participations', 'channels', 'balance']) assert.ok(poll.some((c) => c.command === cmd && c.prio === PERSON_P), `the sync's ${cmd} at PERSON`);
  const lastPoll = poll.filter((c) => c.command === 'coins').at(-1);
  assert.equal(lastPoll && lastPoll.prio, PERSON_P, 'the poll that let the payment go again at PERSON');
  await within(Promise.all(pending), 60_000);
  await within(ask('stop'), 10_000);
}));

test('a pass with a hundred assets to board stops at its bound between two whole boards', timed(async () => {
  const L = library({ boards: 100 });
  const { ask, logs } = await opened({ L });
  await advance(3 * 60_000, 100);
  const bound = logs.filter((l) => /the pass stopped at its bound/.test(l.line));
  const counts = bound.map((l) => Number((l.line.match(/\((\d+) of its commands/) || [])[1]));
  const boarded = [...L.onchain.values()].filter((v) => v === 0n).length;
  say(`boards: ${boarded} of 100 boarded in 3 min; bound lines ${bound.length}, their counts ${counts.join(',')}${bound[0] ? '; first: ' + bound[0].line : ''}`);
  assert.ok(bound.length >= 1, 'the pass stopped at its bound');
  assert.ok(counts.every((n) => n <= 200 + 12), `every stop within one board of the bound (${counts.join(',')})`);
  assert.ok(bound.every((l) => /it was in boards/.test(l.line)));
  // Never inside one board: each board's quote and the board itself, together.
  const seq = L.calls.filter((c) => c.command === 'board_quote' || c.command === 'board');
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].command !== 'board') continue;
    assert.equal(seq[i - 1].args.asset, seq[i].args.asset, 'a board follows its own quote');
  }
  assert.equal(boarded, 100, 'every asset boarded, pass after pass');
  await within(ask('stop'), 10_000);
}));

test('a site polling a read back to back starves nothing: the pass, the mailbox and the upkeep keep their turns', timed(async () => {
  // The review's probe: an `orders` read every 100 ms, each taking 100 ms, for two minutes.
  const L = library({ cost: (c) => (c === 'orders' ? 100 : c === 'coins' ? 90 : c === 'sync' ? 2000 : 40) });
  const { ask } = await opened({ L });
  const t0 = Date.now();
  const polls = [];
  let i = 0;
  const outside = ask('run', { command: 'coins', args: { once: 1 } });
  let person = null, personAt = null;
  await advance(2 * 60_000, 50, () => {
    if (i % 2 === 0) polls.push(ask('run', { command: 'orders', args: {}, paying: true, person: true, from: 'provider-router.js:615 handle' }));
    // A minute in, the person's own read from another caller (the popup).
    if (i === 1200) { const t = Date.now(); person = ask('run', { command: 'balance', args: { mine: 1 }, paying: true, person: true, from: 'popup' }).then((r) => { personAt = Date.now() - t; return r; }); }
    i++;
  });
  const mail = since(L, t0, 'mailbox').length;
  const passes = since(L, t0, 'schedule').length;
  const orders = since(L, t0, 'orders').length;
  const up = L.calls.filter((c) => c.command === 'coins' && c.args && c.args.once);
  say(`site polling back to back: ${polls.length} polls, ${orders} ran; mailbox reads ${mail}, pass schedule reads ${passes}, the outside read ran ${up.length ? 'at +' + (up[0].at - t0) + ' ms' : 'never'}; the person's own read answered in ${personAt} ms`);
  assert.ok(mail >= 6, `${mail} mailbox reads in two minutes`);
  assert.ok(passes >= 2, `${passes} passes in two minutes`);
  assert.equal(up.length, 1, 'the upkeep read had its turn');
  assert.ok(personAt != null && personAt <= 450, `a person's read waited ${personAt} ms: the command running and at most one of each lower kind`);
  const all = await within(Promise.all([...polls, outside, person]), 10_000);
  assert.ok(all.done && all.value.every((r) => r.ok), 'every poll answered, none dropped');
  await within(ask('stop'), 10_000);
}));

test('a site asking ever more different reads is refused visibly past its share, never silently', timed(async () => {
  const L = library({ cost: (c) => (c === 'orders' ? 100 : c === 'sync' ? 2000 : 40) });
  const { ask, logs } = await opened({ L });
  const t0 = Date.now();
  const polls = [];
  let k = 0;
  await advance(60_000, 50, () => { polls.push(ask('run', { command: 'orders', args: { k: k++ }, paying: true, person: true, from: 'site.js:1 poll' })); });
  const all = await within(Promise.all(polls), 30_000);
  assert.ok(all.done, 'every read answered or refused within 30 s of the last ask');
  const refused = all.value.filter((r) => !r.ok);
  say(`different reads from one caller: ${polls.length} asked, ${all.value.length - refused.length} answered, ${refused.length} refused (${refused[0] ? refused[0].error.kind + ': ' + refused[0].error.message : '-'}); mailbox reads ${since(L, t0, 'mailbox').length}`);
  assert.ok(refused.length > 0 && refused.every((r) => r.error.kind === 'busy' && /already wait/.test(r.error.message)), 'each refusal says why');
  assert.ok(logs.some((l) => /read\(s\) refused as busy: their caller already had 16 waiting/.test(l.line)), 'and the host says so');
  assert.ok(since(L, t0, 'mailbox').length >= 3);
  await within(ask('stop'), 10_000);
}));

test('a home quote is made from a reading made now, or refused: never from an older one', timed(async () => {
  const L = library();
  const run = L.run;
  L.run = (command, args, prio) => (command === 'coins' ? (run(command, args, prio), [{ leaf_id: 'h1', asset: 'aa'.repeat(32), value: '5', state: 'live' }]) : run(command, args, prio));
  const { ask } = await opened({ L });
  // Refused the first time it is asked: the person sees the refusal, not a quote of the coins read at open.
  L.refuse.add('coins');
  let q = (await within(ask('homeQuote', {}), 5000)).value;
  say(`home quote, coins refused: ${q.ok ? 'quoted ' + q.value.quotes.length + ' coin(s)' : 'refused: ' + q.error.message}`);
  assert.equal(q.ok, false);
  assert.equal(q.error.kind, 'busy');
  L.refuse.delete('coins');
  q = (await within(ask('homeQuote', {}), 5000)).value;
  assert.ok(q.ok && q.value.quotes.length === 1, 'quoted from a reading made now');
  // Refused later: the earlier quote's reading is not used again.
  L.refuse.add('coins');
  q = (await within(ask('homeQuote', {}), 5000)).value;
  assert.equal(q.ok, false, 'a later refusal is refused too');
  L.refuse.delete('coins');
  L.refuse.add('channels');
  q = (await within(ask('homeQuote', {}), 5000)).value;
  assert.equal(q.ok, false, 'and so is a refused read of the channels');
  await within(ask('stop'), 10_000);
}));

test('taking coins home runs at a person\'s priority to its end, the balance it reports included', timed(async () => {
  const L = library({ cost: (c) => (c === 'orders' ? 100 : c === 'sync' ? 2000 : 40) });
  const { ask } = await opened({ L });
  const t = Date.now();
  const take = await within(ask('takeHome', { quote: { quotes: [{ coin: { leaf_id: 'h1', asset: 'aa'.repeat(32), value: '5' }, quote: { unroll: {} } }], channels: [] } }), 5000);
  assert.ok(take.done && take.value.ok);
  const takeReads = L.calls.filter((c) => c.at >= t && ['exit', 'coins', 'balance'].includes(c.command) && c.prio === PERSON_P).map((c) => c.command);
  say(`take home ran at PERSON: ${takeReads.join(', ')}`);
  for (const cmd of ['exit', 'coins', 'balance']) assert.ok(takeReads.includes(cmd), `take home's ${cmd} at PERSON`);
  await within(ask('stop'), 10_000);
}));

test('the faucet\'s coin taken in reports the balance at PROMPT before it answers', timed(async () => {
  const L = library();
  const { ask } = await opened({ L });
  const t = Date.now();
  const asset = 'cc'.repeat(32);
  L.accept.push({ leaf_id: 'f1', asset, value: '7', kind: 'mailbox' });
  const tin = await within(ask('takeIn', { asset, since: t - 1, ms: 10_000 }), 15_000);
  assert.ok(tin.done && tin.value.ok && tin.value.value.arrived);
  const bal = L.calls.filter((c) => c.at >= t && c.command === 'balance');
  say(`the faucet's coin taken in: its balance read at ${bal.map((c) => c.prio).join(',')}`);
  // Other work's balance reads may run around it; the one takeIn waits on before it answers is PROMPT.
  assert.ok(bal.some((c) => c.prio === PROMPT_P), 'the balance it reports before Received, at PROMPT');
  await within(ask('stop'), 10_000);
}));

test('a person\'s sync runs at once at PERSON while a site polls back to back', timed(async () => {
  const L = library({ cost: (c) => (c === 'orders' ? 100 : c === 'sync' ? 2000 : 40) });
  const { ask } = await opened({ L });
  let t;
  const polls = [];
  let i = 0;
  await advance(15_000, 50, () => { if (i++ % 2 === 0) polls.push(ask('run', { command: 'orders', args: {}, paying: true, person: true, from: 'site' })); });
  t = Date.now();
  const sync = ask('run', { command: 'sync', args: {}, paying: true, person: true });
  let r = null;
  await advance(10_000, 50, () => { if (i++ % 2 === 0) polls.push(ask('run', { command: 'orders', args: {}, paying: true, person: true, from: 'site' })); });
  r = await within(sync, 1000);
  const syncs = L.calls.filter((c) => c.at >= t && ['sync', 'coins', 'participations'].includes(c.command));
  say(`a person's sync under a site's polling: ${r.done && r.value.ok ? 'answered' : 'not answered in 10 s'}; ran at ${syncs.map((c) => c.command + ':' + c.prio).join(', ')}`);
  assert.ok(r.done && r.value.ok, 'answered while the site polls');
  assert.ok(syncs.filter((c) => c.command === 'sync').every((c) => c.prio === PERSON_P) && syncs.some((c) => c.command === 'sync'), 'the sync at PERSON');
  await within(Promise.all(polls), 10_000);
  await within(ask('stop'), 10_000);
}));
