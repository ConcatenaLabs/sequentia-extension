// The issuer's side of a SeqPal offering, from SeqPal's own issuer page, signed
// by the extension's contract engine. SeqPal's regtest drive
// (scripts/regtest-escrow.sh, seqpald/regtest_escrow_test.go) runs the chain,
// seqpald serving its built page, the subscribers and the close, and calls this
// for the two steps that are the issuer's wallet's:
//
//   open     on the issuance page, "Use this browser wallet's contract key" fills
//            the release key, the minimum and the close are typed, the terms are
//            shown, and "Sign the terms in this browser's wallet" signs them
//            with the contract key (signContractStatement), which opens the
//            escrow. Prints {"release_key": ...}.
//   release  on the same page, "Sign in this browser's wallet" hands the built
//            release to the kit's engine, which rebuilds it from the escrow's
//            template and every coin's instance; the approval page is rendered
//            and its five points read from the DOM; Approve signs; the page sends
//            the signed transaction to seqpald, which verifies every signature
//            and broadcasts. Prints {"txid": ...}.
//
// The extension's real provider router runs here with its service worker's own
// code; the page runs in headless Chromium with `window.sequentia` bridged to
// it, and the approval page (approval/approval.html) in a second tab.
//
//   SEQPAL_URL=http://127.0.0.1:port SEQPAL_SESSION=<cookie> SEQPAL_ISSUANCE=<id>
//   NODE_RPC_URL=http://127.0.0.1:port NODE_RPC_AUTH=user:pass CHROME=/path/to/chrome
//   [MINIMUM=<USDX> CLOSE=<height>] node test/regtest/seqpal-issuer.mjs open|release [evidence-dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rpcCall, startEsploraShim } from './esplora-shim.mjs';

const MODE = process.argv[2];
const EVIDENCE = process.argv[3] || null;
const { SEQPAL_URL, SEQPAL_SESSION, SEQPAL_ISSUANCE, NODE_RPC_URL, NODE_RPC_AUTH, CHROME } = process.env;
if (!['open', 'release'].includes(MODE) || !SEQPAL_URL || !SEQPAL_SESSION || !SEQPAL_ISSUANCE || !NODE_RPC_URL || !NODE_RPC_AUTH || !CHROME) {
  console.error('usage: SEQPAL_URL SEQPAL_SESSION SEQPAL_ISSUANCE NODE_RPC_URL NODE_RPC_AUTH CHROME node seqpal-issuer.mjs open|release [evidence-dir]');
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
// The issuer's wallet: a public test mnemonic, never funded anywhere but a local chain.
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean';
const say = (s) => { console.error('[seqpal-issuer ' + MODE + '] ' + s); if (EVIDENCE) fs.appendFileSync(path.join(EVIDENCE, 'seqpal-issuer.log'), '[' + MODE + '] ' + s + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const rpc = { url: NODE_RPC_URL.replace(/\/?$/, '/'), auth: NODE_RPC_AUTH };
const call = (m, p = []) => rpcCall(rpc, m, p);
let shim = null, ext = null, chrome = null, profile = null;
async function cleanup() {
  try { shim && shim.close && await shim.close(); } catch {}
  try { ext && ext.close(); } catch {}
  if (chrome) { chrome.kill(); await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r))); }
  for (let i = 0; profile && i < 40 && fs.existsSync(profile); i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); } }
}

