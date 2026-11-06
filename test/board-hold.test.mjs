// A coin paid to the wallet's address shows in its figure from the moment the wallet's reading of
// the chain holds it and stays there while the leaf wallet boards it, and a payment to an address
// says only what the library did (sequentia-web-wallet#574).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onchainLessBoards, boardSpent } from '../vendor/default-arca.js';

const src = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a coin that reaches the address after a board never vanishes from the figure', () => {
  const t = 1_800_000_000_000;
  const TX = 'cd'.repeat(32);
  // 1 OILX boarded whole, fee included; then a second 1 OILX reaches the address, and the next
  // reading holds the board and the new coin at once.
  const rec = boardSpent(100_000_000n, 100_000_000n, t, TX);
  assert.deepEqual(onchainLessBoards(rec, 100_000_000n, t + 60_000, (x) => x === TX), { atoms: 100_000_000n, seen: true });
  // Before the reading holds the board, the new coin is counted beside what the board left.
  assert.deepEqual(onchainLessBoards(rec, 200_000_000n, t + 30_000, () => false), { atoms: 100_000_000n, seen: false });
});

test('the board names its transaction, and the figure asks the wallet\'s own reading for it', () => {
  assert.match(src('offscreen-leaves.js'), /boardSpent\(c\.onchain, v\.spent, Date\.now\(\), v\.txid\)/);
  assert.match(src('background.js'), /leaves\.onchainLess\(h, bal\.seq\[h\], engine\.seqTxHeld\)/);
  assert.match(src('src/leaves.js'), /onchainLessBoards\(rec, atoms, Date\.now\(\), holds\)/);
});

test('the same payment to an address asked again while the first is on its way is never said to be sent twice', () => {
  assert.match(src('src/default-mode.js'), /offboardOutcome\(v, p\.amt, p\.ticker, p\.minutes, p\.block\)\.text/);
});
