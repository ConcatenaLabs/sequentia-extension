import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetChromeStub } from './helpers/chrome-stub.mjs';
import { MODE_WORDS, tagOf, mode, setMode, rememberWallet, walletTag, modeStamp } from '../src/mode.js';
import { laterMode } from '../src/leaf-schedule.js';
import { readRequest } from '../src/leaf-request.js';

beforeEach(() => resetChromeStub());

test('the mode is user until set, and kept for each wallet', async () => {
  assert.equal(await mode(), 'user');
  await assert.rejects(setMode('developer'), /open the wallet first/);
  await rememberWallet('aaaaaaaa');
  assert.equal(await mode(), 'user');
  await setMode('developer');
  assert.equal(await mode(), 'developer');
  // Another wallet opened in this browser starts in user mode, and keeps its own.
  await rememberWallet('bbbbbbbb');
  assert.equal(await walletTag(), 'bbbbbbbb');
  assert.equal(await mode(), 'user');
  await rememberWallet('aaaaaaaa');
  assert.equal(await mode(), 'developer');
  await assert.rejects(setMode('expert'), /'developer' or 'user'/);
});

test('a mode set before modes were kept per wallet becomes the next opened wallet\'s, once', async () => {
  await chrome.storage.local.set({ 'ext.settings': { mode: 'developer', autoLockMin: 5 } });
  assert.equal(await mode(), 'developer', 'read while no wallet has opened yet');
  await rememberWallet('cccccccc');
  assert.equal(await mode(), 'developer');
  const s = (await chrome.storage.local.get('ext.settings'))['ext.settings'];
  assert.deepEqual(s, { autoLockMin: 5 }, 'the old setting is moved, the others kept');
  await rememberWallet('dddddddd');
  assert.equal(await mode(), 'user');
});

test('the tag is the web wallet\'s: a 32-bit FNV-1a of the descriptor', () => {
  assert.equal(tagOf(''), null);
  assert.equal(tagOf('a'), 'e40c292c');
  assert.equal(tagOf('foobar'), 'bf9cf968');
});

test('the popup carries the shared words of the mode setting', () => {
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  for (const w of Object.values(MODE_WORDS)) assert.ok(html.includes(w), `popup.html lacks "${w}"`);
  assert.equal(MODE_WORDS.userLine, 'One figure per asset, and the wallet chooses how value moves.');
});

test('a receive request is known by its kind, and by the key older texts carry', () => {
  const enc = (v) => 'request:' + Buffer.from(JSON.stringify(v)).toString('hex');
  assert.equal(readRequest(enc({ kind: 'request', owner: '11' })).owner, '11');
  assert.equal(readRequest(enc({ arca_request: 1, owner: '22' })).owner, '22');
  assert.throws(() => readRequest(enc({ kind: 'swap-offer' })), /the text is not one/);
});

// SX1 run 2: a wallet set to developer mode while its join was under way had its coins boarded,
// because the join's start carried the mode it read before the change and arrived after it.
test('the leaf host keeps the mode set last, whatever order the messages arrive in', async () => {
  await rememberWallet('eeeeeeee');
  assert.deepEqual(await modeStamp(), { mode: 'user', at: 0 });
  const read = await modeStamp();                 // the join reads the mode ...
  await new Promise((r) => setTimeout(r, 2));
  await setMode('developer');                     // ... the person changes it ...
  const now = await modeStamp();
  assert.equal(now.mode, 'developer'); assert.ok(now.at > 0);
  let host = { on: false, at: -1 };
  host = laterMode(host, now.mode === 'user', now.at);    // the change reaches the host first,
  host = laterMode(host, read.mode === 'user', read.at);  // the join's start after it
  assert.deepEqual(host, { on: false, at: now.at });
  // In order, the same end; and a tie takes what is told (a start after a sync of one mode).
  assert.deepEqual(laterMode(laterMode({ on: false, at: -1 }, true, read.at), false, now.at), { on: false, at: now.at });
  assert.deepEqual(laterMode({ on: false, at: 5 }, true, 5), { on: true, at: 5 });
});
