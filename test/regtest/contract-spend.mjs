// A website asks the extension to drip from a faucet drip covenant whose faucet
// key is this wallet's contract key, on a private regtest chain. The request goes
// through the real provider router (`signContractSpend`); the approval is read and
// decided through the service worker's own UI messages, exactly as the approval
// page does; the page itself is rendered in a headless Chromium from what the
// worker gave it. The drip confirms. Refused before any approval opens, with the
// engine's reason: a drip before the interval, one above the tier, a request whose
// successor is not the covenant, and a template that is not on the wallet's list.
// An approval decided with another digest than the one shown signs nothing.
//
//   SEQUENTIAD=/path/to/sequentiad SWK_TEMPLATES=/path/to/SWK/lwk_contracts/templates \
//     node test/regtest/contract-spend.mjs [evidence-dir]
//
// CHROME=/path/to/chrome renders the approval page (skipped without one).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rpcCall, startEsploraShim } from './esplora-shim.mjs';

const EXE = process.env.SEQUENTIAD;
if (!EXE) { console.log('SKIP: set SEQUENTIAD to a sequentiad binary'); process.exit(0); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE = process.argv[2] || null;
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-contract-spend-'));

// A public test mnemonic, never funded anywhere but a local chain.
const MNEMONIC = 'exist carry drive collect lend cereal occur much tiger just involve mean';
const ORIGIN = 'https://faucet.example';
const DRIP = '12986f202fbfb850f7699c5d5188f261f276de6c7038142f0a28bbb672b5af34';
const TREASURY_KEY = '561012804a5e7c56565fe7a04c58b7ad2209699c1cf683e0a2a1367a42d7483c';
const COIN = 100000000n;
const hexw = (n, w) => BigInt(n).toString(16).padStart(w, '0');
const lines = [];
const say = (s) => { console.log('[contract-spend] ' + s); lines.push(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

const rpcPort = await freePort();
const node = spawn(EXE, [`-datadir=${WORK}`, '-chain=elementsregtest', `-rpcport=${rpcPort}`, `-port=${await freePort()}`, '-listen=0', '-server',
  '-printtoconsole=0', '-rpcuser=u', '-rpcpassword=p', '-txindex=1', '-par=1', '-evbparams=simplicity:-1:::', '-initialfreecoins=2100000000000000',
  '-anyonecanspendaremine=1', '-blindedaddresses=0', '-con_default_blinded_addresses=0', '-validatepegin=0', '-con_parent_chain_signblockscript=51',
  '-con_any_asset_fees=1', '-fallbackfee=0.0001', '-maxtxfee=100'], { stdio: 'ignore' });
const rpc = { url: `http://127.0.0.1:${rpcPort}/`, auth: 'u:p' };
const call = (m, p = []) => rpcCall(rpc, m, p);
const wcall = (m, p = []) => rpcCall({ ...rpc, url: rpc.url + 'wallet/treasury' }, m, p);
let shim = null;
async function cleanup() {
  try { shim && shim.close && shim.close(); } catch {}
  try { await call('stop'); } catch {}
  if (node.exitCode == null) await new Promise((r) => node.once('exit', r));
  fs.rmSync(WORK, { recursive: true, force: true });
}
let failed = false;
try {
  for (let i = 0; ; i++) { try { await call('getblockcount'); break; } catch (e) { if (i > 300) throw e; await sleep(200); } }
  await call('createwallet', ['treasury']);
  const mine = async (n) => call('generatetoaddress', [n, await wcall('getnewaddress')]);
  await mine(101); await wcall('rescanblockchain');
  await wcall('sendtoaddress', { address: await wcall('getnewaddress'), amount: 1000000, fee_asset_label: 'bitcoin' });
  await mine(1);
  const policy = (await call('getsidechaininfo')).pegged_asset;
  const genesis = await call('getblockhash', [0]);
  const advance = async (secs) => { const t = (await call('getblockheader', [await call('getbestblockhash')])).time; await call('setmocktime', [t + secs + 60]); await mine(12); };

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
  const ui = globalThis.__sw.ui;
  await engine.openFromPhrase(MNEMONIC);
  await perms.grant(ORIGIN);
  const caps = await router.handleDappRequest(ORIGIN, 'getCapabilities');
  assert.ok(caps.methods.includes('signContractSpend') && caps.features.includes('contract-spend'));
  say('getCapabilities lists signContractSpend and the contract-spend feature');

  // The instance: the wallet's contract key is the faucet key.
  const key = engine.getSigner().xonlyPublicKeyAt('m/8383h/1h/0h/0/0');
  const params = { ASSET: Buffer.from(policy, 'hex').reverse().toString('hex'), FAUCET_KEY: key, TREASURY_KEY, INTERVAL: '0001', FEE_CAP: hexw(100000, 16), RECOVERY_DELAY: hexw((1 << 22) | 2, 8) };
  const tiers = [1000000n, 500n, 100000n, 200n, 10000n, 20n, 2n].map((n) => n * COIN);
  ['TIER1_FLOOR', 'TIER1_MAX', 'TIER2_FLOOR', 'TIER2_MAX', 'TIER3_FLOOR', 'TIER3_MAX', 'TIER4_MAX'].forEach((k, i) => { params[k] = hexw(tiers[i], 16); });
  const instance = { instance: 2, template_hash: DRIP, params, slots: {}, genesis };
  const inst = new lwk.ContractInstance(lwk.ContractTemplate.known(DRIP), JSON.stringify(instance));
  const address = inst.address(engine.getNetwork());
  assert.equal((await call('getaddressinfo', [address])).scriptPubKey, inst.scriptPubkey());
  const fund = await wcall('sendtoaddress', { address, amount: 2000000, fee_asset_label: 'bitcoin' });
  await mine(1);
  const coinOf = async (txid) => {
    const t = await call('getrawtransaction', [txid, true]);
    const o = t.vout.find((v) => v.scriptPubKey.hex === inst.scriptPubkey());
    return { txid, vout: o.n, script_pubkey: inst.scriptPubkey(), asset: o.asset, amount: Math.round(o.value * 1e8) };
  };
  let coin = await coinOf(fund);
  say(`covenant ${address} funded by ${fund}`);

  const ask = (p) => router.handleDappRequest(ORIGIN, 'signContractSpend', p);
  const refused = async (label, p, want) => {
    const before = opened.length;
    await assert.rejects(ask(p), (e) => { assert.ok(e.message.includes(want), `${label}: ${e.message}`); say(`${label}: refused before any approval: ${e.message}`); return true; });
    assert.equal(opened.length, before, `${label}: no approval opened`);
  };
  const drip = (amount) => ({ templateHash: DRIP, instance, drip: { coin, amount: String(amount), ratePerKvb: 1000 } });

  await refused('a drip before the interval', drip(500n * COIN), 'non-BIP68-final');
  await advance(512);

  // The approval, as the page reads it.
  const pending = ask(drip(500n * COIN));
  for (let i = 0; i < 200 && !opened.length; i++) await sleep(50);
  const id = new URL(opened.at(-1)).searchParams.get('id');
  const { approval } = await ui('approval.get', { id });
  assert.equal(approval.method, 'signContractSpend');
  const flat = approval.display.sections.flatMap((s) => s.rows.map(([k, v]) => `${s.title} | ${k} | ${v}`));
  for (const want of ['Template | Template | an unregistered template, root 5251ec00d9799dbcdb31da4534f25ef9960321f195e2e24ef7125c46f24b972a', 'Template | It names itself | sequentia/faucet-drip v1 (not checked by any registry)', 'Path | Path | drip (simplicity leaf drip)', 'Parameters | Faucet key [pubkey] |',
    'Parameters | Recovery delay [sequence] | 2 × 512 s = 1024 s', 'Your balance change | This wallet | 500.00000000', 'Checked before signing | 5. Contract key | FAUCET_KEY is this wallet\'s contract key at m/8383h/1h/0h/0/0']) {
    assert.ok(flat.some((r) => r.startsWith(want) || r.includes(want)), `the approval shows ${want}\n${flat.join('\n')}`);
  }
  say('the approval page receives: ' + flat.length + ' rows; ' + flat.filter((r) => /^(Template \| Template|Path \| Path|Your balance)/.test(r)).join('; '));
  if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'extension-approval-display.json'), JSON.stringify(approval, null, 2));

  // The page, rendered from what the worker gave it.
  await renderApproval(approval);

  await ui('approval.decide', { id, approve: true, shown: approval.display.digest });
  const { txid } = await pending;
  await mine(1);
  const conf = await call('getrawtransaction', [txid, true]);
  assert.ok(conf.confirmations >= 1);
  say(`the drip ${txid} confirmed, ${conf.vsize} vB`);

  coin = await coinOf(txid);
  await refused('a second drip before the interval', drip(500n * COIN), 'non-BIP68-final');
  await advance(512);
  await refused('a drip above the tier', drip(500n * COIN + 1n), 'is above the 50000000000');
  const wallet = engine.currentAddress(false).address;
  const req = { path: 'drip', coin, sequence: (1 << 22) | 1, outputs: [
    { to: 'contract', address: wallet, asset: coin.asset, amount: coin.amount - Number(500n * COIN) - 600 },
    { to: 'pay', address: wallet, asset: coin.asset, amount: Number(500n * COIN) }, { to: 'fee', asset: coin.asset, amount: 600 }] };
  await refused('a successor that is not the covenant', { templateHash: DRIP, instance, request: req }, 'is said to return to the contract, but pays the script');
  // A template the site supplies: read and checked, but never on the wallet's list.
  const d = JSON.parse(lwk.ContractTemplate.knownDescriptor(DRIP));
  d.template.summary = 'A faucet that looks like the published one.';
  const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
  d.template_hash = createHash('sha256').update(canonical(d.template)).digest('hex');
  // Its program's resolved source, from SWK's copy of the templates (SWK_TEMPLATES, or a
  // sibling SWK checkout).
  const srcFile = path.join(process.env.SWK_TEMPLATES || path.join(ROOT, '../SWK/lwk_contracts/templates'), 'faucet_drip/faucet_drip.simf');
  if (!fs.existsSync(srcFile)) throw new Error('set SWK_TEMPLATES to SWK\'s lwk_contracts/templates: ' + srcFile + ' is missing');
  const src = fs.readFileSync(srcFile, 'utf8');
  await refused('a template the site supplies', { descriptor: d, sources: { 'faucet_drip.simf': src }, instance: { ...instance, template_hash: d.template_hash },
    request: { path: 'drip', coin, sequence: (1 << 22) | 1, outputs: [
      { to: 'contract', script: inst.scriptPubkey(), asset: coin.asset, amount: coin.amount - Number(500n * COIN) - 600 },
      { to: 'pay', address: wallet, asset: coin.asset, amount: Number(500n * COIN) }, { to: 'fee', asset: coin.asset, amount: 600 }] } },
  'is not on this wallet\'s list of known templates');

  // Approved with a digest other than the one shown: nothing is signed.
  const p2 = ask(drip(500n * COIN));
  for (let i = 0; i < 200 && opened.length < 2; i++) await sleep(50);
  const id2 = new URL(opened.at(-1)).searchParams.get('id');
  await ui('approval.decide', { id: id2, approve: true, shown: '00'.repeat(32) });
  await assert.rejects(p2, (e) => { assert.ok(e.message.includes('is not this spend; nothing was signed'), e.message); say('approved with another digest: ' + e.message); return true; });
  assert.deepEqual(await call('getrawmempool'), []);
  say('the mempool is empty');
} catch (e) {
  failed = true; console.error(e);
} finally {
  if (EVIDENCE) fs.writeFileSync(path.join(EVIDENCE, 'extension-contract-spend.log'), lines.join('\n') + '\n');
  await cleanup();
}
console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);

