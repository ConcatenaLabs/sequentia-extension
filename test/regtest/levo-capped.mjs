// A Pignus version 2 loan signed through the extension's contract engine, on a
// A capped sale's purchase signed through the extension's contract engine, on a
// private regtest chain, from Levo's own sale page. The real levod (Python, the
// levo checkout's levod/) runs against the chain and serves the real built page
// (web/dist); the sale is listed and locked with the real `bin/levo`. The page
// runs in headless Chromium, its `window.sequentia` bridged to the extension's
// real provider router running here with its service worker's own code. The
// page asks the wallet for its contract key (which is on the sale's allocation
// list), finds its cap, and asks levod for the purchase; the router hands the
// request to the kit's engine; the approval page (approval/approval.html, its
// real approval.js) is rendered in a second tab, the five points are read from
// its DOM, and Approve is clicked. The purchase confirms and levod follows the
// sale to its next address. A second purchase fills the cap exactly.
//
// Refused: a purchase one atom past the cap, by the engine before any approval
// opens (and by levod when asked for it); the chain's refusal of an over-cap
// purchase forced into a block is SWK's tests/sale_escrow_regtest.rs.
//
//   SEQUENTIAD=/path/to/sequentiad LEVO=/path/to/levo CHROME=/path/to/chrome \
//     node test/regtest/levo-capped.mjs [evidence-dir]
//
// LEVO is a levo checkout with web/dist built (npm --prefix web run build).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rpcCall, startEsploraShim } from './esplora-shim.mjs';

