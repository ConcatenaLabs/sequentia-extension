// A Pignus loan of three oracles with a threshold of two, signed through the
// extension's contract engine on a private regtest chain. The Pignus page (pignus
// web/, its real app.js and v2.js) runs in headless Chromium with its
// `window.sequentia` bridged to the extension's real provider router, running here
// with its service worker's own code. The page takes one lot of a 2-of-3 offer
// (`pignus/offer-threshold`), which opens a `pignus/vault-threshold`; then the price
// falls, oracles 1 and 3 sign the record alike, oracle 2 abstains, and the page's
// provider is asked to sign the liquidation: the vault, the two signers' beacon coins
// (each spent through its recreate leaf and recreated at output 2j), and the
// wallet's own coin for the repayment. Each approval page (approval/approval.html,
// its real approval.js) is rendered in a second tab from what the worker gave it,
// the five points are read from its DOM, and its Approve button is clicked. Each
// spend confirms at the node.
//
// Refused before any approval opens, with the engine's words: the liquidation with
// one signature (the program the engine runs refuses it).
//
// The oracles' keys, beacon scripts and signatures come from Pignus's vendored
// sequentia-oracle module (PIGNUS_WEB/../pignus/sequentia_oracle), run by python3.
//
//   SEQUENTIAD=/path/to/sequentiad PIGNUS_WEB=/path/to/pignus/web CHROME=/path/to/chrome \
//     node test/regtest/pignus-threshold.mjs [evidence-dir]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const WEB = path.resolve(process.env.PIGNUS_WEB || path.join(ROOT, '../pignus/web'));
if (!fs.existsSync(path.join(WEB, 'v2.js'))) { console.error('set PIGNUS_WEB to a pignus checkout\'s web/: ' + WEB); process.exit(1); }
const EVIDENCE = process.argv[2] || null;
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-pignus-threshold-'));

