#!/usr/bin/env node
// A site trading through the extension in user mode, against the live testnet, in headless
// Chromium: the unpacked extension and the SeqDEX site of a checkout, served by the stand-in box
// in upstream mode (test/market/box.mjs; every other path goes to the real box). One profile at a
// time.
//
//   mode   a new wallet set to developer mode while its join is under way: the leaf host, once
//          open, does not run default mode's boarding (it keeps the mode set last). With
//          EXT=<an older checkout> the same step shows what an older build does.
//   trade  a new wallet in user mode joins by itself; the faucet pays its receive code (so the
//          coin is a leaf); the site, connected through its chooser, shows the leaf as balance;
//          a market sale is declined in the approval window, then approved and traded from the
//          leaves.
//
//   CHROME=… SITE=<seqdex-web checkout> UPSTREAM=https://<box ip> [PAIR=EURX-USDX] [SELL=1]
//     node test/default/site-drive.mjs <evidence-dir> <work-dir> [mode] [trade]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from '../leaves/cdp.mjs';
import { startBox } from '../market/box.mjs';
import { forbiddenIn } from '../../vendor/user-trade.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT ? resolve(process.env.EXT) : resolve(here, '../..');
const { CHROME, SITE, UPSTREAM } = process.env;
const PAIR = process.env.PAIR || 'EURX-USDX';
const SELL = process.env.SELL || '1';
const out = resolve(process.argv[2] || 'site-evidence');
const work = resolve(process.argv[3] || '/tmp/site-drive');
const steps = process.argv.slice(4).length ? process.argv.slice(4) : ['mode', 'trade'];
if (!CHROME || !SITE || !UPSTREAM) { console.error('set CHROME, SITE and UPSTREAM'); process.exit(2); }
mkdirSync(join(out, 'screens'), { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'site-drive.log');
appendFileSync(logFile, `\n=== ${new Date().toISOString()} ${steps.join(' ')} (extension ${EXT}) ===\n`);
const T0 = Date.now();
const note = (s) => { const l = `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${s}`; console.log(l); appendFileSync(logFile, l + '\n'); };
let failures = 0;
const check = (name, ok, detail) => { note(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== undefined ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); if (!ok) failures++; return ok; };
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1) + ' s';
let shotN = 0;
const shot = (p, name) => p.shot(join(out, 'screens', `${String(++shotN).padStart(2, '0')}-${name}.png`));

