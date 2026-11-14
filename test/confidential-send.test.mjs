import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { movesComing, moveWaits, MOVE_SLOW_MS, MOVE_WAIT_MS } from '../src/confidential-send.js';
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { forbiddenIn } from '../vendor/user-trade.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a move asked before counts until its coins are read on the chain, and never twice', () => {
  const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
  const records = [
    { id: 'm1', asset: A, atoms: '10', at: 1 },
    { id: 'm2', asset: A, atoms: '20', at: 2 },
    { id: 'm3', asset: A, atoms: '40', at: 3 },
    { id: 'm4', asset: B, atoms: '80', at: 4 },
    { id: 'm5', asset: A, atoms: '160', at: 5 },
    { id: 'm6', asset: A, atoms: '640', at: 6 },
  ];
  const offboards = [
    { offboard: 'm1', asset: A, amount: '10', state: 'waiting' },
    { offboard: 'm2', asset: A, amount: '20', state: 'paid', txid: 't2', final: true },
    { offboard: 'm3', asset: A, amount: '40', state: 'not_made' },
    { offboard: 'm4', asset: B, amount: '80', state: 'unlocking' },
    { offboard: 'm5', asset: A, amount: '160', state: 'paid', txid: 't5', final: true },
    // Paid and read by the wallet, not final yet: still counted.
    { offboard: 'm6', asset: A, amount: '640', state: 'paid', txid: 't5', final: false },
    // Another move of the wallet's, which this wallet did not ask for a payment: not counted.
    { offboard: 'x', asset: A, amount: '320', state: 'in_round' },
  ];
  const seen = (t) => t === 't5';
  const r = movesComing(A, records, offboards, seen);
  assert.equal(r.atoms, 670n);
  assert.deepEqual(r.open.map((o) => o.id), ['m1', 'm2', 'm6']);
  assert.equal(movesComing(B, records, offboards, seen).atoms, 80n);
  assert.equal(movesComing(A, records, [], seen).atoms, 0n);
});

test('a move waiting for the network is said to wait after three minutes; past the wait, it has not arrived', () => {
  const now = 10 * MOVE_WAIT_MS;
  assert.deepEqual(moveWaits([{ state: 'waiting', at: now - 1000 }], now), { slow: false, over: false });
  assert.deepEqual(moveWaits([{ state: 'waiting', at: now - MOVE_SLOW_MS - 1 }], now), { slow: true, over: false });
  assert.deepEqual(moveWaits([{ state: 'in_round', at: now - MOVE_SLOW_MS - 1 }], now), { slow: false, over: false });
  assert.equal(moveWaits([{ state: 'unlocking', at: now - MOVE_WAIT_MS - 1 }], now).over, true);
  assert.equal(moveWaits([], now).over, false);
});

test('what the wallet says while it moves is the contract\'s, and says none of the forbidden words', () => {
  const said = [
    DEFAULT_WORDS.movingOut('1.00004 USDX', DEFAULT_WORDS.confidentialPurpose, 10),
    DEFAULT_WORDS.movingWaits('1.00004 USDX', DEFAULT_WORDS.confidentialPurpose),
    DEFAULT_WORDS.cannotMoveNow('1.00004 USDX'), DEFAULT_WORDS.notEnough('1', 'USDX'),
    DEFAULT_WORDS.notMoved, DEFAULT_WORDS.notReady, DEFAULT_WORDS.stillOpening, DEFAULT_WORDS.addressShort,
    DEFAULT_WORDS.confidentialHidden, DEFAULT_WORDS.confidentialAmountHidden('USDX'), DEFAULT_WORDS.confidentialSeen,
  ];
  assert.equal(said[0], 'Getting 1.00004 USDX ready to be sent confidentially. Ready within 10 minutes. Keep this page open.');
  for (const s of said) assert.deepEqual(forbiddenIn(s), [], s);
});

test('Send pays a confidential address with its amount hidden, never out of the tree to it', () => {
  const js = read('src/default-mode.js');
  const at = js.indexOf('export async function prepareSend');
  const body = js.slice(at, js.indexOf('\nasync function chainReview', at));
  const conf = body.indexOf('if (engine.isConfidentialAddress(address)) return await confidentialSend(');
  assert.ok(conf > 0, 'prepareSend asks whether the address is confidential');
  // Before the chain's own payment (whose change is in the clear) and any payment out of the tree.
  assert.ok(conf < body.indexOf("if (route === 'chain')") && conf < body.indexOf("'offboard_quote'"));
  const cs = js.slice(js.indexOf('async function confidentialSend'));
  // The web wallet's arithmetic: a round amount moves, and the wallet's own output hides the amount.
  assert.match(js, /import \{ confidentialPlan, ownShare, feeMarginAtoms, liveFromRefusal \} from '\.\.\/vendor\/confidential-pay\.js';/);
  assert.match(cs, /let plan = confidentialPlan\(\{ amount: atoms, margin, onchain, instant: held - arriving, minLeaf, precision: prec \}\);/);
  assert.match(cs, /'offboard', \{ asset, amount: String\(plan\.move\), address: own, shown: q \}/);
  assert.ok(cs.indexOf("hostOp('defaults'") < cs.indexOf("'offboard', {"), 'the upkeep is told before the move');
  // What the library cannot move now (a channel's balance) is left out of the move, by its refusal.
  assert.match(cs, /live = liveFromRefusal\(e\.message\);/);
  assert.match(cs, /plan = confidentialPlan\(\{ amount: atoms, margin, onchain, instant: live, minLeaf, precision: prec \}\);/);
  assert.match(js, /const own = ownShare\(\{ amount: atoms, margin, onchain \}\);/);
  assert.match(cs, /engine\.prepareConfidentialSend\(\{ addr: address, asset, amount: String\(atoms\), own: String\(own\), others \}\)/);
  // The review says exactly what is hidden.
  assert.match(cs, /own === 0n \? DEFAULT_WORDS\.confidentialSeen : others\.length \? DEFAULT_WORDS\.confidentialHidden : DEFAULT_WORDS\.confidentialAmountHidden\(m\.ticker\)/);
  const eng = read('src/engine.js');
  assert.match(eng, /const me = wollet\.address\(undefined\)\.address\(\); \/\/ the wallet's own address, confidential/);
  // The popup asks again while the coins move, and shows the review once they are there.
  assert.match(read('popup/popup.js'), /while \(plan && plan\.moving\) \{/);
  // Removing the wallet forgets its moves.
  assert.match(js, /for \(const k of \[CODE_KEY, ARK_SUM_KEY, MOVES_KEY, PAID_KEY\]\)/);
});
