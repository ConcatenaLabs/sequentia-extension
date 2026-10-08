import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every module the extension loads must at least parse as an ES module. A
// duplicate top-level declaration is a SyntaxError that Chrome reports only in
// the service worker's console, which nothing else here exercises: the unit
// tests import the pure modules, never the engine. `node --check` parses a file
// without running it, but only treats it as ESM under an .mjs name, hence the
// temporary copies.
const root = new URL('..', import.meta.url).pathname;
const modules = [
  'background.js', 'offscreen.js', 'offscreen-boot.js', 'offscreen-leaves.js', 'leaves/worker.js',
  ...readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => 'src/' + f),
];

test('every extension module parses as an ES module', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seqext-parse-'));
  for (const m of modules) {
    const copy = join(dir, m.replace(/\//g, '__') + '.mjs');
    writeFileSync(copy, readFileSync(join(root, m)));
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', copy], { stdio: 'pipe' }),
      m + ' does not parse',
    );
  }
});

// Parsing each file alone misses an import of a name the target module does not
// export, typically a kit function the committed pkg/ build predates. That too
// kills the service worker before it registers a listener, so the popup never
// gets past "Loading…". Linking the graph from each entry point catches it.
test('every import in the extension resolves to an export', () => {
  const entries = ['background.js', 'offscreen.js', 'popup/popup.js', 'approval/approval.js', 'leaves/worker.js'];
  try {
    execFileSync(process.execPath,
      ['--experimental-vm-modules', '--no-warnings', join(root, 'test/helpers/link-check.mjs'), root, ...entries],
      { stdio: 'pipe' });
  } catch (e) {
    assert.fail('unresolved imports:\n' + e.stdout.toString());
  }
});