// ---- a DevTools tab ----
async function tab(port, url) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let n = 0; const waits = new Map(); const errors = []; const bindings = new Map();
  ws.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.bindingCalled' && bindings.has(m.params.name)) bindings.get(m.params.name)(m.params.payload);
  };
  const send = (method, params = {}) => new Promise((ok, no) => { const i = ++n; waits.set(i, (m) => (m.error ? no(new Error(method + ': ' + m.error.message)) : ok(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  const page = {
    errors, send,
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; },
    async waitFor(expr, ms = 60000) { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await page.eval(expr); if (last) return last; } catch (e) { last = e.message; } await sleep(250); } throw new Error('waited for ' + expr + ': ' + JSON.stringify(last)); },
    async bind(name, fn) { bindings.set(name, fn); await send('Runtime.addBinding', { name }); },
    async init(source) { await send('Page.addScriptToEvaluateOnNewDocument', { source }); },
    async go(u) { await send('Page.navigate', { url: u }); },
    async shot(file) { if (!EVIDENCE) return; const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(path.join(EVIDENCE, file), Buffer.from(r.data, 'base64')); },
    close() { try { ws.close(); } catch {} },
  };
  if (url) await page.go(url);
  return page;
}

let failed = false;
let result = null;
try {
  const policy = (await call('getsidechaininfo')).pegged_asset;
  const genesis = await call('getblockhash', [0]);
  shim = await startEsploraShim({ rpc, port: await freePort() });
  register(pathToFileURL(path.join(ROOT, 'test/regtest/loader.mjs')).href, { data: { base: shim.url, t4: 'http://127.0.0.1:9/', policyAsset: policy, genesis, recordsV2Height: null } });
  await import(pathToFileURL(path.join(ROOT, 'test/regtest/sw-stubs.mjs')).href);
  const opened = [];
  globalThis.chrome.tabs.create = async ({ url }) => { opened.push(url); };
  const lwk = await import(pathToFileURL(path.join(ROOT, 'pkg/lwk_wasm.js')).href);
  lwk.initSync({ module: fs.readFileSync(path.join(ROOT, 'pkg/lwk_wasm_bg.wasm')) });
  const engine = await import(pathToFileURL(path.join(ROOT, 'src/engine.js')).href);
  await import(pathToFileURL(path.join(ROOT, 'background.js')).href);
  const router = await import(pathToFileURL(path.join(ROOT, 'src/provider-router.js')).href);
  const perms = await import(pathToFileURL(path.join(ROOT, 'src/permissions.js')).href);
  const vault = await import(pathToFileURL(path.join(ROOT, 'src/vault.js')).href);
  const ui = globalThis.__sw.ui;
  await vault.vaultCreate(MNEMONIC, 'regtest-only');
  await engine.openFromPhrase(MNEMONIC);
  const ORIGIN = new URL(SEQPAL_URL).origin;
  await perms.grant(ORIGIN);

  // The approval page, served from this checkout.
  ext = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const f = path.join(ROOT, p.replace(/^\/__ext\//, ''));
    if (!p.startsWith('/__ext/') || !f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  const extPort = await new Promise((r) => ext.listen(0, '127.0.0.1', () => r(ext.address().port)));

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-seqpal-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,2600', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const devPort = await new Promise((ok, no) => { let b = ''; chrome.stderr.on('data', (x) => { b += x; const m = b.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/); if (m) ok(m[1]); }); setTimeout(() => no(new Error('chrome did not start')), 20000); });
  const site = await tab(devPort);
  await site.send('Network.enable');
  await site.send('Network.setCookie', { name: 'seqpal_session', value: SEQPAL_SESSION, url: SEQPAL_URL });
  const calls = [];
  await site.bind('__seqBridge', async (payload) => {
    const { id, method, params } = JSON.parse(payload);
    calls.push(method);
    let reply;
    try { reply = { ok: true, value: await router.handleDappRequest(ORIGIN, method, params || {}) }; } catch (e) { reply = { ok: false, error: String(e.message || e) }; }
    await site.send('Runtime.evaluate', { expression: `window.__seqReply(${JSON.stringify(id)}, ${JSON.stringify(reply)})` });
  });
  await site.init(`(() => { let n = 0; const waits = new Map();
    window.__seqReply = (id, r) => { const w = waits.get(id); waits.delete(id); if (w) (r.ok ? w.ok(r.value) : w.no(new Error(r.error))); };
    window.sequentia = { isSequentia: true, on() {}, request: ({ method, params }) => new Promise((ok, no) => { const id = ++n; waits.set(id, { ok, no }); window.__seqBridge(JSON.stringify({ id, method, params })); }) };
    window.dispatchEvent(new Event('sequentia#initialized')); })();`);
  await site.go(`${SEQPAL_URL}/seqpal/issuance/${SEQPAL_ISSUANCE}`);

  let seen = 0;
  async function approve(label, wants) {
    for (let i = 0; i < 600 && opened.length <= seen; i++) await sleep(100);
    assert.ok(opened.length > seen, label + ': an approval opened');
    seen = opened.length;
    const id = new URL(opened.at(-1)).searchParams.get('id');
    const { approval } = await ui('approval.get', { id });
    const ap = await tab(devPort);
    const decided = [];
    await ap.bind('__decide', async (payload) => { const m = JSON.parse(payload); decided.push(m); await ui('approval.decide', m.params); });
    await ap.init(`window.chrome = { runtime: { lastError: null, sendMessage: (msg, cb) => {
      const a = ${JSON.stringify(approval)};
      if (msg.method === 'approval.get') return cb({ ok: true, result: { approval: a, unlocked: true } });
      if (msg.method === 'approval.decide') { window.__decide(JSON.stringify(msg)); return setTimeout(() => cb({ ok: true, result: {} }), 300); }
      cb({ ok: true, result: {} }); } }, tabs: { getCurrent() {} } }; window.close = () => {};`);
    await ap.go(`http://127.0.0.1:${extPort}/__ext/approval/approval.html?id=${id}`);
    const text = await ap.waitFor("(t => /Checked before signing|Domain tag/i.test(t) ? t : '')(document.body.innerText||'')", 20000);
    for (const w of wants) assert.ok(text.toLowerCase().includes(w.toLowerCase()), `${label}: the approval page shows "${w}"\n${text}`);
    await ap.shot(`seqpal-${label}-approval.png`);
    if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, `approval-seqpal-${label}.txt`), text);
    await ap.eval("document.getElementById('btnApprove').click()");
    for (let i = 0; i < 300 && !decided.length; i++) await sleep(100);
    assert.ok(decided.length, label + ': decided on the page');
    // A spend's approval signs the digest of what it showed; a statement's shows the statement itself.
    if (approval.display.digest) assert.equal(decided[0].params.shown, approval.display.digest, label + ': decided with the digest shown');
    ap.close();
    say(`${label}: the approval page showed ${wants.length} expected lines and was approved`);
    return approval;
  }
  const setInput = (id, v) => site.eval(`(() => { const i = document.getElementById('${id}'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(String(v))}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const escrow = async () => (await (await fetch(`${SEQPAL_URL}/seqpal/api/issuances/${SEQPAL_ISSUANCE}/escrow`, { headers: { cookie: 'seqpal_session=' + SEQPAL_SESSION } })).json());

  if (MODE === 'open') {
    const key = engine.getSigner().xonlyPublicKeyAt('m/8383h/1h/0h/0/0');
    await site.waitFor("document.querySelector('[data-use-wallet-key]') !== null", 60000);
    await site.eval("document.querySelector('[data-use-wallet-key]').click()");
    const shown = await site.waitFor("document.getElementById('esc-key').value", 30000);
    assert.equal(shown, key, 'the page filled the wallet\'s contract key');
    await setInput('esc-min', process.env.MINIMUM || '250');
    await setInput('esc-close', process.env.CLOSE);
    await site.eval("[...document.querySelectorAll('button')].find((b) => b.innerText.includes('Show the terms to sign')).click()");
    await site.waitFor("document.querySelector('[data-sign-terms-in-wallet]') !== null", 30000);
    await site.shot('seqpal-open-escrow-form.png');
    await site.eval("document.querySelector('[data-sign-terms-in-wallet]').click()");
    await approve('terms', ['Sign a statement with your contract key?', 'Domain tag', 'seqpal-escrow-terms-v1', 'It moves no coin']);
    let e;
    for (let i = 0; i < 120 && !((e = await escrow()).escrow); i++) await sleep(250);
    assert.ok(e.escrow, 'the escrow opened');
    assert.equal(e.escrow.release_key, key);
    say(`escrow opened with release key ${key}, the wallet's contract key`);
    result = { release_key: key };
  } else {
    await site.waitFor("document.querySelector('[data-sign-in-wallet]') !== null", 90000);
    await site.shot('seqpal-release-panel.png');
    const before = await escrow();
    const rel = (before.spends || []).find((s) => s.kind === 'release' && s.state === 'built');
    assert.ok(rel, 'a built release');
    await site.eval("document.querySelector('[data-sign-in-wallet]').click()");
    const n = rel.inputs ? rel.inputs.length : (rel.to_sign || []).length;
    const idx = JSON.stringify([...Array(n).keys()]).replace(/,/g, ', ');
    await approve('release', ['Sign this contract spend?', 'sequentia/subscription-escrow', 'release (tapscript leaf release)', '1. Known template', '2. Output recomputed',
      'derived from its own instance', '3. Program run', '4. Shown', 'it signs digest', '5. Contract key', 'ISSUER_KEY is this wallet\'s contract key',
      `it signs inputs ${idx}`, 'another coin of this template', 'checked against the chain', 'Network fee']);
    let s;
    for (let i = 0; i < 240; i++) {
      s = ((await escrow()).spends || []).find((x) => x.id === rel.id);
      if (s && s.state === 'broadcast') break;
      await sleep(250);
    }
    assert.equal(s && s.state, 'broadcast', 'seqpald broadcast the release: ' + JSON.stringify(s && { state: s.state, error: s.error }));
    say(`release ${s.txid} over ${n} coins: signed by the wallet's engine, verified and broadcast by seqpald`);
    await site.shot('seqpal-release-broadcast.png');
    result = { txid: s.txid };
  }
  assert.deepEqual(site.errors, [], 'no page errors: ' + site.errors.join(' | '));
  say('provider methods the page called: ' + [...new Set(calls)].join(', '));
} catch (e) {
  console.error(e);
} finally {
  await cleanup();
}
if (result) { console.log(JSON.stringify(result)); process.exit(0); }
process.exit(1);
