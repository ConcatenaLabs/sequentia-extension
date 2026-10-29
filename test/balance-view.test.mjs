import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forbiddenIn } from '../vendor/user-trade.js';
import { figureParts, figureOf, userSplit, developerSplit, developerWordsIn, DEVELOPER_WORDS, leafPerAsset } from '../src/balance-view.js';

const fmt = (v) => String(v);
const row = { onchain: '100', leaves: '20', ln: '3', staked: '4000' };

test('the figure counts on-chain, leaves, Lightning and staked', () => {
  assert.deepEqual(figureParts(row).map(([k]) => k), ['On-chain', 'Off-chain', 'Lightning', 'Staked']);
  assert.equal(figureOf(row), 4123n);
  assert.equal(figureOf({ onchain: '5', leaves: null, ln: undefined }), 5n);
});

test('user mode: never where an asset is held; what is staked, when the figure holds more', () => {
  assert.equal(userSplit(row, fmt), 'Staked 4000');
  assert.equal(userSplit({ onchain: '0', leaves: '20', ln: '0', staked: '9' }, fmt), 'Staked 9');
  assert.equal(userSplit({ onchain: '7', leaves: '3', ln: '2', staked: '0' }, fmt), null);
  assert.equal(userSplit({ onchain: '0', leaves: '0', ln: '0', staked: '9', total: '9' }, fmt), null);
  assert.deepEqual(developerWordsIn(userSplit(row, fmt)), []);
  assert.deepEqual(forbiddenIn(userSplit(row, fmt)), []);
});

test('developer mode: every rail by name, staked when there is any', () => {
  assert.equal(developerSplit(row, fmt), '100 on-chain · 20 leaves · 3 Lightning · 4000 staked');
  assert.equal(developerSplit({ onchain: '1', leaves: '0', ln: '0', staked: '0' }, fmt), '1 on-chain · 0 leaves · 0 Lightning');
});

test('the word list names what user mode never shows', () => {
  assert.equal(DEVELOPER_WORDS.length, 15);
  assert.deepEqual(developerWordsIn('3 Leaves, a round, two plans, the claim, CSV and atoms'), ['leaves', 'round', 'plan', 'claim', 'atoms', 'CSV']);
  assert.deepEqual(developerWordsIn('Portfolio total · around · planet · Off-chain'), []);
});

test('the popup builds user mode rows with no rail controls', () => {
  const js = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const body = js.slice(js.indexOf('function renderOverview()'), js.indexOf('// ---- modals ----'));
  const user = body.slice(body.indexOf('if (!dev) {'), body.indexOf('// Developer mode: every rail'));
  assert.match(user, /userSplit\(r, fmt\)/);
  assert.match(user, /continue;/, 'a user-mode row ends before the developer parts');
  assert.ok(!/moveDialog|closeDialog|Lightning/.test(user), 'no Move, no Lightning line in user mode');
});

test('leaves count once in a figure: a leaf whose exit claim is out is the chain\'s, as the library counts it', () => {
  const X = 'aa'.repeat(32), Z = 'cc'.repeat(32);
  // Z: a 2,000,000 leaf exiting with its claim out (1,999,976 landed on the chain) and a
  // 300,000 leaf; the library's held counts the claim once, as the on-chain coin.
  const balance = {
    arca: { [Z]: { live: '300000', exiting: '2000000' }, [X]: { live: '500', awaiting_preimage: '70' } },
    sequentia_onchain: { [Z]: '1999976', [X]: '1000' },
    held: { [Z]: '2299976', [X]: '1500' },
  };
  assert.deepEqual(leafPerAsset(balance), { [Z]: '300000', [X]: '500' });
  // An older library with no `held`: its states summed.
  assert.deepEqual(leafPerAsset({ arca: { [Z]: { live: '3', exiting: '4' } } }), { [Z]: '7' });
  assert.deepEqual(leafPerAsset(null), {});
});
