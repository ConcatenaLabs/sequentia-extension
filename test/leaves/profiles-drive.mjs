#!/usr/bin/env node
// Drives the extension's leaf wallet through what an operator's profiles ask of it, in a
// headless Chromium with the extension loaded, against a local regtest operator serving a
// supervised asset (Z), an issuer-operated asset (I) and an equivocation bond:
//
//  1. the phrase restored (or a wallet created), the operator joined in developer mode;
//     X, Z and I boarded from a site, Z also received from the command-line wallet, and
//     every leaf of them refreshed into a round by the wallet's own upkeep;
//  2. a payment that needs a planned leaf: every X leaf of a round planned by `care`,
//     then a site's payment larger than any free X leaf, made through the next round with
//     no further window while the drive builds that round;
//  3. Z frozen by its issuer at the wallet's landing key: said under Z's figure in both
//     modes, each Z leaf frozen in developer mode, a site's payment of Z refused; the
//     frozen leaf taken home by a developer-mode exit into the landing key, frozen on the
//     chain (the node's `isassetfrozen`), and a user-mode send of it refused in plain
//     words; the freeze lifted, and Z paid again;
//  4. I's batch profile and supply in developer mode;
//  5. the bond: shown in developer mode, then in notice (or dropped), and a receive
//     refused;
//  6. the user-mode screens free of the developer words.
//
// Every step is a DOM assertion (drive.log) and a screenshot; every console line of the
// extension's contexts is in console.log, and the drive fails on any exception or console
// error from them.
//
// Every endpoint at https://sequentiatestnet.com is a stand-in box (an esplora shim over
// the harness's node, prices, fee rates, the registry); the extension is copied into the
// work directory with its engine on the chain's network, as the total drive does. Every
// other host name but 127.0.0.1 resolves to nothing.
//
// Needs, running: the operator harness of the operator repository
// (bark-cli/tests/arca_operator_for_browsers.rs) started with ARCA_OPERATOR_SUPERVISED and
// ARCA_OPERATOR_ISSUER at its control address, and that repository's command-line wallet
// (`arca`), the counterparty.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca \
//     [SEQ_DRIVE_MNEMONIC_FILE=phrase.txt] [BOND_END=notice|drop] \
//     node test/leaves/profiles-drive.mjs <evidence-dir> <work-dir>
//
// With SEQ_DRIVE_MNEMONIC_FILE naming a file that exists, the extension imports that
// phrase (and its join restores what the operator holds of it); otherwise it creates a
// wallet and, when the variable is set, writes its phrase there (mode 600). The phrase is
// never written to the evidence.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';
import { startEsploraShim } from '../regtest/esplora-shim.mjs';
import { DEVELOPER_WORDS } from '../../src/balance-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const cliBin = process.env.ARCA_CLI;
const phraseFile = process.env.SEQ_DRIVE_MNEMONIC_FILE || null;
const bondEnd = process.env.BOND_END === 'drop' ? 'drop' : 'notice';
const out = resolve(process.argv[2] || 'profiles-evidence');
const work = resolve(process.argv[3] || '/tmp/profiles-drive');
if (!CHROME || !cliBin) { console.error('set CHROME and ARCA_CLI'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
const consoleLog = join(out, 'console.log');
writeFileSync(logFile, ''); writeFileSync(consoleLog, '');
const note = (s) => { console.log(s); appendFileSync(logFile, s + '\n'); };

// The words user mode never shows: the extension's list, and three more the operator's
// profiles bring (as the web wallet's profiles drive checks).
const USER_FORBIDDEN = [...DEVELOPER_WORDS, 'landing', 'bond', 'exit'];
const devWordsIn = (t) => USER_FORBIDDEN.filter((w) => new RegExp('\\b' + w + 's?\\b', 'i').test(String(t || '')));
const FROZEN_SENTENCE = /is frozen by its issuer: it can't be sent until the issuer lifts the freeze\./;
const FROZEN_PLAIN = 'This asset is frozen by its issuer for this wallet: nothing was sent.';

let failures = 0, step = 0;
function check(name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures++;
  return ok;
}
const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
};
const rpc = (method, params = []) => ctl('/rpc', { method, params });
const cliDir = join(work, 'cli');
const cli = (...args) => {
  let text;
  try {
    text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args],
      { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { text = e.stdout.toString(); }
  return JSON.parse(text);
};
const DAY = 86_400;

let b = null;
async function shot(p, name) {
  step++;
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
  await p.shot(f);
  note(`     screenshot ${f.split('/').pop()}`);
}

async function main() {
  const st = await ctl('/state');
  const X = st.x, Z = st.supervised, I = st.issuer;
  if (!Z || !I) throw new Error('the harness serves no supervised or no issuer-operated asset: start it with ARCA_OPERATOR_SUPERVISED and ARCA_OPERATOR_ISSUER');
  const policy = (await rpc('getsidechaininfo')).pegged_asset;
  note(`operator ${st.server}; node ${st.node_url}; X ${X}; supervised Z ${Z}; issuer-operated I ${I}`);

  // A bond of its own for this run, posted before the wallet reads it: the wallet sees it
  // bonded (a shared operator may hold a bond another run put in notice).
  const bond = await ctl('/bond_post', {});
  note(`     the operator's bond: ${JSON.stringify(bond)}`);

  // ---- the counterparty: the command-line wallet, with X and Z leaves ----
  rmSync(cliDir, { recursive: true, force: true });
  cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca', '--exit-delay-units', '1', '--min-exit-delay-units', '1');
  for (const a of [X, Z]) await ctl('/fund', { script: cli('address').script_pubkey, asset: a, amount: 5000000 });
  await ctl('/produce');
  for (const a of [X, Z]) { const r = cli('board', a, '3000000'); if (r.error) throw new Error('the command-line wallet\'s board: ' + r.error.message); }
  await ctl('/produce'); await ctl('/bury');
  for (let i = 0; i < 120 && !cli('boards').every((x) => x.server?.state === 'credited'); i++) await sleep(500);
  cli('sync');

  // ---- the extension, its engine on the chain's network; the stand-in box ----
  const EXT = join(work, 'extension');
  rmSync(EXT, { recursive: true, force: true });
  cpSync(SRC, EXT, { recursive: true, filter: (p) => !/\/(\.git|test|node_modules)(\/|$)/.test(p.slice(SRC.length)) });
  const engineFile = join(EXT, 'src/engine.js');
  const esrc = readFileSync(engineFile, 'utf8');
  const from = 'network = Network.sequentiaTestnet();';
  if (esrc.split(from).length !== 2) throw new Error('engine.js: the network line changed; update the drive');
  writeFileSync(engineFile, esrc.replace(from, `network = Network.regtestWithGenesis(new AssetId(${JSON.stringify(policy)}), ${JSON.stringify(st.genesis_hash)});`));
  const shimPort = await new Promise((ok) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const q = t.address().port; t.close(() => ok(q)); }); });
  const shim = await startEsploraShim({ rpc: { url: st.node_url, auth: `${st.node_user}:${st.node_password}` }, port: shimPort });
  const dev = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((ok) => dev.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  const key = join(work, 'box.key'), crt = join(work, 'box.crt');
  if (!existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization' };
  const box = https.createServer({ key: readFileSync(key), cert: readFileSync(crt) }, async (req, res) => {
    const url = new URL(req.url, 'https://sequentiatestnet.com');
    const p = url.pathname;
    const send = (code, data, type = 'application/json') => { res.writeHead(code, { ...CORS, 'Content-Type': type }); res.end(data); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    try {
      if (p.startsWith('/api/') || p.startsWith('/anchor/')) {
        const parts = []; for await (const c of req) parts.push(c);
        const r = await fetch(shim.url + p + url.search, { method: req.method, body: req.method === 'POST' ? Buffer.concat(parts) : undefined });
        return send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/json');
      }
      if (p === '/prices') return send(200, JSON.stringify({ SEQ: { price: 0.5 }, XW: { price: 0.01 }, USDZ: { price: 1 }, ISS: { price: 0.1 }, tBTC: { price: 60000 } }));
      if (p === '/feerates') return send(200, JSON.stringify(await rpc('getfeeexchangerates')));
      if (p === '/registry/index.minimal.json') {
        return send(200, JSON.stringify({ [X]: ['regtest.invalid', 'XW', 'Drive asset', 0, true, false], [Z]: ['regtest.invalid', 'USDZ', 'Supervised drive asset', 0, true, false],
          [I]: ['regtest.invalid', 'ISS', 'Issuer-operated drive asset', 0, true, false], [policy]: ['regtest.invalid', 'tSEQ', 'Sequence', 8, true, false] }));
      }
    } catch (e) { return send(500, String(e.message), 'text/plain'); }
    send(404, 'not served by the stand-in box', 'text/plain');
  });
  await new Promise((ok) => box.listen(0, '127.0.0.1', ok));
  note(`     box at 127.0.0.1:${box.address().port}; site and operator front ${base}`);

  b = new Browser({
    chrome: CHROME, profile: join(work, 'profile'), ext: EXT, consoleLog, headless: process.env.HEADED !== '1',
    extraArgs: ['--ignore-certificate-errors', `--host-resolver-rules=MAP sequentiatestnet.com 127.0.0.1:${box.address().port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
  });
  try {
    await b.launch('profiles');
    const swTarget = await b.serviceWorker();
    await sleep(3000);
    let problems = b.problems.splice(0);
    check('the service worker started and its console shows no exception or error', problems.length === 0, problems.length ? problems : undefined);
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    const ui = async (method, params = {}) => {
      const r = await pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
      if (!r || !r.ok) throw new Error(method + ': ' + JSON.stringify(r && r.error));
      return r.result;
    };
    // The leaf host answers the service worker's messages; a read is asked from the
    // worker's own context (`info`, `coins`, `status`), never a command that moves a coin.
    const sw = await b.pageOf(swTarget.targetId);
    const host = async (op, args = {}) => {
      const r = await sw.eval(`chrome.runtime.sendMessage({scope:'leaf', op:${JSON.stringify(op)}, args:${JSON.stringify(args)}})`);
      if (!r || !r.ok) throw new Error(op + ': ' + JSON.stringify(r && r.error));
      return r.value;
    };
    const read = async (command) => (await host('run', { command, args: {} })).result;

    // ---- 1. the wallet: restored from the given phrase, or created ----
    await pop.waitFor("document.querySelector('#btnStartImport') && document.querySelector('#btnStartImport').offsetParent !== null && !!document.querySelector('#btnStartImport').onclick", 60000);
    const given = phraseFile && existsSync(phraseFile) ? readFileSync(phraseFile, 'utf8').trim() : null;
    if (given) {
      await pop.click('#btnStartImport');
      await pop.set('importPhrase', given);
      await pop.set('importPw', 'drive-password'); await pop.set('importPw2', 'drive-password');
      await pop.click('#btnImportGo');
    } else {
      await pop.click('#btnStartCreate');
      await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
      const made = await pop.eval("document.querySelector('#newPhrase').dataset.phrase");
      if (phraseFile) writeFileSync(phraseFile, made + '\n', { mode: 0o600 });
      await pop.set('createPw', 'drive-password'); await pop.set('createPw2', 'drive-password');
      await pop.click('#btnCreateGo');
    }
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    check(given ? 'the extension restored the given phrase' : 'the extension made a wallet' + (phraseFile ? ' and kept its phrase for the next wallet' : ''), true);
    const setMode = async (m) => {
      await pop.click('[data-tab=settings]');
      await pop.eval(`(()=>{const s=document.querySelector('#setMode'); s.value=${JSON.stringify(m)}; s.dispatchEvent(new Event('change')); return true})()`);
      await pop.waitFor(`document.querySelector('#leafCard').classList.contains('hide') === ${m !== 'developer'}`, 30000);
    };
    await setMode('developer');
    await pop.set('leafServer', base + 'operator'); await pop.set('leafNodeUrl', base + 'node');
    await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
    await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
    await pop.click('#btnLeafJoin');
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
    check('the wallet joined the operator (developer mode; joining restores the phrase\'s leaves)', (await pop.text('#leafOperator')).trim().length === 64, await pop.text('#leafStatus'));
    // The drive's shortcuts: the host's tick, 60 s in use, is 4 s, and care, at most every
    // ten minutes in use, at most every 20 s (a tick that runs care reads no mailbox, so
    // care must leave ticks free). The host reads them when it opens again.
    await pop.eval("chrome.storage.local.get(['ext.walletTag','ext.leaves.byWallet']).then((o)=>{const t=o['ext.walletTag'], all=o['ext.leaves.byWallet']; all[t]={...all[t], tick_ms: 4000, care_ms: 20000}; return chrome.storage.local.set({'ext.leaves.byWallet': all})})");
    await ui('lock'); await sleep(1000);
    await pop.eval('location.reload()');
    await pop.waitFor("document.querySelector('#unlockPw') && document.querySelector('#unlockPw').offsetParent !== null && !!document.querySelector('#btnUnlock').onclick", 60000);
    await pop.set('unlockPw', 'drive-password'); await pop.click('#btnUnlock');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    for (let i = 0; i < 60 && !(await host('status').catch(() => ({}))).open; i++) await sleep(1000);
    const info = await read('info');
    const landing = info.landing_address;
    check('the leaf wallet names its landing key (the phrase\'s first on-chain key)', typeof landing === 'string' && landing.length > 20, landing);
    const first = (await ui('receive', { confidential: false })).address;
    note(`     landing ${landing}; the popup's receive address ${first}`);

    // ---- the site ----
    const site = await b.page(base + 'site.html');
    await site.waitFor('window.siteEvents', 30000);
    const done = (method, ms = 600000) => site.waitFor(`document.querySelector('#out').dataset.method === ${JSON.stringify(method)} && document.querySelector('#out').dataset.ok !== ''`, ms);
    const answer = async () => ({ ok: await site.eval("document.querySelector('#out').dataset.ok === '1'"), text: await site.eval("document.querySelector('#out').textContent") });
    const press = async (btn) => { await site.eval("document.querySelector('#out').dataset.method=''"); await site.click(btn); };
    async function approve(name, expect) {
      const t = await b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 60000);
      const a = await b.pageOf(t.targetId);
      await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 30000);
      const body = await a.text('#reqCard');
      check(`approval screen "${await a.text('#reqTitle')}" shown`, expect.every((re) => re.test(body)), body.replace(/\s+/g, ' ').slice(0, 400));
      if (name) await shot(a, name);
      await a.click('#btnApprove');
      for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100);
      return body;
    }
    await site.waitFor("document.body.dataset.mode === 'developer'", 30000);
    await press('#btnConnect'); await approve(null, [/wants to connect/]); await done('connect');
    await press('#btnAddress'); await done('getLeafAddress');
    let a = await answer();
    const addr = JSON.parse(a.text);
    note(`     the leaf wallet's on-chain address ${addr.address}`);
    // Z exactly what is boarded (its fee paid in X), so the only Z on the chain later is
    // what a landing puts there.
    for (const [asset, v] of [[X, 8000000], [Z, 2000000], [I, 2000000]]) await ctl('/fund', { script: addr.script_pubkey, asset, amount: v });
    await ctl('/produce'); await ctl('/bury');
    await sleep(2000);
    const boards = {};
    for (const [asset, v, name] of [[X, '2000000', 'X'], [Z, '2000000', 'Z'], [I, '1000000', 'I']]) {
      await site.set('asset', asset); await site.set('amount', v); await site.set('feeAsset', X);
      await press('#btnBoard');
      await approve(name === 'Z' ? 'approval-board-z' : null, [/Board a coin into your leaves/]);
      await done('boardLeaves'); a = await answer();
      boards[name] = a.ok ? JSON.parse(a.text) : null;
      check(`${name} boarded from the site`, !!boards[name] && !!boards[name].leaf_id, a.ok ? { leaf: boards[name].leaf_id, fee: boards[name].fee } : a.text);
      await ctl('/produce');
    }
    await ctl('/produce'); await ctl('/bury');
    const coinsNow = async () => (await read('coins')) || [];
    let cs = [];
    for (let i = 0; i < 60; i++) {
      cs = await coinsNow();
      if (Object.values(boards).every((x) => x && cs.some((c) => c.leaf_id === x.leaf_id && c.state === 'live'))) break;
      await sleep(2000); if (i % 5 === 4) { await ctl('/produce'); await ctl('/bury'); }
    }
    const zb = cs.find((c) => c.leaf_id === boards.Z.leaf_id);
    check('Z boarded as a leaf that lands at the wallet\'s landing key', !!zb && zb.state === 'live' && zb.landing === landing, zb && { state: zb.state, landing: zb.landing });
    check('X boarded, a leaf with no landing', cs.some((c) => c.leaf_id === boards.X.leaf_id && c.state === 'live' && !c.landing));

    // Z received from the command-line wallet: the request names the landing.
    await site.set('asset', Z); await site.set('amount', '300000');
    await press('#btnReceive');
    await approve(null, [/receive request for leaves/]);
    await done('requestLeafReceive'); a = await answer();
    const reqZ = a.ok ? JSON.parse(a.text) : null;
    const reqJson = reqZ ? JSON.parse(Buffer.from(reqZ.request.slice(reqZ.request.indexOf(':') + 1), 'hex').toString()) : {};
    check('a receive request for Z, naming the wallet\'s landing', /^[0-9a-f]{40}$/.test(reqJson.landing || ''), reqZ ? reqJson.landing : a.text);
    const paidZ = cli('send', reqZ.request, '--amount', '300000', '--asset', Z);
    check('the command-line wallet paid 300000 Z', !paidZ.error, paidZ.error || 'paid');
    let zRecv = null;
    for (let i = 0; i < 60 && !zRecv; i++) { await sleep(2000); zRecv = (await coinsNow()).find((c) => c.asset === Z && c.value === '300000' && c.state === 'live'); }
    check('the payment of Z is held, landing at the same key', !!zRecv && zRecv.landing === landing, zRecv && zRecv.landing);

    // ---- every leaf refreshed into a round by the wallet's own upkeep ----
    const sch = await read('schedule');
    const expiryOf = (c) => (typeof c.exit_by === 'number' ? c.exit_by + 3 * DAY : null);
    const ours = (await coinsNow()).filter((c) => [X, Z, I].includes(c.asset) && c.state === 'live' && expiryOf(c));
    const latest = Math.max(...ours.map(expiryOf));
    const earliest = Math.min(...ours.map((c) => c.refresh_from).filter((t) => typeof t === 'number'));
    // Within ten days of the latest coin's step window (five days before its expiry), and
    // into the earliest coin's refresh window, so care and sync both ask the refresh.
    const target = Math.max(latest - 5 * DAY - 10 * DAY + DAY, earliest + 60);
    note(`     leaves' expiries up to ${latest}; earliest refresh window ${earliest}; moving the chain's median time from ${sch.now} to ${target}`);
    await ctl('/advance', { seconds: Math.max(1, target - sch.now) });
    await ctl('/produce');
    let parts = [];
    for (let i = 0; i < 90; i++) {
      parts = ((await read('participations')) || []).filter((p) => !['released', 'void', 'expired', 'refused'].includes(p.state) && !p.released);
      cs = await coinsNow();
      const outOfRound = cs.filter((c) => [X, Z, I].includes(c.asset) && c.state === 'live' && c.kind !== 'batch');
      if (!outOfRound.length && parts.length) break;
      await sleep(2000);
    }
    note(`     participations asked by the wallet itself: ${parts.length}`);
    check('the wallet asked a round\'s refresh of every leaf of no round by itself', parts.length >= 1, parts.map((p) => [p.participation && p.participation.slice(0, 8), p.state]));
    const rounds = [];
    for (let i = 0; i < 8; i++) {
      const r = await ctl('/round');
      if (!r.round) { if (rounds.length && !(await coinsNow()).some((c) => ['given', 'pending'].includes(c.state))) break; await sleep(3000); continue; }
      rounds.push(r.round);
      note(`     round ${r.round} (${r.vsize} vB)`);
    }
    for (let i = 0; i < 60; i++) {
      cs = await coinsNow();
      if ([X, Z, I].every((asset) => cs.some((c) => c.asset === asset && c.kind === 'batch' && c.state === 'live'))) break;
      await sleep(2000);
    }
    const zLeaves = cs.filter((c) => c.asset === Z && c.kind === 'batch' && c.state === 'live');
    check('Z refreshed in a round: each new leaf lands at the landing key', zLeaves.length >= 1 && zLeaves.every((c) => c.landing === landing), zLeaves.map((c) => [c.leaf_id.slice(0, 8), c.value, c.landing]));
    const iLeaf = cs.find((c) => c.asset === I && c.kind === 'batch' && c.state === 'live');
    check('I refreshed in an issuer-operated batch', !!iLeaf && iLeaf.batch_profile === 'issuer-operated', iLeaf && iLeaf.batch_profile);
    const xLeaf = cs.find((c) => c.asset === X && c.kind === 'batch' && c.state === 'live');
    check('X\'s new leaf is in an open batch', !!xLeaf && xLeaf.batch_profile === 'open', xLeaf && xLeaf.batch_profile);
    if (rounds.length) {
      const rtx = await rpc('getrawtransaction', [rounds[0], true]);
      check('node: the round is in a block', rtx.confirmations >= 1, { round: rounds[0], confirmations: rtx.confirmations });
    }

    // ---- 4. the issuer-operated asset in developer mode ----
    await pop.click('[data-tab=settings]');
    await pop.waitFor(`!!document.querySelector('#leafSupply [data-asset="${I}"] [data-action=supply]')`, 60000);
    await pop.eval(`document.querySelector('#leafSupply [data-asset="${I}"] [data-action=supply]').click()`);
    await pop.waitFor(`document.querySelector('#leafSupply [data-asset="${I}"]').dataset.checked !== undefined || /refused|error/i.test(document.querySelector('#leafStatus').innerText)`, 120000);
    const sup = await pop.eval(`(()=>{ const r=document.querySelector('#leafSupply [data-asset="${I}"]'); return { checked: r.dataset.checked, text: r.innerText.replace(/\\s+/g,' ') } })()`);
    check('developer mode: I\'s supply, every listed mint and burn read again on this node', sup.checked === 'true', sup.text.slice(0, 300));
    await pop.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.asset===${JSON.stringify(I)} && d.dataset.batchProfile==='issuer-operated')`, 60000).catch(() => {});
    const iRow = await pop.eval(`(()=>{ const d=[...document.querySelectorAll('#leafCoins .leaf-coin')].find(d=>d.dataset.asset===${JSON.stringify(I)} && d.dataset.batchProfile); return d ? d.innerText.replace(/\\s+/g,' ') : '' })()`);
    check('developer mode: I\'s leaf says its batch is issuer-operated', /Batch: issuer-operated: its sweep can only burn/.test(iRow), iRow.slice(0, 200));
    await pop.eval("document.querySelector('#leafSupply').scrollIntoView()");
    await shot(pop, 'issuer-supply-dev');

    // ---- 2. a payment that needs a planned leaf, through the next round, no prompt ----
    let xs = [];
    for (let i = 0; i < 60; i++) {
      const plans = ((await read('plans')) || {}).plans || [];
      const current = new Set(plans.filter((p) => p.state === 'open').map((p) => ((p.steps || []).filter((s) => s.leaf_id).map((s) => s.leaf_id).pop()) || p.coin));
      xs = (await coinsNow()).filter((c) => c.asset === X && c.state === 'live').map((c) => ({ ...c, planned: current.has(c.leaf_id) }));
      if (xs.length && xs.every((c) => c.planned)) break;
      await sleep(2000);
    }
    check('care planned every live X leaf of a round at once (no free X leaf)', xs.length >= 1 && xs.every((c) => c.planned), xs.map((c) => [c.leaf_id.slice(0, 8), c.kind, c.value, c.planned ? 'planned' : 'free']));
    await pop.click('[data-tab=settings]');
    await pop.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.asset===${JSON.stringify(X)} && d.dataset.planned)`, 60000).catch(() => {});
    const marked = await pop.eval(`[...document.querySelectorAll('#leafCoins .leaf-coin')].filter(d=>d.dataset.asset===${JSON.stringify(X)} && d.dataset.planned).length`);
    check('developer mode marks each planned X leaf', marked >= 1, marked);
    await pop.eval("document.querySelector('#leafCoinsCard').scrollIntoView()");
    await shot(pop, 'every-leaf-planned-dev');
    const reqX = cli('receive', '--asset', X, '--amount', '500000').request;
    await site.set('request', reqX); await site.set('asset', ''); await site.set('amount', '');
    const t0 = Date.now();
    await press('#btnSend');
    await approve('approval-send-x', [/Pay from your leaves/, /500000|0\.005/]);
    let releasing = null;
    for (let i = 0; i < 120 && !releasing; i++) { releasing = (await host('status')).releasing; if (!releasing) await sleep(500); }
    check('the payment waits for one round, giving up the planned leaf by itself', !!releasing && releasing.command === 'send' && releasing.coins.length >= 1, releasing);
    await pop.click('[data-tab=settings]');
    await pop.waitFor("!document.querySelector('#leafReleasing').classList.contains('hide')", 30000).catch(() => {});
    const relText = await pop.text('#leafReleasing');
    check('developer mode: "Paying through the next round" while it waits', /^Paying through the next round/.test(relText), relText.slice(0, 200));
    await pop.eval("document.querySelector('#leafCare').scrollIntoView()");
    await shot(pop, 'paying-through-the-next-round-dev');
    const approvalsOpen = async () => (await b.targets()).filter((x) => x.url.includes('/approval/approval.html')).length;
    let rr = null;
    for (let i = 0; i < 30 && !rr; i++) { await sleep(2000); rr = (await ctl('/round')).round; }
    check('the release\'s round was built and is final', !!rr, rr);
    await done('sendLeaves', 900000); a = await answer();
    const sentX = a.ok ? JSON.parse(a.text) : null;
    check('the site\'s payment went through with no further window', !!sentX && sentX.sent && sentX.sent.value === '500000' && (await approvalsOpen()) === 0, sentX ? sentX.sent : a.text);
    note(`     approval to paid: ${Math.round((Date.now() - t0) / 1000)} s, one round`);
    const mbx = cli('sync');
    check('the command-line wallet holds the 500000 X', (mbx.mailbox?.accepted || []).some((c) => c.value === '500000'), (mbx.mailbox?.accepted || []).map((c) => c.value));
    await shot(site, 'paid-through-the-next-round');

    // ---- 3. Z frozen by its issuer at the landing key ----
    const landingSpk = (await rpc('validateaddress', [landing])).scriptPubKey;
    const fz = await ctl('/freeze', { script: landingSpk });
    check('node: the issuer froze the landing key', fz.status && fz.status.frozen === true, fz);
    let zHeld = [];
    for (let i = 0; i < 60; i++) {
      zHeld = (await coinsNow()).filter((c) => c.asset === Z && ['live', 'pending'].includes(c.state));
      if (zHeld.length && zHeld.every((c) => c.frozen && c.frozen.frozen)) break;
      await sleep(2000);
    }
    check('the library reads every held Z leaf frozen', zHeld.length >= 1 && zHeld.every((c) => c.frozen && c.frozen.frozen), zHeld.map((c) => [c.leaf_id.slice(0, 8), c.value, c.frozen]));
    await pop.click('[data-tab=settings]');
    await pop.waitFor(`[...document.querySelectorAll('#leafCoins .leaf-coin')].some(d=>d.dataset.asset===${JSON.stringify(Z)} && d.dataset.frozen==='true')`, 60000).catch(() => {});
    const zRows = await pop.eval(`[...document.querySelectorAll('#leafCoins .leaf-coin')].filter(d=>d.dataset.asset===${JSON.stringify(Z)}).map(d=>({ frozen: d.dataset.frozen, landing: d.dataset.landing, text: d.innerText.replace(/\\s+/g,' ') }))`);
    check('developer mode: each Z leaf says where it lands and that it is frozen, with the sentence', zRows.length >= 1 && zRows.every((r) => r.frozen === 'true' && r.landing === landing && /Lands at/.test(r.text) && FROZEN_SENTENCE.test(r.text)), zRows.map((r) => r.text.slice(0, 160)));
    await pop.eval(`[...document.querySelectorAll('#leafCoins .leaf-coin')].find(d=>d.dataset.asset===${JSON.stringify(Z)}).scrollIntoView()`);
    await shot(pop, 'frozen-leaves-dev');
    // The figure, in developer mode and in user mode: one sentence under it.
    const zRow = async () => pop.eval(`(()=>{ const r=document.querySelector('#assetList .asset-row[data-key=${JSON.stringify(Z)}]'); return r ? { figure: r.querySelector('.fig').innerText, frozen: (r.querySelector('.frozen-line')||{}).innerText||'', text: r.innerText.replace(/\\s+/g,' ') } : null })()`);
    const waitRow = async (want) => { let r = null; for (let i = 0; i < 40; i++) { await pop.click('[data-tab=balance]'); await sleep(1500); r = await zRow(); if (want(r)) break; } return r; };
    // What is frozen: every held Z leaf, and any Z coin a landing put on the chain before
    // (a phrase driven again on a shared harness holds one), as the library counts it.
    const zOnchainFrozen = BigInt((((await read('balance')) || {}).sequentia_onchain_frozen || {})[Z] || 0);
    const zFrozen = (zHeld.reduce((t, c) => t + BigInt(c.value), 0n) + zOnchainFrozen).toString();
    let zr = await waitRow((r) => r && FROZEN_SENTENCE.test(r.frozen) && r.frozen.startsWith(zFrozen + ' '));
    check(`developer mode: Z's figure, and one plain sentence for what is frozen (${zFrozen})`, !!zr && FROZEN_SENTENCE.test(zr.frozen) && zr.frozen.startsWith(zFrozen + ' '), zr);
    await shot(pop, 'frozen-figure-dev');
    await setMode('user');
    zr = await waitRow((r) => r && FROZEN_SENTENCE.test(r.frozen) && r.frozen.startsWith(zFrozen + ' '));
    check('user mode: Z\'s one figure, and the same sentence under it', !!zr && FROZEN_SENTENCE.test(zr.frozen) && zr.frozen.startsWith(zFrozen + ' '), zr);
    await shot(pop, 'frozen-figure-user');
    await setMode('developer');
    // A site's payment of the frozen Z: refused in the library's words.
    const reqZ2 = cli('receive', '--asset', Z, '--amount', '100000').request;
    await site.set('request', reqZ2); await site.set('asset', ''); await site.set('amount', '');
    await press('#btnSend');
    await approve(null, [/Pay from your leaves/]);
    await done('sendLeaves'); a = await answer();
    check('developer mode: a payment of the frozen Z is refused, saying it is frozen', !a.ok && /frozen/i.test(a.text), a.text.slice(0, 300));
    await shot(site, 'frozen-send-refused-dev');

    // ---- the frozen leaf leaves the tree by its landing, into the wallet's own key ----
    const zExit = zHeld.slice().sort((p, q) => Number(BigInt(q.value) - BigInt(p.value)))[0];
    const landedBefore = new Set(((await rpc('scantxoutset', ['start', [`raw(${landingSpk})`]]).catch(() => ({ unspents: [] }))).unspents || []).map((u) => u.txid + ':' + u.vout));
    await site.set('leafId', zExit.leaf_id); await site.set('feeAsset', X);
    await press('#btnExit');
    await approve('approval-exit-z', [/Take a leaf home on-chain/]);
    await done('exitLeaf'); a = await answer();
    const ex = a.ok ? JSON.parse(a.text) : null;
    check('developer mode: the exit of the frozen Z leaf starts', !!ex && !ex.error, ex ? { state: ex.state, broadcast: (ex.broadcast || []).map((x) => x.txid), next: ex.next } : a.text);
    // The wallet's own sync takes the exit on (unroll, then the landing after its delay).
    let claim = null;
    for (let i = 0; i < 60 && !claim; i++) {
      await ctl('/produce');
      if (i % 4 === 3) await ctl('/advance', { seconds: 600 });
      await sleep(3000);
      const utxos = (await rpc('scantxoutset', ['start', [`raw(${landingSpk})`]]).catch(() => ({ unspents: [] }))).unspents || [];
      claim = utxos.find((u) => u.asset === Z && !landedBefore.has(u.txid + ':' + u.vout)) || null;
    }
    await ctl('/produce'); await ctl('/bury');
    check('the exit landed the Z leaf at the landing key', !!claim, claim && { txid: claim.txid, vout: claim.vout, amount: claim.amount });
    if (claim) {
      const tx = await rpc('getrawtransaction', [claim.txid, true]);
      // The landing pays Z to the landing alone; a fee output has an empty script.
      const zOut = tx.vout.filter((o) => o.asset === Z && o.scriptPubKey.hex !== '');
      check('node: the landing pays Z to the landing key alone', zOut.length === 1 && zOut[0].scriptPubKey.hex === landingSpk, zOut.map((o) => [o.value, o.scriptPubKey.hex]));
      const fzState = await rpc('isassetfrozen', [Z, landingSpk]);
      check('node: the landed coin is frozen on the chain', fzState.frozen === true, fzState);
    }
    await pop.click('[data-tab=settings]'); await sleep(1500);
    await shot(pop, 'landed-frozen-dev');
    // User mode: the landed coin counted on the chain, still said frozen; a send refused plainly.
    await setMode('user');
    zr = await waitRow((r) => r && FROZEN_SENTENCE.test(r.frozen) && BigInt((r.figure || '0').replace(/[^\d]/g, '') || 0) > 0n);
    check('user mode: the landed coin still counted, still said frozen', !!zr && FROZEN_SENTENCE.test(zr.frozen), zr);
    await shot(pop, 'landed-frozen-user');
    // The kit's own scan finds the landed coin at its first address.
    const landedAtoms = ((await rpc('scantxoutset', ['start', [`raw(${landingSpk})`]]).catch(() => ({ unspents: [] }))).unspents || [])
      .filter((u) => u.asset === Z).reduce((t, u) => t + BigInt(Math.round(u.amount * 1e8)), 0n);
    let zOn = null;
    for (let i = 0; i < 40; i++) {
      await ui('sync').catch(() => {});
      zOn = ((await ui('overview', { withLn: false })).rows || []).find((r) => r.key === Z);
      if (zOn && BigInt(zOn.onchain) >= landedAtoms && landedAtoms > 0n && BigInt(zOn.total) === BigInt(zOn.frozen)) break;
      await ctl('/produce'); await sleep(3000);
    }
    check('the landed coin is the wallet\'s on the chain (the kit sees it at its first address)', !!zOn && BigInt(zOn.onchain) > 0n, zOn && { onchain: zOn.onchain, leaves: zOn.leaves, frozen: zOn.frozen, total: zOn.total });
    // Every Z the wallet holds is frozen now (the landed coin and the leaf left): the
    // figure counts the landed coin once, so it equals what is frozen.
    check('the figure counts the landed coin once (on-chain + leaves = what is frozen)', !!zOn && BigInt(zOn.total) === BigInt(zOn.frozen), zOn && { total: zOn.total, frozen: zOn.frozen });
    await pop.eval('location.reload()');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    await pop.click('[data-tab=send]');
    await pop.waitFor(`[...document.querySelectorAll('#sendAsset option')].some(o=>o.value===${JSON.stringify(Z)})`, 120000).catch(() => {});
    await pop.set('sendTo', cli('address').address);
    await pop.set('sendAsset', Z);
    await pop.waitFor(`[...document.querySelectorAll('#feeAsset option')].some(o=>o.value===${JSON.stringify(Z)})`, 30000).catch(() => {});
    await pop.set('feeAsset', Z);
    await pop.set('sendAmt', '1000');
    await pop.click('#btnReview');
    await pop.waitFor("[...document.querySelectorAll('.modal button')].some(b=>/Confirm/.test(b.textContent)) || document.querySelector('#sendErr').innerText.length > 0", 120000);
    let sendErr = await pop.text('#sendErr');
    if (!sendErr) {
      await pop.eval("[...document.querySelectorAll('.modal button')].find(b=>/Confirm/.test(b.textContent)).click()");
      await pop.waitFor("(()=>{ const s=document.querySelector('.modal .status'); return !document.querySelector('.modal') || (s && /Failed/.test(s.innerText)) })()", 120000);
      sendErr = await pop.eval("(document.querySelector('.modal .status')||{}).innerText||''");
    }
    check('user mode: a send of the frozen Z is refused in plain words', sendErr.includes(FROZEN_PLAIN), sendErr);
    await shot(pop, 'frozen-send-refused-user');
    await pop.eval("(()=>{ const m=document.querySelector('.modal'); if (m) [...m.querySelectorAll('button')].find(b=>/Cancel/.test(b.textContent)).click(); return true })()");
    await pop.click('[data-tab=balance]');
    await setMode('developer');

    // ---- lifted: the record spent; Z paid again ----
    const lf = await ctl('/lift', { script: landingSpk });
    check('node: the issuer lifted the freeze', lf.status && lf.status.frozen === false, lf);
    for (let i = 0; i < 4; i++) { await ctl('/produce'); await ctl('/bury'); }
    let paidAgain = null;
    for (let i = 0; i < 12 && !paidAgain; i++) {
      const r = cli('receive', '--asset', Z, '--amount', '100000').request;
      await site.set('request', r); await site.set('asset', ''); await site.set('amount', '');
      await press('#btnSend');
      await approve(i === 0 ? 'approval-send-z-lifted' : null, [/Pay from your leaves/]);
      await done('sendLeaves'); a = await answer();
      if (a.ok) paidAgain = JSON.parse(a.text);
      else { note('     not yet: ' + a.text.slice(0, 200)); await ctl('/produce'); await ctl('/bury'); await sleep(3000); }
    }
    check('lifted: Z is paid again', !!paidAgain && paidAgain.sent.value === '100000', paidAgain ? paidAgain.sent : null);
    await shot(site, 'lifted-paid-again');
    await setMode('user');
    zr = await waitRow((r) => r && !r.frozen);
    check('user mode after the lift: no frozen sentence', !!zr && !zr.frozen, zr);
    await setMode('developer');

    // ---- 5. the bond ----
    await pop.click('[data-tab=settings]');
    await pop.waitFor("document.querySelector('#leafBond').dataset.state === 'bonded'", 120000).catch(() => {});
    const bondShown = await pop.text('#leafBond');
    check('developer mode: the bond, its asset, value and state, and the last watch', /State\s*bonded/.test(bondShown) && /Bond\s*5000000 of/.test(bondShown) && /Required by this wallet\s*yes/.test(bondShown) && /Last watch/.test(bondShown), bondShown.replace(/\s+/g, ' ').slice(0, 400));
    await pop.eval("document.querySelector('#leafBond').scrollIntoView()");
    await shot(pop, 'bond-bonded-dev');
    const ended = await ctl(bondEnd === 'drop' ? '/bond_drop' : '/bond_notice', {});
    note(`     the bond ${bondEnd === 'drop' ? 'dropped' : 'in notice'}: ${JSON.stringify(ended)}`);
    await pop.click('#btnLeafWatchBond');
    await pop.waitFor(`document.querySelector('#leafBond').dataset.state === ${JSON.stringify(bondEnd === 'drop' ? 'missing' : 'noticed')}`, 120000).catch(() => {});
    const bondNow = await pop.text('#leafBond');
    check(`developer mode shows the bond ${bondEnd === 'drop' ? 'missing' : 'in notice'}`, new RegExp(bondEnd === 'drop' ? 'missing' : 'noticed').test(bondNow), bondNow.replace(/\s+/g, ' ').slice(0, 400));
    await shot(pop, 'bond-ended-dev');
    await site.set('asset', X); await site.set('amount', '600000');
    await press('#btnReceive');
    await approve(null, [/receive request for leaves/]);
    await done('requestLeafReceive'); a = await answer();
    check('a receive is refused, naming the bond', !a.ok && /\bbond\b/.test(a.text), a.text.slice(0, 300));
    await shot(site, 'bond-receive-refused');

    // ---- 6. the user-mode screens ----
    await setMode('user');
    const texts = [];
    for (const t of ['balance', 'send', 'receive', 'stake']) {
      await pop.click(`[data-tab=${t}]`); await sleep(800);
      texts.push(await pop.eval(`document.querySelector('#t${t[0].toUpperCase() + t.slice(1)}').innerText`));
    }
    texts.push(await pop.eval("(document.querySelector('.hdr')||{}).innerText||''"));
    const words = devWordsIn(texts.join('\n'));
    check('user mode: Balance, Send, Receive, Stake and the header carry no developer word', words.length === 0, words);
    await pop.click('[data-tab=balance]'); await sleep(800);
    await shot(pop, 'user-mode-balance-end');
    problems = b.problems.splice(0);
    check('no exception or console error from the extension\'s contexts during the drive', problems.length === 0, problems.length ? problems.slice(0, 8) : undefined);
  } finally {
    await b.close().catch(() => {});
    dev.kill();
    box.close();
    await shim.close();
  }
}

main().then(() => {
  note(failures ? `${failures} check(s) failed` : 'all passed');
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failures ? 1 : 0);
}).catch(async (e) => {
  note('ERROR ' + (e.stack || e));
  try { if (b) await b.close(); } catch {}
  process.exit(1);
});
