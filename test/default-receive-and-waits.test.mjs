// Default mode keeps its money in coins (the web wallet's docs/DEFAULT_MODE.md): its receive codes
// name no channel, and a payment that waits for a round of the wallet's own says how long, and ends
// at once when the library refuses the settle itself. Review RV93's F1 and F2, and F3's words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { payThrough, receiveArgs, codeChannelsNow, codeNamesChannels, releasingWords, developerReleasingLine, SETTLE_GAVE_UP } from '../src/leaf-schedule.js';
import { DEFAULT_WORDS, SETTLE_LATE_MS } from '../vendor/default-arca.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const X = 'aa'.repeat(32);

// RV93 F1: the library names every usable channel unless `receive` is asked with channels false
// (arca command.rs "receive"); web main asks so in default mode (leaves.js receiveArgs). The
// reviewer's source test, its call form matched to receiveArgs.
test('F1: default mode\'s receive code and the name stock\'s codes name no channel', () => {
  const dm = read('src/default-mode.js');
  const i = dm.indexOf('async function leafCode(');
  const body = dm.slice(i, dm.indexOf('\n}\n', i));
  assert.match(body, /runUser\('receive', receiveArgs\(!\(await isDefault\(\)\)\)\)/, 'leafCode asks receive with receiveArgs');
  const j = dm.indexOf('export async function nameCode(');
  const nbody = dm.slice(j, dm.indexOf('\n}\n', j));
  assert.match(nbody, /runAny\('receive', receiveArgs\(!\(await isDefault\(\)\)\)\)/, 'the name stock codes name no channel either');
  assert.deepEqual(receiveArgs(false), { channels: false }, 'default mode');
  assert.deepEqual(receiveArgs(true), {}, 'developer mode: every channel a payer can pay');
});

// KR97 E1: a code kept from before, naming a channel, is made again in default mode, whatever the
// host reports; developer mode keeps a code that names the channels payable now.
test('F1: a kept code naming a channel is not shown again in default mode', () => {
  const kept = { text: 'sqr1…', owner: 'o', channels: { [X]: 'channel-1' } };
  assert.equal(codeNamesChannels(kept, codeChannelsNow({ [X]: 'channel-1' }, false)), false, 'default mode: made again');
  assert.equal(codeNamesChannels(kept, codeChannelsNow(undefined, false)), false, 'with no reading from the host too');
  assert.equal(codeNamesChannels({ ...kept, channels: {} }, codeChannelsNow({ [X]: 'channel-1' }, false)), true, 'a code naming none stands');
  assert.equal(codeNamesChannels(kept, codeChannelsNow({ [X]: 'channel-1' }, true)), true, 'developer mode keeps it');
  const dm = read('src/default-mode.js');
  const i = dm.indexOf('async function leafCode(');
  const body = dm.slice(i, dm.indexOf('\n}\n', i));
  assert.match(body, /\(!dev \|\| \(st && st\.payable\)\) && !codeNamesChannels\(kept, codeChannelsNow\(/, 'checked in default mode without the host\'s reading');
});

// RV93 F2, the reviewer's test: web main's waitSettled lets a refusal of `settle_first` itself
// stand; payThrough asked it every 5 s for 3 h while the person's payment waited.
test('F2: settle_first that keeps failing (operator not answering) is not polled for hours', async () => {
  let clock = 0, settles = 0;
  const io = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sync: async () => {},
    coins: async () => [],
    run: async (c) => {
      if (c === 'send') throw { kind: 'settle_first', asset: X, coins: ['r1'], message: 'm' };
      if (c === 'settle_first') { settles++; throw { kind: 'unreachable', message: 'the operator is not answering' }; }
      throw new Error('no command ' + c);
    },
  };
  let err = null;
  try { await payThrough('send', { asset: X }, io); } catch (e) { err = e; }
  assert.ok(settles <= 1, `settle_first was asked ${settles} times over ${Math.round(clock / 60000)} minutes of a person's payment`);
  assert.equal(err && err.kind, 'unreachable');
});

// F2: while it waits, the payment says how long, as the library read it, and past that time that it
// takes longer; the sentence when it gives up is the web wallet's own, imported.
test('F2: a payment waiting for its round says how long, in default mode\'s words', async () => {
  let clock = 1_000_000;
  const seen = [];
  let asks = 0;
  const io = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    sync: async () => {},
    coins: async () => [],
    waiting: (st) => seen.push(st && { ...st }),
    run: async (c) => {
      if (c === 'send') { if (asks === 0) throw { kind: 'settle_first', asset: X, coins: ['r1'], usual_in_seconds: 240, final_in_seconds: 480, waiting_for: 'round', message: 'm' }; return { result: 'paid' }; }
      if (c === 'settle_first') { asks++; return asks < 3 ? { ready: false, usual_in_seconds: 200, waiting_for: 'block' } : { ready: true }; }
      throw new Error('no command ' + c);
    },
  };
  assert.equal((await payThrough('send', { asset: X }, io)).result, 'paid');
  assert.equal(seen[0].why, 'settle');
  assert.equal(seen[0].finalBy, 1_000_000 + 240_000, 'the refusal\'s usual wait');
  assert.equal(seen.at(-1), null);
  const rel = { command: 'send', why: 'settle', finalBy: 1_000_000 + 240_000, since: 1_000_000 };
  assert.equal(releasingWords(rel, 1_000_000), DEFAULT_WORDS.goesThrough(4));
  assert.equal(releasingWords(rel, 1_000_000 + 200_000), DEFAULT_WORDS.goesThrough(1));
  assert.equal(releasingWords(rel, 1_000_000 + 240_000 + SETTLE_LATE_MS + 1), DEFAULT_WORDS.goesThroughLate);
  assert.equal(releasingWords({ command: 'send', why: 'channel', minutes: 6 }, 0), DEFAULT_WORDS.goesThrough(6), 'a channel closed: the operator\'s usual wait');
  assert.equal(releasingWords({ command: 'send', why: 'planned' }, 0), null);
  assert.equal(SETTLE_GAVE_UP, DEFAULT_WORDS.settleGaveUp);
  // The popup shows them while default mode's Send waits.
  const popup = read('popup/popup.js');
  assert.match(popup, /msg\.event === 'leafReleasing'\) lastReleasing = msg\.data/);
  assert.match(popup, /const tell = setInterval\(\(\) => \{ const w = sendWaitWords\(since\); if \(w\) st\.textContent = w; \}, 1000\);/);
});

// RV93 F3: developer mode's line names what the payment waits for.
test('F3: developer mode\'s waiting line by what it waits for', () => {
  const s = (x) => x.slice(0, 3);
  assert.match(developerReleasingLine({ command: 'send', why: 'settle', coins: ['abcdef'], finalBy: 0 }, s), /waits for 1 leaf\(s\) \(abc\) to settle first/);
  assert.match(developerReleasingLine({ command: 'send', why: 'channel', coins: ['chanel'] }, s), /side of 1 channel\(s\) \(cha\), closed into the next round/);
  assert.match(developerReleasingLine({ command: 'send', why: 'planned', coins: ['planed'] }, s), /1 planned leaf\(s\) \(pla\) are given up/);
  assert.equal(developerReleasingLine(null), '');
  assert.match(read('popup/popup.js'), /\$\('leafReleasing'\)\.textContent = developerReleasingLine\(rel, short\);/);
});