const key = join(work, 'box.key'), crt = join(work, 'box.crt');
if (!existsSync(crt)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
const box = await startBox({ tls: { key: readFileSync(key), cert: readFileSync(crt) }, site: resolve(SITE), upstream: UPSTREAM });
note(`box at 127.0.0.1:${box.port}, upstream ${UPSTREAM}, site ${SITE}`);

async function open(label) {
  const b = new Browser({ chrome: CHROME, profile: join(work, 'profile-' + label + '-' + Date.now()), ext: EXT, consoleLog: join(out, 'console-' + label + '.log'), headless: true,
    extraArgs: ['--ignore-certificate-errors', '--window-size=1300,1700', `--host-resolver-rules=MAP sequentiatestnet.com 127.0.0.1:${box.port}`] });
  await b.launch(label);
  await b.serviceWorker();
  const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
  pop.ui = async (method, params = {}) => {
    const r = await pop.eval(`chrome.runtime.sendMessage({scope:'ui', method:${JSON.stringify(method)}, params:${JSON.stringify(params)}})`);
    if (!r || !r.ok) throw new Error(method + ': ' + ((r && r.error) || 'no answer'));
    return r.result;
  };
  return { b, pop, label };
}
async function create(w) {
  await w.pop.waitFor("!!document.querySelector('#btnStartCreate') && !!document.querySelector('#btnStartCreate').onclick", 60000);
  await w.pop.click('#btnStartCreate');
  await w.pop.waitFor("!!document.querySelector('#newPhrase').dataset.phrase");
  await w.pop.set('createPw', 'drive-password'); await w.pop.set('createPw2', 'drive-password');
  const t = Date.now();
  await w.pop.click('#btnCreateGo');
  await w.pop.waitFor("!document.querySelector('#vApp').classList.contains('hide')", 120000);
  return t;
}
async function joined(w, t, ms = 240000) {
  for (;;) {
    const j = await w.pop.ui('default.joined').catch(() => ({}));
    if (j.joined && j.open) { j.after = secs(t); return j; }
    if (Date.now() - t > ms) return j;
    await sleep(1000);
  }
}
const rows = async (w) => Object.fromEntries((await w.pop.ui('overview', { withLn: false })).rows.map((r) => [r.ticker, r]));
async function faucet(w, asset) {
  await w.pop.click('[data-tab=receive]'); await sleep(800);
  const tf = Date.now();
  await w.pop.click(`#faucetBtns [data-faucet="${asset === 'tSEQ' ? '' : asset}"]`);
  await w.pop.waitFor("/Received|could not|error/i.test((document.querySelector('#faucetStatus')||{}).innerText||'')", 240000);
  const fs = await w.pop.text('#faucetStatus');
  check(`${w.label}: the faucet paid ${asset}`, /^Received /.test(fs), `${fs} (${secs(tf)})`);
}
let current = null;
async function session(label, fn) {
  const w = await open(label); current = w;
  try { return await fn(w); } finally {
    const probs = w.b.problems.filter((p) => !/ERR_CERT|favicon/.test(p));
    check(`${label}: no error or exception in the extension's contexts`, !probs.length, probs.slice(0, 10));
    await w.b.close().catch(() => {}); current = null;
  }
}

// The approval window: its text checked, a screenshot, then Approve or Reject.
async function approval(w, name, expect, approve) {
  const t = await w.b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 900000);
  const a = await w.b.pageOf(t.targetId);
  await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 60000);
  const body = await a.text('#reqCard');
  const miss = expect.filter((re) => !re.test(body));
  check(`${w.label}: the approval window shows ${name}`, !miss.length, miss.length ? { missing: miss.map(String), body: body.replace(/\s+/g, ' ').slice(0, 800) } : body.replace(/\s+/g, ' ').slice(0, 800));
  await shot(a, `${w.label}-approval-${name}-${approve ? 'approve' : 'reject'}`);
  await a.click(approve ? '#btnApprove' : '#btnReject');
  for (let i = 0; i < 100 && (await w.b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100);
  return body;
}
const STATUS = "(()=>{ const s=document.querySelector('#fStatus'); return s && (s.classList.contains('ok') || s.classList.contains('err')) ? (s.classList.contains('ok') ? 'ok: ' : 'err: ') + s.textContent : false })()";
async function siteStatus(p, ms = 900000) {
  await p.waitFor(STATUS, ms);
  return await p.eval(STATUS);
}
async function sell(p, amount) {
  await p.click('#type-market'); await sleep(300); await p.click('#side-sell'); await sleep(300);
  await p.set('fAmount', amount); await p.click('#fGo');
}

async function stepMode() {
  await session('M', async (M) => {
    const t = await create(M);
    // While the wallet joins the operator its user mode runs on (the join reads the mode at its
    // start and takes 20 s or more), the person turns developer mode on.
    await sleep(Number(process.env.MODE_DELAY_MS || 3000));
    let set = null;
    for (let i = 0; i < 30 && !set; i++) { try { set = await M.pop.ui('setMode', { mode: 'developer' }); } catch (e) { note('     setMode: ' + e.message); await sleep(500); } }
    check('M: developer mode set while the wallet joins', set && set.mode === 'developer', `${JSON.stringify(set)} ${secs(t)} after Create`);
    const j = await joined(M, t);
    note(`     M: joined ${j.joined}, open ${j.open}, ${j.after || ''}`);
    // The leaf host's own word on default mode's upkeep (boarding), read at once and for 30 s.
    const seen = [];
    for (let i = 0; i < 15; i++) {
      const st = await M.pop.ui('leaves.state').catch((e) => ({ error: e.message }));
      seen.push(st && st.status ? st.status.defaultMode : 'n/a');
      await sleep(2000);
    }
    check('M: the leaf host never runs default mode\'s boarding after the change', j.joined && seen.length && seen.every((v) => v === false), seen);
    const log = readFileSync(join(out, 'console-M.log'), 'utf8');
    check('M: the leaf host boarded nothing', !/\[leaves\] board of/.test(log), (log.match(/\[leaves\] board[^\n]*/g) || []).slice(0, 3));
  });
}

