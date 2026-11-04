// The testnet faucet, once per wallet, from the extension's own service worker code: a real
// sequentia-faucet (its node CLI a stand-in, so no coins move) behind a local front door, and
// background.js answering the popup's messages. Checks that a request carries the wallet's id
// (the abandon phrase's is the web wallet's vector), that the wallet reads what it has received,
// that a second request for the asset is refused in the faucet's words, and that BTC is asked of
// the address. No chain is needed.
//
//   FAUCET_DIR=/path/to/sequentia-faucet node test/regtest/faucet-once.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FAUCET_DIR = process.env.FAUCET_DIR;
if (!FAUCET_DIR) { console.log('SKIP: set FAUCET_DIR to a sequentia-faucet checkout'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ID0 = '0dc441add97a52d9e9f9254c6d6a7aaf530c1cca887a08d9b188cb3a6b196803';   // the web wallet's faucet-wallet.test.mjs
const log = (...a) => console.log('[faucet-once]', ...a);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-faucet-once-'));
const freePort = () => new Promise((ok) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

const cli = path.join(work, 'cli');
fs.writeFileSync(cli, '#!/bin/sh\ncase "$*" in *getbalance*) echo 0; exit 0;; esac\necho ' + 'cd'.repeat(32) + '\n', { mode: 0o755 });
const fport = await freePort();
const faucet = spawn(process.execPath, [path.join(FAUCET_DIR, 'server.js')], {
  env: { PATH: process.env.PATH, FAUCET_PORT: String(fport), FAUCET_CLI: cli, FAUCET_DATADIR: '/nowhere', FAUCET_LEDGER: path.join(work, 'claims.jsonl') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.on('exit', () => { faucet.kill(); fs.rmSync(work, { recursive: true, force: true }); });
await new Promise((ok, no) => { faucet.stdout.on('data', (d) => { if (String(d).includes('listening')) ok(); }); faucet.once('exit', (c) => no(new Error('the faucet exited ' + c))); });

// The site's front door: /faucet to the faucet, with the client's address forwarded.
const posted = [];
const door = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!(u.pathname === '/faucet' || u.pathname.startsWith('/faucet/'))) { res.writeHead(404); res.end('{}'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST') posted.push(JSON.parse(body));
    const up = http.request({ host: '127.0.0.1', port: fport, method: req.method, path: (u.pathname.slice(7) || '/') + u.search,
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.' + (posted.length + 1) } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.end(body);
  });
});
const dport = await freePort();
await new Promise((ok) => door.listen(dport, '127.0.0.1', ok));

register(pathToFileURL(path.join(ROOT, 'test/regtest/loader.mjs')).href, {
  data: { base: `http://127.0.0.1:${dport}`, t4: 'http://127.0.0.1:9/', recordsV2Height: null },
});
await import(pathToFileURL(path.join(ROOT, 'test/regtest/sw-stubs.mjs')).href);
const lwk = await import(pathToFileURL(path.join(ROOT, 'pkg/lwk_wasm.js')).href);
lwk.initSync({ module: fs.readFileSync(path.join(ROOT, 'pkg/lwk_wasm_bg.wasm')) });
const engine = await import(pathToFileURL(path.join(ROOT, 'src/engine.js')).href);
await import(pathToFileURL(path.join(ROOT, 'background.js')).href);
const ui = globalThis.__sw.ui;
await engine.openFromPhrase(MNEMONIC);

assert.deepEqual(await ui('default.faucetReceived', {}), { claimed: [] });
log('a fresh wallet has received nothing');
const paid = await ui('default.faucet', { asset: 'USDX' });
assert.equal(paid.text, 'Received 500,000 USDX.');
assert.equal(posted[0].wallet, ID0, 'the wallet\'s id, the same as the web wallet\'s');
assert.equal(posted[0].address, 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl');
log('USDX paid, the request named the wallet', posted[0].wallet);
assert.deepEqual(await ui('default.faucetReceived', {}), { claimed: ['USDX'] });
log('the wallet reads that it has received USDX');
let err = null;
try { await ui('default.faucet', { asset: 'USDX' }); } catch (e) { err = e; }
assert.equal(err && err.message, 'This wallet has already received its USDX from the faucet. The faucet pays each asset once per wallet. To get more, trade for it in the wallet.');
log('a second USDX request is refused:', err.message);
const btc = await ui('default.faucet', { asset: 'BTC' }).catch((e) => e);
assert.equal(posted.at(-1).asset, 'BTC');
assert.equal(posted.at(-1).wallet, ID0);
assert.equal(posted.at(-1).request, undefined, 'BTC is asked of the address, not a receive request');
assert.equal(btc.message, 'This faucet does not pay BTC.', 'the faucet here has no Bitcoin side, so it says so');
log('BTC is asked of the address, with the id');
console.log('all passed');
door.close();
process.exit(0);
