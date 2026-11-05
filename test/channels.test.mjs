// The channel rules the leaf host follows in default mode (src/leaf-schedule.js, the web wallet's).
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelPollMs, channelArrivals, payableChannels, codeNamesChannels, CHANNEL_POLL_MS, CHANNEL_POLL_IDLE_MS, CHANNEL_FAST_FOR_MS } from '../src/leaf-schedule.js';

const X = 'aa'.repeat(32), Y = 'bb'.repeat(32);

test('channels are read fast only while the popup is open and the wallet in use', () => {
  const now = 1_000_000_000;
  assert.equal(channelPollMs({ visible: true, usedAt: now - 1000, now }), CHANNEL_POLL_MS);
  assert.equal(channelPollMs({ visible: true, usedAt: now - CHANNEL_FAST_FOR_MS - 1, now }), CHANNEL_POLL_IDLE_MS);
  assert.equal(channelPollMs({ visible: false, usedAt: now, now }), CHANNEL_POLL_IDLE_MS);
  assert.equal(CHANNEL_POLL_MS, 300);
  assert.equal(CHANNEL_POLL_IDLE_MS, 5000);
});

test('a channel whose credit grew is an arrival; a new or failed read is not', () => {
  const before = [{ leaf_id: 'c1', asset: X, credit: '100' }, { leaf_id: 'c2', asset: Y, credit: '5' }];
  const after = [{ leaf_id: 'c1', asset: X, credit: '350' }, { leaf_id: 'c2', asset: Y, credit: '5' }, { leaf_id: 'c3', asset: Y, credit: '9' }, { leaf_id: 'c4', error: 'x' }];
  assert.deepEqual(channelArrivals(before, after), [{ leaf_id: 'c1', asset: X, atoms: 250n }]);
  assert.deepEqual(channelArrivals([], after), []);
});

test('a receive code names the live, final channels; one made before they changed is made again', () => {
  const chans = [{ leaf_id: 'c1', asset: X, coin_state: 'live', final: true }, { leaf_id: 'c2', asset: Y, coin_state: 'pending', final: false },
    { leaf_id: 'c3', asset: X, coin_state: 'live', final: true }];
  const p = payableChannels(chans);
  assert.deepEqual(p, { [X]: 'c1' });
  assert.ok(codeNamesChannels({ channels: { [X]: 'c1' } }, p));
  assert.ok(!codeNamesChannels({ channels: {} }, p));
  assert.ok(!codeNamesChannels({}, p));
  assert.ok(codeNamesChannels({}, {}));
  assert.ok(!codeNamesChannels({ channels: { [X]: 'c3' } }, p));
});
