// Whose the site-trade engine's and its order review's leaf commands are (src/site-context.js): one
// side for each site, so that what one site asks is that site's or the person's, never another
// site's; what the person approved always the person's, for as long as its confirmation runs
// (sequentia-extension#225, and the reviews of the first design's one wallet-wide counter).
//   node --test test/site-context.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteSide, keptSide, siteTag, keptRecords, sitesWithRecords } from '../src/site-context.js';

const tick = () => new Promise((r) => setImmediate(r));
const recorder = () => { const asked = []; return { asked, runUser: async (cmd, args, opts) => { asked.push([cmd, opts]); return cmd; } }; };

test('a site\'s side: its requests the site\'s, what was approved the person\'s, the rest the wallet\'s own', async () => {
  const r = recorder();
  const s = siteSide('https://a.example', r.runUser);
  await s.leaves.command('coins');
  await s.asking(async () => { await s.leaves.command('take_quote', { x: 1 }); await tick(); await s.leaves.command('schedule'); });
  await s.approving(async () => { await s.leaves.command('order_place'); });
  assert.deepEqual(r.asked, [
    ['coins', {}],
    ['take_quote', { origin: 'https://a.example' }],
    ['schedule', { origin: 'https://a.example' }],
    ['order_place', { person: true }],
  ]);
});

test('what was approved always wins on its side, and its confirmation stays the person\'s after the request answered', async () => {
  const r = recorder();
  const s = siteSide('https://a.example', r.runUser);
  let endAsk;
  const ask = s.asking(() => new Promise((res) => { endAsk = res; }));
  assert.deepEqual(s.attribution(), { origin: 'https://a.example' });
  // The person approves while the site's request is open: the person's.
  let endConfirm;
  const confirm = s.approving(() => {
    // The engine's confirmation, in its hold, outlives the approved request (the review answers the
    // site after SITE_ANSWER_MS while it goes on).
    s.leaves.hold(() => new Promise((res) => { endConfirm = res; }));
    return 'answered';
  });
  assert.deepEqual(s.attribution(), { person: true }, 'approved wins over the site\'s open request');
  assert.equal(await confirm, 'answered');
  endAsk(); await ask;
  assert.deepEqual(s.attribution(), { person: true }, 'the confirmation\'s hold keeps it the person\'s');
  endConfirm(); await tick();
  assert.deepEqual(s.attribution(), {}, 'and the wallet\'s own once it ended');
  // A quote's hold is the site's for as long as it runs, after its request ended (a quote let go at
  // its time limit goes on).
  let endQuote;
  await s.asking(async () => { s.leaves.hold(() => new Promise((res) => { endQuote = res; })); });
  assert.deepEqual(s.attribution(), { origin: 'https://a.example' });
  endQuote(); await tick();
  assert.deepEqual(s.attribution(), {});
  // A request that throws ends all the same.
  await assert.rejects(s.asking(async () => { throw new Error('x'); }));
  await assert.rejects(s.approving(async () => { throw new Error('x'); }));
  assert.deepEqual(s.attribution(), {});
});

test('two sites\' sides never touch each other', async () => {
  const r = recorder();
  const a = siteSide('https://a.example', r.runUser), b = siteSide('https://b.example', r.runUser);
  let endA;
  const pa = a.asking(() => new Promise((res) => { endA = res; }));
  await b.approving(() => b.leaves.command('take'));
  await b.asking(() => b.leaves.command('take_quote'));
  await b.leaves.command('coins');
  endA(); await pa;
  assert.deepEqual(r.asked, [['take', { person: true }], ['take_quote', { origin: 'https://b.example' }], ['coins', {}]]);
});

test('the records kept before: one site\'s request at a time under its origin; approved work does not wait and is the person\'s', async () => {
  const r = recorder();
  const k = keptSide(r.runUser);
  let endA;
  const a = k.asking('https://a.example', async () => { await k.leaves.command('orders'); await new Promise((res) => { endA = res; }); await k.leaves.command('order_refund_quote'); });
  const b = k.asking('https://b.example', async () => { await k.leaves.command('orders'); });
  await tick();
  await k.approving(() => k.leaves.command('order_refund'));
  endA(); await a; await b;
  await k.leaves.command('coins');
  assert.deepEqual(r.asked, [
    ['orders', { origin: 'https://a.example' }],
    ['order_refund', { person: true }],
    ['order_refund_quote', { origin: 'https://a.example' }],
    ['orders', { origin: 'https://b.example' }],
    ['coins', {}],
  ]);
});

