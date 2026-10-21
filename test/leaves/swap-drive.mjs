#!/usr/bin/env node
// Drives an in-tree swap through the wallet's provider end to end, in Chromium with this
// extension loaded, against a local regtest operator, with the operator repository's
// command-line wallet as the other wallet:
//
//  - the wallet is created in the popup, put in developer mode and joins the operator;
//    the test site (test/leaves/site.html) connects and boards Y into leaves; the
//    command-line wallet holds leaves of X;
//  - the command-line wallet offers X for Y; the site accepts the offer
//    (`leafSwapAccept`): the approval shows what the wallet gets, gives and pays before
//    anything is signed; the command-line wallet completes it; both wallets' leaves move,
//    and nothing goes on the chain;
//  - the other way: the site offers Y for X (`leafSwapOffer`, approval showing what is
//    given, got and paid), the command-line wallet accepts, the site completes it
//    (`leafSwapComplete`, approval shown); both wallets' leaves move again;
//  - `getLeafSwaps` lists both swaps done; an offer rejected in its window is cancelled
//    and its coins are free; in user mode every swap method is refused before any window.
//
// Every step is a DOM assertion (drive.log) and a screenshot, and the drive fails on any
// exception or console error from the extension's own contexts.
//
//   CHROME=… ARCA_OPERATOR_CONTROL=127.0.0.1:18640 ARCA_CLI=/path/to/arca HEADLESS=1 \
//     node test/leaves/swap-drive.mjs <evidence-dir> <work-dir>
//
// Every host name but 127.0.0.1 resolves to nothing: the drive reaches no public server.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../..');
const CHROME = process.env.CHROME;
const control = process.env.ARCA_OPERATOR_CONTROL || '127.0.0.1:18640';
const cliBin = process.env.ARCA_CLI;
const out = resolve(process.argv[2] || 'leaf-swap-evidence');
const work = resolve(process.argv[3] || mkdtempSync('/tmp/leaf-swap-drive-'));
if (!CHROME || !cliBin) { console.error('set CHROME and ARCA_CLI'); process.exit(2); }
mkdirSync(out, { recursive: true }); mkdirSync(work, { recursive: true });
const logFile = join(out, 'drive.log');
const consoleLog = join(out, 'console.log');
writeFileSync(logFile, ''); writeFileSync(consoleLog, '');
const note = (s) => { console.log(s); appendFileSync(logFile, s + '\n'); };