const EXE = process.env.SEQUENTIAD;
const CHROME = process.env.CHROME;
if (!EXE || !CHROME) { console.log('SKIP: set SEQUENTIAD to a sequentiad binary and CHROME to a Chromium'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEVO = path.resolve(process.env.LEVO || path.join(ROOT, '../levo'));
if (!fs.existsSync(path.join(LEVO, 'web/dist/index.html')) || !fs.existsSync(path.join(LEVO, 'levod/server.py'))) {
  console.error('set LEVO to a levo checkout with web/dist built: ' + LEVO); process.exit(1);
}
const CLI = path.join(path.dirname(EXE), 'sequentia-cli');
const EVIDENCE = process.argv[2] || null;
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-levo-capped-'));

// A public test mnemonic, never funded anywhere but a local chain.
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean';
const COIN = 100000000;
const lines = [];
const say = (s) => { console.log('[levo-capped] ' + s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// The parent chain: the kit reads Sequentia's anchored block headers, so the chain is
// anchored to a regtest parent, run by the same binary in Bitcoin mode.
const parentPort = await freePort();
fs.mkdirSync(path.join(WORK, 'parent'));
const parentNode = spawn(EXE, [`-datadir=${path.join(WORK, 'parent')}`, '-chain=regtest', `-rpcport=${parentPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
  '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-disablewallet'], { stdio: 'ignore' });
const pcall = (m, p = []) => rpcCall({ url: `http://127.0.0.1:${parentPort}/`, auth: 'u:p' }, m, p);
for (let i = 0; ; i++) { try { await pcall('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
await pcall('generatetodescriptor', [5, (await pcall('getdescriptorinfo', ['raw(51)'])).descriptor]);
const rpcPort = await freePort();
const NODE = path.join(WORK, 'node');
fs.mkdirSync(NODE);
// The command line's settings, as bin/levo's sequentia-cli reads them.
fs.writeFileSync(path.join(NODE, 'elements.conf'), `chain=elementsregtest\n[elementsregtest]\nrpcport=${rpcPort}\nrpcuser=u\nrpcpassword=p\n`);
const node = spawn(EXE, [`-datadir=${NODE}`, '-chain=elementsregtest', '-con_bitcoin_anchor=1', '-validateanchor=1', '-mainchainrpchost=127.0.0.1',
  `-mainchainrpcport=${parentPort}`, '-mainchainrpcuser=u', '-mainchainrpcpassword=p', '-parentgenesisblockhash=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
  '-anchorpollinterval=1', '-anchorminconf=1', `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
  '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-txindex=1', '-par=1', '-evbparams=simplicity:-1:::', '-initialfreecoins=2100000000000000',
  '-anyonecanspendaremine=1', '-blindedaddresses=0', '-con_default_blinded_addresses=0', '-validatepegin=0', '-con_parent_chain_signblockscript=51',
  '-con_any_asset_fees=1', '-fallbackfee=0.0001', '-maxtxfee=100'], { stdio: 'ignore' });
const rpc = { url: `http://127.0.0.1:${rpcPort}/`, auth: 'u:p' };
const call = (m, p = []) => rpcCall(rpc, m, p);
const wcall = (m, p = []) => rpcCall({ ...rpc, url: rpc.url + 'wallet/levo' }, m, p);
let shim = null, front = null, chrome = null, profile = null, levod = null;
async function cleanup() {
  try { shim && shim.close && await shim.close(); } catch {}
  try { front && front.close(); } catch {}
  if (levod && levod.exitCode === null) { levod.kill('SIGTERM'); await new Promise((r) => (levod.exitCode !== null ? r() : levod.once('exit', r))); }
  if (chrome) { chrome.kill(); await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r))); }
  for (let i = 0; profile && i < 40 && fs.existsSync(profile); i++) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); } }
  try { await call('stop'); } catch {}
  if (node.exitCode == null) await new Promise((r) => node.once('exit', r));
  try { await pcall('stop'); } catch {}
  if (parentNode.exitCode == null) await new Promise((r) => parentNode.once('exit', r));
  fs.rmSync(WORK, { recursive: true, force: true });
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
try {
  for (let i = 0; ; i++) { try { await call('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
  await sleep(2000);   // the anchor watcher's first look at the parent
  await call('createwallet', ['levo']);
  const mine = async (n) => call('generatetoaddress', [n, await wcall('getnewaddress')]);
  await mine(101); await wcall('rescanblockchain');
  const policy = (await call('getsidechaininfo')).pegged_asset;
  const genesis = await call('getblockhash', [0]);
  const issue = async (n) => { const a = (await wcall('issueasset', { assetamount: n, tokenamount: 0, blind: false, fee_asset: 'bitcoin' })).asset; await mine(1); return a; };
  const PAY = await issue(1000000), TOKEN = await issue(100000);
  // The fee whitelist: the asset the sale is paid in is accepted, so a buyer's fee is paid in it.
  const rates = await call('getfeeexchangerates'); rates[PAY] = COIN;
  await call('setfeeexchangerates', [rates]);
  say(`chain: PAY ${PAY.slice(0, 12)}… (fees accepted), TOKEN ${TOKEN.slice(0, 12)}…`);

  // The extension, in this process, with its service worker's own code.
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
  const contractKey = engine.getSigner().xonlyPublicKeyAt('m/8383h/1h/0h/0/0');
  const me = engine.currentAddress(false).address;
  // The buyer's money: PAY at its own address, nothing of the policy asset.
  for (const n of [40, 300]) await wcall('sendtoaddress', { address: me, amount: n, assetlabel: PAY, fee_asset_label: 'bitcoin' });
  await mine(1);
  await engine.sync();
  const held = JSON.parse(lwk.ContractSpend.walletCoins(engine.getWollet()));
  say(`wallet ${me}: contract key ${contractKey}; ${held.length} coins, all PAY: ${held.every((c) => c.asset === PAY)}`);

  // levod, the real server, against this chain, serving the built page.
  const levodPort = await freePort();
  const levodLog = fs.openSync(path.join(WORK, 'levod.log'), 'w');
  levod = spawn('python3', [path.join(LEVO, 'levod/server.py')], {
    stdio: ['ignore', levodLog, levodLog],
    env: { ...process.env, LEVOD_PORT: String(levodPort), LEVOD_HOST: '127.0.0.1', LEVOD_STATE: path.join(WORK, 'state.json'),
      LEVOD_SECRET: 'regtest-only', LEVOD_RPC_URL: rpc.url, LEVOD_RPC_USER: 'u', LEVOD_RPC_PASSWORD: 'p',
      LEVOD_PAYMENT_ASSET: PAY, LEVOD_PAYMENT_LABEL: 'PAY', LEVOD_HRP: 'ert', LEVOD_WATCH_SECONDS: '2', LEVOD_CHAIN_TTL: '0',
      LEVOD_TIERS: JSON.stringify([{ name: 'Everyone', min_stake: 0, cap: 1000000, may_list: true }]) },
  });
  const LEVOD = `http://127.0.0.1:${levodPort}`;
  for (let i = 0; ; i++) { try { if ((await fetch(LEVOD + '/api/health')).ok) break; } catch {} if (i > 120) throw new Error('levod did not start: ' + fs.readFileSync(path.join(WORK, 'levod.log'), 'utf8').slice(-2000)); await sleep(250); }

  // The listing, through bin/levo, with the extension's contract key on the list.
  const levoEnv = { ...process.env, LEVO_URL: LEVOD, SEQUENTIA_CLI: CLI, SEQUENTIA_DATADIR: NODE, SEQUENTIA_WALLET: 'levo', LEVO_SESSION: path.join(WORK, 'session.json') };
  const levo = (...args) => execFileSync('python3', [path.join(LEVO, 'bin/levo'), ...args], { env: levoEnv, encoding: 'utf8', timeout: 240000 });
  const keys = JSON.parse(levo('keygen'));
  const other = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const CAP = 300 * COIN;
  const spec = { project: { slug: 'capped', name: 'Capped Sale', ticker: 'CAP', decimals: 8, summary: 'A sale whose caps are in its address.',
    description: 'Bought from a browser wallet, within its cap.' },
  terms: { token_asset: TOKEN, price_num: 1, price_den: 4, min_lot: 10 * COIN, total_atoms: 1000 * COIN,
    close_locktime: (await call('getblockcount')) + 400, treasury_address: await wcall('getnewaddress', ['', 'bech32']),
    reclaim_xonly: keys.reclaim_xonly,
    allocations: [{ key: other, cap_atoms: String(500 * COIN) }, { key: contractKey, cap_atoms: String(CAP) }] } };
  fs.writeFileSync(path.join(WORK, 'listing.json'), JSON.stringify(spec));
  say('levo create: ' + levo('create', path.join(WORK, 'listing.json')).trim().split('\n').pop());
  say('levo lock: ' + levo('lock', 'capped').trim().split('\n').pop());
  await mine(1);
  const detail = async () => (await (await fetch(LEVOD + '/api/projects/capped')).json()).sale;
  for (let i = 0; (await detail()).status !== 'live'; i++) { if (i > 80) throw new Error('the sale did not go live'); await sleep(250); }
  const first = await detail();
  say(`sale live at ${first.script_pubkey.slice(0, 20)}…, ${first.locked_atoms} atoms locked, caps enforced by ${first.capped.enforced_by}`);

  // The front: levod's page and API, and the extension's approval page beside them.
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  front = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/__ext/')) {
      const f = path.join(ROOT, p.slice('/__ext/'.length));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); return res.end(fs.readFileSync(f));
    }
    const up = http.request(LEVOD + req.url, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${levodPort}` } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(up);
  });
  const frontPort = await new Promise((r) => front.listen(0, '127.0.0.1', () => r(front.address().port)));
  const ORIGIN = `http://127.0.0.1:${frontPort}`;
  await perms.grant(ORIGIN);

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-levo-chrome-'));
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=1280,2400', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const devPort = await new Promise((ok, no) => { let b = ''; chrome.stderr.on('data', (x) => { b += x; const m = b.match(/DevTools listening on ws:\/\/[^:]+:(\d+)/); if (m) ok(m[1]); }); setTimeout(() => no(new Error('chrome did not start')), 20000); });
  const site = await tab(devPort);
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
  await site.go(ORIGIN + '/p/capped');
  await site.waitFor("document.querySelector('[data-capped-wallet]') !== null", 60000);
  await site.shot('levo-capped-page.png');
  await site.eval("document.querySelector('[data-capped-wallet]').click()");
  const capText = await site.waitFor("(document.querySelector('[data-capped-cap]')||{}).innerText||''", 30000);
  say('the sale page, with the wallet\'s key: "' + capText.trim() + '"');

  // The approval page for the newest approval the worker opened: rendered, read, and
  // decided by clicking, through the worker's own UI message.
  let seen = 0;
  async function approvalScreen(label) {
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
    await ap.go(`${ORIGIN}/__ext/approval/approval.html?id=${id}`);
    // Read once the page has rendered the request, not its empty frame.
    let text;
    try {
      text = await ap.waitFor("(t => /Checked before signing|Domain tag/i.test(t) ? t : '')(document.body.innerText||'')", 20000);
    } catch (e) {
      throw new Error(label + ': the approval page did not render: ' + JSON.stringify({ errors: ap.errors, body: await ap.eval('document.body.innerText').catch((x) => String(x)) }).slice(0, 3000));
    }
    return { id, approval, ap, text, decided };
  }
  const FIVE = ['Sign this contract spend?', 'sequentia/capped-sale', '1. Known template', '2. Output recomputed', '3. Program run', 'ran against the final transaction',
    '4. Shown', 'it signs digest', '5. Contract key', 'BUYER_KEY is this wallet\'s contract key', 'over this purchase and no other',
    'What this capped purchase does', 'this wallet\'s contract key)', 'to the sale\'s treasury at output 0', 'What it spends', 'this wallet\'s coin', 'Your balance change', 'Network fee'];
  async function buy(label, tokens) {
    const before = (await call('getrawmempool')).length;
    await site.eval(`(() => { const i = document.getElementById('capped-qty'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '${tokens}'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await site.eval("document.querySelector('[data-capped-buy]').click()");
    const scr = await approvalScreen(label);
    for (const want of FIVE) assert.ok(scr.text.toLowerCase().includes(want.toLowerCase()), `${label}: the approval page shows "${want}"\n${scr.text}`);
    await scr.ap.shot(`levo-${label.replace(/\W+/g, '-')}-approval.png`);
    if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, `approval-${label.replace(/\W+/g, '-')}.txt`), scr.text);
    await scr.ap.eval("document.getElementById('btnApprove').click()");
    for (let i = 0; i < 300 && !scr.decided.length; i++) await sleep(100);
    assert.equal(scr.decided[0].params.shown, scr.approval.display.digest, label + ': the page decided with the digest it showed');
    const txid = await site.waitFor("(document.querySelector('[data-capped-sent]')||{dataset:{}}).dataset.cappedSent", 120000);
    assert.equal((await call('getrawmempool')).length, before + 1);
    await mine(1);
    const conf = await call('getrawtransaction', [txid, true]);
    assert.ok(conf.confirmations >= 1);
    say(`${label}: approved on the approval page (digest ${scr.approval.display.digest.slice(0, 16)}…), ${txid} confirmed, ${conf.vsize} vB, fee in ${conf.vout.find((o) => o.scriptPubKey.hex === '' || o.scriptPubKey.type === 'fee')?.asset === PAY ? 'PAY' : 'another asset'}`);
    scr.ap.close();
    return conf;
  }

  // ---- 200 of the 300 the key may buy ----
  const p1 = await buy('purchase-200', '200');
  assert.equal(p1.vout[1].scriptPubKey.hex !== first.script_pubkey, true, 'the rest moved to the next state');
  for (let i = 0; ; i++) {
    const s = await detail();
    const a = s.capped.allocations.find((x) => x.key === contractKey);
    if (a && BigInt(a.bought_atoms) === 200n * BigInt(COIN)) { say(`levod followed the sale to ${s.script_pubkey.slice(0, 20)}…: this key has bought ${a.bought_atoms} of ${a.cap_atoms}`); break; }
    if (i > 120) throw new Error('levod did not follow the purchase'); await sleep(250);
  }
  await engine.sync();
  await site.go(ORIGIN + '/p/capped');
  await site.waitFor("document.querySelector('[data-capped-wallet]') !== null", 60000);
  await site.eval("document.querySelector('[data-capped-wallet]').click()");
  await site.waitFor("((document.querySelector('[data-capped-cap]')||{}).innerText||'').includes('100')", 30000);

  // ---- refused: one atom past the cap, by levod and by the engine ----
  const body = { buyer_key: contractKey, token_atoms: String(100 * COIN + 1), token_address: me };
  const r = await fetch(LEVOD + '/api/projects/capped/wallet-purchase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const rj = await r.json();
  assert.equal(r.status, 409); say(`levod, asked for one atom past the cap: ${r.status} "${rj.error}"`);
  const ok = await (await fetch(LEVOD + '/api/projects/capped/wallet-purchase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, token_atoms: String(100 * COIN) }) })).json();
  const over = JSON.parse(JSON.stringify(ok));
  over.request.spender.AMOUNT = (100n * BigInt(COIN) + 1n).toString(16).padStart(16, '0');
  const beforeOpened = opened.length;
  await assert.rejects(router.handleDappRequest(ORIGIN, 'signContractSpend', { templateHash: over.templateHash, instance: over.instance, request: over.request, fund: true }),
    (e) => { assert.ok(e.message.includes('past its cap'), e.message); say(`the engine, given AMOUNT one atom past the cap: refused before any approval: ${e.message}`); return true; });
  assert.equal(opened.length, beforeOpened, 'no approval opened');

  // ---- the rest of the cap, exactly ----
  await buy('purchase-fills-the-cap', '100');
  for (let i = 0; ; i++) {
    const s = await detail();
    const a = s.capped.allocations.find((x) => x.key === contractKey);
    if (a && a.bought_atoms === a.cap_atoms) { say(`levod: this key has bought ${a.bought_atoms} of its cap of ${a.cap_atoms}`); break; }
    if (i > 120) throw new Error('levod did not follow the second purchase'); await sleep(250);
  }
  await site.shot('levo-capped-after.png');
  assert.deepEqual(site.errors, [], 'no page errors: ' + site.errors.join(' | '));
  say('provider methods the page called: ' + [...new Set(calls)].join(', '));
} catch (e) {
  failed = true; console.error(e);
  try { console.error(fs.readFileSync(path.join(WORK, 'levod.log'), 'utf8').slice(-3000)); } catch {}
} finally {
  if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'levo-capped.log'), lines.join('\n') + '\n');
  await cleanup();
}
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
