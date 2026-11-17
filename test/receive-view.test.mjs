// src/receive-view.js: what default mode's Receive shows around the picture, in the web wallet's
// words: one line, the code's text only when asked for, and the name's one tap away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receiveView, nameShown } from '../src/receive-view.js';
import { NAME_WORDS, nameQrText } from '../vendor/lnaddr.js';
import { DEFAULT_WORDS } from '../vendor/default-arca.js';
import { forbiddenIn } from '../vendor/user-trade.js';

const named = { isCode: true, isName: true, named: true, nameText: 'AmberFalcon@sequentiatestnet.com' };

test('with a name: the line, no code text, Show full code, and where the name is changed', () => {
  const v = receiveView(named);
  assert.deepEqual(v, { line: DEFAULT_WORDS.receiveLine, codeText: null, toggle: NAME_WORDS.showFull,
    settingsLine: 'Your payment name is AmberFalcon@sequentiatestnet.com. You can change or remove it in Settings.' });
  assert.equal(v.line, 'Scan or share to get paid in BTC or any asset.');
  assert.equal(nameQrText(' Alice@SequentiaTestnet.com '), 'alice@sequentiatestnet.com', 'the QR holds the bare name in lower case');
});

test('the full code: its text and Show name back, only when asked for with a name held', () => {
  const full = { isCode: true, named: true, code: 'BITCOIN:tb1q?sequentia=…', nameText: 'x@y' };
  assert.deepEqual(receiveView(full, { full: true }),
    { line: NAME_WORDS.fullTip, codeText: full.code, toggle: NAME_WORDS.showName, settingsLine: NAME_WORDS.settingsLine('x@y') });
  // With an amount (the service worker answers the full code although `full` is off): no text, no toggle.
  const amt = receiveView(full, { amount: true });
  assert.equal(amt.codeText, null); assert.equal(amt.toggle, null);
});

test('without a name: the line and Copy only; while the answer is asked for, the wait', () => {
  assert.deepEqual(receiveView({ isCode: true }), { line: DEFAULT_WORDS.receiveLine, codeText: null, toggle: null, settingsLine: null });
  assert.equal(receiveView(null).line, DEFAULT_WORDS.receiveWait);
  assert.equal(receiveView({ isCode: false }).line, DEFAULT_WORDS.receiveLine);
});

test('confidential: its own line, no name, no toggle', () => {
  const v = receiveView({ isCode: true, confidential: true, named: true, nameText: 'x@y' }, { conf: true });
  assert.equal(v.line, DEFAULT_WORDS.receiveTipConf); assert.equal(v.toggle, null); assert.equal(v.codeText, null);
});

test('a name is shown only while the service answers and has said the key holds it', () => {
  assert.equal(nameShown({ name: 'a', verified: true, unreachable: false }), true);
  assert.equal(nameShown({ name: 'a', verified: false, unreachable: false }), false, 'kept from before, not confirmed yet');
  assert.equal(nameShown({ name: 'a', verified: true, unreachable: true }), false, 'the service does not answer');
  assert.equal(nameShown({ name: null, verified: false }), false);
  assert.equal(nameShown(null), false);
});

test('every word it shows names no protocol', () => {
  for (const r of [named, { isCode: true }, { isCode: true, named: true, nameText: 'x@y' }])
    for (const o of [{}, { full: true }, { conf: true }])
      for (const w of Object.values(receiveView(r, o))) if (typeof w === 'string') assert.deepEqual(forbiddenIn(w), [], w);
});

test('the card: the picture, one line and Copy; everything else under More options', () => {
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const card = html.slice(html.indexOf('id="recvDefault"'), html.indexOf('id="faucetCard"'));
  const more = card.indexOf('id="recvMore"');
  assert.ok(more > 0);
  const top = card.slice(0, more);
  for (const id of ['recvDQr', 'recvDLine', 'btnDCopy', 'recvArrive', 'btnRecvMore']) assert.ok(top.includes(`id="${id}"`), id + ' is on the card');
  for (const id of ['recvDAmt', 'btnDNew', 'btnDFull', 'recvDConf', 'btnRecvOamp']) assert.ok(card.indexOf(`id="${id}"`) > more, id + ' is under More options');
  assert.ok(!top.includes('recvDLbl') && !top.includes('nameBox'), 'no label and no name block on the card');
});

test('the name block sits in Settings in default mode and under the address in developer mode', () => {
  const pop = readFileSync(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const i = pop.indexOf('async function renderName()'), body = pop.slice(i, pop.indexOf('\n}\n', i));
  assert.match(body, /setCard\.appendChild\(box\)/);
  assert.match(body, /\$\('tReceive'\)\.insertBefore\(box, \$\('recvOamp'\)\)/);
  assert.match(body, /const checking = !!nameNow && !st\.verified/);
  assert.match(body, /NAME_WORDS\.change/);
  assert.match(pop, /\$\('btnRecvOamp'\)\.onclick/);
});
