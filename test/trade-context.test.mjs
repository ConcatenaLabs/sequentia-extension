// What default mode's Trade tab lists comes from the pairs admitted and the chain they are for:
// the chain's genesis is read from esplora and never waits on the leaf wallet, the pairs are
// served as the operator serves them, and no sentence the composer shows names an empty asset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chainGenesis } from '../src/chain-genesis.js';
import { servedPairs } from '../src/leaf-profiles.js';
import { USER_WORDS, forbiddenIn } from '../vendor/user-trade.js';

const G = 'ddd11d54c87a2bd94400fd31ce05d8e1110bb4b78e7103f738342086fc4ea92e';
const answer = (body, ok = true) => async () => ({ ok, text: async () => body });

test('the genesis comes from esplora without asking the leaf wallet', async () => {
  let asked = 0;
  const g = await chainGenesis({ esplora: 'E', fetchFn: answer(G + '\n'), info: async () => { asked++; return { genesis_hash: 'x' }; } });
  assert.equal(g, G);
  assert.equal(asked, 0);
});

test('esplora silent: the leaf wallet\'s answer, and a hung leaf wallet is not waited on forever', async () => {
  const down = async () => { throw new Error('offline'); };
  assert.equal(await chainGenesis({ esplora: 'E', fetchFn: down, info: async () => ({ genesis_hash: G }) }), G);
  assert.equal(await chainGenesis({ esplora: 'E', fetchFn: answer('Found. Redirecting to /'), info: async () => ({ genesis_hash: G }) }), G);
  const t = Date.now();
  assert.equal(await chainGenesis({ esplora: 'E', fetchFn: down, info: () => new Promise(() => {}), timeoutMs: 50 }), null);
  assert.ok(Date.now() - t < 2000);
  assert.equal(await chainGenesis({ esplora: 'E', fetchFn: down }), null);
});

test('a pair with a supervised asset is served only by the in-tree swap', () => {
  const pairs = { chains: { [G]: { pairs: [
    { pay: 'BTC', receive: 'a', sources: ['btc-gateway'] },
    { pay: 'a', receive: 's', sources: ['leaf-maker', 'covenant-round', 'leaf-resting'] },
  ] } } };
  assert.equal(servedPairs(pairs, []), pairs);
  const out = servedPairs(pairs, ['s']).chains[G].pairs;
  assert.deepEqual(out[0].sources, ['btc-gateway']);
  assert.deepEqual(out[1].sources, ['leaf-maker']);
});

test('no sentence the composer shows names an empty asset', () => {
  const src = readFileSync(new URL('../vendor/user-composer.js', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/USER_WORDS\.\w+\(\s*(?:''|""|``)/g)].map((m) => m[0]), []);
  assert.equal(USER_WORDS.nothingOffered('BTC'), 'Not offered right now: nobody offers anything for BTC.');
  assert.deepEqual(forbiddenIn(USER_WORDS.nothingOffered('BTC')), []);
});
