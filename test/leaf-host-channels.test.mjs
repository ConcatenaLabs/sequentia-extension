// The offscreen host itself, on a stand-in library: in default mode it runs care with no channels and
// closes the live channel into the next round; in developer mode it keeps it (review RV93's test).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const X = 'aa'.repeat(32);

// Positive: the host, in default mode, runs care with channels false and closes the live channel;
// in developer mode it runs care with channels true and closes nothing.
function lib(channels) {
  const L = { calls: [] };
  L.run = (command, args) => {
    L.calls.push({ command, args });
    switch (command) {
      case 'schedule': return { now: Math.floor(Date.now() / 1000), due: false, next_sync_at: Math.floor(Date.now() / 1000) + 86400, receive_requests: [] };
      case 'sync': return { mailbox: { accepted: [] }, schedule: { now: Math.floor(Date.now() / 1000) } };
      case 'mailbox': return { accepted: [], refused: [], waiting: [] };
      case 'channels': return channels;
      case 'channel_sync': return channels;
      case 'coins': case 'participations': case 'claims': return [];
      case 'balance': return { assets: {} };
      case 'info': return { operator: 'op', server_info: { assets: [] } };
      case 'care': return { claims: [], plans: [], channels: null };
      case 'quote': return { coins: args.leaves.map((l) => ({ leaf: l, fee: '1' })) };
      case 'participate': return { participations: [{ participation: 'p' }] };
      default: return null;
    }
  };
  return L;
}
async function hostWith(L) {
  let listener = null;
  const storage = new Map();
  globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) };
  globalThis.chrome = { runtime: { id: 'test', onMessage: { addListener: (f) => { listener = f; } }, sendMessage: async () => {} } };
  globalThis.Worker = class {
    constructor() { this.chain = Promise.resolve(); }
    postMessage({ id, op, args }) {
      this.chain = this.chain.then(() => new Promise((done) => setTimeout(() => {
        let m;
        try { m = { id, ok: true, value: op === 'exists' ? true : op === 'run' ? { result: L.run(args.command, args.args || {}) } : true }; }
        catch (e) { m = { id, ok: false, error: e && e.kind ? e : { message: String(e.message) } }; }
        this.onmessage({ data: m }); done();
      }, 5)));
    }
    terminate() {}
  };
  for (const k of ['info', 'warn', 'log']) console[k] = () => {};
  await import('../offscreen-leaves.js?host=' + Math.random());
  return (op, args) => new Promise((ok) => listener({ scope: 'leaf', op, args }, { id: 'test' }, ok));
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function run(defaultMode) {
  const saved = { info: console.info, warn: console.warn, log: console.log };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  try {
    const L = lib([{ leaf_id: 'ch1', asset: X, coin_state: 'live', final: true }]);
    const ask = await hostWith(L);
    const p = ask('start', { mnemonic: 'test phrase', defaultMode, defaultModeAt: 1, careMs: 3600_000 });
    let done = false; p.then(() => { done = true; });
    for (let t = 0; t < 120_000 && !done; t += 50) { mock.timers.tick(50); await flush(); }
    const c = ask('care', {});
    let cd = false; c.then(() => { cd = true; });
    for (let t = 0; t < 60_000 && !cd; t += 50) { mock.timers.tick(50); await flush(); }
    return L;
  } finally { mock.timers.reset(); Object.assign(console, saved); }
}
test('host: default mode cares with no channels and closes the live one; developer mode keeps it', async () => {
  const d = await run(true);
  const care = d.calls.filter((x) => x.command === 'care');
  assert.ok(care.length >= 1);
  assert.ok(care.every((x) => x.args.channels === false), 'care asked with channels false');
  assert.deepEqual(d.calls.find((x) => x.command === 'participate').args.leaves, ['ch1']);
  const v = await run(false);
  assert.ok(v.calls.filter((x) => x.command === 'care').every((x) => x.args.channels === true));
  assert.equal(v.calls.filter((x) => x.command === 'participate').length, 0);
});
