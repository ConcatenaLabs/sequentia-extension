import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgainstDir, checkAgainstGitHub } from '../scripts/vendor-check.mjs';

// The modules copied from the web wallet must be its main branch's, byte for
// byte: a copy that falls behind ships an older trade flow or Lightning client
// than the web wallet's, and nothing else notices. Set WEB_WALLET_DIR to compare
// with a checkout instead of GitHub. Without the network and without that
// variable the test is skipped, never passed.
test('vendored files match the web wallet main', (t) => {
  let res;
  if (process.env.WEB_WALLET_DIR) {
    res = checkAgainstDir(process.env.WEB_WALLET_DIR);
  } else {
    try {
      res = checkAgainstGitHub();
    } catch (e) {
      t.skip('the web wallet repository is unreachable: ' + String(e.stderr || e.message).trim().split('\n')[0]);
      return;
    }
  }
  const lines = res.drift.map((d) => `${d.local}: ${d.why}`);
  assert.deepEqual(lines, [], `out of date with the web wallet at ${res.commit.slice(0, 8)}; run node scripts/vendor-check.mjs --sync`);
});