// A public test mnemonic, never funded anywhere but a local chain.
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean';
const COIN = 100000000;
const LOT = 10 * COIN, DEBT = 1050000000, COLLATERAL = 10 * COIN;
const lines = [];
const say = (s) => { console.log('[pignus-threshold] ' + s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const rev = (h) => Buffer.from(h, 'hex').reverse().toString('hex');
const sha = (h) => createHash('sha256').update(Buffer.from(h, 'hex')).digest('hex');
const hexw = (n, bytes) => BigInt(n).toString(16).padStart(bytes * 2, '0');

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
const node = spawn(EXE, [`-datadir=${WORK}`, '-chain=elementsregtest', '-con_bitcoin_anchor=1', '-validateanchor=1', '-mainchainrpchost=127.0.0.1',
  `-mainchainrpcport=${parentPort}`, '-mainchainrpcuser=u', '-mainchainrpcpassword=p', '-parentgenesisblockhash=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
  '-anchorpollinterval=1', '-anchorminconf=1', `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
  '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-txindex=1', '-par=1', '-evbparams=simplicity:-1:::', '-initialfreecoins=2100000000000000',
  '-anyonecanspendaremine=1', '-blindedaddresses=0', '-con_default_blinded_addresses=0', '-validatepegin=0', '-con_parent_chain_signblockscript=51',
  '-con_any_asset_fees=1', '-fallbackfee=0.0001', '-maxtxfee=100'], { stdio: 'ignore' });
const rpc = { url: `http://127.0.0.1:${rpcPort}/`, auth: 'u:p' };
const call = (m, p = []) => rpcCall(rpc, m, p);
const wcall = (m, p = []) => rpcCall({ ...rpc, url: rpc.url + 'wallet/lender' }, m, p);
let shim = null, book = null, chrome = null, profile = null;
async function cleanup() {
  try { shim && shim.close && await shim.close(); } catch {}
  try { book && book.close(); } catch {}
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
  await call('createwallet', ['lender']);
  const mine = async (n) => call('generatetoaddress', [n, await wcall('getnewaddress')]);
  await mine(101); await wcall('rescanblockchain');
  const policy = (await call('getsidechaininfo')).pegged_asset;
  const genesis = await call('getblockhash', [0]);
  const issue = async () => { const a = (await wcall('issueasset', { assetamount: 1000, tokenamount: 0, blind: false, fee_asset: 'bitcoin' })).asset; await mine(1); return a; };
  const X = await issue(), Y = await issue();
  const rates = await call('getfeeexchangerates'); rates[X] = COIN; rates[Y] = COIN;
  await call('setfeeexchangerates', [rates]);
  const t0 = (await call('getblockheader', [await call('getbestblockhash')])).time;
  await call('setmocktime', [t0 + 60]); await mine(12);
  const mtp = async () => (await call('getblockchaininfo')).mediantime;

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

  const outTo = async (txid, spk) => { const t = await call('getrawtransaction', [txid, true]); const o = t.vout.find((v) => v.scriptPubKey.hex === spk); return { txid, vout: o.n, amount: Math.round(o.value * 1e8) }; };

  // ---- three oracles, each with its beacon ----
  const ORACLE_PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
from pignus.sequentia_oracle import attestation as AF
cmd = sys.argv[2]
if cmd == "oracles":
    out = []
    for i in range(3):
        sk, nonce = bytes([7 + i]) * 32, bytes([20 + i]) * 32
        b = AF.BeaconScript(AF.xonly_pubkey(sk), nonce)
        out.append({"key": AF.xonly_pubkey(sk).hex(), "program": b.program.hex(), "spk": b.script_pubkey.hex(),
                    "witness": [b.leaf("recreate").hex(), b.control_block("recreate").hex()]})
    print(json.dumps(out))
else:
    i, base, quote, price, precision, time, program = sys.argv[3:10]
    a = AF.AttestationV2(AF.xonly_pubkey(bytes([7 + int(i)]) * 32), AF.asset_from_display(base),
                         AF.asset_from_display(quote), int(price), int(precision), int(time), bytes.fromhex(program))
    a.sign(bytes([7 + int(i)]) * 32)
    assert a.verify()
    print(a.signature.hex())
`;
  const PIGNUS_ROOT = path.resolve(WEB, '..');
  const { execFileSync } = await import('node:child_process');
  const py = (...args) => execFileSync('python3', ['-I', '-c', ORACLE_PY, PIGNUS_ROOT, ...args.map(String)], { encoding: 'utf8' }).trim();
  const oracles = JSON.parse(py('oracles'));
  for (const o of oracles) {
    o.asset = (await wcall('issueasset', { assetamount: 0.00000002, tokenamount: 0, blind: false, fee_asset: 'bitcoin' })).asset;
    await mine(1);
    const addr = (await call('decodescript', [o.spk])).address || (await call('decodescript', [o.spk])).segwit?.address;
    o.coins = [];
    for (let k = 0; k < 2; k++) {
      const txid = await wcall('sendtoaddress', { address: addr, amount: 0.00000001, assetlabel: o.asset, fee_asset_label: 'bitcoin' });
      await mine(1);
      o.coins.push(await outTo(txid, o.spk));
    }
  }
  say('three oracles, each with a beacon asset and two one-atom beacon coins: ' + oracles.map((o) => o.key.slice(0, 12) + '…').join(', '));

  // The wallet: collateral and debt-asset coins at its own address.
  const me = engine.currentAddress(false).address;
  const meSpk = (await call('getaddressinfo', [me])).scriptPubKey;
  for (const [a, n] of [[X, 15], [Y, 20]]) await wcall('sendtoaddress', { address: me, amount: n, assetlabel: a, fee_asset_label: 'bitcoin' });
  await mine(1);
  await engine.sync();
  say(`wallet ${me}: ${JSON.parse(lwk.ContractSpend.walletCoins(engine.getWollet())).length} coins in its own record`);

  // The 2-of-3 offer, in Pignus's terms.
  const v2 = await import(pathToFileURL(path.join(WEB, 'v2.js')).href);
  v2.selfTest(JSON.parse(fs.readFileSync(path.join(WEB, 'v2_vectors.json'), 'utf8')));   // the page's pin, as it loads it
  const lenderSpk = (await call('getaddressinfo', [await wcall('getnewaddress', ['', 'bech32'])])).scriptPubKey;
  const now = await mtp();
  const terms = { market: 'XCOL/YDEBT', collateral_asset: X, debt_asset: Y, oracles: oracles.map((o) => o.key),
    beacon_assets: oracles.map((o) => o.asset), threshold: 2, precision: 8, liq_bp: 12000, target_bp: 15000, bonus_bp: 10500,
    maturity: now + 4 * 3600, recover_after: now + 8 * 3600, lender_spk: lenderSpk };
  const offer = { terms, lot: String(LOT), debt: String(DEBT), collateral: String(COLLATERAL), expiry: now + 2 * 3600 };
  const OFFER_T = 'c8d981f09b6bd60b52e152a093ed54070e76fe82b305ca02a43c568e81e1e811';
  const VAULT_T = 'b7fee3aa3dd5f1078204e91384f14bd7c78d7d8a051fc7ace00e9b3bde0e6f75';
  const offerInst = new lwk.ContractInstance(lwk.ContractTemplate.known(OFFER_T), JSON.stringify(v2.offerInstance(offer, genesis)));
  const ospk = offerInst.scriptPubkey();
  assert.equal(ospk, v2.offerSpk(offer), 'the kit and the page derive one offer script');
  const vaultInst = (debt, last) => new lwk.ContractInstance(lwk.ContractTemplate.known(VAULT_T),
    JSON.stringify(v2.vaultInstance({ ...terms, borrower_spk: meSpk }, debt, last, genesis)));
  const ofund = await wcall('sendtoaddress', { address: offerInst.address(engine.getNetwork()), amount: LOT / COIN, assetlabel: Y, fee_asset_label: 'bitcoin' });
  await mine(1);
  const ocoin = await outTo(ofund, ospk);
  say(`2-of-3 offer ${ospk.slice(0, 16)}… funded with one lot at ${ofund}:${ocoin.vout}; the kit's script and the page's agree`);

  // The book, in pignusd's documented shapes, and the page's files.
  const state = { offers: [{ offer_id: 'o1', market: terms.market, status: 'open', offer, spk: ospk, coin: { ...ocoin, confirmed: true }, lots_left: 1 }], loans: [] };
  const vectors = JSON.parse(fs.readFileSync(path.join(WEB, '../pignus/vectors.json'), 'utf8'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
  book = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    try {
      if (p === '/v2/offers') return json({ offers: state.offers, median_time: await mtp() });
      if (p === '/v2/loans') return json({ loans: state.loans });
      if (p === '/v1/vectors') return json(vectors);
      if (p === '/healthz') return json({ ok: true, height: await call('getblockcount') });
      if (/^\/v1\/(offers|loans|markets|assets|oracles|btc\/offers)$/.test(p)) return json({ offers: [], loans: [], markets: [], assets: [], oracles: [] });
      if (p === '/v1/fees') return json({ rates: {} });
      const f = path.join(WEB, p === '/' ? 'index.html' : decodeURIComponent(p));
      const approvalFile = p.startsWith('/__ext/') ? path.join(ROOT, p.slice('/__ext/'.length)) : null;
      const file = approvalFile || f;
      if (!(file.startsWith(WEB) || file.startsWith(ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json({ error: 'not served' }, 404);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
    } catch (e) { json({ error: String(e.message || e) }, 500); }
  });
  const bookPort = await new Promise((r) => book.listen(0, '127.0.0.1', () => r(book.address().port)));
  const ORIGIN = `http://127.0.0.1:${bookPort}`;
  await perms.grant(ORIGIN);
  // Chromium, and the Pignus page with the extension's provider bridged in.
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-pignus-chrome-'));
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
  await site.go(ORIGIN + '/#v2');
  await site.waitFor("document.querySelector('[data-v2-take]') !== null", 60000);
  say('the Pignus page pinned its vectors and lists the offer with "Take one lot with your wallet"');

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
    const text = await ap.waitFor("(document.getElementById('reqCard')||{}).innerText||''", 20000);
    return { id, approval, ap, text, decided };
  }
  const five = (text, label, extra = []) => {
    for (const want of ['Sign this contract spend?', '1. Known template', '2. Output recomputed', '3. Program run', 'ran against the final transaction',
      '4. Shown', 'it signs digest', '5. Contract key', 'takes no signature, so no contract key signs', 'What it spends', 'this wallet\'s coin',
      'Your balance change', 'Network fee', ...extra]) {
      assert.ok(text.toLowerCase().includes(want.toLowerCase()), `${label}: the approval page shows "${want}"\n${text}`);
    }
  };
  async function signFromPage(label, clickExpr, extra, shotName) {
    const before = (await call('getrawmempool')).length;
    await site.eval("document.getElementById('note').innerText = ''");
    await site.eval(clickExpr);
    const scr = await approvalScreen(label);
    five(scr.text, label, extra);
    await scr.ap.shot(shotName);
    await scr.ap.eval("document.getElementById('btnApprove').click()");
    for (let i = 0; i < 300 && !scr.decided.length; i++) await sleep(100);
    assert.equal(scr.decided[0].params.shown, scr.approval.display.digest, label + ': the page decided with the digest it showed');
    const note = await site.waitFor("(document.getElementById('note').innerText.match(/broadcast: ([0-9a-f]{64})/)||[])[1]", 120000);
    assert.equal((await call('getrawmempool')).length, before + 1);
    await mine(1);
    const conf = await call('getrawtransaction', [note, true]);
    assert.ok(conf.confirmations >= 1);
    say(`${label}: approved on the approval page (digest ${scr.approval.display.digest.slice(0, 16)}…), ${note} confirmed, ${conf.vsize} vB`);
    if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, `approval-${label.replace(/\W+/g, '-')}.txt`), scr.text);
    scr.ap.close();
    return conf;
  }


  // ---- the take of the 2-of-3 offer, from the page ----
  const take = await signFromPage('take 2-of-3', "document.querySelector('[data-v2-take]').click()",
    ['pignus/offer-threshold', 'Output 0 opens a contract', 'opens pignus/vault-threshold', 'SHA-256 of this wallet\'s script', 'Path chosen by'], 'pignus-threshold-take-approval.png');
  await site.shot('pignus-threshold-take-signed.png');
  const last = take.locktime;
  assert.equal(take.vout[0].scriptPubKey.hex, vaultInst(DEBT, last).scriptPubkey(), 'the take opened the threshold vault this wallet borrows under');
  const vcoin = { txid: take.txid, vout: 0, script_pubkey: take.vout[0].scriptPubKey.hex, asset: X, amount: Math.round(take.vout[0].value * 1e8) };
  state.offers[0].status = 'taken';
  await engine.sync();

  // ---- the price falls; oracles 1 and 3 sign the record, oracle 2 abstains ----
  const tip = (await call('getblockheader', [await call('getbestblockhash')])).time;
  await call('setmocktime', [tip + 660]); await mine(12);
  const time = (await mtp()) - 1;
  const price = 115000000;      // 109.5 %: under 120 %, a partial liquidation back to 150 %
  const c = BigInt(vcoin.amount), d = BigInt(DEBT);
  assert.ok(!v2.healthy(c, d, BigInt(price), 8, 12000));
  const r = v2.maxRepay(c, d, BigInt(price), 8, 15000, 10500);
  let seized = v2.maxSeizure(r, BigInt(price), 8, 10500); if (seized > c) seized = c;
  const kept = c - seized, debtAfter = d - r;
  const sigOf = (i) => py('sign', i, X, Y, price, 8, time, oracles[i].program);
  const FEE = 6000;
  const liqParams = (signers) => {
    const slots = ['None', 'None', 'None'];
    const inputs = [{ is: 'contract' }];
    signers.forEach((i, j) => {
      const o = oracles[i];
      inputs.push({ is: 'foreign', txid: o.coins[0].txid, vout: o.coins[0].vout, script_pubkey: o.spk, asset: o.asset, amount: 1, witness: o.witness, label: `oracle ${i + 1}'s beacon coin` });
      slots[i] = `Some((0x${sigOf(i)}, 0x${o.program}, ${j + 1}))`;
    });
    const beaconOut = (j) => { const o = oracles[signers[j - 1]]; return { to: 'foreign', input: j, script: o.spk, asset: o.asset, amount: 1 }; };
    const outputs = [{ to: 'contract', script: vaultInst(Number(debtAfter), time).scriptPubkey(), asset: X, amount: Number(kept) },
      { to: 'pay', script: lenderSpk, asset: Y, amount: Number(r) }, beaconOut(1), { to: 'wallet', address: me, asset: X, amount: Number(seized) }];
    if (signers.length > 1) outputs.push(beaconOut(2));
    outputs.push({ to: 'fee', asset: Y, amount: FEE });
    return { templateHash: VAULT_T, instance: v2.vaultInstance({ ...terms, borrower_spk: meSpk }, DEBT, last, genesis), fund: true,
      request: { path: 'liquidate', coin: vcoin, inputs, lock_time: time, outputs,
        spender: { PATH: `Right(Left((${price}, ${time}, [${slots.join(', ')}], false)))` },
        next_slots: { DEBT_OUT: hexw(debtAfter, 8), LAST_TIME: hexw(time, 4) } } };
  };
  // Asked through the page's own provider, as a liquidator's page would.
  const ask = (p) => `(window.__liq = window.sequentia.request({ method: 'signContractSpend', params: ${JSON.stringify(p)} })
      .then((x) => { document.getElementById('note').innerText = 'broadcast: ' + x.txid; }, (e) => { document.getElementById('note').innerText = 'Not signed. ' + e.message; }), true)`;

  // One signature of a 2-of-3: refused before any approval opens.
  {
    const before = opened.length;
    await site.eval("document.getElementById('note').innerText = ''");
    await site.eval(ask(liqParams([0])));
    const why = await site.waitFor("(document.getElementById('note').innerText.match(/Not signed\\. (.*)/)||[])[1]", 60000);
    assert.ok(why.includes('the contract\'s program refuses this transaction'), why);
    assert.equal(opened.length, before, 'no approval opened');
    say('a liquidation with one signature of the 2-of-3: refused before any approval: "' + why + '"');
  }
  const liq = await signFromPage('liquidate 2-of-3', ask(liqParams([0, 2])),
    ['pignus/vault-threshold', 'neither the contract\'s nor this wallet\'s', 'BEACON_ASSET_1', 'BEACON_ASSET_3', 'recreated at output 2', 'recreated at output 4', 'Pays output 1'],
    'pignus-threshold-liquidate-approval.png');
  assert.equal(liq.locktime, time);
  assert.equal(liq.vout[0].scriptPubKey.hex, vaultInst(Number(debtAfter), time).scriptPubkey(), 'the successor owes the rest, LAST_TIME the record\'s time');
  assert.equal(Math.round(liq.vout[0].value * 1e8), Number(kept));
  assert.equal(liq.vout[1].scriptPubKey.hex, lenderSpk); assert.equal(Math.round(liq.vout[1].value * 1e8), Number(r));
  assert.equal(liq.vout[2].scriptPubKey.hex, oracles[0].spk); assert.equal(liq.vout[4].scriptPubKey.hex, oracles[2].spk);
  for (const [k, o] of [[1, oracles[0]], [2, oracles[2]]]) assert.equal(`${liq.vin[k].txid}:${liq.vin[k].vout}`, `${o.coins[0].txid}:${o.coins[0].vout}`);
  say(`the liquidation repaid ${r} and seized ${seized}; beacons of oracles 1 and 3 spent at inputs 1 and 2 and recreated at outputs 2 and 4`);
  assert.deepEqual(site.errors, [], 'no page errors: ' + site.errors.join(' | '));
  say('provider methods the page called: ' + [...new Set(calls)].join(', '));
} catch (e) {
  failed = true; console.error(e);
} finally {
  if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'pignus-threshold.log'), lines.join('\n') + '\n');
  await cleanup();
}
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