test('each site\'s records under its own tag; the records kept before are found where the engine and review kept them', () => {
  assert.equal(siteTag('w1', 'https://a.example'), 'w1|site|https://a.example');
  const store = (m) => ({ getItem: (k) => (k in m ? m[k] : null) });
  assert.equal(keptRecords(store({}), 'w1'), false);
  assert.equal(keptRecords(store({ 'swk.usertrade.w1': '[]', 'swk.siteorders.w1': '{"trades":{},"orders":{}}' }), 'w1'), false);
  assert.equal(keptRecords(store({ 'swk.usertrade.w1': '[{"id":"t"}]' }), 'w1'), true, 'a trade of the engine\'s');
  assert.equal(keptRecords(store({ 'swk.siteorders.w1': '{"orders":{"o1":{"origin":"https://a.example"}}}' }), 'w1'), true, 'an order of the review\'s');
  assert.equal(keptRecords(store({ 'swk.usertrade.w1|site|https://a.example': '[{"id":"t"}]' }), 'w1'), false, 'a site\'s own are not kept before');
  // The tags the vendored modules key their records by: the same as keptRecords reads.
  const ut = readFileSync(new URL('../vendor/user-trade.js', import.meta.url), 'utf8');
  const so = readFileSync(new URL('../vendor/site-orders.js', import.meta.url), 'utf8');
  assert.match(ut, /const TRADES_KEY = 'swk\.usertrade'/);
  assert.match(ut, /const key = \(\) => TRADES_KEY \+ '\.' \+ \(deps\.tag \? deps\.tag\(\) : 'default'\)/);
  assert.match(so, /const KEY = 'swk\.siteorders'/);
  assert.match(so, /const key = \(\) => KEY \+ '\.' \+ tag\(\)/);
  // The sites the background follow serves after the service worker starts again.
  assert.deepEqual(sitesWithRecords(['swk.usertrade.w1', 'swk.usertrade.w1|site|https://a.example', 'swk.usertrade.w1|site|https://a.example.notfinal',
    'swk.siteorders.w1|site|https://b.example', 'swk.usertrade.w2|site|https://c.example', 'other'], 'w1').sort(), ['https://a.example', 'https://b.example']);
  assert.equal((ut.match(/key\(\) \+ '\./g) || []).length, 1, 'the engine keeps one key beside its trades');
  assert.match(ut, /const nfKey = \(\) => key\(\) \+ '\.notfinal'/);
  const st = readFileSync(new URL('../src/site-trade.js', import.meta.url), 'utf8');
  assert.match(st, /for \(const origin of sitesWithRecords\(Object\.keys\(mem \|\| \{\}\), b\.tag\)\) await forSite\(origin\);\n  const k = await keptTrades\(\);/, 'follow serves every site with records, and the records kept before');
});

test('every route a site reaches before approval names its origin; each site has its own engine; what the person approved does not', () => {
  const st = readFileSync(new URL('../src/site-trade.js', import.meta.url), 'utf8');
  assert.doesNotMatch(st, /siteContext|several sites|person: held > 0/, 'no wallet-wide counter');
  assert.match(st, /s = makeTrades\(b\.st, b\.tag, siteTag\(b\.tag, key\), siteSide\(key, leaves\.runUser\)\); sites\.set\(key, s\);/, 'one engine and review for each site, under its own tag');
  assert.match(st, /kept = keptRecords\(b\.st, b\.tag\) \? makeTrades\(b\.st, b\.tag, b\.tag, keptSide\(leaves\.runUser\)\) : null;/, 'the records kept before, by one more');
  assert.match(st, /leaves: side\.leaves,/, 'the engine gets the side\'s hold back');
  assert.match(st, /leaves: reviewLeaves\(side, \(\) => recordedElsewhere\(Object\.keys\(mem \|\| \{\}\), \(k\) => st\.getItem\(k\), walletTag, tag\)\),/, 'each review reads only the orders no other review records');
  assert.match(st, /const q = await s\.side\.asking\(\(\) => s\.orders\.quote\(params, origin\)\);/);
  assert.match(st, /const r = await s\.side\.approving\(\(\) => s\.orders\.confirm\(id\)\);/);
  assert.match(st, /const mine = await s\.side\.asking\(\(\) => s\.orders\.orders\(origin\)\);/);
  assert.match(st, /q = await s\.side\.asking\(\(\) => s\.orders\.quoteCancel\(params, origin\)\);/);
  assert.match(st, /return await o\.side\.approving\(\(\) => o\.orders\.confirmCancel\(id\)\);/);
  assert.match(st, /await s\.side\.asking\(\(\) => s\.engine\.spendable\(\)\)/);
  const mk = readFileSync(new URL('../src/market.js', import.meta.url), 'utf8');
  assert.match(mk, /const info = await leaves\.run\('info', \{\}, \{ origin \}\);/);
  assert.match(mk, /await leafResting\.fillQuote\(served, plan\.filled\.toString\(\), origin\);/);
  assert.match(mk, /const r = await leafResting\.fill\(served, plan\.filled\.toString\(\), quote2\);/, 'the fill, approved, is the person\'s');
  const lv = readFileSync(new URL('../src/leaves.js', import.meta.url), 'utf8');
  assert.match(lv, /host\('run', \{ command, args, paying: true, person: !!person \|\| undefined, site: origin \|\| undefined, from: callerOf\(\) \}\)/, 'runUser carries the origin');
  const pr = readFileSync(new URL('../src/provider-router.js', import.meta.url), 'utf8');
  assert.match(pr, /await siteTrade\.spendable\(origin\)/);
});