// Renders approval/approval.html as Chromium shows it, with chrome.runtime answering
// approval.get with what the service worker answered above.
async function renderApproval(approval) {
  const chrome = process.env.CHROME;
  if (!chrome) { say('approval page render skipped: set CHROME'); return; }
  const http = await import('node:http');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  const httpPort = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-approval-render-'));
  const proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--window-size=420,2600',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const ws = await new Promise((ok, no) => { let b = ''; proc.stderr.on('data', (x) => { b += x; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) ok(m[1]); }); setTimeout(() => no(new Error('chrome did not start')), 20000); });
    const port = new URL(ws).port;
    let target; for (let i = 0; i < 40 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(250); }
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok) => { sock.onopen = ok; });
    let n = 0; const waits = new Map(); const errors = [];
    sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((ok) => { const i = ++n; waits.set(i, ok); sock.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    const stub = `window.chrome = { runtime: { lastError: null, sendMessage: (msg, cb) => { const a = ${JSON.stringify(approval)}; if (msg.method === 'approval.get') cb({ ok: true, result: { approval: a, unlocked: true } }); else cb({ ok: true, result: {} }); } }, tabs: { getCurrent() {} } };`;
    await send('Page.addScriptToEvaluateOnNewDocument', { source: stub });
    await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/approval/approval.html?id=` + approval.id });
    await sleep(1500);
    const text = (await send('Runtime.evaluate', { expression: "document.getElementById('reqCard').innerText", returnByValue: true })).result.result.value || '';
    for (const want of ['Sign this contract spend?', 'sequentia/faucet-drip v1', 'drip (simplicity leaf drip)', 'This wallet', '500.00000000 tSEQ', 'it signs digest ' + approval.display.digest]) {
      assert.ok(text.toLowerCase().includes(want.toLowerCase()), 'the approval page shows ' + want + '\n' + text);
    }
    assert.deepEqual(errors, []);
    say('the approval page renders the template, the path, the parameters, the balance change and the digest; no page errors');
    if (EVIDENCE) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(path.join(EVIDENCE, 'extension-approval.png'), Buffer.from(shot.result.data, 'base64'));
    }
    sock.close();
  } finally {
    proc.kill();
    srv.close();
    await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    // Chromium's helper processes can still be writing to the profile after the
    // browser exits: try until it is gone.
    for (let i = 0; i < 40 && fs.existsSync(profile); i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { await sleep(250); }
    }
  }
}
