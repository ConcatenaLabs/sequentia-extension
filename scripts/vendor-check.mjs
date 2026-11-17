#!/usr/bin/env node
// The files this repository copies from the web wallet must stay byte-for-byte
// the web wallet's: a fix lands there and is copied here, never forked here.
// This compares every copied file with the web wallet's main branch and exits 1
// naming each one that differs.
//
//   node scripts/vendor-check.mjs              compare with GitHub's main
//   node scripts/vendor-check.mjs --sync       and copy the web wallet's version
//   node scripts/vendor-check.mjs --from DIR   use a web wallet checkout instead
//
// The copied set is everything under vendor/ (vendor/ mirrors the web wallet's
// root), and btc-ark/ and leaves/ (worker and pkg), which keep their paths.
// `popup/picker.css` and `src/pair.js` are extracts, not copies, and are not
// checked. Against GitHub the comparison uses a clone without file contents:
// git's blob ids are content hashes, so equal ids are equal bytes.
//
// A copied module's relative imports are copied with it: a file a vendored module
// imports and vendor/ lacks is reported ("imported but not copied"), and --sync
// copies it from the web wallet, and what it imports in turn. A sync copies only
// files already here otherwise, so a module that gained an import would arrive
// without it and fail to load.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export const UPSTREAM = 'https://github.com/ConcatenaLabs/sequentia-web-wallet.git';
const root = new URL('..', import.meta.url).pathname;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// [local path, web wallet path], both relative.
export function copiedFiles() {
  const pairs = [];
  for (const p of walk(join(root, 'vendor'))) {
    const rel = relative(root, p);
    pairs.push([rel, relative('vendor', rel)]);
  }
  for (const top of ['btc-ark', 'leaves']) {
    for (const p of walk(join(root, top))) {
      const rel = relative(root, p);
      pairs.push([rel, rel]);
    }
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]));
}

// The relative module specifiers a source file imports: static imports, re-exports
// and dynamic import() of a string literal.
export function relativeImports(src) {
  const out = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const m of src.matchAll(re)) out.add(m[2]);
  return [...out];
}

// The files under vendor/ that a vendored module imports and that are missing:
// [{ local, up, by }], paths relative to the repository root and to the web wallet's.
export function missingImports() {
  const vendorDir = join(root, 'vendor');
  const out = new Map();
  for (const p of walk(vendorDir)) {
    if (!/\.m?js$/.test(p)) continue;
    for (const spec of relativeImports(readFileSync(p, 'utf8'))) {
      const target = join(dirname(p), spec.split(/[?#]/)[0]);
      const rel = relative(vendorDir, target);
      if (rel.startsWith('..') || existsSync(target)) continue;
      const local = relative(root, target);
      if (!out.has(local)) out.set(local, { local, up: rel, by: relative(root, p) });
    }
  }
  return [...out.values()];
}

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// Compare against a blobless clone of the upstream's default branch.
export function checkAgainstGitHub({ sync = false, url = UPSTREAM } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'ambra-vendor-'));
  try {
    git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', url, tmp]);
    const commit = git(['-C', tmp, 'rev-parse', 'HEAD']).trim();
    const tree = new Map();
    for (const line of git(['-C', tmp, 'ls-tree', '-r', 'HEAD']).split('\n')) {
      const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
      if (m) tree.set(m[2], m[1]);
    }
    const drift = [];
    for (const [local, up] of copiedFiles()) {
      const want = tree.get(up);
      if (!want) { drift.push({ local, up, why: 'not in the web wallet' }); continue; }
      const have = git(['hash-object', join(root, local)]).trim();
      if (have !== want) drift.push({ local, up, why: 'differs' });
    }
    if (sync) {
      const fix = drift.filter((d) => d.why === 'differs');
      if (fix.length) {
        git(['-C', tmp, 'checkout', '-q', 'HEAD', '--', ...fix.map((d) => d.up)]);
        for (const d of fix) copyFileSync(join(tmp, d.up), join(root, d.local));
      }
    }
    for (let round = 0; round < 20; round++) {
      const missing = missingImports();
      if (!missing.length) break;
      const known = missing.filter((m) => tree.has(m.up));
      for (const m of missing) drift.push({ local: m.local, up: m.up, why: tree.has(m.up) ? 'imported but not copied' : 'imported but not in the web wallet', by: m.by });
      if (!sync || !known.length) break;
      git(['-C', tmp, 'checkout', '-q', 'HEAD', '--', ...known.map((m) => m.up)]);
      for (const m of known) { mkdirSync(dirname(join(root, m.local)), { recursive: true }); copyFileSync(join(tmp, m.up), join(root, m.local)); }
    }
    return { commit, drift };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Compare against the working tree of a web wallet checkout.
export function checkAgainstDir(dir, { sync = false } = {}) {
  const drift = [];
  for (const [local, up] of copiedFiles()) {
    const src = join(dir, up);
    if (!existsSync(src)) { drift.push({ local, up, why: 'not in the web wallet' }); continue; }
    if (!readFileSync(src).equals(readFileSync(join(root, local)))) {
      drift.push({ local, up, why: 'differs' });
      if (sync) { mkdirSync(dirname(join(root, local)), { recursive: true }); copyFileSync(src, join(root, local)); }
    }
  }
  for (let round = 0; round < 20; round++) {
    const missing = missingImports();
    if (!missing.length) break;
    const known = missing.filter((m) => existsSync(join(dir, m.up)));
    for (const m of missing) drift.push({ local: m.local, up: m.up, why: existsSync(join(dir, m.up)) ? 'imported but not copied' : 'imported but not in the web wallet', by: m.by });
    if (!sync || !known.length) break;
    for (const m of known) { mkdirSync(dirname(join(root, m.local)), { recursive: true }); copyFileSync(join(dir, m.up), join(root, m.local)); }
  }
  let commit = '';
  try { commit = git(['-C', dir, 'rev-parse', 'HEAD']).trim(); } catch { /* not a git checkout */ }
  return { commit, drift };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const args = process.argv.slice(2);
  const sync = args.includes('--sync');
  const at = args.indexOf('--from');
  const from = at >= 0 ? args[at + 1] : process.env.WEB_WALLET_DIR;
  const { commit, drift } = from ? checkAgainstDir(from, { sync }) : checkAgainstGitHub({ sync });
  const where = from ? from : 'web wallet main';
  if (!drift.length) {
    console.log(`vendored files match ${where}${commit ? ' at ' + commit.slice(0, 8) : ''}`);
    process.exit(0);
  }
  for (const d of drift) console.log(`${d.why === 'differs' ? 'DRIFT' : d.why === 'imported but not copied' ? 'MISSING' : 'ORPHAN'} ${d.local} (${d.up}: ${d.why}${d.by ? ', by ' + d.by : ''})`);
  const differs = drift.filter((d) => d.why === 'differs' || d.why === 'imported but not copied').length;
  if (sync) console.log(`copied ${differs} file(s) from ${where}${commit ? ' at ' + commit.slice(0, 8) : ''}; run the tests`);
  else console.log(`${drift.length} vendored file(s) do not match ${where}${commit ? ' at ' + commit.slice(0, 8) : ''}; re-copy with --sync`);
  process.exit(sync && drift.every((d) => d.why === 'differs' || d.why === 'imported but not copied') ? 0 : 1);
}
