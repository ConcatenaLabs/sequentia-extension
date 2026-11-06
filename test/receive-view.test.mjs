// src/receive-view.js: what default mode's Receive shows around the picture, in the web wallet's
// words, with and without a payment name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveView } from '../src/receive-view.js';
import { NAME_WORDS, nameQrText } from '../vendor/lnaddr.js';
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { forbiddenIn } from '../vendor/user-trade.js';

test('with a name: the name, a line saying it is public, Copy name, Show full code, no New code', () => {
  const v = receiveView({ isCode: true, isName: true, named: true });
  assert.deepEqual(v, { label: NAME_WORDS.label, tip: NAME_WORDS.qrTip, copy: NAME_WORDS.copyName, newCode: false,
    toggle: NAME_WORDS.showFull, publicLine: NAME_WORDS.public });
  assert.equal(nameQrText(' Alice@SequentiaTestnet.com '), 'alice@sequentiatestnet.com', 'the QR holds the bare name in lower case');
});

test('the full code: Show name back only when the wallet holds a name and asked for it', () => {
  assert.deepEqual(receiveView({ isCode: true, named: true }, { full: true }),
    { label: DEFAULT_WORDS.codeLabel, tip: NAME_WORDS.fullTip, copy: DEFAULT_WORDS.copyCode, newCode: true, toggle: NAME_WORDS.showName, publicLine: null });
  // With an amount (the service worker answers the full code although `full` is off): no toggle.
  assert.equal(receiveView({ isCode: true, named: true }, { full: false }).toggle, null);
  assert.deepEqual(receiveView({ isCode: true }), { label: DEFAULT_WORDS.codeLabel, tip: null, copy: DEFAULT_WORDS.copyCode, newCode: true, toggle: null, publicLine: null });
  assert.equal(receiveView({ isCode: false }).label, 'Receive');
});

test('every word it shows names no protocol', () => {
  for (const r of [{ isCode: true, isName: true }, { isCode: true, named: true }])
    for (const w of Object.values(receiveView(r, { full: true }))) if (typeof w === 'string') assert.deepEqual(forbiddenIn(w), [], w);
});
