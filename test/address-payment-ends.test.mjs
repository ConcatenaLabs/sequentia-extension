// A payment to an address out of the tree reads "Sending" until the leaf library says it is made,
// and only then "Sent"; one that ended unmade is said once, in the review or on Balance's card; a
// payment whose coins are still arriving is refused as arriving, with when (the web wallet's
// #604 and #607); and the arriving lines under a figure are developer mode's (#188).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WORDS, offboardOutcome, offboardEnds, offboardNewsText, addressRoute } from '../vendor/default-arca.js';
import { forbiddenIn } from '../vendor/user-trade.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const ID = 'c21516a41cd39b103984ca3403ca8fe14bc430ea1ce72ccc0828b9df4e4e2934';

test('the answer to Send is "Sending" until the library says made, then "Sent"', () => {
  const o = offboardOutcome({ offboard: ID, state: 'pending', round_within_seconds: 60 }, '1', 'OILX', 10, 60);
  assert.equal(o.text, 'Sending 1 OILX. Keep this page open until it is sent.');
  const js = read('src/default-mode.js');
  // The service worker answers "Sending" with the payment to follow, and "Sent" kept for later.
  assert.match(js, /return \{ text: o\.text, ms: Date\.now\(\) - t0, follow: id, sent: DEFAULT_WORDS\.sentLater\(p\.amt, p\.ticker, o\.minutes\) \};/);
  const pop = read('popup/popup.js');
  // The popup says "Sent" only on 'made'.
  assert.match(pop, /if \(p\.stage === 'made'\) \{ st\.className = 'status ok'; st\.textContent = r\.sent;/);
  assert.match(pop, /if \(!r\.follow\) \{ st\.className = 'status ok'; st\.textContent = r\.text; return; \}/);
});

test('an unmade payment is said once, on Balance, until OK', () => {
  const asked = [{ offboard: ID, stage: 'pending', asset: 'aa'.repeat(32), atoms: '100000000', address: 'tb1q68apqvgwpsnewuwvtjy2xra4g3phq23quqzedu' }];
  const { stages, news } = offboardEnds(asked, [{ offboard: ID, state: 'not_made' }]);
  assert.equal(stages.get(ID), 'not_made');
  assert.equal(news.length, 1);
  assert.equal(offboardNewsText(asked[0], '1', 'OILX'), 'Your payment of 1 OILX to tb1q68apqvgwps…zedu was not made: nothing left your wallet. Send it again.');
  const pop = read('popup/popup.js');
  assert.match(pop, /rpc\('default\.addressNews'\)/);
  assert.match(pop, /rpc\('default\.addressPaymentTold', \{ id: n\.id \}\)/);
  assert.match(read('popup/popup.html'), /<div id="newsCard" class="card hide"/);
  const bg = read('background.js');
  for (const op of ['default.addressPayment', 'default.addressNews', 'default.addressPaymentTold']) assert.ok(bg.includes(`'${op}':`), op);
  for (const s of [offboardNewsText(asked[0], '1', 'OILX'), DEFAULT_WORDS.sendingLater('1', 'OILX'), DEFAULT_WORDS.notArrived('1', 'OILX', 'tb1q'), DEFAULT_WORDS.newsOk])
    assert.deepEqual(forbiddenIn(s), [], s);
});

test('coins still arriving are said so, with when, never "can\'t be sent" (#607)', () => {
  assert.equal(addressRoute(100000000n, 0n, 0n, 0n, 500000000000n), 'arriving');
  const js = read('src/default-mode.js');
  assert.match(js, /if \(route === 'arriving'\) \{/);
  assert.match(js, /throw new Error\(DEFAULT_WORDS\.stillArrivingWithin\(m\.ticker, arrivalMinutes\(/);
});

test('the arriving, moving, redone and kept-safe lines are developer mode\'s (#188)', () => {
  const pop = read('popup/popup.js');
  const i = pop.indexOf("row.appendChild(el('div', 'sub arriving-line'");
  assert.ok(i > 0);
  const before = pop.slice(0, i);
  const gate = before.lastIndexOf('if (dev) {');
  assert.ok(gate > 0 && gate > before.lastIndexOf("if (!(OV.mode === 'developer'))"), 'the lines sit under if (dev)');
  assert.ok(!pop.includes("if (!(OV.mode === 'developer')) {\n      // What has vested"), 'no default-mode arriving block');
});

test('a payment on the chain reads as the contract\'s, and "Sent" says when it arrives', () => {
  const js = read('src/default-mode.js');
  assert.match(js, /else lines\.push\(DEFAULT_WORDS\.arrivesNextBlock\);/);
  assert.match(js, /DEFAULT_WORDS\.sentBlock\(p\.amt, p\.ticker\), ms/);
  assert.equal(DEFAULT_WORDS.sentBlock('1', 'OILX'), 'Sent 1 OILX. It arrives after the next block, in about a minute.');
});