let failures = 0, step = 0;
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
const cliDir = join(work, 'cli');
const cli = (...args) => {
  let text;
  try {
    text = execFileSync(cliBin, ['--datadir', cliDir, '--witness-patience', '3', ...args],
      { env: { ...process.env, ARCA_NODE_PASSWORD: 'arca' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  } catch (e) { text = e.stdout.toString(); }
  return JSON.parse(text);
};
const live = (bal, asset) => Object.entries((bal.arca || {})[asset] || {}).filter(([st]) => !/spent|given|offered|sending/.test(st)).reduce((t, [, v]) => t + BigInt(v), 0n);

const profile = join(work, 'chrome-profile');
const b = new Browser({
  chrome: CHROME, profile, ext: EXT, consoleLog, headless: process.env.HEADLESS === '1',
  extraArgs: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
});
async function shot(p, name) {
  step++;
  const f = join(out, `${String(step).padStart(2, '0')}-${name}.png`);
  await p.shot(f);
  note(`     screenshot ${f.split('/').pop()}`);
}
async function readConsole(label) {
  await b.serviceWorker();
  await sleep(3000);
  const mine = b.problems.splice(0);
  check(`${label}: the service worker started (${b.extId}) and its console shows no exception or error`, mine.length === 0, mine.length ? mine : undefined);
}
let siteOut = async () => '';
async function approve(name, expect, decide = true) {
  const t = await b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 120000)
    .catch(async (e) => { throw new Error(`${name}: no approval window; the site's last answer: ${await siteOut()}`); });
  const a = await b.pageOf(t.targetId);
  await a.waitFor("document.querySelector('#reqCard') && !document.querySelector('#reqCard').classList.contains('hide')", 30000);
  const title = await a.text('#reqTitle');
  const body = await a.text('#reqCard');
  check(`approval screen "${title}" shown`, expect.every((re) => re.test(body)), body.replace(/\s+/g, ' ').slice(0, 700));
  await shot(a, name);
  await a.click(decide ? '#btnApprove' : '#btnReject');
  for (let i = 0; i < 100 && (await b.targets()).some((x) => x.targetId === t.targetId); i++) await sleep(100);
  return body;
}

async function main() {
  const srv = spawn(process.execPath, [join(here, 'dev-server.mjs'), '--control', control], { stdio: ['ignore', 'pipe', 'inherit'] });
  const base = await new Promise((ok) => srv.stdout.on('data', (d) => { const m = String(d).match(/serving (\S+)/); if (m) ok(m[1]); }));
  try {
    const st = await ctl('/state');
    const X = st.x, Y = st.y;
    note(`site ${base}; operator ${st.server}; node ${st.node_url}; asset X ${X} (listed for fees), Y ${Y}`);

    // --- The other wallet: the command-line wallet, with leaves of X ---
    cli('create', '--server', st.server, '--node-url', st.node_url, '--node-user', 'arca', '--exit-delay-units', '1', '--min-exit-delay-units', '1');
    await ctl('/fund', { script: cli('address').script_pubkey, asset: X, amount: 5000000 });
    await ctl('/produce');
    const cb = cli('board', X, '3000000');
    if (cb.error) throw new Error('the CLI wallet could not board: ' + cb.error.message);
    await ctl('/produce'); await ctl('/bury');
    for (let i = 0; i < 120 && cli('boards')[0]?.server?.state !== 'credited'; i++) await sleep(500);
    cli('sync');

    // --- The wallet: created, developer mode, joined ---
    await b.launch('start 1');
    await readConsole('start 1');
    const pop = await b.page(`chrome-extension://${b.extId}/popup/popup.html`);
    await pop.waitFor("document.querySelector('#btnStartCreate') && document.querySelector('#btnStartCreate').offsetParent !== null && !!document.querySelector('#btnStartCreate').onclick", 60000);
    await pop.click('#btnStartCreate');
    await pop.waitFor("document.querySelector('#newPhrase').dataset.phrase");
    await pop.set('createPw', 'drive-password'); await pop.set('createPw2', 'drive-password');
    await pop.click('#btnCreateGo');
    await pop.waitFor("document.querySelector('#vApp') && !document.querySelector('#vApp').classList.contains('hide')", 120000);
    await pop.click('[data-tab=settings]');
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); s.value='developer'; s.dispatchEvent(new Event('change')); return true})()");
    await pop.waitFor("!document.querySelector('#leafCard').classList.contains('hide')", 30000);
    await pop.set('leafServer', base + 'operator'); await pop.set('leafNodeUrl', base + 'node');
    await pop.set('leafNodeUser', st.node_user); await pop.set('leafNodePassword', st.node_password);
    await pop.set('leafDelay', '1'); await pop.set('leafMinDelay', '1');
    await pop.click('#btnLeafJoin');
    await pop.waitFor("!document.querySelector('#leafJoined').classList.contains('hide') || /refused|error|could not|failed/i.test(document.querySelector('#leafStatus').innerText)", 180000);
    check('the wallet joined the operator', !(await pop.eval("document.querySelector('#leafJoined').classList.contains('hide')")), await pop.text('#leafStatus'));
    await pop.eval("chrome.storage.local.get(['ext.walletTag','ext.leaves.byWallet']).then((o)=>{const t=o['ext.walletTag'], all=o['ext.leaves.byWallet']; all[t]={...all[t], tick_ms: 4000}; return chrome.storage.local.set({'ext.leaves.byWallet': all})})");

    // --- The site: connect, board Y ---
    const site = await b.page(base + 'site.html');
    siteOut = () => site.eval("document.querySelector('#out').dataset.method + ': ' + document.querySelector('#out').textContent").catch(() => '');
    await site.waitFor('window.siteEvents', 30000);
    await site.waitFor("document.body.dataset.mode === 'developer'", 30000);
    const done = (method) => site.waitFor(`document.querySelector('#out').dataset.method === ${JSON.stringify(method)} && document.querySelector('#out').dataset.ok !== ''`, 300000);
    const answer = async () => ({ ok: await site.eval("document.querySelector('#out').dataset.ok === '1'"), text: await site.eval("document.querySelector('#out').textContent") });
    const press = async (btn) => { await site.eval("document.querySelector('#out').dataset.method=''"); await site.click(btn); };
    const approvals = async () => (await b.targets()).filter((x) => x.url.includes('/approval/approval.html')).length;
    const leafBal = async () => {
      await press('#btnBalances'); await done('getLeafBalances');
      const a = await answer();
      const l = a.ok ? JSON.parse(a.text).leaves : {};
      // Every coin the wallet holds, whatever its standing (a coin received is operator-confirmed
      // until a round settles it): all states but those given up.
      const g = (h) => Object.entries(((l[h] || {}).states) || {}).filter(([st]) => !/spent|given|offered|sending/.test(st)).reduce((t, [, v]) => t + BigInt(v), 0n);
      return { [X]: g(X), [Y]: g(Y) };
    };
    await press('#btnConnect');
    await approve('approval-connect', [/wants to connect/]);
    await done('connect');
    await press('#btnAddress'); await done('getLeafAddress');
    const addr = JSON.parse((await answer()).text);
    await ctl('/fund', { script: addr.script_pubkey, asset: Y, amount: 4000000 });
    await ctl('/fund', { script: addr.script_pubkey, asset: X, amount: 1000000 });
    await ctl('/produce');
    await site.set('asset', Y); await site.set('amount', '3000000'); await site.set('feeAsset', X);
    for (let i = 0; ; i++) {
      await press('#btnBoard');
      const t = await Promise.race([b.waitTarget((x) => x.type === 'page' && x.url.includes('/approval/approval.html'), 60000).then(() => 'window'), done('boardLeaves').then(() => 'answer')]);
      if (t === 'window') { await approve('approval-board', [/Board a coin into your leaves/, /3000000 atoms/]); await done('boardLeaves'); break; }
      const a = await answer();
      if (i < 10 && /no live coin|holds 0|Scan already in progress|not enough/i.test(a.text)) { await sleep(2000); await ctl('/produce'); continue; }
      throw new Error('the board was refused: ' + a.text);
    }
    await ctl('/produce'); await ctl('/bury');
    let w0 = null;
    for (let i = 0; i < 90; i++) { w0 = await leafBal(); if (w0[Y] >= 3000000n) break; await sleep(2000); await ctl('/produce'); }
    check('the wallet holds 3000000 Y as a live leaf', w0[Y] >= 3000000n, { X: String(w0[X]), Y: String(w0[Y]) });
    const c0 = cli('balance');
    note(`     before: wallet X ${w0[X]} Y ${w0[Y]}; command-line wallet X ${live(c0, X)} Y ${live(c0, Y)}`);

    // --- 1. The command-line wallet offers 300000 X for 400000 Y; the site accepts ---
    const offer = cli('swap', 'offer', '--give-asset', X, '--give', '300000', '--want-asset', Y, '--want', '400000');
    check('the command-line wallet made an offer', !!offer.offer, offer.error || offer.offer.slice(0, 24));
    await site.set('swapOffer', offer.offer);
    await press('#btnSwapAccept');
    const readScreen = await approve('approval-swap-accept', [/Accept a swap of leaves\?/, /accept another wallet/, /You get\s*[\d.]+ \S+ \(300000 atoms\) as a leaf/, /You give\s*[\d.]+ \S+ \(400000 atoms\)/, /You pay/, /The other wallet pays/, /Dates/]);
    await done('leafSwapAccept'); let a = await answer();
    const acc = a.ok ? JSON.parse(a.text) : null;
    check('leafSwapAccept answers the acceptance, signed on the terms shown', !!acc && /accept:/.test(acc.accept) && acc.pays && readScreen.includes(`(${acc.pays.margins} atoms)`), acc ? { swap: acc.swap, pays: acc.pays } : a.text);
    await shot(site, 'site-accepted');
    const pool0 = await rpc('getrawmempool');
    const comp = cli('swap', 'complete', acc.accept);
    check('the command-line wallet completed the swap', !comp.error && comp.swap === acc.swap, comp.error || comp.swap);
    check('node: an in-tree swap puts nothing on the chain', (await rpc('getrawmempool')).length === pool0.length);
    let w1 = null;
    for (let i = 0; i < 60; i++) { w1 = await leafBal(); if (w1[X] - w0[X] === 300000n) break; await sleep(2000); }
    const c1 = cli('balance');
    check('both balances moved: the wallet got 300000 X and gave 400000 Y and the margins it was shown',
      w1[X] - w0[X] === 300000n && w0[Y] - w1[Y] === 400000n + BigInt(acc.pays.margins), { dX: String(w1[X] - w0[X]), dY: String(w1[Y] - w0[Y]), margins: acc.pays.margins });
    check('both balances moved: the command-line wallet got 400000 Y', live(c1, Y) - live(c0, Y) === 400000n && live(c1, X) < live(c0, X), { dX: String(live(c1, X) - live(c0, X)), dY: String(live(c1, Y) - live(c0, Y)) });
    await shot(site, 'site-after-swap-1');

    // --- 2. The site offers 500000 Y for 200000 X; the command-line wallet accepts; the site completes ---
    await site.set('giveAsset', Y); await site.set('give', '500000'); await site.set('wantAsset', X); await site.set('want', '200000');
    // First rejected in its window: the offer is cancelled and its coins freed.
    await press('#btnSwapOffer');
    await approve('approval-swap-offer-rejected', [/Offer a swap of your leaves\?/, /offer a swap/, /You give\s*[\d.]+ \S+ \(500000 atoms\)/], false);
    await done('leafSwapOffer'); a = await answer();
    check('an offer rejected in its window is refused to the site', !a.ok && /rejected/.test(a.text), a.text);
    await press('#btnSwaps'); await done('getLeafSwaps'); a = await answer();
    check('a rejected offer leaves no swap of this site behind', a.ok && JSON.parse(a.text).swaps.every((s) => s.state !== 'open'), a.text);
    await press('#btnSwapOffer');
    const offerScreen = await approve('approval-swap-offer', [/Offer a swap of your leaves\?/, /offer a swap/, /You give\s*[\d.]+ \S+ \(500000 atoms\)/, /You get\s*[\d.]+ \S+ \(200000 atoms\)/, /You pay\s*[\d.]+ \S+ \(\d+ atoms\) as the reassignment/]);
    await done('leafSwapOffer'); a = await answer();
    const mine = a.ok ? JSON.parse(a.text) : null;
    check('leafSwapOffer answers the offer, and what the window showed it pays', !!mine && /offer:/.test(mine.offer) && offerScreen.includes(`(${mine.pays.margin} atoms)`), mine ? { swap: mine.swap, pays: mine.pays } : a.text);
    const theirs = cli('swap', 'accept', mine.offer);
    check('the command-line wallet accepted the site\'s offer', !!theirs.accept, theirs.error || theirs.swap);
    await site.set('swapAccept', 'not an acceptance');
    await press('#btnSwapComplete'); await done('leafSwapComplete'); a = await answer();
    check('a text that names no swap of this site is refused before any window', !a.ok && /names no swap/.test(a.text) && (await approvals()) === 0, a.text);
    await site.set('swapAccept', theirs.accept);
    await press('#btnSwapComplete');
    await approve('approval-swap-complete', [/Complete your swap of leaves\?/, /complete your swap/, /You give\s*[\d.]+ \S+ \(500000 atoms\)/, /You get\s*[\d.]+ \S+ \(200000 atoms\)/]);
    await done('leafSwapComplete'); a = await answer();
    check('leafSwapComplete completed it', a.ok && JSON.parse(a.text).done === true, a.text);
    let w3 = null;
    // Measured from before the offer: while it was open, its coin was held for it.
    for (let i = 0; i < 60; i++) { w3 = await leafBal(); if (w3[X] - w1[X] === 200000n) break; await sleep(2000); }
    cli('sync');
    const c3 = cli('balance');
    check('both balances moved: the wallet got 200000 X and gave 500000 Y and the margins it was shown',
      w3[X] - w1[X] === 200000n && w1[Y] - w3[Y] === 500000n + BigInt(mine.pays.margin) + BigInt(mine.pays.margins), { dX: String(w3[X] - w1[X]), dY: String(w3[Y] - w1[Y]), pays: mine.pays });
    check('both balances moved: the command-line wallet got 500000 Y more', live(c3, Y) - live(c1, Y) === 500000n, { dY: String(live(c3, Y) - live(c1, Y)) });
    await press('#btnSwaps'); await done('getLeafSwaps'); a = await answer();
    const list = a.ok ? JSON.parse(a.text).swaps : [];
    check('getLeafSwaps lists this site\'s two swaps, done, one taken and one offered', list.filter((s) => s.state === 'done').length === 2 && list.some((s) => s.role === 'taker') && list.some((s) => s.role === 'maker'), list);
    await shot(site, 'site-after-swap-2');

    // --- User mode: every swap method refused before any window ---
    await pop.front();
    await pop.eval("(()=>{const s=document.querySelector('#setMode'); s.value='user'; s.dispatchEvent(new Event('change')); return true})()");
    await site.waitFor("document.body.dataset.mode === 'user'", 30000);
    for (const [btn, m] of [['#btnSwapOffer', 'leafSwapOffer'], ['#btnSwapAccept', 'leafSwapAccept'], ['#btnSwapComplete', 'leafSwapComplete'], ['#btnSwaps', 'getLeafSwaps']]) {
      await site.eval("document.querySelector('#leafFeatures').hidden=false");
      await press(btn); await done(m); a = await answer();
      check(`in user mode ${m} is refused before any window`, !a.ok && /developer-mode rail/.test(a.text) && (await approvals()) === 0, a.text);
    }
    await shot(site, 'site-user-mode-refused');
    const late = b.problems.splice(0);
    check('no exception or console error from the extension\'s contexts during the drive', late.length === 0, late.length ? late : undefined);
    await b.close();
  } finally {
    srv.kill();
  }
}

main().then(() => {
  note(failures ? `${failures} check(s) failed` : 'all passed');
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  process.exit(failures ? 1 : 0);
}).catch(async (e) => {
  note('ERROR ' + (e.stack || e));
  try { await b.close(); } catch {}
  process.exit(1);
});
