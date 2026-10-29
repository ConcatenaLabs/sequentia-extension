import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionHidden } from '../src/hidden.js';

test('hidden assets fold away; BTC never does; a hidden asset at 0 is nowhere', () => {
  const rows = [{ key: 'BTC', total: '0' }, { key: 'aa', total: '5' }, { key: 'bb', total: '7' }, { key: 'cc', total: '0' }];
  const { shown, folded } = partitionHidden(rows, ['bb', 'cc', 'BTC']);
  assert.deepEqual(shown.map((r) => r.key), ['BTC', 'aa']);
  assert.deepEqual(folded.map((r) => r.key), ['bb']);
  assert.deepEqual(partitionHidden(rows, []).shown.length, 4);
});
