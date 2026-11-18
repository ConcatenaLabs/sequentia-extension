// Whose the site-trade engine's and its site-order review's leaf commands are (src/site-context.js):
// a site's while it asks for something the person has not approved, the person's while what they
// approved runs, the wallet's own otherwise (sequentia-extension#225).
//   node --test test/site-context.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteContext, siteLeaves, SEVERAL_SITES } from '../src/site-context.js';

const tick = () => new Promise((r) => setImmediate(r));

test('a site\'s span, an approved one, none', async () => {
  const ctx = siteContext();
  const asked = [];
  const L = siteLeaves(ctx, async (cmd, args, opts) => { asked.push([cmd, opts]); return cmd; });
  await L.command('coins');
  await ctx.site('https://a.example', async () => { await L.command('take_quote', { x: 1 }); await tick(); await L.command('schedule'); });
  await ctx.approved(async () => { await L.command('order_place'); });
  assert.deepEqual(asked, [
    ['coins', {}],
    ['take_quote', { origin: 'https://a.example' }],
    ['schedule', { origin: 'https://a.example' }],
    ['order_place', { person: true }],
  ]);
});

test('overlapping spans: two sites share one origin; a site\'s span under way wins over an approved one', async () => {
  const ctx = siteContext();
  let releaseA, releaseB;
  const a = ctx.site('https://a.example', () => new Promise((r) => { releaseA = r; }));
  assert.deepEqual(ctx.attribution(), { origin: 'https://a.example' });
  const b = ctx.site('https://b.example', () => new Promise((r) => { releaseB = r; }));
  assert.deepEqual(ctx.attribution(), { origin: SEVERAL_SITES });
  let approvedDone;
  const ap = ctx.approved(() => new Promise((r) => { approvedDone = r; }));
  assert.deepEqual(ctx.attribution(), { origin: SEVERAL_SITES }, 'never the person\'s while a site asks');
  releaseB(); await b;
  assert.deepEqual(ctx.attribution(), { origin: 'https://a.example' });
  releaseA(); await a;
  assert.deepEqual(ctx.attribution(), { person: true });
  approvedDone(); await ap;
  assert.deepEqual(ctx.attribution(), {});
  // A span that throws ends all the same.
  await assert.rejects(ctx.site('https://c.example', async () => { throw new Error('x'); }));
  assert.deepEqual(ctx.attribution(), {});
});

test('every route a site reaches before approval names its origin; what the person approved does not', () => {
  const st = readFileSync(new URL('../src/site-trade.js', import.meta.url), 'utf8');
  assert.equal((st.match(/leaves: siteLeaves\(ctx, leaves\.runUser\)/g) || []).length, 2, 'the engine and the review');
  assert.doesNotMatch(st, /person: held > 0|\{ person: true \}\) \}/, 'no adapter makes a site\'s command the person\'s');
  assert.match(st, /export async function quote\(params, origin\) \{ const s = await fresh\(\); return await ctx\.site\(origin, \(\) => s\.orders\.quote\(params, origin\)\); \}/);
  assert.match(st, /const r = await ctx\.approved\(\(\) => s\.orders\.confirm\(id\)\);/);
  assert.match(st, /return await ctx\.site\(origin, \(\) => s\.orders\.orders\(origin\)\);/);
  assert.match(st, /ctx\.site\(origin, \(\) => s\.orders\.quoteCancel\(params, origin\)\)/);
  assert.match(st, /ctx\.approved\(\(\) => s\.orders\.confirmCancel\(id\)\)/);
  assert.match(st, /ctx\.site\(origin, \(\) => s\.engine\.spendable\(\)\)/);
  const mk = readFileSync(new URL('../src/market.js', import.meta.url), 'utf8');
  assert.match(mk, /const info = await leaves\.run\('info', \{\}, \{ origin \}\);/);
  assert.match(mk, /await leafResting\.fillQuote\(served, plan\.filled\.toString\(\), origin\);/);
  assert.match(mk, /const r = await leafResting\.fill\(served, plan\.filled\.toString\(\), quote2\);/, 'the fill, approved, is the person\'s');
  const lv = readFileSync(new URL('../src/leaves.js', import.meta.url), 'utf8');
  assert.match(lv, /host\('run', \{ command, args, paying: true, person: !!person \|\| undefined, site: origin \|\| undefined, from: callerOf\(\) \}\)/, 'runUser carries the origin');
  const pr = readFileSync(new URL('../src/provider-router.js', import.meta.url), 'utf8');
  assert.match(pr, /await siteTrade\.spendable\(origin\)/);
});
