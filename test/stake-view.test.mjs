import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldAtoms, lockWords } from '../src/stake-view.js';
import { STAKE_CSVS, HEIGHT_CSV, TIME_CSV, isTimeCsv } from '../vendor/stake-records.js';

test('the stakes of both locks are looked for: the height lock and the time lock', () => {
  assert.deepEqual(STAKE_CSVS, [43200, (1 << 22) | 2532]);
  assert.equal(isTimeCsv(HEIGHT_CSV), false);
  assert.equal(isTimeCsv(TIME_CSV), true);
  assert.equal(lockWords(HEIGHT_CSV), 'a lock of 43,200 blocks');
  assert.equal(lockWords(TIME_CSV), 'a time lock of about 15 days');
});

test('a stake counts its bond, then its unbonding output, and nothing once claimed back', () => {
  const e = { txid: 'a', atoms: '5000000000' };
  assert.equal(heldAtoms(e, null), 5000000000n, 'not read yet: its bond');
  assert.equal(heldAtoms(e, { state: 'pending', stake: { value: '5000000000' } }), 5000000000n);
  assert.equal(heldAtoms(e, { state: 'bonded', stake: { value: '5000000000' } }), 5000000000n);
  assert.equal(heldAtoms(e, { state: 'unbondable', stake: { value: '5000000000' } }), 5000000000n);
  assert.equal(heldAtoms(e, { state: 'unbonding', stake: { value: '5000000000' }, unbonding: { value: '4999999460' } }), 4999999460n);
  assert.equal(heldAtoms(e, { state: 'claimable', stake: { value: '5000000000' }, unbonding: { value: '4999999460' } }), 4999999460n);
  for (const st of ['claiming', 'claimed', 'left', 'unknown']) assert.equal(heldAtoms(e, { state: st }), 0n, st);
});
