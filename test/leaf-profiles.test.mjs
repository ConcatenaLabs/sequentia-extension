// What an operator's profiles mean for what the wallet shows (src/leaf-profiles.js): the
// rules and the words are the web wallet's, shared across the three wallets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supervisedAssets, frozenAtoms, frozenSentence, plainRefusal, frozenRefusal, FROZEN_REFUSAL, DECLINED_REFUSAL, bondRefusal, BOND_WORDS, issuerAssets, batchLine } from '../src/leaf-profiles.js';
import { developerWordsIn } from '../src/balance-view.js';

const X = 'aa'.repeat(32);
const Y = 'bb'.repeat(32);

test('supervised assets are the ones the operator serves with a landing allowance', () => {
  const info = { server_info: { assets: [{ asset: X }, { asset: Y, supervised: { landing_allowance: '100' } }] } };
  assert.deepEqual(supervisedAssets(info), [Y]);
  assert.deepEqual(supervisedAssets(null), []);
  assert.deepEqual(supervisedAssets({ server_info: {} }), []);
});

test('what is frozen counts frozen and paused held leaves and frozen on-chain coins, nothing else', () => {
  const coins = [
    { leaf_id: 'a', asset: Y, value: '1000', state: 'live', frozen: { frozen: true, paused: false } },
    { leaf_id: 'b', asset: Y, value: '20', state: 'live', frozen: { frozen: false, paused: true } },
    { leaf_id: 'c', asset: Y, value: '300', state: 'live', frozen: { frozen: false, paused: false } },
    { leaf_id: 'd', asset: Y, value: '4000', state: 'spent', frozen: { frozen: true } },
    { leaf_id: 'e', asset: X, value: '5', state: 'live' },
  ];
  const m = frozenAtoms(coins, { sequentia_onchain_frozen: { [Y]: '700' } });
  assert.equal(m.get(Y), 1720n);
  assert.equal(m.has(X), false);
  assert.equal(frozenAtoms([], { sequentia_onchain_frozen: { [X]: '0' } }).size, 0, 'nothing frozen, nothing said');
});

test('the frozen sentence is the one the three wallets show, and carries no developer word', () => {
  const s = frozenSentence('17.2', 'USDC.e');
  assert.equal(s, "17.2 USDC.e is frozen by its issuer: it can't be sent until the issuer lifts the freeze.");
  assert.deepEqual(developerWordsIn(s), []);
  assert.deepEqual(developerWordsIn(FROZEN_REFUSAL), []);
  for (const w of ['landing', 'bond', 'exit', 'leaf', 'operator']) assert.ok(!new RegExp(`\\b${w}\\b`, 'i').test(s + FROZEN_REFUSAL), w);
});

test('user mode says a frozen refusal plainly, and leaves every other refusal as it is', () => {
  const f = plainRefusal({ kind: 'server_refused', code: 'frozen', status: 409, message: 'the server refused cosign_transfer (409 frozen): …' });
  assert.equal(f.message, 'This asset is frozen by its issuer for this wallet: nothing was sent.');
  assert.equal(f.code, 'frozen');
  assert.match(plainRefusal(new Error("refused: the issuer has frozen this coin's landing")).message, /frozen by its issuer/);
  // The node's word for a spend of a frozen coin, as a broadcast refusal reads it.
  assert.equal(frozenRefusal(new Error('sendrawtransaction RPC error: {"code":-26,"message":"bad-txns-asset-frozen"}')), true);
  assert.equal(frozenRefusal(new Error('refused: the issuer has paused this asset')), true);
  const o = new Error('refused: no');
  assert.equal(plainRefusal(o), o);
});

test('a payment the operator declines reads plainly in user mode, in the words the three wallets share', () => {
  const e = { kind: 'server_refused', code: 'declined', status: 422, message: 'the server refused cosign_transfer (422 declined): the signer: the signer declined: policy: …' };
  const p = plainRefusal(e);
  assert.equal(p.message, 'This payment was declined; nothing was sent.');
  assert.equal(p.message, DECLINED_REFUSAL);
  assert.equal(p.status, 422);
  assert.equal(p.code, 'declined');
  assert.deepEqual(developerWordsIn(DECLINED_REFUSAL), []);
  // An operator not reached is no refusal: said as it is.
  const u = new Error('cosign_transfer: the server answered 503 signer_unavailable: …');
  assert.equal(plainRefusal(u), u);
});

test('a refusal of the bond reads plainly in user mode, in the words the three wallets share', () => {
  for (const m of ['refused: the operator\'s bond is missing: it was seen bonded …', 'refused: the operator\'s bond is noticed …', 'refused: more than the bond\'s 5000000 …']) {
    const e = new Error(m);
    assert.equal(bondRefusal(e), true);
    assert.equal(plainRefusal(e).message, BOND_WORDS.refused);
  }
  assert.equal(BOND_WORDS.refused, 'Not accepted: the security deposit that backs these instant payments is missing or being withdrawn, so this wallet takes no payment that rests on it. Nothing was signed.');
  assert.equal(bondRefusal(new Error('refused: no')), false);
  assert.equal(bondRefusal(new Error('refused: the bonded stake')), false, 'a whole word only');
  assert.deepEqual(developerWordsIn(BOND_WORDS.refused), []);
  for (const w of ['leaf', 'operator', 'round', 'tree', 'bond']) assert.ok(!new RegExp(`\\b${w}\\b`, 'i').test(BOND_WORDS.refused), w);
});

test('issuer-operated assets are the ones the operator serves with an issuer entry, and a leaf says its batch', () => {
  const info = { server_info: { assets: [{ asset: X, issuer: { limiter: 'l' } }, { asset: Y }] } };
  assert.deepEqual(issuerAssets(info), [X]);
  assert.deepEqual(issuerAssets({}), []);
  assert.equal(batchLine('issuer-operated'), 'issuer-operated: its sweep can only burn');
  assert.equal(batchLine('open'), 'open: its sweep pays the operator');
  assert.equal(batchLine(null), null);
});
