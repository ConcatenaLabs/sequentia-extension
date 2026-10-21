#!/usr/bin/env node
// One phrase, every component of its balance, read by the extension's popup on a private
// regtest chain where another wallet put them: on-chain coins, leaves in a local operator's
// tree, a Lightning channel, and the Sequence token staked under both locks. The web wallet's
// tooling/total-drive.mjs puts them there (and writes the phrase to a file of mode 600); this
// drive opens the same phrase in the extension, joins the same operator (its leaf wallet
// restores the leaves from the mailbox, as joining does), and reads the popup's one
// figure per asset and its headline in user mode, beside the web wallet's (`WEB_TOTALS`).
// It reads only: nothing is boarded, sent, bonded or spent.
//
// Every endpoint is reached at https://sequentiatestnet.com through a stand-in box: the
// explorer (an esplora shim over the harness's node), the anchor lookup, the prices and fee
// rates, the registry, and the LSP's /status, served in its shape with one channel of the
// wallet's own asset node (the figure reads only that status: the counting is checked, not a
// channel). The extension is copied to the work directory with its engine on the chain's
// network, as the market drive does.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 TOTAL_PHRASE_FILE=… [WEB_TOTALS=…/totals.json] \
//     node test/leaves/total-drive.mjs <evidence-dir> <work-dir>
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';
import { startEsploraShim } from '../regtest/esplora-shim.mjs';
import { developerWordsIn } from '../../src/balance-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const phraseFile = process.env.TOTAL_PHRASE_FILE;
const out = resolve(process.argv[2] || 'total-evidence');
const work = resolve(process.argv[3] || '/tmp/total-drive');
if (!CHROME || !phraseFile) { console.error('set CHROME and TOTAL_PHRASE_FILE'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
writeFileSync(logFile, '');
const note = (s) => { console.log(s); appendFileSync(logFile, s + '\n'); };
let failures = 0;
function check(name, ok, detail) {
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
  if (!ok) failures++;
  return ok;
}
const ctl = async (path, body) => {
  const r = await fetch(`http://${control}${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
};
const rpc = (method, params = []) => ctl('/rpc', { method, params });

const PRICES = { SEQ: { price: 0.5 }, XTOT: { price: 0.01 }, tBTC: { price: 60000 } };
const LN_X = 700_000;

async function main() {
  const st = await ctl('/state');
  const X = st.x;
  const policy = (await rpc('getsidechaininfo')).pegged_asset;
  note(`operator ${st.server}; node ${st.node_url}; genesis ${st.genesis_hash}; X ${X}; policy ${policy}`);
  const mnemonic = readFileSync(phraseFile, 'utf8').trim();

  // ---- the extension, its engine on the chain's network ----
  const EXT = join(work, 'extension');
  rmSync(EXT, { recursive: true, force: true });
  cpSync(SRC, EXT, { recursive: true, filter: (p) => !/\/(\.git|test|node_modules)(\/|$)/.test(p.slice(SRC.length)) });
  const engineFile = join(EXT, 'src/engine.js');
  const src = readFileSync(engineFile, 'utf8');
  const from = 'network = Network.sequentiaTestnet();';
  if (src.split(from).length !== 2) throw new Error('engine.js: the network line changed; update the drive');
  writeFileSync(engineFile, src.replace(from, `network = Network.regtestWithGenesis(new AssetId(${JSON.stringify(policy)}), ${JSON.stringify(st.genesis_hash)});`));

  // ---- the explorer, the operator's CORS front, and the stand-in box ----
  const shimPort = await new Promise((ok) => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const q = t.address().port; t.close(() => ok(q)); }); });
  const shim = await startEsploraShim({ rpc: { url: st.node_url, auth: `${st.node_user}:${st.node_password}` }, port: shimPort });
  const dev = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const devBase = await new Promise((ok) => dev.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  const key = join(work, 'box.key'), crt = join(work, 'box.crt');
  if (!existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization' };
  const asked = new Set();
  const box = https.createServer({ key: readFileSync(key), cert: readFileSync(crt) }, async (req, res) => {
    const url = new URL(req.url, 'https://sequentiatestnet.com');
    const p = url.pathname;
    const send = (code, data, type = 'application/json') => { res.writeHead(code, { ...CORS, 'Content-Type': type }); res.end(data); };
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (!asked.has(p.split('/').slice(0, 3).join('/'))) { asked.add(p.split('/').slice(0, 3).join('/')); }
    try {
      if (p.startsWith('/api/') || p.startsWith('/anchor/')) {
        const parts = []; for await (const c of req) parts.push(c);
        const r = await fetch(shim.url + p + url.search, { method: req.method, body: req.method === 'POST' ? Buffer.concat(parts) : undefined });
        return send(r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/json');
      }
      if (p === '/prices') return send(200, JSON.stringify(PRICES));
      if (p === '/feerates') return send(200, JSON.stringify(await rpc('getfeeexchangerates')));
      if (p === '/registry/index.minimal.json') {
        return send(200, JSON.stringify({ [X]: ['regtest.invalid', 'XTOT', 'Drive asset', 0, true, false], [policy]: ['regtest.invalid', 'tSEQ', 'Sequence', 8, true, false] }));
      }
      if (p === '/lsp/status') {
        // One channel of a node of the wallet's own (the LSP marks those with their node key).
        const nodes = (url.searchParams.get('nodes') || '').split(',').filter(Boolean);
        const channels = nodes.length ? [{ node_key: nodes[nodes.length - 1], asset: X, asset_label: 'XTOT', leg: 'asset', state: 'CHANNELD_NORMAL',
          balance_units: LN_X, spendable_units: LN_X - 7000, receivable_units: 0, short_channel_id: '1x1x0' }] : [];
        return send(200, JSON.stringify({ ok: true, channels, nodes: nodes.map((k) => ({ node_key: k, up: true })) }));
      }
    } catch (e) { return send(500, String(e.message), 'text/plain'); }
    send(404, 'not served by the stand-in box', 'text/plain');
  });
  await new Promise((ok) => box.listen(0, '127.0.0.1', ok));
  const boxPort = box.address().port;
  note(`box at 127.0.0.1:${boxPort} (https://sequentiatestnet.com for the browser); operator front ${devBase}`);

  const b = new Browser({
    chrome: CHROME, profile: join(work, 'profile'), ext: EXT, consoleLog: join(out, 'console.log'), headless: true,
    extraArgs: ['--ignore-certificate-errors', `--host-resolver-rules=MAP sequentiatestnet.com 127.0.0.1:${boxPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`],
  });
  try {
    await b.launch('total');
    const swTarget = await b.serviceWorker();
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop.waitFor("document.querySelector('#btnStartImport') && document.querySelector('#btnStartImport').offsetParent !== null && !!document.querySelector('#btnStartImport').onclick", 60000);
    await pop.click('#btnStartImport');
    await pop.set('importPhrase', mnemonic);
    await pop.set('importPw', 'drive-password'); await pop.set('importPw2', 'drive-password');
    await pop.click('#btnImportGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    const ui = (method, params = {}) => pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
    const first = (await ui('receive', { confidential: false })).result.address;
    note(`     the phrase's first address in the extension: ${first}`);

    // ---- leaves: join the same operator (which restores the phrase's leaves) ----
    await pop.click('[data-tab=settings]');
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); s.value='developer'; s.dispatchEvent(new Event('change')); return true})()");
    await pop.waitFor("!document.querySelector('#leafCard').classList.contains('hide')", 30000);
    await pop.set('leafServer', devBase + 'operator'); await pop.set('leafNodeUrl', devBase + 'node');
    await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
    await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
    await pop.click('#btnLeafJoin');
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
    check('the extension joined the same operator', (await pop.text('#leafOperator')).trim().length === 64, await pop.text('#leafStatus'));
    // The leaf host answers the service worker (a page's message would be answered by the
    // worker first): restore is asked from the worker's own context.
    const sw = await b.pageOf(swTarget.targetId);
    const host = (args, op = 'run') => sw.eval(`chrome.runtime.sendMessage({scope:'leaf', op:${JSON.stringify(op)}, args:${JSON.stringify(args)}})`);
    // Joining restored the phrase's leaves from the mailbox: nothing more is asked for them.
    const bal = await host({ command: 'balance', args: {} });
    note(`     leaf balance: ${JSON.stringify(bal.ok ? bal.value.result : bal.error)}`);
    const live = bal.ok ? Object.values((bal.value.result || {}).arca || {}).reduce((n, st) => n + BigInt((st && st.live) || 0), 0n) : 0n;
    check('joining restored the phrase\'s leaves', live > 0n, String(live));
    const careAt = await host({}, 'status');
    note(`     care, as it ran once the leaf wallet opened: ${JSON.stringify(careAt && careAt.value && careAt.value.lastCare && careAt.value.lastCare.summary)}`);

    // ---- user mode: the popup's figures and headline ----
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); s.value='user'; s.dispatchEvent(new Event('change')); return true})()");
    await pop.waitFor("document.querySelector('#leafCard').classList.contains('hide')", 30000);
    let ov = null;
    for (let i = 0; i < 60; i++) {
      ov = (await ui('overview', { withLn: true })).result;
      const x = ov.rows.find((r) => r.key === X), s = ov.rows.find((r) => r.key === policy);
      if (x && s && BigInt(x.ln) > 0n && BigInt(x.leaves) > 0n && BigInt(s.staked) > 0n && BigInt(x.onchain) > 0n) break;
      await sleep(3000);
    }
    await pop.click('[data-tab=balance]');
    await pop.eval('location.reload()');
    await pop.waitFor("document.querySelectorAll('#assetList .asset-row').length >= 3 && document.querySelector('#headline').innerText !== '—'", 120000)
      .catch(async (e) => { note('     overview: ' + JSON.stringify(ov).slice(0, 3000)); note('     popup: ' + (await pop.text('#tBalance'))); throw e; });
    await sleep(8000);   // the popup's second pass, with Lightning
    const rows = await pop.eval("[...document.querySelectorAll('#assetList .asset-row')].map((r)=>({ key: r.dataset.key, tk: r.querySelector('.tk').innerText, figure: r.querySelector('.fig').innerText, value: (r.querySelector('.amt .sub')||{}).innerText||'' }))");
    const headline = await pop.text('#headline');
    note(`     popup (user mode): headline ${headline}; ${rows.map((r) => `${r.tk} ${r.figure} (${r.value})`).join('; ')}`);
    const parts = Object.fromEntries(ov.rows.map((r) => [r.ticker, { onchain: r.onchain, leaves: r.leaves, ln: r.ln, staked: r.staked, total: r.total }]));
    note(`     the parts of each figure (the worker's overview): ${JSON.stringify(parts)}`);
    // Each tSEQ and XTOT row opened, for the screenshot: its parts a tap away.
    for (const k of [policy, X]) await pop.eval(`(()=>{ const r=document.querySelector('#assetList .asset-row[data-key=${JSON.stringify(k)}]'); if (r && r.classList.contains('tappable')) r.click(); return true })()`);
    await sleep(800);
    await pop.shot(join(out, '01-user-mode-totals.png'));
    const splits = await pop.eval("[...document.querySelectorAll('#assetList .asset-row')].map((r)=>({ tk: r.querySelector('.tk').innerText, split: (r.querySelector('.rail-split')||{}).innerText||'' }))");
    note(`     user mode, rows tapped: ${JSON.stringify(splits)}`);
    const words = developerWordsIn(await pop.eval("document.querySelector('#tBalance').innerText"));
    check('user mode: the Balance tab carries no developer word', words.length === 0, words);

    const totals = { rows: rows.map((r) => ({ tk: r.tk, total: r.figure + ' ' + r.tk })), headline, parts, splits, first_address: first };
    writeFileSync(join(out, 'totals.json'), JSON.stringify(totals, null, 1));
    const web = process.env.WEB_TOTALS ? JSON.parse(readFileSync(process.env.WEB_TOTALS, 'utf8')) : null;
    if (web) {
      const norm = (s) => String(s).replace(/,/g, '').trim();
      for (const w of web.rows) {
        const mine = totals.rows.find((r) => r.tk === w.tk);
        check(`${w.tk}: the extension's figure equals the web wallet's (${w.total})`, !!mine && norm(mine.total) === norm(w.total), mine);
      }
      check(`the headline equals the web wallet's (${web.headline})`, norm(headline) === norm(web.headline), headline);
      check('the same phrase: the same first address', first === web.mnemonic_first_address, { extension: first, web: web.mnemonic_first_address });
    }
    note(`     the box was asked: ${[...asked].join(' ')}`);
    const problems = b.problems.splice(0);
    note(`     extension console problems: ${problems.length}${problems.length ? ' ' + JSON.stringify(problems.slice(0, 5)) : ''}`);
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
}).catch((e) => { note('ERROR ' + (e.stack || e)); process.exit(1); });