async function stepTrade() {
  await session('T', async (T) => {
    const t = await create(T);
    const j = await joined(T, t);
    check('T: joined the operator by itself (user mode)', j.joined && j.open, j);
    const [baseTk] = PAIR.split('-');
    if (process.env.FAUCET_ONCHAIN) {
      // Paid on the chain, at the address the wallet shows: default mode boards it by itself.
      await T.pop.click('[data-tab=receive]');
      await T.pop.waitFor("/^bitcoin:tb1/i.test((document.querySelector('#recvDCode')||{}).innerText||'')", 120000);
      const addr = decodeURIComponent(String(await T.pop.text('#recvDCode')).replace(/^bitcoin:/i, '').split('?')[0]).trim();
      const r = await fetch('https://sequentiatestnet.com/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, asset: baseTk }) }).then(async (x) => ({ ok: x.ok, t: await x.text() })).catch((e) => ({ ok: false, t: e.message }));
      check(`T: the faucet paid ${baseTk} on the chain to ${addr}`, r.ok, r.t.slice(0, 200));
    } else await faucet(T, baseTk);
    // The coin lands as a leaf (the receive code's tree part).
    let r = null;
    const tw = Date.now();
    while (Date.now() - tw < (process.env.FAUCET_ONCHAIN ? 900000 : 240000)) { r = (await rows(T))[baseTk]; if (r && BigInt(r.leaves || 0) > 0n && BigInt(r.arriving || 0) === 0n) break; await sleep(5000); }
    note(`     T: ${baseTk} held as leaves after ${secs(tw)}`);
    check(`T: ${baseTk} is held as leaves`, r && BigInt(r.leaves || 0) > 0n, r && { onchain: r.onchain, leaves: r.leaves, total: r.total });

    const site = await T.b.page(`https://sequentiatestnet.com/dex/index.html?pair=${PAIR}&view=default`);
    await site.waitFor("document.querySelector('#btnConnect') && document.querySelector('#fGo')", 120000);
    await site.click('#btnConnect'); await sleep(1500);
    const menu = await site.text('#connectMenu');
    check('T: the chooser lists every wallet', /Sequentia web wallet/.test(menu) && /Ambra mobile/.test(menu) && /Ambra browser\s*Ready/.test(menu), menu.replace(/\s+/g, ' '));
    await shot(site, 'T-site-chooser');
    await site.click('#connectMenu [data-connector="extension"]');
    await approval(T, 'connect', [/wants to connect/], true);
    await site.waitFor("document.querySelector('#btnConnect').classList.contains('ok')", 60000);
    await sleep(3000);
    const bal = await site.eval("document.body.innerText");
    const held = (bal.match(new RegExp('[^\\n]*' + baseTk + '[^\\n]*[1-9][^\\n]*', 'g')) || []).slice(0, 4);
    check(`T: the site shows the ${baseTk} held as leaves`, held.length > 0, held);
    await shot(site, 'T-site-connected');

    await sell(site, SELL);
    const shown = await approval(T, 'trade', [/You pay/, new RegExp(SELL + ' ' + baseTk), /You get/, /Asked by/], false);
    check('T: the approval says none of the words default mode never says', !forbiddenIn(shown).filter((w) => w !== 'on-chain').length, forbiddenIn(shown));
    let st = await siteStatus(site);
    check('T: declined: the site says the wallet refused it', /^err: .*rejected/.test(st), st);
    const tt = Date.now();
    await sell(site, SELL);
    await approval(T, 'trade', [/You pay/, /You get/, /Asked by/], true);
    st = await siteStatus(site);
    check('T: approved: the site says it traded', /^ok: Traded with 1 order/.test(st), `${st} (${secs(tt)} from the click)`);
    await sleep(5000);
    const body = await site.eval("document.body.innerText");
    const ord = (body.match(new RegExp('[^\\n]*Sold ' + SELL + ' ' + baseTk + '[^\\n]*', 'g')) || []).slice(0, 3);
    check('T: the trade is listed on the site', ord.length >= 1, ord);
    await shot(site, 'T-site-traded');
    const after = (await rows(T))[baseTk] || {};
    note(`     T: ${baseTk} after: ${JSON.stringify({ onchain: after.onchain, leaves: after.leaves, total: after.total })}`);
    writeFileSync(join(out, 'T-trade-records.json'), JSON.stringify(await T.pop.eval("chrome.storage.local.get('ext.siteTrade').then((x)=>x['ext.siteTrade']||{})").catch(() => ({})), null, 1));
  });
}

try {
  if (steps.includes('mode')) await stepMode();
  if (steps.includes('trade')) await stepTrade();
} catch (e) {
  check('drive ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  if (current) await current.b.close().catch(() => {});
}
box.close && box.close();
note(`done: ${failures} failed`);
process.exit(failures ? 1 : 0);
