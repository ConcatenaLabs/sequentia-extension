import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingImports, relativeImports, checkAgainstDir } from '../scripts/vendor-check.mjs';

// Every module under vendor/ can load: each file a vendored module imports is
// vendored too. A sync copies only the files already here, so a web wallet module
// that gained an import (stake-records.js importing explorer-script-hash.js) would
// arrive without it and stop the service worker at load.
test('every relative import of a vendored module is vendored', () => {
  assert.deepEqual(missingImports().map((m) => `${m.local} (imported by ${m.by})`), []);
});

test('the specifiers a module imports', () => {
  assert.deepEqual(relativeImports(`import { a } from './a.js';\nexport * from "../b.js";\nimport './c.js';\nconst d = await import('./d.js');\nimport x from 'pkg';`).sort(),
    ['../b.js', './a.js', './c.js', './d.js']);
});

// A sync from a web wallet checkout copies a module's new import with it.
test('a sync brings the files a copied module now imports', () => {
  const web = mkdtempSync(join(tmpdir(), 'web-'));
  try {
    const up = readFileSync(new URL('../vendor/stake-records.js', import.meta.url), 'utf8');
    writeFileSync(join(web, 'stake-records.js'), `import { probe } from './vendor-sync-probe.js';\n${up}`);
    writeFileSync(join(web, 'vendor-sync-probe.js'), 'export const probe = 1;\n');
    const local = new URL('../vendor/stake-records.js', import.meta.url);
    const probe = new URL('../vendor/vendor-sync-probe.js', import.meta.url);
    const saved = readFileSync(local);
    try {
      checkAgainstDir(web, { sync: true });
      assert.ok(existsSync(probe), 'the new import was copied');
      assert.deepEqual(missingImports(), []);
    } finally {
      writeFileSync(local, saved);
      rmSync(probe, { force: true });
    }
  } finally {
    rmSync(web, { recursive: true, force: true });
  }
});
